import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import type { F3dClient } from '@tweakcad/f3d-import';
import {
  buildArchive,
  buildDesign,
  lineRecord,
  placementRecord,
  pointRecord,
  sketchRecord,
} from '../../../lib/f3d-import/src/parser/designBuilder.testHelper';
import { f3dImportMessage, importF3dFile } from './f3d';

/** A file holding a 4 × 2 cm rectangle. */
function plate(): Uint8Array {
  const corners: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 2],
    [0, 2],
  ];
  return buildArchive(
    buildDesign([
      placementRecord(2, null),
      sketchRecord(1, 2, 'Outline', [10, 11, 12, 13, 20, 21, 22, 23]),
      ...corners.map(([x, y], i) => pointRecord(10 + i, 30 + i, x, y)),
      ...corners.map((from, i) =>
        lineRecord(20 + i, 10 + i, 10 + ((i + 1) % 4), from, corners[(i + 1) % 4] as [number, number]),
      ),
    ]),
  );
}

const client: F3dClient = {
  evaluate: () => Promise.resolve(),
  vetSketch: () => Promise.resolve([]),
  vetSketches: (_doc, features) => Promise.resolve(features.map(() => [])),
  locateOnSurfaces: () => Promise.resolve([]),
  bodiesMadeBy: () => Promise.resolve([]),
  locateFacesOnSurfaces: () => Promise.resolve([]),
};

describe('f3dImportMessage', () => {
  const note = (object: string, message: string, severity: 'info' | 'warning' = 'warning') => ({
    severity,
    object,
    message,
  });

  it('says why the timeline is short, then what the console lists', () => {
    expect(
      f3dImportMessage([
        note('timeline', 'This design has no history.'),
        note('document', '1 draft left out'),
        note('document', '2 holes left out'),
      ]),
    ).toBe('This design has no history. 2 other things were not imported; the console lists them.');
  });

  it('counts what is left out when the timeline needs no reason', () => {
    expect(f3dImportMessage([note('document', '1 draft left out')])).toBe(
      '1 other thing was not imported; the console lists them.',
    );
  });

  it('says nothing when only information remains', () => {
    expect(f3dImportMessage([note('timeline', '3 components', 'info')])).toBeNull();
  });
});

describe('importF3dFile', () => {
  it('opens a file as a document named after it', async () => {
    const outcome = await importF3dFile({ name: 'plate.f3d', bytes: plate() }, client, seededIds(3));
    if (!outcome.ok) throw new Error(outcome.message);
    expect(readDocument(outcome.document).diagnostics.filter((d) => d.severity === 'refuse')).toEqual([]);
    expect((outcome.document.metadata as { name: string }).name).toBe('plate');
    expect(outcome.notes.map((n) => n.severity)).toEqual(['warning']);
  });

  it('says so when the file cannot be read', async () => {
    const outcome = await importF3dFile({ name: 'bad.f3d', bytes: Uint8Array.from([1, 2, 3]) }, client, seededIds(3));
    expect(outcome.ok).toBe(false);
  });

  it('says so when the worker cannot finish it', async () => {
    const failing: F3dClient = {
      ...client,
      evaluate: () => Promise.reject(new Error('no kernel')),
      vetSketches: () => Promise.reject(new Error('no kernel')),
    };
    const outcome = await importF3dFile({ name: 'plate.f3d', bytes: plate() }, failing, seededIds(3));
    expect(outcome).toEqual({ ok: false, message: 'The .f3d model could not be finished: no kernel' });
  });
});

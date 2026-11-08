/**
 * The assembly features as their panels write them, on the real kernel:
 * a pattern of an instance written, read back, edited and undone; a mirror
 * in a default plane and in a picked face, of the same hand and of the
 * opposite hand (a new mirrored part); a replicate from one face to
 * another.
 */
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { raycast } from '@tweakcad/worker/src/v2/service/testKit';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { partsOf } from '../features';
import { assemblyOf, indicesOf, instanceRow, newAssemblyCommands, rowsOf } from './assembly';
import {
  asmTimelineRows,
  assemblyFeatureOf,
  buildAsmMirror,
  buildAsmPattern,
  buildAsmReplicate,
  copiesOf,
  newAsmDirection,
  newAsmMirrorForm,
  newAsmPatternForm,
  newAsmReplicateForm,
  readAsmMirror,
  readAsmPattern,
  readAsmReplicate,
  type Built,
} from './asmFeatures';
import { commitSolved } from './commit';
import { endFrame, jointEnd } from './joints';

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  service = new EvaluationService(k);
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

function client(): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(service.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(service.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(service.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(service.properties(key)),
    measure: (kind, targets) => Promise.resolve(service.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(service.resolve(record, scope)),
    externalCurves: (key, mode, frame) => Promise.resolve(service.externalCurves(key, mode, frame)),
    neighbours: (key) => Promise.resolve(service.neighbours(key)),
  };
}

async function settled(s: AppServices): Promise<Display> {
  do await s.scheduler.whenIdle();
  while (s.scheduler.busy);
  const display = s.display.getState().display;
  if (!display) throw new Error('nothing shown');
  return display;
}

/**
 * An assembly of a 60 × 40 × 10 base (grounded, its top at z = 10, its +x
 * face at x = 30) and a 40 × 10 × 6 arm placed at (100, 0, 0).
 */
async function boot() {
  const { services: s } = await bootApp({
    client: client(),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(41),
    name: () => 'features',
  });
  const d = new Docs(9);
  const base = d.part('Base');
  base.box('60 mm', '40 mm', '10 mm', [0, 0, 5]);
  const arm = d.part('Arm');
  arm.box('40 mm', '10 mm', '6 mm', [0, 0, 3]);
  s.editor.store.replace(d.document({ part: { id: base.id } }));
  await settled(s);
  const made = newAssemblyCommands(s.editor, 'Assembly 1', [base.id]);
  expect(await commitSolved(s, 'New Assembly', made.commands)).toEqual({ ok: true });
  const row = instanceRow(
    s.editor,
    { part: { id: arm.id } },
    { placement: { position: [100, 0, 0], rotation: [0, 0, 0, 1] } },
  );
  expect(
    await commitSolved(s, 'Insert', [{ type: 'addAssemblyRow', assembly: made.assembly, table: 'instances', row }]),
  ).toEqual({ ok: true });
  await settled(s);
  return {
    s,
    assembly: made.assembly,
    base: base.id,
    arm: arm.id,
    baseInstance: rowsOf(assemblyOf(s.editor.document, made.assembly), 'instances')[0]?.id as string,
    armInstance: row.id as string,
  };
}

async function write(s: AppServices, built: Built): Promise<Display> {
  if (!built.ok) throw new Error(built.message);
  expect(await commitSolved(s, built.label, built.commands)).toEqual({ ok: true });
  const d = await settled(s);
  expect(d.pauses).toEqual([]);
  expect(readDocument(s.editor.document).refused).toBe(false);
  return d;
}

const copies = (d: Display, assembly: string) =>
  (d.assemblies.find((a) => a.id === assembly)?.instances ?? [])
    .slice(2)
    .map((i) => i.placement.position.map((v) => Math.round(v * 1e6) / 1e6 + 0));

describe('assembly features', { timeout: 60_000 }, () => {
  it('patterns an instance, reads the pattern back, edits it and undoes the edit', async () => {
    const { s, assembly, armInstance } = await boot();
    const form = newAsmPatternForm(s.editor, assembly, [armInstance]);
    form.directions = [{ ...newAsmDirection('y'), count: '3', spacing: '20' }];
    const built = buildAsmPattern(s.editor, assembly, form);
    expect(built.ok && built.label).toBe('Add Pattern 1');
    let d = await write(s, built);
    expect(copiesOf(d, assembly, form.feature)).toBe(2);
    expect(copies(d, assembly)).toEqual([
      [100, 20, 0],
      [100, 40, 0],
    ]);
    expect(asmTimelineRows(s.editor.document, assembly, d).map((r) => [r.name, r.status])).toEqual([
      ['Pattern 1', 'success'],
    ]);

    // Read back as the panel opens on it, then four copies along -x.
    const row = assemblyFeatureOf(s.editor.document, form.feature)?.row as Json;
    const edited = readAsmPattern(s.editor, row);
    expect(edited.instances).toEqual([armInstance]);
    expect(edited.directions.map((x) => [x.axis, x.count, x.spacing])).toEqual([[{ standard: 'y' }, '3', '20']]);
    edited.directions = [{ ...edited.directions[0]!, axis: { standard: 'x' }, reversed: true, count: '5' }];
    const again = buildAsmPattern(s.editor, assembly, edited);
    expect(again.ok && again.label).toBe('Edit Pattern 1');
    d = await write(s, again);
    expect(copies(d, assembly).map((p) => p[0])).toEqual([80, 60, 40, 20]);
    // The values kept their ids: the count's value object is the one first written.
    const countOf = (inputs: unknown) =>
      ((((inputs as Json).layout as Json).linear as Json).directions as Json[])[0]?.count as Json;
    expect(countOf(assemblyFeatureOf(s.editor.document, form.feature)?.row.inputs).id).toBe(countOf(row.inputs).id);

    s.editor.undo();
    d = await settled(s);
    expect(copiesOf(d, assembly, form.feature)).toBe(2);
    s.dispose();
  });

  it('patterns an instance symmetrically, along a direction and about an axis, and reads it back', async () => {
    const { s, assembly, armInstance } = await boot();
    const form = newAsmPatternForm(s.editor, assembly, [armInstance]);
    form.directions = [{ ...newAsmDirection('y'), count: '3', spacing: '20', symmetric: true }];
    let d = await write(s, buildAsmPattern(s.editor, assembly, form));
    expect(copies(d, assembly).sort((a, b) => (a[1] as number) - (b[1] as number))).toEqual([
      [100, -20, 0],
      [100, 20, 0],
    ]);
    const row = assemblyFeatureOf(s.editor.document, form.feature)?.row as Json;
    const edited = readAsmPattern(s.editor, row);
    expect(edited.directions[0]?.symmetric).toBe(true);

    edited.layout = 'circular';
    edited.circular = { ...edited.circular, count: '3', angle: '180', distribution: 'symmetric' };
    d = await write(s, buildAsmPattern(s.editor, assembly, edited));
    // Three over half a turn: a quarter turn each way about Z takes (100, 0) to (0, ±100).
    expect(copies(d, assembly).sort((a, b) => (a[1] as number) - (b[1] as number))).toEqual([
      [0, -100, 0],
      [0, 100, 0],
    ]);
    expect(
      readAsmPattern(s.editor, assemblyFeatureOf(s.editor.document, form.feature)?.row as Json).circular.distribution,
    ).toBe('symmetric');
    s.dispose();
  });

  it('patterns about a picked straight edge of an instance', async () => {
    const { s, assembly, armInstance, base } = await boot();
    let d = await settled(s);
    // The base's vertical edge at (30, 20): a circular pattern of the arm about it.
    const def = d.definitions[d.parts[base] as number]!;
    let edge = -1;
    for (const b of def.bodies) {
      for (let i = 0; i + 2 < b.mesh.edges.length; i += 3) {
        const key = b.mesh.edges[i + 2] as number;
        const m = service.properties(key)?.measures as { curve?: string; quarter?: number[] } | undefined;
        if (
          m?.curve === 'line' &&
          m.quarter &&
          Math.abs(m.quarter[0]! - 30) < 1e-6 &&
          Math.abs(m.quarter[1]! - 20) < 1e-6
        )
          edge = key;
      }
    }
    expect(edge).toBeGreaterThanOrEqual(0);
    const picked = await s.pick({ key: edge, instance: { assembly, index: 0 } });
    if (!picked || 'region' in picked) throw new Error('the edge did not pick');
    const form = newAsmPatternForm(s.editor, assembly, [armInstance]);
    form.layout = 'circular';
    form.circular = {
      axis: { picked: { reference: picked.reference, names: picked.names, label: 'Edge' } },
      reversed: false,
      count: '2',
      angle: '180',
      distribution: 'partial',
    };
    d = await write(s, buildAsmPattern(s.editor, assembly, form));
    // Half a turn about the line x = 30, y = 20 takes (100, 0) to (-40, 40).
    const [copy] = copies(d, assembly);
    expect(copy?.[0]).toBeCloseTo(-40, 6);
    expect(copy?.[1]).toBeCloseTo(40, 6);
    s.dispose();
  });

  it('mirrors an instance in a default plane and in a picked face, of the same hand and of the opposite hand', async () => {
    const { s, assembly, armInstance, base } = await boot();
    const form = newAsmMirrorForm(s.editor, assembly, [armInstance]);
    let d = await write(s, buildAsmMirror(s.editor, assembly, form));
    expect(copies(d, assembly)).toEqual([[-100, 0, 0]]);

    // In the base's +x face (x = 30): the copy lands at 2 × 30 − 100.
    const face = raycast(d, d.parts[base] as number, [50, 0, 5], [-1, 0, 0])?.key as number;
    const picked = await s.pick({ key: face, instance: { assembly, index: 0 } });
    if (!picked || 'region' in picked) throw new Error('the face did not pick');
    const edited = readAsmMirror(s.editor, assemblyFeatureOf(s.editor.document, form.feature)?.row as Json);
    expect(edited.plane).toEqual({ standard: 'yz' });
    edited.plane = { picked: { reference: picked.reference, names: picked.names, label: 'Face' } };
    d = await write(s, buildAsmMirror(s.editor, assembly, edited));
    expect(copies(d, assembly)[0]?.[0]).toBeCloseTo(-40, 6);

    // The opposite hand: a new part, a mirrored derive of the arm, placed where the reflection lands.
    const parts = partsOf(s.editor.document).length;
    const opposite = readAsmMirror(s.editor, assemblyFeatureOf(s.editor.document, form.feature)?.row as Json);
    opposite.hand = 'opposite';
    d = await write(s, buildAsmMirror(s.editor, assembly, opposite));
    const made = partsOf(s.editor.document);
    expect(made).toHaveLength(parts + 1);
    expect(made.at(-1)?.name).toBe('Arm (Mirror)');
    const copy = d.assemblies[0]?.instances[2];
    expect(copy?.definition).toBe(d.parts[made.at(-1)?.id as string]);
    expect(copiesOf(d, assembly, form.feature)).toBe(1);
    // Edited again, the seed keeps its mirrored part.
    const kept = readAsmMirror(s.editor, assemblyFeatureOf(s.editor.document, form.feature)?.row as Json);
    expect(kept.parts[armInstance]).toBe(made.at(-1)?.id);
    await write(s, buildAsmMirror(s.editor, assembly, { ...kept, plane: { standard: 'yz' } }));
    expect(partsOf(s.editor.document)).toHaveLength(parts + 1);
    s.dispose();
  });

  it('replicates an instance from the face it sits on to another like it', async () => {
    const { s, assembly, armInstance, base } = await boot();
    // A second base 100 mm along y; the arm sits on the first base's top.
    const second = instanceRow(
      s.editor,
      { part: { id: base } },
      { placement: { position: [0, 100, 0], rotation: [0, 0, 0, 1] }, grounded: true },
    );
    expect(
      await commitSolved(s, 'Place', [
        { type: 'addAssemblyRow', assembly, table: 'instances', row: second },
        {
          type: 'editAssemblyRow',
          row: armInstance,
          set: { placement: { position: [0, 0, 10], rotation: [0, 0, 0, 1] } },
        },
      ]),
    ).toEqual({ ok: true });
    let d = await settled(s);
    const top = raycast(d, d.parts[base] as number, [0, 0, 50], [0, 0, -1])?.key as number;
    const end = async (index: number) => {
      const e = await jointEnd(s, { key: top, instance: { assembly, index } }, 'Base');
      if ('problem' in e) throw new Error(e.problem);
      return { frame: endFrame(s.editor, e), names: e.names, label: e.label };
    };
    const form = newAsmReplicateForm(s.editor, assembly, [armInstance]);
    form.seed = await end(0);
    form.targets = [await end(indicesOf(d, assembly, second.id as string)[0] as number)];
    d = await write(s, buildAsmReplicate(s.editor, assembly, form));
    const copy = d.assemblies[0]?.instances.at(-1)?.placement.position.map((v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(copy).toEqual([0, 100, 10]);
    const read = readAsmReplicate(s.editor, assemblyFeatureOf(s.editor.document, form.feature)?.row as Json);
    expect(read.targets).toHaveLength(1);
    expect(read.seed?.label).toBe('Seed');
    s.dispose();
  });
});

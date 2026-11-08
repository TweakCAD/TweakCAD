/**
 * An extrude whose profile is to be reconnected, edited as its panel edits
 * it on the real kernel: the panel lists the profile as missing, a region
 * clicked takes its place, and OK writes an extrude that builds, starting
 * on the sketch plane or on a face.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { raycast } from '@tweakcad/worker/src/v2/service/testKit';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { findFeature } from '../features';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import {
  buildExtrude,
  candidateDocument,
  readExtrude,
  writeExtrude,
  ValueSlots,
  type ExtrudeProfile,
  type ExtrudeTarget,
} from './extrude';
import { pickFor } from './picks';
import { isMissingProfile, profilesLabel, regionKeysAt, toggleProfile } from './profiles';

const HERE = dirname(fileURLToPath(import.meta.url));

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(HERE, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  service = new EvaluationService(k, await make_gcs_wrapper(realpathSync(wasm)));
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

function client(s: EvaluationService): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(s.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(s.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(s.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(s.properties(key)),
    externalCurves: (key, mode, frame) => Promise.resolve(s.externalCurves(key, mode, frame)),
    measure: (kind, targets) => Promise.resolve(s.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(s.resolve(record, scope)),
    bodiesBefore: (scope, records, options) => Promise.resolve(s.bodiesBefore(scope, records, options)),
  };
}

async function settled(s: AppServices): Promise<Display> {
  do await s.scheduler.whenIdle();
  while (s.scheduler.busy);
  const display = s.display.getState().display;
  if (!display) throw new Error('nothing shown');
  return display;
}

function volume(display: Display, part: string): number {
  let v = 0;
  for (const b of display.definitions[display.parts[part] as number]?.bodies ?? []) {
    const m = service.measure('volume', [b.key]);
    if ('value' in m) v += m.value;
  }
  return v;
}

const featureNamed = (doc: Json, part: Json, name: string): string =>
  ((part.timeline as Json[]).find((f) => f.name === name) as Json).id as string;

describe('an extrude whose profile is lost', { timeout: 120_000 }, () => {
  it('lists the profile as missing, takes a clicked region in its place, and builds after OK', async () => {
    const { services: s } = await bootApp({
      client: client(service),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(31),
      name: () => 'knob',
    });
    expect(s.session.openText(readFileSync(resolvePath(HERE, 'fixtures/knob.cadjson'), 'utf8')).ok).toBe(true);
    // The kernel here does not build a full revolve: the knob turns by 359.5 degrees instead, so Extrude 1 has a body to cut.
    const revolve = featureNamed(s.editor.document, (s.editor.document.parts as Json[])[0] as Json, 'Revolve 1');
    const turned = s.editor.dispatch({
      type: 'replaceInput',
      feature: revolve,
      pointer: '/sides',
      with: [
        { angle: { a: { id: s.editor.newId('val'), def: { expr: { text: '359.5 deg', grammar: 1, refs: {} } } } } },
      ],
    });
    if (!turned.ok) throw new Error(turned.error.message);
    let display = await settled(s);
    const doc = s.editor.document;
    const partRow = (doc.parts as Json[])[0] as Json;
    const part = partRow.id as string;
    const extrude = featureNamed(doc, partRow, 'Extrude 1');
    const sketch = featureNamed(doc, partRow, 'Sketch 2');
    expect(display.pauses.find((p) => p.feature === extrude)?.message).toBe('a profile is to be reconnected');

    // The panel opens on the stored inputs: one profile, missing.
    const read = readExtrude(doc, part, extrude);
    if (!read) throw new Error('Extrude 1 does not read back');
    expect(read.profiles).toHaveLength(1);
    expect(read.profiles.every(isMissingProfile)).toBe(true);
    expect(profilesLabel(read.profiles, 'Sketch')).toBe('1 profile missing');

    // The D of the shaft hole, clicked in Sketch 2, takes the missing profile's place.
    const uncut = volume(display, part);
    const [shaft] = regionKeysAt(display, part, sketch, [[0, 0]]);
    if (shaft === undefined) throw new Error('no region at the centre of Sketch 2');
    const clicked = await toggleProfile(s, part, read.profiles, shaft);
    if (!clicked || !('toggle' in clicked)) throw new Error('the click did not pick a profile');
    const profiles: ExtrudeProfile[] = clicked.toggle(read.profiles);
    expect(profiles).toHaveLength(1);
    expect(profiles.some(isMissingProfile)).toBe(false);
    expect(profilesLabel(profiles, String(findFeature(doc, sketch)?.name))).toBe('Sketch 2');

    // The preview builds the extrude, and so does OK.
    const target: ExtrudeTarget = { part, feature: extrude, base: read.inputs };
    const values = new ValueSlots(() => s.editor.newId('val'), read.inputs);
    const built = buildExtrude(doc, target, read.form, profiles, values);
    if (!built.ok) throw new Error(built.message);
    const candidate = candidateDocument(doc, target, built, profiles, (kind) => s.editor.newId(kind));
    if (!candidate.ok) throw new Error(candidate.message);
    expect(service.evaluate(candidate.doc).pauses.filter((p) => p.feature === extrude)).toEqual([]);
    const written = writeExtrude(s.editor, target, built, profiles);
    if (!written.ok) throw new Error(written.error.message);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(readExtrude(s.editor.document, part, extrude)?.profiles.some(isMissingProfile)).toBe(false);
    // A 12 mm deep hole of a 6 mm D: less than a round one, more than half.
    const cut = uncut - volume(display, part);
    expect(cut).toBeLessThan(Math.PI * 9 * 12);
    expect(cut).toBeGreaterThan((Math.PI * 9 * 12) / 2);

    // Started on the knob's bottom face, which lies on the sketch plane, it cuts the same hole.
    const face = raycast(display, display.parts[part] as number, [8, -100, 0], [0, 1, 0]);
    if (!face) throw new Error('no face below the knob');
    const startFace = await pickFor(s, target, { key: face.key });
    if (!startFace) throw new Error('the start face was refused');
    const edited = readExtrude(s.editor.document, part, extrude);
    if (!edited) throw new Error('Extrude 1 does not read back');
    const onFace = buildExtrude(
      s.editor.document,
      { ...target, base: edited.inputs },
      { ...edited.form, startType: 'face', startFace },
      edited.profiles,
      new ValueSlots(() => s.editor.newId('val'), edited.inputs),
    );
    if (!onFace.ok) throw new Error(onFace.message);
    const faceWritten = writeExtrude(s.editor, { ...target, base: edited.inputs }, onFace, edited.profiles);
    if (!faceWritten.ok) throw new Error(faceWritten.error.message);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(uncut - volume(display, part)).toBeCloseTo(cut, 3);
  });
});

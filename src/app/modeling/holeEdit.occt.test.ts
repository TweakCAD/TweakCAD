/**
 * Editing a hole as its panel edits it, on the real kernel, in the flange
 * whose hole lost its face: the viewport shows the part just before the
 * hole (the features after it hidden), the preview cuts the hole while the
 * form builds, and taking the face off shows the part before the hole
 * again, never the last preview. A click near the hub's circular edge
 * places the hole at the circle's centre.
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
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { candidateFeature, editTarget, ValueSlots, type FeatureTarget } from './feature';
import { buildHole, clickFace, readHole, removeFace, type HoleForm } from './hole';
import { snapOnFace, snapTargets } from './holeSnap';
import { pickFor, planarFrame } from './picks';

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

const featureNamed = (part: Json, name: string): string =>
  ((part.timeline as Json[]).find((f) => f.name === name) as Json).id as string;

/** What the panel's preview does with a form: the candidate when it builds, the state before the hole when it does not. */
function preview(s: AppServices, target: FeatureTarget, form: HoleForm, values: ValueSlots): boolean {
  const built = buildHole(s.editor.document, target, form, values);
  if (!built.ok) {
    s.scheduler.setPreview(null);
    return false;
  }
  const candidate = candidateFeature(s.editor.document, target, 'core.hole', built, (kind) => s.editor.newId(kind));
  if (!candidate.ok) throw new Error(candidate.message);
  s.scheduler.setPreview(candidate.doc);
  return true;
}

/** Face-frame millimetres as the panel's fields hold them. */
const field = (n: number): string => String(Math.round(n * 100) / 100);

describe('editing the flange hole whose face was lost', { timeout: 120_000 }, () => {
  it('shows the part before the hole without a preview, and snaps a click near the hub edge to its centre', async () => {
    const { services: s } = await bootApp({
      client: client(service),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(31),
      name: () => 'flange',
    });
    expect(s.session.openText(readFileSync(resolvePath(HERE, 'fixtures/flange.cadjson'), 'utf8')).ok).toBe(true);
    const partRow = (s.editor.document.parts as Json[])[0] as Json;
    const part = partRow.id as string;
    // The kernel here does not build a full revolve: the flange turns by 359.5 degrees instead, so the hole has a body to cut.
    const revolve = featureNamed(partRow, 'Revolve 1');
    const turned = s.editor.dispatch({
      type: 'replaceInput',
      feature: revolve,
      pointer: '/sides',
      with: [
        { angle: { a: { id: s.editor.newId('val'), def: { expr: { text: '359.5 deg', grammar: 1, refs: {} } } } } },
      ],
    });
    if (!turned.ok) throw new Error(turned.error.message);
    const hole = featureNamed(partRow, 'Hole 1');
    const fillet = featureNamed(partRow, 'Fillet 1');
    const committed = await settled(s);
    expect(committed.pauses.find((p) => p.feature === hole)?.message).toBe('the hole face is gone');
    const end = volume(committed, part);

    // The panel opens on Hole 1: the viewport shows the part just before it, the bolt holes cut after it hidden.
    const target = editTarget(s.editor.document, part, hole, 'core.hole')!;
    let form = readHole(s.editor.document, part, target.base!)!;
    const values = new ValueSlots(() => s.editor.newId('val'), target.base);
    s.scheduler.setBefore({ part, feature: hole });
    let display = await settled(s);
    const definition = () => display.definitions[display.parts[part] as number]!;
    expect(s.display.getState().preview).toBe(true);
    expect(definition().rollback).toBe(hole);
    const before = volume(display, part);
    expect(before).toBeGreaterThan(end);

    // The hub's top face, clicked near its circular edge: the position snaps to the circle's centre.
    const top = raycast(display, display.parts[part] as number, [10, 200, 0], [0, -1, 0]);
    if (!top) throw new Error('no face on top of the hub');
    const frame = await planarFrame(s, { key: top.key });
    if (!frame) throw new Error('the hub top is not flat');
    const hub = snapTargets(display, display.entities[top.key]!.body, frame).find(
      (t) => t.kind === 'centre' && t.radius! > 20,
    );
    if (!hub) throw new Error('no circular edge on the hub top');
    const near = snapOnFace(display, { key: top.key }, frame, [hub.radius! - 0.4, 0.3], 1);
    expect(near.target?.kind).toBe('centre');
    expect([field(near.uv[0]), field(near.uv[1])]).toEqual(['0', '0']);
    // A click away from the edge and the centre stays where it is.
    expect(snapOnFace(display, { key: top.key }, frame, [-14.01, -20.42], 1)).toEqual({
      uv: [-14.01, -20.42],
      target: null,
    });

    const face = await pickFor(s, target, { key: top.key });
    if (!face) throw new Error('the hub top was refused');
    form = {
      ...form,
      ...clickFace(form, face, { id: s.editor.newId('hp'), x: field(near.uv[0]), y: field(near.uv[1]) }, true),
    };
    expect(form.positions.map((p) => [p.x, p.y])).toEqual([['0', '0']]);

    // The form builds: the preview cuts the hole, rolled back to just after it.
    expect(preview(s, target, form, values)).toBe(true);
    display = await settled(s);
    expect(definition().rollback).toBe(fillet);
    expect(display.pauses.find((p) => p.feature === hole)).toBeUndefined();
    const cut = volume(display, part);
    expect(cut).toBeLessThan(before - 1000);

    // The face taken off: the positions stay, nothing builds, and the part before the hole shows, not the last preview.
    form = { ...form, ...removeFace() };
    expect(form.positions.map((p) => [p.x, p.y])).toEqual([['0', '0']]);
    expect(preview(s, target, form, values)).toBe(false);
    display = await settled(s);
    expect(s.display.getState().preview).toBe(true);
    expect(definition().rollback).toBe(hole);
    expect(volume(display, part)).toBeCloseTo(before, 3);

    // The hub top picked again: it takes the stored position, the centre, wherever the click lands.
    const again = raycast(display, display.parts[part] as number, [10, 200, 0], [0, -1, 0]);
    if (!again) throw new Error('no face on top of the hub');
    const againFrame = await planarFrame(s, { key: again.key });
    const snapped = snapOnFace(display, { key: again.key }, againFrame!, [0.3, -(hub.radius! - 0.4)], 1);
    expect(snapped.target?.kind).toBe('centre');
    const repicked = await pickFor(s, target, { key: again.key });
    form = { ...form, ...clickFace(form, repicked!, { id: s.editor.newId('hp'), x: '-14.01', y: '-20.42' }, false) };
    expect(form.positions.map((p) => [p.x, p.y])).toEqual([['0', '0']]);
    expect(preview(s, target, form, values)).toBe(true);
    display = await settled(s);
    expect(volume(display, part)).toBeCloseTo(cut, 3);

    // The panel closes: the committed model, at the end of its timeline.
    s.scheduler.setPreview(null);
    s.scheduler.setBefore(null);
    display = await settled(s);
    expect(s.display.getState().preview).toBe(false);
    expect(definition().rollback).toBeNull();
    expect(volume(display, part)).toBeCloseTo(end, 3);
    s.dispose();
  });
});

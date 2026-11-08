/**
 * The extrude panel's flip for a profile of a sketch on a body face, on the
 * real kernel: Cut and Intersect run into the body, Join and New body out of
 * it, and a sketch on a plane is left alone. A cut written with that flip
 * takes material away; written out of the body, it pauses.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededIds, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { raycast } from '@tweakcad/worker/src/v2/service/testKit';
import type { Display, FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { SketchSession, type SketchPointer } from '../../sketcher';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import {
  buildExtrude,
  faceSketchFlip,
  ValueSlots,
  writeExtrude,
  type ExtrudeForm,
  type ExtrudeProfile,
} from './extrude';
import { profileOf, sketchesOf } from './profiles';
import { addSketch } from './sketch';

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  service = new EvaluationService(k, gcs);
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

/** The service as the app's client, in this thread. */
function client(): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(service.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(service.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(service.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(service.properties(key)),
    externalCurves: (key, mode, frame) => Promise.resolve(service.externalCurves(key, mode, frame)),
    measure: (kind, targets) => Promise.resolve(service.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(service.resolve(record, scope)),
    bodiesBefore: (scope, records, options) => Promise.resolve(service.bodiesBefore(scope, records, options)),
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

/** Draws a circle of radius `r` about (`u`, `v`) in a sketch session, as the circle tool's two clicks do. */
function drawCircle(s: AppServices, part: string, sketch: string, u: number, v: number, r: number): void {
  const frame = sketchesOf(s.display.getState().display, part).find((x) => x.feature === sketch)?.frame as FrameDisplay;
  expect(frame).toBeDefined();
  const session = new SketchSession(
    { editor: s.editor, part, feature: sketch, frame, group: new THREE.Group(), requestRender: () => undefined },
    gcs,
  );
  const event = (type: SketchPointer['type'], a: number, b: number): SketchPointer => ({
    type,
    uv: [a, b],
    pixel: 0.05,
    button: 0,
    shift: false,
    ctrl: false,
    alt: false,
  });
  session.setTool('circle');
  for (const [a, b] of [
    [u, v],
    [u + r, v],
  ] as const) {
    session.pointer(event('down', a, b));
    session.pointer(event('up', a, b));
  }
  session.finish();
  session.dispose();
}

const PLATE = 40 * 30 * 10;

describe('the extrude flip for a sketch on a body face', { timeout: 120_000 }, () => {
  it('runs a cut or intersect into the body and a join or new body out of it; a cut out of it pauses', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(31),
      name: () => 'flip',
    });
    const d = new DocBuilder();
    const plate = d.sketch('xy', (x) => x.rect(0, 0, 40, 30));
    d.extrude({ sketch: plate.feature, profiles: [plate.region([1, 1])], sides: [{ distance: '10 mm' }] });
    s.editor.store.replace(d.document());
    let display = await settled(s);
    const part = ((s.editor.document.root as Json).part as Json).id as string;

    // A sketch on the plate's top face, a circle of radius 3 on it.
    const hit = raycast(display, display.parts[part] as number, [20, 15, 50], [0, 0, -1]);
    if (!hit) throw new Error('no top face');
    const face = await s.pick({ key: hit.key });
    if (!face || 'region' in face) throw new Error('the face did not pick');
    const added = addSketch(s.editor, part, face);
    if (!added.ok) throw new Error(added.message);
    const sketch = added.feature;
    await settled(s);
    drawCircle(s, part, sketch, 20, 15, 3);
    display = await settled(s);
    const region = sketchesOf(display, part).find((x) => x.feature === sketch)?.regions[0] as { key: number };
    const profile = (await profileOf(s, part, region.key)) as ExtrudeProfile;
    expect(profile).not.toBeNull();

    const doc = s.editor.document;
    expect(faceSketchFlip(doc, sketch, 'cut')).toBe(true);
    expect(faceSketchFlip(doc, sketch, 'intersect')).toBe(true);
    expect(faceSketchFlip(doc, sketch, 'join')).toBe(false);
    expect(faceSketchFlip(doc, sketch, 'new')).toBe(false);
    // The plate's own sketch lies on the XY plane: the operation leaves its flip alone.
    expect(faceSketchFlip(doc, plate.feature, 'cut')).toBeNull();
    expect(faceSketchFlip(doc, null, 'cut')).toBeNull();

    const cut = (reversed: boolean) => {
      const target = { part, feature: s.editor.newId('feat'), name: 'Extrude' };
      const form: ExtrudeForm = { extent: 'throughAll', distance: '10', face: null, reversed, operation: 'cut' };
      const built = buildExtrude(
        s.editor.document,
        target,
        form,
        [profile],
        new ValueSlots(() => s.editor.newId('val')),
      );
      if (!built.ok) throw new Error(built.message);
      const r = writeExtrude(s.editor, target, built, [profile]);
      if (!r.ok) throw new Error(r.error.message);
    };

    // Out of the plate, the cut takes nothing away and pauses; the plate stays whole.
    cut(!faceSketchFlip(doc, sketch, 'cut'));
    display = await settled(s);
    expect(display.pauses.map((p) => p.message)).toEqual(['no target body found to cut or intersect']);
    expect(volume(display, part)).toBeCloseTo(PLATE, 3);

    s.editor.undo();
    await settled(s);
    // Flipped as the panel flips it, the cut runs through the plate.
    cut(faceSketchFlip(doc, sketch, 'cut') as boolean);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(PLATE - Math.PI * 9 * 10, 3);
  });
});

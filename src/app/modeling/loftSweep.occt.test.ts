/**
 * Loft and Sweep as their panels write them, on the real kernel: a loft
 * between two profiles, then a sweep of a third along a drawn path, each
 * hiding its profile sketches as it is added.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { featureHidden } from '../attributes';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { ValueSlots, newTarget, writeFeature, type Built } from './feature';
import { buildLoft, newLoftForm } from './loft';
import { pickFor } from './picks';
import { profileOf, sketchesOf } from './profiles';
import { buildSweep, newSweepForm } from './sweep';
import { connectedCurves } from './sweepChains';

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

const ok = (built: Built): Extract<Built, { ok: true }> => {
  if (!built.ok) throw new Error(built.message);
  return built;
};

describe('a loft, then a sweep along a drawn path', { timeout: 120_000 }, () => {
  it("builds the sweep along the whole path as a body of its own, and hides each feature's profile sketches", async () => {
    const { services: s } = await bootApp({
      client: client(service),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(31),
      name: () => 'loft',
    });
    expect(s.session.openText(readFileSync(resolvePath(HERE, 'fixtures/loft-sweep.cadjson'), 'utf8')).ok).toBe(true);
    let display = await settled(s);
    const part = ((s.editor.document.parts as Json[])[0] as Json).id as string;
    const [square, circle, small, path] = sketchesOf(display, part);
    if (!square || !circle || !small || !path) throw new Error('four sketches expected');

    // The loft from the square to the circle.
    const loft = newTarget(s.editor, part, 'Loft');
    const loftForm = newLoftForm(false);
    for (const sketch of [square, circle]) {
      const profile = await profileOf(s, part, (sketch.regions[0] as { key: number }).key);
      if (!profile) throw new Error('no profile');
      loftForm.sections.push({ id: s.editor.newId('sec'), profile });
    }
    expect(
      writeFeature(
        s.editor,
        loft,
        'core.loft',
        ok(buildLoft(s.editor.document, loft, loftForm, new ValueSlots(() => s.editor.newId('val')))),
        'Loft',
      ).ok,
    ).toBe(true);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    for (const sketch of [square, circle]) expect(featureHidden(s.editor.document, part, sketch.feature)).toBe(true);
    expect(featureHidden(s.editor.document, part, small.feature)).toBe(false);

    // The small square swept along the path that starts at its centre: up 20 mm, then 20 mm along x.
    const after = sketchesOf(display, part);
    const sweep = newTarget(s.editor, part, 'Sweep');
    const form = newSweepForm(s.editor.newId('sec'), true);
    const profile = await profileOf(s, part, ((after[2] as typeof small).regions[0] as { key: number }).key);
    if (!profile) throw new Error('no profile');
    form.profiles = [profile];
    for (const key of connectedCurves(display, part, ((after[3] as typeof path).curves[0] as { key: number }).key)) {
      const link = await pickFor(s, sweep, { key });
      if (!link) throw new Error('no path link');
      form.path.push(link);
    }
    expect(form.path).toHaveLength(2);
    expect(
      writeFeature(
        s.editor,
        sweep,
        'core.sweep',
        ok(buildSweep(s.editor.document, sweep, form, new ValueSlots(() => s.editor.newId('val')))),
        'Sweep',
      ).ok,
    ).toBe(true);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const bodies = display.definitions[display.parts[part] as number]?.bodies ?? [];
    const swept = bodies.find((b) => b.feature === sweep.feature);
    if (!swept) throw new Error('no swept body');
    expect(service.measure('volume', [swept.key])).toMatchObject({ value: expect.closeTo(4 * 4 * 40, 3) as number });
    const box = (service.properties(swept.key)?.measures as { bbox: [number[], number[]] }).bbox;
    expect(box[0][0]).toBeCloseTo(38, 3);
    expect(box[1][0]).toBeCloseTo(60, 3);
    expect(box[1][2]).toBeCloseTo(22, 3);
    expect(featureHidden(s.editor.document, part, small.feature)).toBe(true);
    // The path's sketch stays as it was.
    expect(featureHidden(s.editor.document, part, path.feature)).toBe(false);
  });
});

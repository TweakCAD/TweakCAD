/**
 * The feature panels' models on the real kernel: each builds its inputs from
 * a form and picks made as the panel makes them (through the app's pick,
 * against the state the feature starts from), writes them as one undo step,
 * and the evaluation shows the expected geometry with nothing paused.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededIds, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { raycast } from '@tweakcad/worker/src/v2/service/testKit';
import type { Display, Key } from '@tweakcad/worker/src/v2/service/types';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { buildChamfer, buildFillet, newChamferForm, newFilletForm, readFillet } from './blends';
import { tangentChain, tangentFaces } from './edgeChains';
import {
  at,
  candidateFeature,
  editTarget,
  newTarget,
  ValueSlots,
  writeFeature,
  type Built,
  type FeatureTarget,
  type PickedRef,
} from './feature';
import { buildHole, newHoleForm, readHole } from './hole';
import { buildLoft, newLoftForm, readLoft, sectionProfiles, withProfiles } from './loft';
import { pickFor, planarFrame } from './picks';
import { profileOf, sketchesOf, isMissingProfile, profilesLabel, toggleProfile } from './profiles';
import { buildRevolve, newRevolveForm, readRevolve } from './revolve';
import { buildSweep, newSweepForm, readSweep, type ChainPick } from './sweep';
import { connectedCurves } from './sweepChains';
import { buildThread, isBore, newThreadForm, readThread, sizeForDiameter } from './thread';
import { findFeature } from '../features';
import {
  buildBoolean,
  buildMirror,
  buildMove,
  buildPattern,
  buildRemoveBody,
  buildShell,
  newBooleanForm,
  newMirrorForm,
  newMoveForm,
  newPatternForm,
  newShellForm,
  readMove,
  readPattern,
  readPlacement,
  type PatternForm,
} from './bodyFeatures';
import { pickBody } from './BodyPanels';
import { buildPrimitive, newPrimitiveForm, readPrimitive } from './primitive';
import { fieldsFor, transformOf } from './MoveBodiesPanel';
import * as THREE from 'three';
import { bindExpression } from '@tweakcad/editor';
import { buildConstruction, newConstructionForm, readConstruction, withMode } from './construction';
import { keepMeasure, measuredValues, measuresFor } from './measure';
import { setColor, setName, setVisible } from '../attributes';
import { buildExtrude, readExtrude, type ExtrudeForm } from './extrude';
import { importBodies, placeImported, placementDelta } from './placeBodies';

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

export function inThreadClient(s: EvaluationService): AppServiceClient {
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

/** A 40 × 30 × 10 plate from the origin, and a 4 × 6 profile on XZ at x = 50 (its sketch y runs along −z). */
function plateDocument(): Json {
  const d = new DocBuilder();
  const plate = d.sketch('xy', (x) => x.rect(0, 0, 40, 30));
  d.extrude({ sketch: plate.feature, profiles: [plate.region([1, 1])], sides: [{ distance: '10 mm' }] });
  d.sketch('xz', (x) => x.rect(50, -6, 4, 6));
  return d.document();
}

async function boot(): Promise<{ s: AppServices; part: string }> {
  const { services: s } = await bootApp({
    client: inThreadClient(service),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(21),
    name: () => 'panels',
  });
  s.editor.store.replace(plateDocument());
  await settled(s);
  const part = ((s.editor.document.root as Json).part as Json).id as string;
  return { s, part };
}

function volume(display: Display, part: string): number {
  let v = 0;
  for (const b of display.definitions[display.parts[part] as number]?.bodies ?? []) {
    const m = service.measure('volume', [b.key]);
    if ('value' in m) v += m.value;
  }
  return v;
}

/** The drawn edge of the part whose polyline's midpoint lies within `tol` of `near`. */
function edgeNear(display: Display, part: string, near: readonly number[], tol = 0.05): Key {
  for (const b of display.definitions[display.parts[part] as number]?.bodies ?? []) {
    const m = b.mesh;
    for (let i = 0; i + 2 < m.edges.length; i += 3) {
      const first = m.edges[i] as number;
      const count = m.edges[i + 1] as number;
      const pts: number[][] = [];
      for (let s = first; s < first + count; s++)
        for (const j of [2 * s, 2 * s + 1])
          pts.push([m.segments[3 * j] as number, m.segments[3 * j + 1] as number, m.segments[3 * j + 2] as number]);
      const a = pts[0] as number[];
      const z = pts[pts.length - 1] as number[];
      const mid = [0, 1, 2].map((c) => ((a[c] as number) + (z[c] as number)) / 2);
      if (mid.every((v, c) => Math.abs(v - (near[c] as number)) <= tol)) return m.edges[i + 2] as number;
    }
  }
  throw new Error(`no edge near ${near.join(', ')}`);
}

function faceAt(
  display: Display,
  part: string,
  origin: [number, number, number],
  direction: [number, number, number],
): Key {
  const hit = raycast(display, display.parts[part] as number, origin, direction);
  if (!hit) throw new Error('no face there');
  return hit.key;
}

/** Builds and writes a feature as its panel's OK does. */
function commit(s: AppServices, target: FeatureTarget, type: string, built: Built): void {
  if (!built.ok) throw new Error(built.message);
  const r = writeFeature(s.editor, target, type, built);
  if (!r.ok) throw new Error(r.error.message);
}

async function picked(s: AppServices, target: FeatureTarget, key: Key): Promise<PickedRef> {
  const p = await pickFor(s, target, { key });
  if (!p) throw new Error('the pick was refused');
  return p;
}

const PLATE = 40 * 30 * 10;

describe('feature panels on the kernel', { timeout: 120_000 }, () => {
  it('revolves a profile about the part z axis and reads the form back', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    const sketch = sketchesOf(display, part)[1];
    const profile = await profileOf(s, part, (sketch?.regions[0] as { key: number }).key);
    const target = newTarget(s.editor, part, 'Revolve');
    const values = new ValueSlots(() => s.editor.newId('val'));
    const form = {
      ...newRevolveForm(true),
      profiles: profile ? [profile] : [],
      axis: { standard: 'z' as const },
      angle: '90',
      operation: 'new' as const,
    };
    expect(buildRevolve(s.editor.document, target, { ...form, axis: null }, values)).toMatchObject({
      ok: false,
      field: 'axis',
      quiet: true,
    });
    commit(s, target, 'core.revolve', buildRevolve(s.editor.document, target, form, values));
    expect(s.editor.store.undoLabel()).toBe('Add Revolve 1');
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    // A 4 × 6 section whose centre is 52 mm from the axis, a quarter turn.
    expect(volume(display, part)).toBeCloseTo(PLATE + 24 * 52 * (Math.PI / 2), 1);
    const back = readRevolve(
      s.editor.document,
      part,
      editTarget(s.editor.document, part, target.feature, 'core.revolve')?.base as Json,
    );
    expect(back).toMatchObject({ axis: { standard: 'z' }, extent: 'angle', angle: '90', operation: 'new' });
    expect(back.profiles).toHaveLength(1);
    s.dispose();
  });

  it('lofts profiles of two sketches in the order picked, edits it, and reads the form back', async () => {
    const { s } = await boot();
    const d = new DocBuilder();
    d.sketch('xy', (x) => x.rect(-5, -5, 10, 10));
    d.sketch('xy', (x) => x.circle(0, 0, 3), 10);
    s.editor.store.replace(d.document());
    let display = await settled(s);
    const docPart = ((s.editor.document.root as Json).part as Json).id as string;
    const keys = sketchesOf(display, docPart).map((x) => (x.regions[0] as { key: number }).key);
    const profiles = await Promise.all(keys.map((key) => profileOf(s, docPart, key)));
    const target = newTarget(s.editor, docPart, 'Loft');
    const values = new ValueSlots(() => s.editor.newId('val'));
    const empty = { ...newLoftForm(false), sections: [] };
    expect(buildLoft(s.editor.document, target, empty, values)).toMatchObject({
      ok: false,
      field: 'sections',
      quiet: true,
    });
    const sections = profiles.map((profile) => ({
      id: s.editor.newId('sec'),
      profile: profile as NonNullable<typeof profile>,
    }));
    const form = { ...empty, sections };
    expect(buildLoft(s.editor.document, target, { ...form, closed: true }, values)).toMatchObject({
      ok: false,
      field: 'sections',
    });
    commit(s, target, 'core.loft', buildLoft(s.editor.document, target, form, values));
    expect(s.editor.store.undoLabel()).toBe('Add Loft 1');
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, docPart)).toBeGreaterThan(0);

    const edit = editTarget(s.editor.document, docPart, target.feature, 'core.loft') as FeatureTarget;
    const back = readLoft(s.editor.document, docPart, edit.base as Json);
    expect(back).toMatchObject({ ruled: false, closed: false, operation: 'new' });
    expect(back.sections.map((x) => x.id)).toEqual(sections.map((x) => x.id));
    expect(sectionProfiles(back.sections).filter(isMissingProfile)).toEqual([]);
    const ruled = { ...back, ruled: true };
    commit(
      s,
      edit,
      'core.loft',
      buildLoft(s.editor.document, edit, ruled, new ValueSlots(() => s.editor.newId('val'), edit.base)),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(
      readLoft(
        s.editor.document,
        docPart,
        editTarget(s.editor.document, docPart, target.feature, 'core.loft')?.base as Json,
      ).ruled,
    ).toBe(true);
    s.dispose();
  });

  /** A section reference that names no region, as a profile to be reconnected is stored. */
  const lostProfiles = { set: [{ entity: { id: [], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } }] };

  /** Rewrites a feature's section `index` so its profile is lost. */
  function lose(s: AppServices, feature: string, index: number): void {
    const inputs = structuredClone(findFeature(s.editor.document, feature)?.inputs as Json);
    (((inputs.sections as Json[])[index] as Json).section as Json).profiles = lostProfiles;
    const done = s.editor.dispatch({ type: 'replaceInput', feature, pointer: '', with: inputs });
    if (!done.ok) throw new Error(done.error.message);
  }

  it('reconnects a lost loft section in its place, under its row', async () => {
    const { s } = await boot();
    const d = new DocBuilder();
    d.sketch('xy', (x) => x.rect(-5, -5, 10, 10));
    d.sketch('xy', (x) => x.rect(-3, -3, 6, 6), 5);
    d.sketch('xy', (x) => x.rect(-5, -5, 10, 10), 10);
    s.editor.store.replace(d.document());
    let display = await settled(s);
    const part = ((s.editor.document.root as Json).part as Json).id as string;
    const keys = sketchesOf(display, part).map((x) => (x.regions[0] as { key: number }).key);
    const profiles = await Promise.all(keys.map((key) => profileOf(s, part, key)));
    const target = newTarget(s.editor, part, 'Loft');
    const sections = profiles.map((profile) => ({
      id: s.editor.newId('sec'),
      profile: profile as NonNullable<typeof profile>,
    }));
    const form = { ...newLoftForm(false), ruled: true, sections };
    commit(
      s,
      target,
      'core.loft',
      buildLoft(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    const whole = volume(display, part);

    lose(s, target.feature, 1);
    display = await settled(s);
    expect(display.pauses.map((p) => p.message)).toEqual(['a profile is to be reconnected']);

    const edit = editTarget(s.editor.document, part, target.feature, 'core.loft') as FeatureTarget;
    const back = readLoft(s.editor.document, part, edit.base as Json);
    expect(back.sections.map((x) => x.id)).toEqual(sections.map((x) => x.id));
    expect(sectionProfiles(back.sections).map(isMissingProfile)).toEqual([false, true, false]);

    const clicked = await toggleProfile(s, part, sectionProfiles(back.sections), keys[1] as number, {
      anySketch: true,
    });
    if (!clicked || !('toggle' in clicked)) throw new Error('the click picked nothing');
    const next = withProfiles(back.sections, clicked.toggle(sectionProfiles(back.sections)), () =>
      s.editor.newId('sec'),
    );
    expect(next.map((x) => x.id)).toEqual(sections.map((x) => x.id));
    commit(
      s,
      edit,
      'core.loft',
      buildLoft(
        s.editor.document,
        edit,
        { ...back, sections: next },
        new ValueSlots(() => s.editor.newId('val'), edit.base),
      ),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(whole, 6);
    s.dispose();
  });

  it('lists a lost sweep profile as missing, and takes a clicked region in its place', async () => {
    const { s } = await boot();
    const d = new DocBuilder();
    d.sketch('xy', (x) => x.rect(-2, -2, 4, 4));
    d.sketch('xz', (x) => {
      x.line(x.point(0, 0), x.point(0, -20));
    });
    s.editor.store.replace(d.document());
    let display = await settled(s);
    const part = ((s.editor.document.root as Json).part as Json).id as string;
    const [section, drawn] = sketchesOf(display, part);
    const key = (section?.regions[0] as { key: number }).key;
    const profile = await profileOf(s, part, key);
    const target = newTarget(s.editor, part, 'Sweep');
    const path = (
      await Promise.all(
        connectedCurves(display, part, (drawn?.curves[0] as { key: number }).key).map((k) =>
          pickFor(s, target, { key: k }),
        ),
      )
    ).filter((p) => p !== null) as ChainPick[];
    const form = { ...newSweepForm(s.editor.newId('sec'), false), profiles: profile ? [profile] : [], path };
    commit(
      s,
      target,
      'core.sweep',
      buildSweep(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(volume(display, part)).toBeCloseTo(16 * 20, 3);

    lose(s, target.feature, 0);
    display = await settled(s);
    expect(display.pauses.map((p) => p.message)).toEqual(['a profile is to be reconnected']);

    const edit = editTarget(s.editor.document, part, target.feature, 'core.sweep') as FeatureTarget;
    const back = readSweep(s.editor.document, part, edit.base as Json);
    if (!back) throw new Error('the sweep does not read back');
    expect(back.profiles.every(isMissingProfile)).toBe(true);
    expect(profilesLabel(back.profiles, 'Sketch 1')).toBe('1 profile missing');

    const clicked = await toggleProfile(s, part, back.profiles, key);
    if (!clicked || !('toggle' in clicked)) throw new Error('the click picked nothing');
    const profiles = clicked.toggle(back.profiles);
    expect(profiles).toHaveLength(1);
    expect(profiles.some(isMissingProfile)).toBe(false);
    commit(
      s,
      edit,
      'core.sweep',
      buildSweep(
        s.editor.document,
        edit,
        { ...back, profiles },
        new ValueSlots(() => s.editor.newId('val'), edit.base),
      ),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(16 * 20, 3);
    s.dispose();
  });

  it('sweeps a profile along a drawn path taken in one click, and reads the form back', async () => {
    const { s } = await boot();
    const d = new DocBuilder();
    d.sketch('xy', (x) => x.rect(-2, -2, 4, 4));
    d.sketch('xz', (x) => {
      const [a, b, c] = [x.point(0, 0), x.point(0, -20), x.point(20, -20)];
      x.line(a, b);
      x.line(b, c);
    });
    s.editor.store.replace(d.document());
    let display = await settled(s);
    const part = ((s.editor.document.root as Json).part as Json).id as string;
    const [section, drawn] = sketchesOf(display, part);
    const profile = await profileOf(s, part, (section?.regions[0] as { key: number }).key);
    const target = newTarget(s.editor, part, 'Sweep');
    const curve = (drawn?.curves[1] as { key: number }).key;
    const chain = connectedCurves(display, part, curve);
    expect(chain).toHaveLength(2);
    const path = (await Promise.all(chain.map((key) => pickFor(s, target, { key })))).filter(
      (p) => p !== null,
    ) as ChainPick[];
    expect(path).toHaveLength(2);

    const values = new ValueSlots(() => s.editor.newId('val'));
    const form = { ...newSweepForm(s.editor.newId('sec'), false), profiles: profile ? [profile] : [] };
    expect(buildSweep(s.editor.document, target, form, values)).toMatchObject({
      ok: false,
      field: 'path',
      quiet: true,
    });
    commit(s, target, 'core.sweep', buildSweep(s.editor.document, target, { ...form, path }, values));
    expect(s.editor.store.undoLabel()).toBe('Add Sweep 1');
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(16 * 40, 3);

    const back = readSweep(
      s.editor.document,
      part,
      editTarget(s.editor.document, part, target.feature, 'core.sweep')?.base as Json,
    );
    expect(back).toMatchObject({ section: form.section, orientation: 'followPath', operation: 'new' });
    expect(back?.profiles).toHaveLength(1);
    expect(back?.path).toHaveLength(2);
    s.dispose();
  });

  it('fillets and chamfers edges, follows a tangent chain, picks on a preview, and edits in one step', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    // A box edge has no tangent neighbours.
    const vertical = edgeNear(display, part, [40, 30, 5]);
    expect(tangentChain(display, vertical)).toEqual([vertical]);

    const fillet = newTarget(s.editor, part, 'Fillet');
    const values = new ValueSlots(() => s.editor.newId('val'));
    const form = { ...newFilletForm(), targets: [await picked(s, fillet, vertical)], radius: '3' };
    const built = buildFillet(s.editor.document, fillet, form, values);
    commit(s, fillet, 'core.fillet', built);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const corner = (9 - (Math.PI * 9) / 4) * 10;
    expect(volume(display, part)).toBeCloseTo(PLATE - corner, 2);

    // The top edges each side of the rounded corner continue through its arc: one chain of three.
    const topFront = edgeNear(display, part, [18.5, 30, 10], 0.6);
    expect(tangentChain(display, topFront)).toHaveLength(3);
    // The rounded corner continues the two side faces it joins: one chain of three faces; the top face meets them at a crease.
    const round = faceAt(display, part, [45, 35, 5], [-Math.SQRT1_2, -Math.SQRT1_2, 0]);
    expect(new Set(tangentFaces(display, round)).size).toBe(3);
    expect(tangentFaces(display, faceAt(display, part, [20, 15, 50], [0, 0, -1]))).toHaveLength(1);

    // On a preview of a chamfer, an edge the chamfer leaves alone still picks against the state before it.
    const chamfer = newTarget(s.editor, part, 'Chamfer');
    const cValues = new ValueSlots(() => s.editor.newId('val'));
    const bottom = edgeNear(display, part, [20, 0, 0]);
    const cForm = { ...newChamferForm(), targets: [await picked(s, chamfer, bottom)], distance: '1' };
    const candidate = candidateFeature(
      s.editor.document,
      chamfer,
      'core.chamfer',
      buildChamfer(s.editor.document, chamfer, cForm, cValues) as Extract<Built, { ok: true }>,
      (kind) => s.editor.newId(kind),
    );
    if (!candidate.ok) throw new Error(candidate.message);
    s.scheduler.setPreview(candidate.doc);
    display = await settled(s);
    expect(s.display.getState().preview).toBe(true);
    const leftTop = edgeNear(display, part, [0, 15, 10]);
    const onPreview = await pickFor(s, chamfer, { key: leftTop });
    expect(onPreview).not.toBeNull();
    s.scheduler.setPreview(null);
    await settled(s);
    commit(
      s,
      chamfer,
      'core.chamfer',
      buildChamfer(
        s.editor.document,
        chamfer,
        { ...cForm, targets: [...cForm.targets, onPreview as PickedRef] },
        cValues,
      ),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(PLATE - corner - 0.5 * 40 - 0.5 * 30, 1);

    // Editing the fillet: the form reads back and a new radius is one "Edit" step.
    const edit = editTarget(s.editor.document, part, fillet.feature, 'core.fillet') as FeatureTarget;
    const read = readFillet(s.editor.document, part, edit.base as Json);
    expect(read).toMatchObject({ radius: '3' });
    commit(
      s,
      edit,
      'core.fillet',
      buildFillet(
        s.editor.document,
        edit,
        { ...(read as NonNullable<typeof read>), radius: '2' },
        new ValueSlots(() => s.editor.newId('val'), edit.base),
      ),
    );
    expect(s.editor.store.undoLabel()).toBe('Edit Fillet 1');
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(PLATE - (4 - Math.PI) * 10 - 0.5 * 40 - 0.5 * 30, 1);
    s.dispose();
  });

  it('drills holes at clicked positions, taps one from the thread table, and threads a bore', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    const top = faceAt(display, part, [10, 10, 50], [0, 0, -1]);
    const frame = await planarFrame(s, top);
    expect(frame && [...frame.origin, ...frame.normal].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([
      0, 0, 10, 0, 0, 1,
    ]);
    const hole = newTarget(s.editor, part, 'Hole');
    const values = new ValueSlots(() => s.editor.newId('val'));
    const face = await picked(s, hole, top);
    const form = {
      ...newHoleForm(),
      face,
      positions: [
        { id: s.editor.newId('hp'), x: '10', y: '10' },
        { id: s.editor.newId('hp'), x: '30', y: '10' },
      ],
      extent: 'throughAll' as const,
    };
    expect(buildHole(s.editor.document, hole, { ...form, positions: [] }, values)).toMatchObject({
      ok: false,
      quiet: true,
    });
    commit(s, hole, 'core.hole', buildHole(s.editor.document, hole, form, values));
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const bores = 2 * Math.PI * 2.5 * 2.5 * 10;
    expect(volume(display, part)).toBeCloseTo(PLATE - bores, 1);
    const back = readHole(
      s.editor.document,
      part,
      editTarget(s.editor.document, part, hole.feature, 'core.hole')?.base as Json,
    );
    expect(back?.positions.map((p) => [p.x, p.y])).toEqual([
      ['10', '10'],
      ['30', '10'],
    ]);

    // A tapped M6 hole is drilled at its tap drill, 5 mm, and blind with a drill point.
    const tapped = newTarget(s.editor, part, 'Hole');
    const top2 = faceAt(display, part, [20, 25, 50], [0, 0, -1]);
    const tForm = {
      ...newHoleForm(),
      face: await picked(s, tapped, top2),
      positions: [{ id: s.editor.newId('hp'), x: '20', y: '25' }],
      threaded: true,
      designation: 'M6',
      depth: '6',
      tip: 'angle' as const,
    };
    commit(
      s,
      tapped,
      'core.hole',
      buildHole(s.editor.document, tapped, tForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);

    // A cosmetic thread on a 5 mm bore: the thread table takes it as an M6 bore.
    expect(sizeForDiameter(5, true)).toEqual({ designation: 'M6', threadClass: '6H' });
    expect(sizeForDiameter(5, false)).toEqual({ designation: 'M5', threadClass: '6g' });
    const bore = faceAt(display, part, [10, 10, 5], [0, 1, 0]);
    const axis = (await s.client.properties(bore))?.measures.axis as number[];
    expect(isBore(display, bore, 2.5, axis)).toBe(true);
    const thread = newTarget(s.editor, part, 'Thread');
    const before = volume(display, part);
    commit(
      s,
      thread,
      'core.thread',
      buildThread(
        s.editor.document,
        thread,
        { ...newThreadForm(), face: await picked(s, thread, bore), designation: 'M6', threadClass: '6H' },
        new ValueSlots(() => s.editor.newId('val')),
      ),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(before, 6);

    // The same thread, modelled: read back from the document, the groove comes out of the body.
    const read = readThread(s.editor.document, part, findFeature(s.editor.document, thread.feature)?.inputs as Json);
    expect(read.modelled).toBe(false);
    const edit = { ...thread, base: findFeature(s.editor.document, thread.feature)?.inputs as Json };
    const built = buildThread(
      s.editor.document,
      edit,
      { ...read, modelled: true },
      new ValueSlots(() => s.editor.newId('val')),
    );
    if (!built.ok) throw new Error(built.message);
    expect(
      s.editor.dispatch({
        type: 'replaceInput',
        feature: thread.feature,
        pointer: '',
        with: built.inputs,
        names: built.names,
      }).ok,
    ).toBe(true);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeLessThan(before - 1);
    s.dispose();
  });

  it('shells, patterns, mirrors, moves, combines and removes bodies, and adds primitives', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    const bodyOf = async (target: FeatureTarget, at: [number, number, number], dir: [number, number, number]) => {
      const p = await pickBody(s, target, { key: faceAt(display, part, at, dir) });
      if (!p) throw new Error('no body there');
      return p;
    };

    // A box beside the plate, 10 mm on a side, centred at (60, 15, 5).
    const box = newTarget(s.editor, part, 'Primitive');
    const boxForm = {
      ...newPrimitiveForm('box'),
      dims: { width: '10', depth: '10', height: '10' },
      x: '60',
      y: '15',
      z: '5',
      operation: 'new' as const,
    };
    commit(
      s,
      box,
      'core.primitive',
      buildPrimitive(s.editor.document, box, boxForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(PLATE + 1000, 3);
    expect(
      readPrimitive(
        s.editor.document,
        part,
        editTarget(s.editor.document, part, box.feature, 'core.primitive')?.base as Json,
      ),
    ).toMatchObject({ shape: 'box', x: '60', y: '15', z: '5' });

    // Three copies of the box along x, 15 mm apart, as new bodies.
    const pattern = newTarget(s.editor, part, 'Pattern');
    const pForm: PatternForm = { ...newPatternForm(), items: [await bodyOf(pattern, [60, 15, 50], [0, 0, -1])] };
    pForm.directions = [{ axis: { standard: 'x' }, reversed: false, count: '3', spacing: '15' }];
    commit(
      s,
      pattern,
      'core.pattern',
      buildPattern(s.editor.document, pattern, pForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(PLATE + 3000, 3);
    expect(
      readPattern(
        s.editor.document,
        part,
        editTarget(s.editor.document, part, pattern.feature, 'core.pattern')?.base as Json,
      ),
    ).toMatchObject({ layout: 'linear', directions: [{ axis: { standard: 'x' }, count: '3', spacing: '15' }] });

    // The plate mirrored in YZ, as a new body.
    const mirror = newTarget(s.editor, part, 'Mirror');
    const mForm = {
      ...newMirrorForm(),
      operation: 'new' as const,
      items: [await bodyOf(mirror, [20, 15, 50], [0, 0, -1])],
      plane: { reference: { standard: { name: 'yz' } }, names: {}, label: 'YZ plane' },
    };
    commit(
      s,
      mirror,
      'core.mirror',
      buildMirror(s.editor.document, mirror, mForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(2 * PLATE + 3000, 3);

    // The mirrored plate moves up 20 mm and turns a quarter about z.
    const move = newTarget(s.editor, part, 'Move');
    const moveForm = {
      ...newMoveForm(),
      bodies: [await bodyOf(move, [-20, 15, 50], [0, 0, -1])],
      z: '20',
      angle: '90',
    };
    commit(
      s,
      move,
      'core.move',
      buildMove(s.editor.document, move, moveForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(
      readMove(s.editor.document, part, editTarget(s.editor.document, part, move.feature, 'core.move')?.base as Json),
    ).toMatchObject({ x: '0', y: '0', z: '20', angle: '90', axis: ['0', '0', '1'] });
    // Turned about z, the mirrored plate (x -40..0, y 0..30) lies at x -30..0, y -40..0, from z 20 to 30.
    expect(faceAt(display, part, [-15, -20, 80], [0, 0, -1])).toBeGreaterThanOrEqual(0);

    // A taller box overlapping the plate's right edge cuts it.
    const cutter = newTarget(s.editor, part, 'Primitive');
    commit(
      s,
      cutter,
      'core.primitive',
      buildPrimitive(
        s.editor.document,
        cutter,
        {
          ...newPrimitiveForm('box'),
          dims: { width: '10', depth: '10', height: '20' },
          x: '40',
          y: '15',
          z: '5',
          operation: 'new',
        },
        new ValueSlots(() => s.editor.newId('val')),
      ),
    );
    display = await settled(s);
    const before = volume(display, part);
    const cut = newTarget(s.editor, part, 'Combine');
    const bForm = {
      ...newBooleanForm('cut'),
      target: await bodyOf(cut, [20, 15, 50], [0, 0, -1]),
      tools: [await bodyOf(cut, [40, 15, 50], [0, 0, -1])],
    };
    commit(
      s,
      cut,
      'core.boolean',
      buildBoolean(s.editor.document, cut, bForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    // The tool (2000) is consumed and the plate loses the 5 × 10 × 10 it shared with it.
    expect(volume(display, part)).toBeCloseTo(before - 2000 - 500, 3);

    // The plate is shelled 1 mm inward with its top open.
    const shell = newTarget(s.editor, part, 'Shell');
    const topFace = faceAt(display, part, [10, 10, 50], [0, 0, -1]);
    const sForm = {
      ...newShellForm(),
      faces: [await picked(s, shell, topFace)],
      bodies: [await bodyOf(shell, [10, 10, 50], [0, 0, -1])],
      thickness: '1',
    };
    commit(
      s,
      shell,
      'core.shell',
      buildShell(s.editor.document, shell, sForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);

    // The three box copies are removed.
    const remove = newTarget(s.editor, part, 'Remove');
    const copies = [
      await bodyOf(remove, [60, 15, 50], [0, 0, -1]),
      await bodyOf(remove, [75, 15, 50], [0, 0, -1]),
      await bodyOf(remove, [90, 15, 50], [0, 0, -1]),
    ];
    const shown = display.definitions[display.parts[part] as number]?.bodies.length ?? 0;
    commit(s, remove, 'core.removeBody', buildRemoveBody(s.editor.document, remove, { bodies: copies }));
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(display.definitions[display.parts[part] as number]?.bodies.length).toBe(shown - 3);
    s.dispose();
  });

  it('turns the gizmo pose into the move fields and back', () => {
    const centre = new THREE.Vector3(10, 0, 0);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const fields = fieldsFor(centre, new THREE.Vector3(0, 10, 5), q);
    expect(fields).toEqual({ x: '0', y: '0', z: '5', axis: ['0', '0', '1'], angle: '90' });
    const back = transformOf({ ...newMoveForm(), ...fields });
    expect(
      back &&
        centre
          .clone()
          .applyQuaternion(back.q)
          .add(back.t)
          .toArray()
          .map((v) => Math.round(v * 1e6) / 1e6 + 0),
    ).toEqual([0, 10, 5]);
    expect(readPlacement('placement(vector(1 mm, d1 * 2, 0 mm), rotate(vector(0, 1, 0), 30 deg))')).toEqual({
      x: '1',
      y: 'd1 * 2',
      z: '0',
      axis: ['0', '1', '0'],
      angle: '30',
    });
  });

  it('makes construction planes, axes, points and frames, and keeps measures as named values', async () => {
    const { s, part } = await boot();
    let display: Display;
    const add = (kind: 'plane' | 'axis' | 'point' | 'frame', form: ReturnType<typeof newConstructionForm>) => {
      const target = newTarget(s.editor, part, kind);
      commit(
        s,
        target,
        `core.construction${kind[0]?.toUpperCase()}${kind.slice(1)}`,
        buildConstruction(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val'))),
      );
      return target.feature;
    };
    const xy = { reference: { standard: { name: 'xy' } }, names: {}, label: 'XY plane' };
    const origin = { reference: { standard: { name: 'origin' } }, names: {}, label: 'Origin' };
    const offset = add('plane', { ...newConstructionForm('plane'), supports: [xy], offset: '5' });
    display = await settled(s);
    const top = faceAt(display, part, [10, 10, 50], [0, 0, -1]);
    const onTop = newTarget(s.editor, part, 'Plane');
    commit(
      s,
      onTop,
      'core.constructionPlane',
      buildConstruction(
        s.editor.document,
        onTop,
        { ...newConstructionForm('plane'), supports: [await picked(s, onTop, top)], offset: '2' },
        new ValueSlots(() => s.editor.newId('val')),
      ),
    );
    const axis = add('axis', { ...withMode(newConstructionForm('axis'), 'planeAtPoint'), supports: [xy, origin] });
    const point = add('point', { ...newConstructionForm('point'), x: '1', y: '2', z: '3' });
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const outputs = display.definitions[display.parts[part] as number]?.construction ?? [];
    const frameOf = (feature: string) => outputs.find((c) => c.feature === feature)?.frame;
    expect(frameOf(offset)?.origin[2]).toBeCloseTo(5, 9);
    expect(frameOf(onTop.feature)?.origin[2]).toBeCloseTo(12, 9);
    expect(frameOf(axis)?.normal).toEqual([0, 0, 1]);
    expect(frameOf(point)?.origin.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 2, 3]);
    const pointRef = { reference: { object: { feature: { id: point } } }, names: {}, label: 'Point' };
    const frame = add('frame', {
      ...newConstructionForm('frame'),
      supports: [origin, pointRef, { ...xy, reference: { standard: { name: 'origin' } } }],
    });
    display = await settled(s);
    // Three points with two the same are collinear: that frame pauses, with the evaluator's reason.
    expect(display.pauses.map((p) => p.feature)).toEqual([frame]);
    const read = readConstruction('plane')(
      s.editor.document,
      part,
      editTarget(s.editor.document, part, offset, 'core.constructionPlane')?.base as Json,
    );
    expect(read).toMatchObject({ mode: 'plane', offset: '5', angle: '0', flip: false });
    s.editor.undo();
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const shownTop = faceAt(display, part, [10, 10, 50], [0, 0, -1]);

    // The top face's area, read as the measure panel reads it, then kept as m1; a second reading goes into the same feature.
    expect(measuresFor(['face'])).toEqual(['area', 'radius']);
    const area = await s.client.measure('area', [shownTop]);
    expect('value' in area && area.value).toBeCloseTo(1200, 6);
    const topRef = await s.pick({ key: shownTop });
    if (!topRef || 'region' in topRef) throw new Error('no face');
    const first = keepMeasure(s.editor, part, 'area', [topRef]);
    expect(first.result.ok && first.name).toBe('m1');
    display = await settled(s);
    const edge = edgeNear(display, part, [20, 0, 10]);
    const edgeRef = await s.pick({ key: edge });
    if (!edgeRef || 'region' in edgeRef) throw new Error('no edge');
    const second = keepMeasure(s.editor, part, 'length', [edgeRef]);
    expect(second.name).toBe('m2');
    const measures = (s.editor.document.parts as Json[])[0]!.timeline as Json[];
    const measure = measures.filter((f) => f.type === 'core.measure');
    expect(measure).toHaveLength(1);
    expect(measuredValues(s.editor.document, measure[0]!.id as string).map((v) => [v.name, v.kind])).toEqual([
      ['m1', 'area'],
      ['m2', 'length'],
    ]);
    // A later expression may use them.
    const later = bindExpression(s.editor.document, { part, feature: measure[0]!.id as string }, 'm2 / 2', {
      type: 'number',
      quantity: 'length',
    });
    expect(later).toMatchObject({ ok: true, stored: null });
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    s.dispose();
  });

  it('makes axes along an edge and through two points, a point at a point, and a plane normal to an axis', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    const add = (kind: 'plane' | 'axis' | 'point', form: ReturnType<typeof newConstructionForm>) => {
      const target = newTarget(s.editor, part, kind);
      commit(
        s,
        target,
        `core.construction${kind[0]?.toUpperCase()}${kind.slice(1)}`,
        buildConstruction(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val'))),
      );
      return target.feature;
    };
    // The plate's vertical edge at x = 40, y = 30, picked as the panel picks it.
    const edgeTarget = newTarget(s.editor, part, 'Axis');
    const edge = await picked(s, edgeTarget, edgeNear(display, part, [40, 30, 5]));
    const axisForm = newConstructionForm('axis');
    expect(axisForm.mode).toBe('alongLine');
    expect(
      buildConstruction(s.editor.document, edgeTarget, axisForm, new ValueSlots(() => s.editor.newId('val'))),
    ).toMatchObject({ ok: false, message: 'Pick a straight edge, line or axis' });
    commit(
      s,
      edgeTarget,
      'core.constructionAxis',
      buildConstruction(
        s.editor.document,
        edgeTarget,
        { ...axisForm, supports: [edge] },
        new ValueSlots(() => s.editor.newId('val')),
      ),
    );
    const origin = { reference: { standard: { name: 'origin' } }, names: {}, label: 'Origin' };
    const far = add('point', { ...newConstructionForm('point'), x: '3', y: '4', z: '12' });
    const farRef = { reference: { object: { feature: { id: far } } }, names: {}, label: 'Point' };
    const through = add('axis', { ...withMode(newConstructionForm('axis'), 'twoPoints'), supports: [origin, farRef] });
    const at = add('point', { ...withMode(newConstructionForm('point'), 'point'), supports: [farRef] });
    const xAxis = { reference: { standard: { name: 'x' } }, names: {}, label: 'X axis' };
    const normal = add('plane', {
      ...withMode(newConstructionForm('plane'), 'alongLine'),
      supports: [xAxis],
      offset: '7',
    });
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const outputs = display.definitions[display.parts[part] as number]?.construction ?? [];
    const frameOf = (feature: string) => outputs.find((c) => c.feature === feature)?.frame;
    const round = (v: readonly number[] | undefined) => v?.map((x) => Math.round(x * 1e9) / 1e9 + 0);
    const alongEdge = frameOf(edgeTarget.feature);
    expect(round(alongEdge?.origin)?.slice(0, 2)).toEqual([40, 30]);
    expect(Math.abs(alongEdge?.normal[2] ?? 0)).toBeCloseTo(1, 9);
    expect(frameOf(through)?.normal).toEqual([3, 4, 12].map((v) => expect.closeTo(v / 13, 9)));
    expect(round(frameOf(at)?.origin)).toEqual([3, 4, 12]);
    expect(round(frameOf(normal)?.origin)).toEqual([7, 0, 0]);
    expect(round(frameOf(normal)?.normal)).toEqual([1, 0, 0]);
    const read = readConstruction('plane')(
      s.editor.document,
      part,
      editTarget(s.editor.document, part, normal, 'core.constructionPlane')?.base as Json,
    );
    expect(read).toMatchObject({ mode: 'alongLine', offset: '7', supports: [{ label: 'X axis' }] });
    s.dispose();
  });

  it('cuts only the target bodies picked, in extrude and primitive, and reads them back', async () => {
    // A plate 0..40 × 0..30 × 0..10, a box 50..70 × 0..30 × 0..10 beside it, and a strip 30..60 × 10..20 on XY across both.
    const d = new DocBuilder();
    const plate = d.sketch('xy', (x) => x.rect(0, 0, 40, 30));
    d.extrude({ sketch: plate.feature, profiles: [plate.region([1, 1])], sides: [{ distance: '10 mm' }] });
    const box = d.sketch('xy', (x) => x.rect(50, 0, 20, 30));
    d.extrude({ sketch: box.feature, profiles: [box.region([51, 1])], sides: [{ distance: '10 mm' }], op: 'new' });
    const strip = d.sketch('xy', (x) => x.rect(30, 10, 30, 10));
    const { services: s } = await bootApp({
      client: inThreadClient(service),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(22),
      name: () => 'targets',
    });
    s.editor.store.replace(d.document());
    let display = await settled(s);
    const part = ((s.editor.document.root as Json).part as Json).id as string;
    const BOTH = 40 * 30 * 10 + 20 * 30 * 10;
    expect(volume(display, part)).toBeCloseTo(BOTH, 3);
    const boxBody = async (target: FeatureTarget) => {
      const p = await pickBody(s, target, { key: faceAt(display, part, [65, 5, 50], [0, 0, -1]) });
      if (!p) throw new Error('no body there');
      return p;
    };

    // The strip cut through all, with only the box as its target: the plate keeps its 10 × 10 × 10.
    const strips = sketchesOf(display, part).find((k) => k.feature === strip.feature);
    const profile = await profileOf(s, part, (strips?.regions[0] as { key: number }).key);
    if (!profile) throw new Error('no profile');
    const cut = newTarget(s.editor, part, 'Extrude');
    const values = new ValueSlots(() => s.editor.newId('val'));
    const form: ExtrudeForm = {
      extent: 'throughAll',
      distance: '10',
      reversed: false,
      operation: 'cut',
      face: null,
      targets: [await boxBody(cut)],
    };
    const built = buildExtrude(s.editor.document, cut, form, [profile], values);
    if (!built.ok) throw new Error(built.message);
    expect(at(built.inputs, 'operation', 'targets', 'bodies', 'set')).toHaveLength(1);
    commit(s, cut, 'core.extrude', built as Built);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(BOTH - 1000, 3);
    expect(readExtrude(s.editor.document, part, cut.feature)?.form.targets).toHaveLength(1);
    // With no target picked, the cut acts on every body.
    s.editor.undo();
    display = await settled(s);
    const all = newTarget(s.editor, part, 'Extrude');
    commit(
      s,
      all,
      'core.extrude',
      buildExtrude(
        s.editor.document,
        all,
        { ...form, targets: [] },
        [profile],
        new ValueSlots(() => s.editor.newId('val')),
      ) as Built,
    );
    display = await settled(s);
    expect(volume(display, part)).toBeCloseTo(BOTH - 2000, 3);
    expect(readExtrude(s.editor.document, part, all.feature)?.form.targets).toEqual([]);
    s.editor.undo();
    display = await settled(s);

    // A box primitive across both, cut from the box only.
    const prim = newTarget(s.editor, part, 'Primitive');
    const primForm = {
      ...newPrimitiveForm('box'),
      dims: { width: '30', depth: '10', height: '30' },
      x: '45',
      y: '15',
      z: '5',
      operation: 'cut' as const,
      targets: [await boxBody(prim)],
    };
    commit(
      s,
      prim,
      'core.primitive',
      buildPrimitive(s.editor.document, prim, primForm, new ValueSlots(() => s.editor.newId('val'))),
    );
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(volume(display, part)).toBeCloseTo(BOTH - 1000, 3);
    expect(
      readPrimitive(
        s.editor.document,
        part,
        editTarget(s.editor.document, part, prim.feature, 'core.primitive')?.base as Json,
      )?.targets,
    ).toHaveLength(1);
    // A new body takes no targets, whatever the form holds.
    const fresh = buildPrimitive(
      s.editor.document,
      prim,
      { ...primForm, operation: 'new' },
      new ValueSlots(() => s.editor.newId('val')),
    );
    expect(fresh.ok && at(fresh.inputs, 'operation', 'targets')).toEqual({ all: {} });
    s.dispose();
  });

  it('builds a revolve whose cut names its target bodies', async () => {
    const { s, part } = await boot();
    // A box 10 on a side centred at (52, 2, 3), in the way of the profile turning about z (the plate is not).
    const box = newTarget(s.editor, part, 'Primitive');
    commit(
      s,
      box,
      'core.primitive',
      buildPrimitive(
        s.editor.document,
        box,
        {
          ...newPrimitiveForm('box'),
          dims: { width: '10', depth: '10', height: '10' },
          x: '52',
          y: '2',
          z: '3',
          operation: 'new',
        },
        new ValueSlots(() => s.editor.newId('val')),
      ),
    );
    const display = await settled(s);
    const sketch = sketchesOf(display, part)[1];
    const profile = await profileOf(s, part, (sketch?.regions[0] as { key: number }).key);
    const target = newTarget(s.editor, part, 'Revolve');
    const body = await pickBody(s, target, { key: faceAt(display, part, [52, 2, 50], [0, 0, -1]) });
    if (!body || !profile) throw new Error('no pick');
    const form = {
      ...newRevolveForm(true),
      profiles: [profile],
      axis: { standard: 'z' as const },
      angle: '90',
      operation: 'cut' as const,
      targets: [body],
    };
    const built = buildRevolve(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    commit(s, target, 'core.revolve', built);
    const after = await settled(s);
    expect(after.pauses).toEqual([]);
    expect(volume(after, part)).toBeLessThan(PLATE + 1000);
    expect(
      readRevolve(
        s.editor.document,
        part,
        editTarget(s.editor.document, part, target.feature, 'core.revolve')?.base as Json,
      ).targets,
    ).toHaveLength(1);
    s.dispose();
  });

  it('places an imported body at the origin and on the XY plane, each as one Move step', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    // A box 10 on a side centred at (60, 15, 25), standing in for an import far from the origin.
    const box = newTarget(s.editor, part, 'Primitive');
    commit(
      s,
      box,
      'core.primitive',
      buildPrimitive(
        s.editor.document,
        box,
        {
          ...newPrimitiveForm('box'),
          dims: { width: '10', depth: '10', height: '10' },
          x: '60',
          y: '15',
          z: '25',
          operation: 'new',
        },
        new ValueSlots(() => s.editor.newId('val')),
      ),
    );
    display = await settled(s);
    const key = () => display.entities[faceAt(display, part, [60, 15, 100], [0, 0, -1])]?.body as number;
    const found = importBodies(display, part, key());
    expect(found?.keys).toHaveLength(1);
    expect(placementDelta(found!.box, 'origin')).toEqual([-60, -15, -25]);
    expect(placementDelta(found!.box, 'xy')).toEqual([0, 0, -20]);

    expect(await placeImported(s, part, key(), 'xy')).toEqual({ ok: true });
    expect(s.editor.store.undoLabel()).toBe('Add Move 1');
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const dropped = importBodies(
      display,
      part,
      display.entities[faceAt(display, part, [60, 15, 100], [0, 0, -1])]?.body as number,
    )!.box;
    expect(dropped.min[2]).toBeCloseTo(0, 6);
    expect(dropped.min[0]).toBeCloseTo(55, 6);

    expect(
      await placeImported(
        s,
        part,
        display.entities[faceAt(display, part, [60, 15, 100], [0, 0, -1])]?.body as number,
        'origin',
      ),
    ).toEqual({ ok: true });
    display = await settled(s);
    const centred = importBodies(
      display,
      part,
      display.entities[faceAt(display, part, [-2, -2, 100], [0, 0, -1])]?.body as number,
    )!.box;
    expect(centred.min.map((v) => Math.round(v * 1000) / 1000)).toEqual([-5, -5, -5]);
    // Placed again where it is, nothing is written.
    const steps = s.editor.store.undoLabel();
    expect(
      await placeImported(
        s,
        part,
        display.entities[faceAt(display, part, [-2, -2, 100], [0, 0, -1])]?.body as number,
        'origin',
      ),
    ).toEqual({ ok: true });
    expect(s.editor.store.undoLabel()).toBe(steps);
    s.dispose();
  });

  it('colours and hides a body through one attribute, found again from a later pick', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    const bodyAt = async () => {
      const key = display.entities[faceAt(display, part, [10, 10, 50], [0, 0, -1])]?.body as number;
      const picked = await s.pick({ key });
      if (!picked || 'region' in picked) throw new Error('no body');
      return { key, target: { reference: picked.reference, names: picked.names } };
    };
    const attributes = () => ((s.editor.document.parts as Json[])[0]!.attributes as Json[]).length;
    const shownBody = () => display.definitions[display.parts[part] as number]!.bodies[0]!;

    ok(setColor(s.editor, part, (await bodyAt()).target, '#E53935'));
    display = await settled(s);
    expect(shownBody().color).toBe('#e53935');
    const shown = (await bodyAt()).target;
    ok(setVisible(s.editor, part, shown, false));
    display = await settled(s);
    expect(attributes()).toBe(1);
    expect(shownBody().visible).toBe(false);
    // Hidden, it is not drawn to pick again: shown through the target picked before.
    ok(setVisible(s.editor, part, shown, true));
    display = await settled(s);
    expect(shownBody().visible).toBe(true);
    ok(setColor(s.editor, part, (await bodyAt()).target, null));
    display = await settled(s);
    expect(attributes()).toBe(0);
    expect(shownBody().color).toBe('#6699cc');
    s.dispose();
  });

  it('names a body through its attribute, and gives it its numbered name again when the name is cleared', async () => {
    const { s, part } = await boot();
    let display = await settled(s);
    const target = async () => {
      const key = display.entities[faceAt(display, part, [10, 10, 50], [0, 0, -1])]?.body as number;
      const picked = await s.pick({ key });
      if (!picked || 'region' in picked) throw new Error('no body');
      return { reference: picked.reference, names: picked.names };
    };
    const shownName = () => display.definitions[display.parts[part] as number]!.bodies[0]!.name;
    const numbered = shownName();
    expect(numbered).toMatch(/^Body \d+$/);

    ok(setName(s.editor, part, await target(), '  Base plate '));
    display = await settled(s);
    expect(shownName()).toBe('Base plate');
    ok(setName(s.editor, part, await target(), ''));
    display = await settled(s);
    expect(shownName()).toBe(numbered);
    expect(((s.editor.document.parts as Json[])[0]!.attributes as Json[]).length).toBe(0);
    s.dispose();
  });
});

function ok(r: { ok: boolean; error?: { message: string } }): void {
  if (!r.ok) throw new Error(r.error?.message);
}

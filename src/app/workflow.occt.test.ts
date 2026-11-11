/**
 * The modelling workflow end to end, headless, as the app runs it: the app's
 * services over a real editor and a real evaluation service on the kernel,
 * sketches edited through sketch sessions on real planegcs, extrudes written
 * as the extrude panel writes them. Each step is judged by the geometry the
 * evaluation shows.
 *
 * A 40 × 20 rectangle on XY is extruded 10 mm; its top face (y = 20, a side
 * face of that extrude) takes a second sketch with a circle, extruded 5 mm
 * and joined. Changing the rectangle's height moves the top face, and the
 * second sketch, attached to it by name, moves with it.
 *
 * An extrude started on a face: a boss sketched on the plate's own plane
 * starts on the plate's top face and follows it when the plate gets thicker.
 *
 * The everyday edits, as the feature panels write them: a fillet on an
 * edge, a hole inserted before it at the rollback marker, and a
 * configuration that changes the parameter the sketch's width reads; the
 * fillet stays on its edge through each.
 *
 * An assembly edit, as the assembly tools make it: the part becomes an
 * assembly, a new part is modelled in place in it, hinged on the first by
 * a joint picked on their faces, and turned; undo and redo; save and load.
 *
 * A component pattern, as its panel writes it: the part's instance copied
 * three times along X; the pattern edited to two directions; the part
 * widened, and every copy with it.
 *
 * A frozen feature: a block joined on a plate is frozen; the plate widens
 * and the frozen block keeps the body it stored, shown as waiting on the
 * change; unfrozen, it builds on the wider plate.
 */
import { unzipSync } from 'fflate';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, loadDocument, saveDocument, seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { raycast } from '@tweakcad/worker/src/v2/service/testKit';
import type { Display, FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { SketchSession, type SketchPointer } from '../sketcher';
import { loadFont } from '../sketcher/text';
import {
  buildExtrude,
  readExtrude,
  ValueSlots,
  writeExtrude,
  type ExtrudeForm,
  type ExtrudeProfile,
} from './modeling/extrude';
import { profileOf, sketchesOf } from './modeling/profiles';
import { addSketch } from './modeling/sketch';
import type { LocateClient } from '@tweakcad/fcstd-import';
import { importFreeCad } from './io/freecad';
import { importGeometry, type GeometryClient } from './io/geometry';
import { bootApp, type AppServiceClient, type AppServices } from './services';
import { MemoryWorkingCopy } from './storage/workingCopy';
import { bodiesOf, partView } from './features';
import { runAgentTurn, type ChatTurnEvent } from '../ai/agentTurn';
import type { ChatStreamEvent, NormalizedMessage } from '../ai/chatClient';
import { createAiContext } from '../ai/context';
import { buildFillet, newFilletForm } from './modeling/blends';
import { newTarget, ValueSlots, writeFeature } from './modeling/feature';
import { buildHole, newHoleForm } from './modeling/hole';
import { pickFor } from './modeling/picks';
import { newAssembly, newPart, finishInPlace } from './assembly/commands';
import { commitSolved } from './assembly/commit';
import { activePartOf } from './assembly/focus';
import { jointCommands, jointEnd, newJointForm } from './assembly/joints';
import { activePart } from './modeling/commands';
import {
  assemblyFeatureOf,
  buildAsmPattern,
  copiesOf,
  newAsmDirection,
  newAsmPatternForm,
  readAsmPattern,
} from './assembly/asmFeatures';
import { freezeFeature, unfreezeFeature } from './modeling/freeze';
import { buildPrimitive, newPrimitiveForm } from './modeling/primitive';
import {
  addConfiguration,
  addConfigurationRow,
  addParameter,
  configurationsOf,
  parametersOf,
  setActiveConfiguration,
  setConfigurationOverride,
} from './parameters';

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [2, 3, 4]
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

/** The service as the app's client, in this thread, with the importers' calls. */
function client(): AppServiceClient & GeometryClient & LocateClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc, options) => Promise.resolve(service.evaluate(doc as Json, options)),
    pick: (target, options) => Promise.resolve(service.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(service.exportFile(format, scope, options)),
    exportFreeCad: () => Promise.resolve(service.exportFreeCad()),
    properties: (key) => Promise.resolve(service.properties(key)),
    importFile: (bytes, format, name) => Promise.resolve(service.importFile(bytes, format, name)),
    locate: (part, before, brep, kind, indices, ofFaces) =>
      Promise.resolve(service.locate(part, before, brep, kind, indices, ofFaces)),
    bodyRecords: (part, before) => Promise.resolve(service.bodyRecords(part, before)),
    shapeMeasures: (brep) => Promise.resolve(service.shapeMeasures(brep)),
    stepMeasures: (part, feature) => Promise.resolve(service.stepMeasures(part, feature)),
    externalCurves: (key, mode, frame) => Promise.resolve(service.externalCurves(key, mode, frame)),
    measure: (kind, targets) => Promise.resolve(service.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(service.resolve(record, scope)),
    neighbours: (key) => Promise.resolve(service.neighbours(key)),
    updateContexts: (doc, requests, options) => Promise.resolve(service.updateContexts(doc as Json, requests, options)),
    freeze: (doc, feature) => Promise.resolve(service.freeze(doc as Json, feature)),
  };
}

async function settled(s: AppServices): Promise<Display> {
  do await s.scheduler.whenIdle();
  while (s.scheduler.busy);
  const display = s.display.getState().display;
  if (!display) throw new Error('nothing shown');
  return display;
}

function partOf(s: AppServices): string {
  return ((s.editor.document.root as Json).part as Json).id as string;
}

/** A session on a sketch of the shown display, with pointer helpers in sketch coordinates. */
function open(s: AppServices, part: string, feature: string) {
  const frame = sketchesOf(s.display.getState().display, part).find((x) => x.feature === feature)
    ?.frame as FrameDisplay;
  expect(frame).toBeDefined();
  const session = new SketchSession(
    { editor: s.editor, part, feature, frame, group: new THREE.Group(), requestRender: () => undefined },
    gcs,
  );
  const event = (type: SketchPointer['type'], u: number, v: number): SketchPointer => ({
    type,
    uv: [u, v],
    pixel: 0.05,
    button: 0,
    shift: false,
    ctrl: false,
    alt: false,
  });
  const click = (u: number, v: number) => {
    session.pointer(event('down', u, v));
    session.pointer(event('up', u, v));
  };
  return { session, frame, click };
}

const sketchInputsOf = (s: AppServices, part: string, sketch: string) => {
  const timeline = ((s.editor.document.parts as Json[]).find((p) => p.id === part) as Json).timeline as Json[];
  return (timeline.find((f) => f.id === sketch) as Json).inputs as Json;
};

const constraints = (s: AppServices, part: string, sketch: string) => {
  const timeline = ((s.editor.document.parts as Json[]).find((p) => p.id === part) as Json).timeline as Json[];
  return ((timeline.find((f) => f.id === sketch) as Json).inputs as Json).constraints as Json[];
};

/** The shown bodies: count, total volume and bounds. */
function bodies(display: Display, part: string) {
  const definition = display.definitions[display.parts[part] as number];
  const box = new THREE.Box3();
  let volume = 0;
  for (const b of definition?.bodies ?? []) {
    const m = service.measure('volume', [b.key]);
    if ('value' in m) volume += m.value;
    const p = b.mesh.positions;
    for (let i = 0; i < p.length; i += 3) box.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
  }
  return { count: definition?.bodies.length ?? 0, volume, min: box.min.toArray(), max: box.max.toArray() };
}

const close = (a: readonly number[], b: readonly number[], tol = 1e-3) =>
  a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol);

/** The drawn edge of the part whose polyline runs between `a` and `b`, either way round. */
function edgeBetween(display: Display, part: string, a: readonly number[], b: readonly number[]): number {
  for (const body of display.definitions[display.parts[part] as number]?.bodies ?? []) {
    const m = body.mesh;
    for (let i = 0; i + 2 < m.edges.length; i += 3) {
      const first = m.edges[i] as number;
      const last = first + (m.edges[i + 1] as number) - 1;
      const p = (j: number) => [
        m.segments[3 * j] as number,
        m.segments[3 * j + 1] as number,
        m.segments[3 * j + 2] as number,
      ];
      const [s0, s1] = [p(2 * first), p(2 * last + 1)];
      if ((close(s0, a, 1e-2) && close(s1, b, 1e-2)) || (close(s0, b, 1e-2) && close(s1, a, 1e-2)))
        return m.edges[i + 2] as number;
    }
  }
  throw new Error('no such edge');
}

const ok = (r: { ok: boolean; error?: { message: string } }) => {
  if (!r.ok) throw new Error(r.error?.message);
};

/** The extrude panel's write: a form over profiles, as one undo step. */
function extrude(
  s: AppServices,
  part: string,
  profiles: ExtrudeProfile[],
  form: Partial<ExtrudeForm>,
  editing?: string,
) {
  const base = editing ? readExtrude(s.editor.document, part, editing) : null;
  const full: ExtrudeForm = {
    ...(base?.form ?? { extent: 'distance', distance: '10 mm', reversed: false, operation: 'new', face: null }),
    ...form,
  };
  const feature = editing ?? s.editor.newId('feat');
  const target = editing ? { part, feature, base: base?.inputs as Json } : { part, feature, name: 'Extrude' };
  const built = buildExtrude(
    s.editor.document,
    target,
    full,
    base?.profiles ?? profiles,
    new ValueSlots(() => s.editor.newId('val'), target.base),
  );
  if (!built.ok) throw new Error(built.message);
  const result = writeExtrude(s.editor, target, built, base?.profiles ?? profiles);
  if (!result.ok) throw new Error(result.error.message);
  return feature;
}

describe('sketch, extrude, sketch on a face, extrude, edit, undo, save', { timeout: 60_000 }, () => {
  it('builds the model and keeps the face sketch on its face through an upstream edit', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(11),
      name: () => 'workflow',
    });
    const part = partOf(s);
    await settled(s);

    // A sketch on XY, a 40 × 20 rectangle from the origin, its width and height dimensioned.
    const first = addSketch(s.editor, part, { reference: { standard: { name: 'xy' } }, names: {} });
    if (!first.ok) throw new Error(first.message);
    await settled(s);
    const one = open(s, part, first.feature);
    expect(one.frame).toEqual({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] });
    one.session.setTool('rectangle');
    one.click(0, 0);
    one.click(40, 20);
    one.session.setTool('dimension');
    one.click(20, 0);
    one.click(20, -8);
    one.click(40, 10);
    one.click(48, 10);
    const dims = constraints(s, part, first.feature).filter((c) => c.kind === 'distance');
    expect(dims.map((d) => d.solved)).toEqual([40, 20]);
    const height = dims[1] as Json;
    one.session.finish();
    one.session.dispose();
    expect(readDocument(s.editor.document).refused).toBe(false);

    // Extrude its one region 10 mm: a new body.
    let display = await settled(s);
    const region = sketchesOf(display, part).find((x) => x.feature === first.feature)?.regions ?? [];
    expect(region).toHaveLength(1);
    const profile = await profileOf(s, part, (region[0] as { key: number }).key);
    expect(profile).not.toBeNull();
    const base = extrude(s, part, [profile as ExtrudeProfile], { distance: '10' });
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    let shown = bodies(display, part);
    expect(shown.count).toBe(1);
    expect(shown.volume).toBeCloseTo(8000, 3);
    expect(close(shown.min, [0, 0, 0]) && close(shown.max, [40, 20, 10])).toBe(true);

    // The top face (y = 20) takes a sketch: its frame is the face's, origin the part origin projected.
    const hit = raycast(display, display.parts[part] as number, [20, 100, 5], [0, -1, 0]);
    expect(hit).toBeDefined();
    const face = await s.pick({ key: (hit as { key: number }).key });
    if (!face || 'region' in face) throw new Error('the face did not pick');
    const second = addSketch(s.editor, part, face);
    if (!second.ok) throw new Error(second.message);
    await settled(s);
    const two = open(s, part, second.feature);
    expect(
      close(two.frame.origin, [0, 20, 0]) && close(two.frame.normal, [0, 1, 0]) && close(two.frame.x, [1, 0, 0]),
    ).toBe(true);
    // Sketch y is normal × x = -z: (20, -5) is above the middle of the face.
    two.session.setTool('circle');
    two.click(20, -5);
    two.click(23, -5);
    two.session.finish();
    two.session.dispose();

    // Extrude the circle 5 mm; the part has a body, so the panel joins.
    display = await settled(s);
    const circle = sketchesOf(display, part).find((x) => x.feature === second.feature)?.regions ?? [];
    expect(circle).toHaveLength(1);
    const boss = await profileOf(s, part, (circle[0] as { key: number }).key);
    extrude(s, part, [boss as ExtrudeProfile], { distance: '5 mm', operation: 'join' });
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    shown = bodies(display, part);
    const cylinder = Math.PI * 9 * 5;
    expect(shown.count).toBe(1);
    expect(shown.volume).toBeCloseTo(8000 + cylinder, 0);
    expect(close(shown.max, [40, 25, 10], 1e-2)).toBe(true);

    // The rectangle's height becomes 30: the top face moves to y = 30, and the face sketch with it.
    const edit = open(s, part, first.feature);
    expect(edit.session.setDimension(height.id as string, '30 mm').ok).toBe(true);
    edit.session.dispose();
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const moved = sketchesOf(display, part).find((x) => x.feature === second.feature)?.frame as FrameDisplay;
    expect(close(moved.origin, [0, 30, 0]) && close(moved.normal, [0, 1, 0])).toBe(true);
    shown = bodies(display, part);
    expect(shown.volume).toBeCloseTo(12000 + cylinder, 0);
    expect(close(shown.max, [40, 35, 10], 1e-2)).toBe(true);

    // Editing the first extrude through its panel: 12 mm deep, one undo step.
    extrude(s, part, [], { distance: '12 mm' }, base);
    expect(s.editor.store.undoLabel()).toMatch(/^Edit /);
    display = await settled(s);
    shown = bodies(display, part);
    expect(shown.volume).toBeCloseTo(40 * 30 * 12 + cylinder, 0);

    // Undo the extrude edit and the height, then redo both.
    s.editor.undo();
    s.editor.undo();
    display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(8000 + cylinder, 0);
    s.editor.redo();
    s.editor.redo();
    display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(40 * 30 * 12 + cylinder, 0);

    // Save and reload: the same bytes, the same model.
    const text = s.editor.save();
    const loaded = loadDocument(text);
    if (!loaded.ok) throw new Error(loaded.message);
    const reopened = new Editor(loaded.document);
    expect(reopened.save()).toBe(text);
    const again = service.evaluate(reopened.document as Json);
    expect(again.pauses).toEqual([]);
    expect(bodies(again, part).volume).toBeCloseTo(40 * 30 * 12 + cylinder, 0);
    s.dispose();
  });
});

/** Every body of a part: how many, and their volume. */
function solids(display: Display, part: string) {
  const definition = display.definitions[display.parts[part] as number];
  const keys = (definition?.bodies ?? []).map((b) => b.key);
  const volume = keys.reduce((sum, key) => {
    const m = service.measure('volume', [key]);
    return sum + ('value' in m ? m.value : 0);
  }, 0);
  return { count: keys.length, volume };
}

const fcstd = (name: string) =>
  new Uint8Array(
    readFileSync(resolvePath(dirname(fileURLToPath(import.meta.url)), '../../lib/fcstd-import/fixtures', name)),
  );

describe('importing and exporting files', { timeout: 120_000 }, () => {
  it('imports a STEP file into the part, models on it, and exports a file that imports the same', async () => {
    const c = client();
    const { services: s } = await bootApp({
      client: c,
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(12),
      name: () => 'imports',
    });
    const part = partOf(s);
    await settled(s);

    // Two blocks in a STEP file, as another program writes one.
    const a = k.makeBox(30, 20, 10);
    const b = k.translate(k.makeBox(10, 10, 10), 50, 0, 0);
    const both = k.makeCompound([a, b]);
    const file = { name: 'blocks.step', bytes: new TextEncoder().encode(k.exportStep(both)) };
    for (const h of [both, b, a]) k.release(h);
    const imported = await importGeometry(s.editor, c, file, 'step', part);
    if (!imported.ok) throw new Error(imported.message);
    expect(s.editor.store.undoLabel()).toBe('Add blocks');
    let display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(solids(display, part).count).toBe(2);
    expect(solids(display, part).volume).toBeCloseTo(7000, 6);

    // The top of the larger block takes a sketch and a boss joined to it.
    const hit = raycast(display, display.parts[part] as number, [15, 10, 100], [0, 0, -1]);
    const face = await s.pick({ key: (hit as { key: number }).key });
    if (!face || 'region' in face) throw new Error('the face did not pick');
    const sketch = addSketch(s.editor, part, face);
    if (!sketch.ok) throw new Error(sketch.message);
    await settled(s);
    const top = open(s, part, sketch.feature);
    expect(close(top.frame.origin, [0, 0, 10]) && close(top.frame.normal, [0, 0, 1])).toBe(true);
    top.session.setTool('circle');
    top.click(15, 10);
    top.click(18, 10);
    top.session.finish();
    top.session.dispose();
    display = await settled(s);
    const region = sketchesOf(display, part).find((x) => x.feature === sketch.feature)?.regions[0] as { key: number };
    const boss = await profileOf(s, part, region.key);
    extrude(s, part, [boss as ExtrudeProfile], { distance: '5 mm', operation: 'join' });
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const total = 7000 + Math.PI * 9 * 5;
    expect(solids(display, part).volume).toBeCloseTo(total, 1);

    // Saved and loaded, the files of the import travel with the document and build the same.
    const loaded = loadDocument(s.editor.save());
    if (!loaded.ok) throw new Error(loaded.message);
    expect(Object.keys(loaded.document.assets as Json)).toHaveLength(2);
    expect(solids(service.evaluate(loaded.document as Json), part).volume).toBeCloseTo(total, 1);
    s.scheduler.request(s.editor.document, s.editor.store.revision);
    await settled(s);

    // The shown part as STEP, imported into a new document: the same solids.
    const exported = await s.exportShown('step');
    s.session.newDocument();
    await settled(s);
    const again = await importGeometry(s.editor, c, { name: 'exported.step', bytes: exported }, 'step', partOf(s));
    if (!again.ok) throw new Error(again.message);
    display = await settled(s);
    expect(solids(display, partOf(s)).count).toBe(2);
    expect(solids(display, partOf(s)).volume).toBeCloseTo(total, 1);

    // Undo takes the import out with its files.
    s.editor.undo();
    expect(Object.keys(s.editor.document.assets as Json)).toEqual([]);
    s.dispose();
  });

  it('opens a FreeCAD file as a document its dimensions still drive, with its fillets on the right edges', async () => {
    const c = client();
    const { services: s } = await bootApp({
      client: c,
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(13),
      name: () => 'freecad',
    });
    await settled(s);
    const plate = await importFreeCad(
      { name: 'constrained_plate.FCStd', bytes: fcstd('constrained_plate.FCStd') },
      c,
      seededIds(14),
    );
    if (!plate.ok) throw new Error(plate.message);
    expect(plate.notes).toEqual([]);
    expect(s.session.openText(saveDocument(plate.document)).ok).toBe(true);
    let display = await settled(s);
    expect(display.pauses).toEqual([]);
    const part = partOf(s);
    expect(solids(display, part).volume).toBeCloseTo(40 * 20 * 10 - Math.PI * 16 * 10, 3);

    // The width of the plate, 40 mm in the file, set to 50 mm.
    const sketch = (((s.editor.document.parts as Json[])[0] as Json).timeline as Json[])[0] as Json;
    const width = constraints(s, part, sketch.id as string).find(
      (x) => x.kind === 'distanceX' && x.solved === 40,
    ) as Json;
    const result = s.editor.dispatch({
      type: 'setValueDef',
      value: (width.value as Json).id as string,
      def: { expr: { text: '50 mm', grammar: 1, refs: {} } },
    });
    expect(result.ok).toBe(true);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(solids(display, part).volume).toBeCloseTo(50 * 20 * 10 - Math.PI * 16 * 10, 3);

    // A fillet names edges by the file's numbering; they are found on the imported block.
    const rounded = await importFreeCad({ name: 'fillet.FCStd', bytes: fcstd('fillet.FCStd') }, c, seededIds(15));
    if (!rounded.ok) throw new Error(rounded.message);
    expect(rounded.notes).toEqual([]);
    expect(s.session.openText(saveDocument(rounded.document)).ok).toBe(true);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    expect(solids(display, partOf(s)).volume).toBeCloseTo(5965.664, 2);

    // Written out again, it is a FreeCAD file with its Body and features, nothing stored in their place.
    const out = await s.exportFreeCad();
    expect(out.notes).toEqual([]);
    expect(out.bodies.map((b) => b.features)).toEqual([['BaseSketch', 'Base', 'Fillet']]);
    const text = new TextDecoder().decode(unzipSync(out.bytes)['Document.xml']);
    expect(text).toContain('type="PartDesign::Fillet"');
    s.dispose();
  });
});

describe(
  'sketch tools on the model: a filleted profile, projected and intersected edges, text',
  { timeout: 60_000 },
  () => {
    it('builds each and evaluates them as the session drew them', async () => {
      const { services: s } = await bootApp({
        client: client(),
        workingCopy: new MemoryWorkingCopy(),
        localId: null,
        ids: seededIds(13),
        name: () => 'tools',
      });
      const part = partOf(s);
      await settled(s);

      // A 40 × 20 rectangle on XY with one corner filleted 4 mm, extruded 10 mm.
      const first = addSketch(s.editor, part, { reference: { standard: { name: 'xy' } }, names: {} });
      if (!first.ok) throw new Error(first.message);
      await settled(s);
      const one = open(s, part, first.feature);
      one.session.setTool('rectangle');
      one.click(0.5, 0.5);
      one.click(40, 20);
      one.session.setSettings({ fillet: 4 });
      one.session.setTool('fillet');
      one.click(40, 20);
      expect(one.session.getState().message).toBeNull();
      one.session.dispose();
      let display = await settled(s);
      expect(display.pauses).toEqual([]);
      const regions = sketchesOf(display, part).find((x) => x.feature === first.feature)?.regions ?? [];
      expect(regions).toHaveLength(1);
      const profile = await profileOf(s, part, (regions[0] as { key: number }).key);
      extrude(s, part, [profile as ExtrudeProfile], { distance: '10' });
      display = await settled(s);
      expect(display.pauses).toEqual([]);
      const area = 39.5 * 19.5 - (16 - 4 * Math.PI);
      expect(bodies(display, part).volume).toBeCloseTo(area * 10, 1);

      // A sketch on the top face (z = 10) projects the edge along x = 0.5 and intersects the face there.
      const hit = raycast(display, display.parts[part] as number, [20, 10, 100], [0, 0, -1]);
      const face = await s.pick({ key: (hit as { key: number }).key });
      if (!face || 'region' in face) throw new Error('the face did not pick');
      const top = addSketch(s.editor, part, face);
      if (!top.ok) throw new Error(top.message);
      display = await settled(s);
      const sketch = open(s, part, top.feature);
      const edge = edgeBetween(display, part, [0.5, 0.5, 10], [0.5, 20, 10]);
      const projected = service.externalCurves(edge, 'project', sketch.frame);
      if ('pause' in projected) throw new Error(projected.pause);
      expect(projected.shapes.map((c) => c.kind)).toEqual(['line']);
      const picked = await s.pick({ key: edge }, { before: top.feature });
      if (!picked || 'region' in picked) throw new Error('the edge did not pick');
      ok(sketch.session.addExternal(picked, 'project', projected.shapes));
      // Keys last for one display: pick the side face from the new one.
      display = await settled(s);
      const side = raycast(display, display.parts[part] as number, [-100, 10, 5], [1, 0, 0]);
      const sideKey = (side as { key: number }).key;
      const cut = service.externalCurves(sideKey, 'intersect', sketch.frame);
      if ('pause' in cut) throw new Error(cut.pause);
      expect(cut.shapes).toHaveLength(1);
      const sideFace = await s.pick({ key: sideKey }, { before: top.feature });
      if (!sideFace || 'region' in sideFace) throw new Error('the side face did not pick');
      ok(sketch.session.addExternal(sideFace, 'intersect', cut.shapes));
      const rows = (sketchInputsOf(s, part, top.feature).curves as Json[]).filter((c) => c.kind === 'external');
      expect(rows.map((r) => [r.index, r.count])).toEqual([
        [undefined, undefined],
        [0, 1],
      ]);
      display = await settled(s);
      expect(display.pauses).toEqual([]);
      const built = sketchesOf(display, part).find((x) => x.feature === top.feature);
      expect(built?.externals).toHaveLength(2);
      // Both are the same line in the sketch, built as the service gave them.
      expect(built?.externals.map((e) => e.shape)).toEqual([projected.shapes[0], cut.shapes[0]]);

      // Text on the face sketch, in a bundled font: it evaluates and its glyphs bound regions.
      const here = dirname(fileURLToPath(import.meta.url));
      const font = loadFont(
        new Uint8Array(readFileSync(resolvePath(here, '../assets/fonts/LilitaOne-Regular.ttf'))),
        'Lilita One',
      );
      sketch.session.setTool('text');
      sketch.session.setTextFont(font);
      sketch.session.setTextOptions({ string: 'IO', size: 6 });
      sketch.click(10, 8);
      expect(sketch.session.getState().message).toBeNull();
      sketch.session.dispose();
      display = await settled(s);
      expect(display.pauses).toEqual([]);
      const glyphRegions = sketchesOf(display, part).find((x) => x.feature === top.feature)?.regions ?? [];
      expect(glyphRegions.length).toBeGreaterThanOrEqual(3);
      expect(readDocument(s.editor.document).refused).toBe(false);
      s.dispose();
    });
  },
);

describe('the everyday edits: a fillet, a feature inserted earlier, a configuration', { timeout: 60_000 }, () => {
  it('keeps the fillet on its edge through an insertion before it and a configuration change', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(12),
      name: () => 'everyday',
    });
    const part = partOf(s);
    await settled(s);

    // A part parameter drives the plate's width: a 40 × 20 rectangle extruded 10 mm.
    ok(addParameter(s.editor, { part }, 'width', 'length', '40'));
    const sketch = addSketch(s.editor, part, { reference: { standard: { name: 'xy' } }, names: {} });
    if (!sketch.ok) throw new Error(sketch.message);
    await settled(s);
    const one = open(s, part, sketch.feature);
    one.session.setTool('rectangle');
    one.click(0, 0);
    one.click(40, 20);
    one.session.setTool('dimension');
    one.click(20, 0);
    one.click(20, -8);
    one.click(40, 10);
    one.click(48, 10);
    const [widthDim] = constraints(s, part, sketch.feature).filter((c) => c.kind === 'distance');
    expect(one.session.setDimension((widthDim as Json).id as string, 'width').ok).toBe(true);
    one.session.finish();
    one.session.dispose();
    let display = await settled(s);
    const region = sketchesOf(display, part).find((x) => x.feature === sketch.feature)?.regions[0] as { key: number };
    extrude(s, part, [(await profileOf(s, part, region.key)) as ExtrudeProfile], { distance: '10' });
    display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(8000, 3);

    // A fillet on the vertical edge at the far corner (40, 20).
    const fillet = newTarget(s.editor, part, 'Fillet');
    const edge = edgeBetween(display, part, [40, 20, 0], [40, 20, 10]);
    const picked = await pickFor(s, fillet, { key: edge });
    if (!picked) throw new Error('the edge did not pick');
    const filletBuilt = buildFillet(
      s.editor.document,
      fillet,
      { ...newFilletForm(), targets: [picked], radius: '4' },
      new ValueSlots(() => s.editor.newId('val')),
    );
    if (!filletBuilt.ok) throw new Error(filletBuilt.message);
    ok(writeFeature(s.editor, fillet, 'core.fillet', filletBuilt));
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const corner = (16 - 4 * Math.PI) * 10;
    expect(bodies(display, part).volume).toBeCloseTo(8000 - corner, 2);

    // Insert earlier: roll back before the fillet, drill a through hole, roll to the end. The fillet still finds its edge.
    ok(s.editor.dispatch({ type: 'setRollback', part, before: fillet.feature }));
    display = await settled(s);
    const top = raycast(display, display.parts[part] as number, [5, 5, 50], [0, 0, -1]);
    const hole = newTarget(s.editor, part, 'Hole');
    expect(hole.before).toBe(fillet.feature);
    const face = await pickFor(s, hole, { key: (top as { key: number }).key });
    if (!face) throw new Error('the face did not pick');
    const holeBuilt = buildHole(
      s.editor.document,
      hole,
      {
        ...newHoleForm(),
        face,
        positions: [{ id: s.editor.newId('hp'), x: '10', y: '10' }],
        diameter: '4',
        extent: 'throughAll',
      },
      new ValueSlots(() => s.editor.newId('val')),
    );
    if (!holeBuilt.ok) throw new Error(holeBuilt.message);
    ok(writeFeature(s.editor, hole, 'core.hole', holeBuilt));
    ok(s.editor.dispatch({ type: 'setRollback', part }));
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const timeline = ((s.editor.document.parts as Json[])[0] as Json).timeline as Json[];
    expect(timeline.map((f) => f.type)).toEqual(['core.sketch', 'core.extrude', 'core.hole', 'core.fillet']);
    const bore = Math.PI * 4 * 10;
    expect(bodies(display, part).volume).toBeCloseTo(8000 - corner - bore, 2);

    // A configuration: "Wide" sets the width to 60 mm. Switching to it widens the plate, and the fillet follows its corner.
    ok(addConfiguration(s.editor, part));
    ok(addConfigurationRow(s.editor, configurationsOf(s.editor.document, part)[0]!, 'Wide'));
    const width = parametersOf(s.editor.document, { part }).find((p) => p.name === 'width')!;
    ok(setConfigurationOverride(s.editor, part, configurationsOf(s.editor.document, part)[0]!, 'Wide', width, '60'));
    display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(8000 - corner - bore, 2);
    ok(setActiveConfiguration(s.editor, configurationsOf(s.editor.document, part)[0]!, 'Wide'));
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const wide = bodies(display, part);
    expect(wide.volume).toBeCloseTo(12000 - corner - bore, 2);
    expect(close(wide.max, [60, 20, 10], 1e-2)).toBe(true);

    // Back to the default, then undo the switch and redo it.
    ok(setActiveConfiguration(s.editor, configurationsOf(s.editor.document, part)[0]!, 'Default'));
    display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(8000 - corner - bore, 2);
    s.editor.undo();
    display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(12000 - corner - bore, 2);
    s.editor.redo();
    display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(8000 - corner - bore, 2);
    expect(readDocument(s.editor.document).refused).toBe(false);
    s.dispose();
  });
});

describe('an assistant turn', { timeout: 60_000 }, () => {
  it('models a plate through the tools as one undo step', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(13),
      name: () => 'assistant',
    });
    const part = partOf(s);
    await settled(s);
    const ctx = createAiContext({ services: s, solver: () => Promise.resolve(gcs) });
    // The model's rounds: each reads the ids the previous round's results gave it.
    const resultOf = (messages: NormalizedMessage[]): Json => {
      const block = messages.at(-1)?.content.find((c) => c.type === 'tool_result') as { content: string } | undefined;
      return JSON.parse(block?.content ?? '{}') as Json;
    };
    const call = (id: string, name: string, input: Json): ChatStreamEvent => ({ type: 'tool_call', id, name, input });
    let sketch = '';
    const rounds = [
      () => [call('1', 'sketch_create', { on: 'xy' })],
      (m: NormalizedMessage[]) => {
        sketch = resultOf(m).sketch as string;
        return [call('2', 'sketch_draw_rectangle', { sketch, from: [0, 0], to: [40, 20] })];
      },
      () => [call('3', 'feature_extrude', { sketch, distance: 10 })],
    ];
    let round = 0;
    const stream = async function* (req: { messages: NormalizedMessage[] }): AsyncIterable<ChatStreamEvent> {
      yield { type: 'meta', source: 'platform', model: 'm' };
      const next = rounds[round++];
      if (!next) {
        yield { type: 'text', delta: 'A plate, 40 by 20 by 10.' };
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }
      for (const e of next(req.messages)) yield e;
      yield { type: 'done', stopReason: 'tool_use' };
    };
    const events: ChatTurnEvent[] = [];
    for await (const e of runAgentTurn({
      text: 'Make a plate',
      history: [],
      modelId: null,
      signal: new AbortController().signal,
      ctx,
      stream,
    }))
      events.push(e);
    expect(events.filter((e) => e.type === 'tool_result').every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });

    let display = await settled(s);
    expect(bodies(display, part).volume).toBeCloseTo(8000, 3);
    expect(s.editor.store.inTransaction).toBe(false);
    expect(s.editor.store.undoLabel()).toBe('AI: Make a plate');
    s.editor.undo();
    display = await settled(s);
    expect(bodies(display, part).count).toBe(0);
    expect(partView(s.editor.document, part, display)?.features).toEqual([]);
    s.dispose();
  });
});

describe('an assembly edit: a part made in place, hinged and turned', { timeout: 60_000 }, () => {
  /** A box primitive in the part new features go into, as the Box panel writes it. */
  const box = (s: AppServices, width: string, height: string, z: string) => {
    const part = activePart(s) as string;
    const target = newTarget(s.editor, part, 'Box');
    const form = { ...newPrimitiveForm('box'), dims: { width, depth: '20', height }, z };
    const built = buildPrimitive(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val')));
    if (!built.ok) throw new Error(built.message);
    expect(writeFeature(s.editor, target, 'core.primitive', built, 'Box').ok).toBe(true);
    return part;
  };

  it('builds, joins, drives, undoes and saves', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(13),
      name: () => 'assembly',
    });
    const base = box(s, '60', '10', '5');
    await settled(s);

    expect((await newAssembly(s)).ok).toBe(true);
    const assembly = ((s.editor.document.root as Json).assembly as Json).id as string;
    expect((await newPart(s)).ok).toBe(true);
    const arm = activePartOf(s.editor.document, s.app.getState().focus) as string;
    expect(arm).not.toBe(base);
    // In place: the new part takes the feature, and the assembly shows.
    expect(box(s, '40', '6', '3')).toBe(arm);
    finishInPlace(s);
    expect(s.app.getState().focus).toBeNull();
    let d = await settled(s);
    expect(d.assemblies[0]?.instances).toHaveLength(2);

    const face = (part: string, from: [number, number, number], dir: [number, number, number]) =>
      raycast(d, d.parts[part] as number, from, dir)?.key as number;
    const a = await jointEnd(
      s,
      { key: face(base, [5, 5, 50], [0, 0, -1]), instance: { assembly, index: 0 } },
      'Part 1:1',
    );
    const b = await jointEnd(
      s,
      { key: face(arm, [5, 5, -50], [0, 0, 1]), instance: { assembly, index: 1 } },
      'Part 2:1',
    );
    if ('problem' in a || 'problem' in b) throw new Error('no joint end');
    const built = jointCommands(s.editor, assembly, { ...newJointForm(), kind: 'revolute', a, b });
    if (!built.ok) throw new Error(built.message);
    expect(await commitSolved(s, 'Add Revolute joint', built.commands)).toEqual({ ok: true });
    d = await settled(s);
    expect(d.assemblies[0]?.instances[1]?.placement.position.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 10]);

    expect(
      await commitSolved(s, 'Drive Revolute 1', [
        { type: 'editAssemblyRow', row: built.joint, set: { state: { rz: 30 } } },
      ]),
    ).toEqual({ ok: true });
    d = await settled(s);
    const turned = d.assemblies[0]?.instances[1]?.placement.rotation as number[];
    expect(turned[2]).toBeCloseTo(Math.sin(Math.PI / 12), 9);

    s.editor.undo();
    d = await settled(s);
    expect(d.assemblies[0]?.instances[1]?.placement.rotation[2]).toBeCloseTo(0, 9);
    s.editor.redo();
    d = await settled(s);
    expect(d.assemblies[0]?.instances[1]?.placement.rotation[2]).toBeCloseTo(Math.sin(Math.PI / 12), 9);
    expect(d.pauses).toEqual([]);

    const text = s.editor.save();
    const loaded = loadDocument(text);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(new Editor(loaded.document).save()).toBe(text);
    expect(readDocument(JSON.parse(text)).refused).toBe(false);
    s.dispose();
  });
});

describe('an extrude started on a face', { timeout: 60_000 }, () => {
  it('starts on the picked face and follows it when the plate under it gets thicker', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(17),
      name: () => 'workflow',
    });
    const part = partOf(s);
    await settled(s);

    // A 40 × 20 plate, 10 mm thick.
    const first = addSketch(s.editor, part, { reference: { standard: { name: 'xy' } }, names: {} });
    if (!first.ok) throw new Error(first.message);
    await settled(s);
    const one = open(s, part, first.feature);
    one.session.setTool('rectangle');
    one.click(0, 0);
    one.click(40, 20);
    one.session.finish();
    one.session.dispose();
    let display = await settled(s);
    const plate = await profileOf(
      s,
      part,
      (sketchesOf(display, part).find((x) => x.feature === first.feature)?.regions[0] as { key: number }).key,
    );
    const base = extrude(s, part, [plate as ExtrudeProfile], { distance: '10' });

    // A circle on the same plane, extruded 5 mm from the plate's top face.
    const second = addSketch(s.editor, part, { reference: { standard: { name: 'xy' } }, names: {} });
    if (!second.ok) throw new Error(second.message);
    await settled(s);
    const two = open(s, part, second.feature);
    two.session.setTool('circle');
    two.click(20, 10);
    two.click(23, 10);
    two.session.finish();
    two.session.dispose();
    display = await settled(s);
    const hit = raycast(display, display.parts[part] as number, [5, 5, 100], [0, 0, -1]);
    const top = await s.pick({ key: (hit as { key: number }).key });
    if (!top || 'region' in top) throw new Error('the face did not pick');
    const circle = sketchesOf(display, part).find((x) => x.feature === second.feature)?.regions ?? [];
    const boss = await profileOf(s, part, (circle[0] as { key: number }).key);
    extrude(s, part, [boss as ExtrudeProfile], {
      distance: '5',
      operation: 'join',
      startType: 'face',
      startFace: { ...top, label: 'Face' },
    });
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    const cylinder = Math.PI * 9 * 5;
    let shown = bodies(display, part);
    expect(shown.count).toBe(1);
    expect(shown.volume).toBeCloseTo(8000 + cylinder, 0);
    expect(close(shown.max, [40, 20, 15], 1e-2)).toBe(true);

    // The plate gets 2 mm thicker; the boss starts on its top face still.
    extrude(s, part, [], { distance: '12 mm' }, base);
    display = await settled(s);
    expect(display.pauses).toEqual([]);
    shown = bodies(display, part);
    expect(shown.volume).toBeCloseTo(9600 + cylinder, 0);
    expect(close(shown.max, [40, 20, 17], 1e-2)).toBe(true);
    s.dispose();
  });
});

/** A box primitive in the part new features go into, as the Box panel writes it; returns its feature. */
function boxFeature(
  s: AppServices,
  dims: { width: string; depth: string; height: string },
  at: { x?: string; y?: string; z?: string } = {},
): string {
  const part = activePart(s) as string;
  const target = newTarget(s.editor, part, 'Box');
  const form = {
    ...newPrimitiveForm('box'),
    operation: partView(s.editor.document, part, null)?.features.length !== 0 ? ('join' as const) : ('new' as const),
    z: '0',
    dims,
    ...at,
  };
  const built = buildPrimitive(s.editor.document, target, form, new ValueSlots(() => s.editor.newId('val')));
  if (!built.ok) throw new Error(built.message);
  expect(writeFeature(s.editor, target, 'core.primitive', built, 'Box').ok).toBe(true);
  return target.feature;
}

/** The shape inputs of a box feature of the first part: its dimensions' value objects. */
const boxValue = (s: AppServices, feature: string) =>
  (
    (
      (((s.editor.document.parts as Json[])[0] as Json).timeline as Json[]).find((f) => f.id === feature)
        ?.inputs as Json
    ).shape as Json
  ).box as Json;

describe('a component pattern', { timeout: 60_000 }, () => {
  it('copies an instance, is edited to two directions, and its copies follow the part', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(19),
      name: () => 'pattern',
    });
    const part = partOf(s);
    const box = boxFeature(s, { width: '20', depth: '20', height: '10' });
    await settled(s);
    expect((await newAssembly(s)).ok).toBe(true);
    const assembly = ((s.editor.document.root as Json).assembly as Json).id as string;
    const instance = (((s.editor.document.assemblies as Json[])[0] as Json).instances as Json[])[0]?.id as string;

    // Three copies 30 mm apart along X, as the panel writes them.
    const form = newAsmPatternForm(s.editor, assembly, [instance]);
    form.directions = [{ ...newAsmDirection('x'), count: '4', spacing: '30' }];
    const built = buildAsmPattern(s.editor, assembly, form);
    if (!built.ok) throw new Error(built.message);
    expect(await commitSolved(s, built.label, built.commands)).toEqual({ ok: true });
    let d = await settled(s);
    expect(d.pauses).toEqual([]);
    const xs = () => d.assemblies[0]?.instances.map((i) => Math.round(i.placement.position[0] * 1e6) / 1e6);
    expect(xs()).toEqual([0, 30, 60, 90]);

    // Edited: two copies along X and a second row along Y, nine in all.
    const edited = readAsmPattern(s.editor, assemblyFeatureOf(s.editor.document, form.feature)?.row as Json);
    edited.directions = [
      { ...edited.directions[0]!, count: '3' },
      { ...newAsmDirection('y'), count: '3', spacing: '40' },
    ];
    const again = buildAsmPattern(s.editor, assembly, edited);
    if (!again.ok) throw new Error(again.message);
    expect(await commitSolved(s, again.label, again.commands)).toEqual({ ok: true });
    d = await settled(s);
    expect(copiesOf(d, assembly, form.feature)).toBe(8);
    expect(s.editor.store.undoLabel()).toBe('Edit Pattern 1');

    // The part widens: every copy places the wider part.
    const width = boxValue(s, box).width as Json;
    ok(
      s.editor.dispatch({
        type: 'setValueDef',
        value: width.id as string,
        def: { expr: { text: '25 mm', grammar: 1, refs: {} } },
      }),
    );
    d = await settled(s);
    expect(d.pauses).toEqual([]);
    expect(new Set(d.assemblies[0]?.instances.map((i) => i.definition)).size).toBe(1);
    expect(bodies(d, part).volume).toBeCloseTo(25 * 20 * 10, 3);

    s.editor.undo();
    s.editor.undo();
    d = await settled(s);
    expect(copiesOf(d, assembly, form.feature)).toBe(3);
    s.editor.redo();
    d = await settled(s);
    expect(copiesOf(d, assembly, form.feature)).toBe(8);

    const text = s.editor.save();
    const loaded = loadDocument(text);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(new Editor(loaded.document).save()).toBe(text);
    s.dispose();
  });
});

describe('a rollback moved with a face selected', { timeout: 60_000 }, () => {
  it('drops the face from the selection once the display no longer shows it, and keeps one it still shows', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(29),
      name: () => 'rollback',
    });
    const part = partOf(s);
    boxFeature(s, { width: '10', depth: '10', height: '10' });
    const second = boxFeature(s, { width: '10', depth: '10', height: '10' }, { x: '50' });
    const d = await settled(s);
    const definition = d.definitions[d.parts[part] as number]!;
    const faceOf = (feature: string) => definition.bodies.find((b) => b.feature === feature)!.mesh.faces[2] as number;
    const kept = faceOf(definition.bodies.find((b) => b.feature !== second)!.feature);
    const gone = faceOf(second);
    s.selection.setState({ items: [{ key: kept }, { key: gone }] });

    ok(s.editor.dispatch({ type: 'setRollback', part, before: second }));
    const rolled = await settled(s);
    expect(rolled.restyled).toBe(d.generation);
    expect(s.selection.getState().items).toEqual([{ key: kept }]);
    s.dispose();
  });
});

describe('a frozen feature and an edit before it', { timeout: 60_000 }, () => {
  it('keeps what it stored when the plate under it widens, and builds on the wider plate once unfrozen', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(23),
      name: () => 'freeze',
    });
    const part = partOf(s);
    const plate = boxFeature(s, { width: '40', depth: '20', height: '10' }, { z: '5' });
    const block = boxFeature(s, { width: '10', depth: '10', height: '10' }, { z: '15' });
    let d = await settled(s);
    expect(bodies(d, part)).toMatchObject({ count: 1 });
    expect(bodies(d, part).volume).toBeCloseTo(8000 + 1000, 3);

    expect(await freezeFeature(s, block)).toEqual({ ok: true });
    expect(s.editor.store.undoLabel()).toBe('Freeze Box 2');
    d = await settled(s);
    expect(d.pauses).toEqual([]);
    expect(partView(s.editor.document, part, d)?.features.map((f) => [f.name, f.frozen, f.status])).toEqual([
      ['Box 1', false, 'success'],
      ['Box 2', true, 'success'],
    ]);

    // The plate widens: the frozen block replays the body it stored, built but not as authored.
    const width = boxValue(s, plate).width as Json;
    ok(
      s.editor.dispatch({
        type: 'setValueDef',
        value: width.id as string,
        def: { expr: { text: '60 mm', grammar: 1, refs: {} } },
      }),
    );
    d = await settled(s);
    expect(bodies(d, part).volume).toBeCloseTo(8000 + 1000, 3);
    expect(partView(s.editor.document, part, d)?.features[1]).toMatchObject({
      frozen: true,
      status: 'success',
      warning: expect.stringContaining('replays its stored shape'),
    });

    // Unfrozen, it builds on the wider plate; undo freezes it again.
    ok(unfreezeFeature(s.editor, block));
    d = await settled(s);
    expect(bodies(d, part).volume).toBeCloseTo(12000 + 1000, 3);
    expect(partView(s.editor.document, part, d)?.features[1]).toMatchObject({ frozen: false, status: 'success' });
    s.editor.undo();
    d = await settled(s);
    expect(bodies(d, part).volume).toBeCloseTo(8000 + 1000, 3);
    expect(readDocument(s.editor.document).refused).toBe(false);

    const text = s.editor.save();
    const loaded = loadDocument(text);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(new Editor(loaded.document).save()).toBe(text);
    s.dispose();
  });
});

describe('bodies from one sketch: separate profiles, and a ring with its disc', { timeout: 60_000 }, () => {
  it('extrudes each separate group of profiles as its own body, listed and named one row each', async () => {
    const { services: s } = await bootApp({
      client: client(),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(31),
      name: () => 'bodies',
    });
    const part = partOf(s);
    await settled(s);
    const sketch = addSketch(s.editor, part, { reference: { standard: { name: 'xy' } }, names: {} });
    if (!sketch.ok) throw new Error(sketch.message);
    await settled(s);
    const one = open(s, part, sketch.feature);
    // A 20 × 20 square with a circle inside it, and a 5 × 5 square apart from it.
    one.session.setTool('rectangle');
    one.click(0, 0);
    one.click(20, 20);
    one.click(30, 0);
    one.click(35, 5);
    one.session.setTool('circle');
    one.click(10, 10);
    one.click(13, 10);
    one.session.finish();
    one.session.dispose();

    let display = await settled(s);
    const regions = sketchesOf(display, part).find((x) => x.feature === sketch.feature)?.regions ?? [];
    expect(regions).toHaveLength(3);
    const profiles: ExtrudeProfile[] = [];
    for (const r of regions) profiles.push((await profileOf(s, part, r.key)) as ExtrudeProfile);
    extrude(s, part, profiles, { distance: '2' });
    display = await settled(s);
    expect(display.pauses).toEqual([]);

    // The ring and its disc touch, so they fuse into one body; the small square is a body of its own.
    const rows = bodiesOf(display, part);
    expect(rows.map((r) => r.name)).toEqual(['Body 1', 'Body 2']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    const volumes = rows
      .map((r) => service.measure('volume', [r.key]))
      .map((m) => ('value' in m ? m.value : NaN))
      .sort((a, b) => b - a);
    expect(volumes[0]).toBeCloseTo(20 * 20 * 2, 3);
    expect(volumes[1]).toBeCloseTo(5 * 5 * 2, 3);
  });
});

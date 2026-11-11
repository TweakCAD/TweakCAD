/**
 * The viewport's scene over a real display: raycasts as the pointer makes
 * them land on faces, edges, regions and standard planes through the pick
 * tables, and the keys they give are the ones the service picks.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { pickReference } from '../picking';
import { ModelScene } from './ModelScene';

let k: OcctKernel;
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
  service = new EvaluationService(k, await make_gcs_wrapper(realpathSync(wasm)));
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

/** A 60 × 40 × 10 plate with a 6 mm hole through it at (45, 20). */
function plate() {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => x.rect(0, 0, 60, 40));
  const extrude = d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '10 mm' }] });
  const hole = d.sketch('xy', (x) => x.circle(45, 20, 3));
  const cut = d.extrude({
    sketch: hole.feature,
    profiles: [hole.region([45, 20])],
    sides: [{ throughAll: true }],
    op: 'cut',
  });
  return { doc: d.document(), part: d.partId, extrude, cut };
}

function ray(origin: [number, number, number], direction: [number, number, number]): THREE.Raycaster {
  return new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction).normalize());
}

describe('ModelScene', { timeout: 60_000 }, () => {
  let display: Display;
  let scene: ModelScene;
  let part: string;
  let extrude: string;
  let cut: string;

  beforeAll(() => {
    const p = plate();
    part = p.part;
    extrude = p.extrude;
    cut = p.cut;
    display = service.evaluate(p.doc);
    expect(display.pauses).toEqual([]);
    scene = new ModelScene();
    scene.setDisplay(display, { part });
  });

  const kindOf = (key: number) => display.entities[key]?.kind;

  it('picks the top face from above, and the service picks the same key', async () => {
    const item = scene.pick(ray([10, 10, 100], [0, 0, -1]), 0.5);
    expect(item && 'key' in item).toBe(true);
    if (!item || !('key' in item)) return;
    expect(kindOf(item.key)).toBe('face');
    const picked = await pickReference(service, item);
    expect(picked && 'reference' in picked && 'entity' in (picked.reference as object)).toBe(true);
  });

  it('prefers an edge in reach over the face it bounds', () => {
    const item = scene.pick(ray([30, -50, 9.9], [0, 1, 0]), 0.5);
    expect(item && 'key' in item && kindOf(item.key)).toBe('edge');
  });

  it('picks the face when only faces may be picked', () => {
    scene.setPickFilter(new Set(['face']));
    const item = scene.pick(ray([30, -50, 9.9], [0, 1, 0]), 0.5);
    scene.setPickFilter(new Set(['face', 'edge', 'sketchCurve', 'sketchPoint', 'region', 'construction', 'standard']));
    expect(item && 'key' in item && kindOf(item.key)).toBe('face');
  });

  it('does not pick a region through the plate where only regions are picked, unless a preview covers them', () => {
    scene.setPickFilter(new Set(['region']));
    const under = () => scene.pick(ray([10, 10, 100], [0, 0, -1]), 0.01);
    const through = scene.pick(ray([46, 21, 100], [0, 0, -1]), 0.01);
    const hidden = under();
    scene.setRegionsOccluded(false);
    const previewing = under();
    scene.setRegionsOccluded(true);
    scene.setPickFilter(new Set(['face', 'edge', 'sketchCurve', 'sketchPoint', 'region', 'construction', 'standard']));
    expect(hidden).toBeNull();
    expect(previewing && 'key' in previewing && kindOf(previewing.key)).toBe('region');
    expect(through && 'key' in through && kindOf(through.key)).toBe('region');
  });

  it('holds an edge to a few screen pixels where it lies, so a click just inside a face picks the face', () => {
    // The ray runs 0.4 mm below the plate's top front edge (z = 10) into the front face.
    const at = ray([30, -50, 9.6], [0, 1, 0]);
    const tenthPerPixel = scene.pick(at, 1, () => 0.1);
    const fifthPerPixel = scene.pick(at, 1, () => 0.2);
    expect(tenthPerPixel && 'key' in tenthPerPixel && kindOf(tenthPerPixel.key)).toBe('face');
    expect(fifthPerPixel && 'key' in fifthPerPixel && kindOf(fifthPerPixel.key)).toBe('edge');
  });

  it('picks the hole sketch region through the hole, and a standard plane where nothing else is', () => {
    const region = scene.pick(ray([46, 21, 100], [0, 0, -1]), 0.01);
    expect(region && 'key' in region && kindOf(region.key)).toBe('region');
    const standard = scene.pick(ray([-20, -10, 100], [0, 0, -1]), 0.01);
    expect(standard).toEqual({ standard: 'xy' });
    scene.setOriginShown(new Set());
    expect(scene.pick(ray([-20, -10, 100], [0, 0, -1]), 0.01)).toBeNull();
    // Each plane on its own: with XY hidden, the ray no longer lands on it.
    scene.setOriginShown(new Set(['xz', 'yz']));
    expect(scene.pick(ray([-20, -10, 100], [0, 0, -1]), 0.01)).not.toEqual({ standard: 'xy' });
    scene.setOriginShown(new Set(['xy', 'xz', 'yz']));
  });

  it('picks the nearer of a standard plane and a face, and a face lying on the plane over the plane', () => {
    scene.setPickFilter(new Set(['face', 'standard']));
    // From below, the plate's bottom face lies on the XY plane.
    const bottom = scene.pick(ray([10, 10, -100], [0, 0, 1]), 0.01);
    // Rising towards the front face (y = 0), the ray crosses the XY plane outside the plate first.
    const crossing = scene.pick(ray([30, -50, -20], [0, 70, 30]), 0.01);
    // The XZ plane lies on the front face too.
    const front = scene.pick(ray([30, -50, 5], [0, 1, 0]), 0.01);
    scene.setPickFilter(new Set(['face', 'edge', 'sketchCurve', 'sketchPoint', 'region', 'construction', 'standard']));
    expect(bottom && 'key' in bottom && kindOf(bottom.key)).toBe('face');
    expect(crossing).toEqual({ standard: 'xy' });
    expect(front && 'key' in front && kindOf(front.key)).toBe('face');
  });

  it('cuts the bodies with a section plane, caps them, keeps the cut through a redraw, and picks past what is cut off', () => {
    // Keep z above 5: the plate's bottom face (z = 0) is cut off.
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -5);
    scene.setClipping([plane]);
    const body = () => scene.root.getObjectByName(display.definitions[0]!.bodies[0]!.name) as THREE.Mesh;
    const materials = () => body().material as THREE.MeshPhongMaterial[];
    expect(materials()[0]!.clippingPlanes).toEqual([plane]);
    expect(body().getObjectByName('section stencil')?.children).toHaveLength(2);
    // From below, the cut-off bottom face is not picked; the faces left are seen from inside, so nothing is.
    scene.setPickFilter(new Set(['face']));
    expect(scene.pick(ray([10, 10, -100], [0, 0, 1]), 0.5)).toBeNull();
    expect(scene.pick(ray([10, 10, 100], [0, 0, -1]), 0.5)).not.toBeNull();
    scene.setClipping(null);
    const bottom = scene.pick(ray([10, 10, -100], [0, 0, 1]), 0.5);
    scene.setPickFilter(new Set(['face', 'edge', 'sketchCurve', 'sketchPoint', 'region', 'construction', 'standard']));
    expect(bottom && 'key' in bottom && kindOf(bottom.key)).toBe('face');
    expect(materials()[0]!.clippingPlanes).toBeNull();
    expect(body().getObjectByName('section stencil')).toBeUndefined();
    // A new display keeps the cut.
    scene.setClipping([plane]);
    scene.setDisplay(display, { part });
    expect(materials()[0]!.clippingPlanes).toEqual([plane]);
    expect(body().getObjectByName('section stencil')).toBeDefined();
    scene.setClipping(null);
  });

  it('cuts the highlight of a selected face or body with the section, as it cuts the body', () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -5);
    const face = scene.pick(ray([10, 10, 100], [0, 0, -1]), 0.5)!;
    const bodyKey = display.definitions[0]!.bodies[0]!.key;
    const overlays = () => (scene as unknown as { selectionOverlays: THREE.Object3D[] }).selectionOverlays;
    const clipped = () => overlays().map((o) => ((o as THREE.Mesh).material as THREE.Material).clippingPlanes);
    scene.setSelection([face, { key: bodyKey }]);
    scene.setClipping([plane]);
    expect(overlays().length).toBeGreaterThan(0);
    expect(clipped().every((c) => c?.[0] === plane)).toBe(true);
    // Selected while the section cuts, too.
    scene.setSelection([{ key: bodyKey }]);
    expect(clipped().every((c) => c?.[0] === plane)).toBe(true);
    scene.setClipping(null);
    expect(clipped().every((c) => c === null)).toBe(true);
    scene.setSelection([]);
  });

  it('draws the selection and the hover, and a selected feature glows', () => {
    const face = scene.pick(ray([10, 10, 100], [0, 0, -1]), 0.5)!;
    const edge = scene.pick(ray([30, -50, 9.9], [0, 1, 0]), 0.5)!;
    scene.setSelection([face]);
    scene.setHover(edge);
    expect(scene.overlayCount).toEqual({ selection: 1, hover: 1 });
    scene.setHover(face);
    expect(scene.overlayCount.hover).toBe(0);
    scene.setSelection([{ feature: extrude }]);
    const body = scene.root.getObjectByName(display.definitions[0]!.bodies[0]!.name) as THREE.Mesh;
    expect((body.material as THREE.MeshPhongMaterial[])[0]!.emissiveIntensity).toBeGreaterThan(0);
    expect(scene.overlayCount.selection).toBe(0);
    // A feature that made no body shows the faces it made.
    scene.setSelection([{ feature: cut }]);
    expect(scene.overlayCount.selection).toBeGreaterThan(0);
    expect((body.material as THREE.MeshPhongMaterial[])[0]!.emissiveIntensity).toBe(0);
    scene.setSelection([]);
    expect((body.material as THREE.MeshPhongMaterial[])[0]!.emissiveIntensity).toBe(0);
  });

  it('ghosts bodies while a sketch is edited and hides that sketch', () => {
    const sketch = display.definitions[0]!.sketches[1]!.feature;
    scene.setMode({ ghost: true, hiddenSketch: sketch });
    const body = scene.root.getObjectByName(display.definitions[0]!.bodies[0]!.name) as THREE.Mesh;
    expect((body.material as THREE.MeshPhongMaterial[])[0]!.opacity).toBeCloseTo(0.25);
    // Through the hole: the plate sketch's region below it, not the hidden hole sketch's.
    const under = scene.pick(ray([46, 21, 100], [0, 0, -1]), 0.01);
    expect(under && 'key' in under && display.entities[under.key]?.feature).toBe(
      display.definitions[0]!.sketches[0]!.feature,
    );
    scene.setMode({ ghost: false, hiddenSketch: null });
    expect((body.material as THREE.MeshPhongMaterial[])[0]!.opacity).toBe(1);
  });

  it('draws bodies moved while a move is dragged, highlights and all, until it is put back', () => {
    const face = scene.pick(ray([10, 10, 100], [0, 0, -1]), 0.5)!;
    scene.setSelection([face]);
    const key = display.definitions[0]!.bodies[0]!.key;
    scene.moveBodies([key], new THREE.Matrix4().makeTranslation(0, 0, 50));
    expect(scene.bodiesBox().min.z).toBeCloseTo(50, 3);
    // The highlight drawn after the move started moves with the body.
    scene.setSelection([face]);
    const overlays: THREE.Object3D[] = [];
    scene.root.traverse((o) => {
      if (o.userData.overlay) overlays.push(o);
    });
    expect(overlays.map((o) => o.matrix.elements[14])).toEqual([50]);
    scene.moveBodies([key], null);
    expect(scene.bodiesBox().min.z).toBeCloseTo(0, 3);
    scene.setSelection([]);
  });

  it('frames the bodies and knows each sketch frame', () => {
    const box = scene.bodiesBox();
    expect(box.min.toArray()).toEqual([0, 0, 0].map((v) => expect.closeTo(v, 3)));
    expect(box.max.toArray()).toEqual([60, 40, 10].map((v) => expect.closeTo(v, 3)));
    const sketch = display.definitions[0]!.sketches[0]!;
    expect(scene.sketchFrame(sketch.feature)).toEqual(sketch.frame);
  });

  it('keeps the sketch being edited hidden when the display is drawn again', () => {
    const edited = new ModelScene();
    edited.setDisplay(display, { part });
    const feature = display.definitions[0]!.sketches[0]!.feature;
    const group = () => edited.root.getObjectByName(`sketch ${feature}`)!;
    expect(group().visible).toBe(true);
    edited.setMode({ ghost: true, hiddenSketch: feature });
    expect(group().visible).toBe(false);
    edited.setDisplay(display, { part });
    expect(group().visible).toBe(false);
    edited.setMode({ ghost: false, hiddenSketch: null });
    expect(group().visible).toBe(true);
  });

  it('shows nothing for a document root that is not drawn', () => {
    const empty = new ModelScene();
    empty.setDisplay(display, null);
    expect(empty.bodiesBox().isEmpty()).toBe(true);
    expect(empty.pick(ray([10, 10, 100], [0, 0, -1]), 0.5)).toEqual({ standard: 'xy' });
  });

  it("draws a body's mesh it drew before with the same geometry, and lets go of one it no longer draws", () => {
    const own = new ModelScene();
    const geometryOf = (s: ModelScene) => {
      let found: THREE.BufferGeometry | undefined;
      s.root.traverse((o) => {
        if (!found && (o as THREE.Mesh).isMesh && o.userData.pick?.kind === 'face') found = (o as THREE.Mesh).geometry;
      });
      return found as THREE.BufferGeometry;
    };
    own.setDisplay(display, { part });
    const first = geometryOf(own);
    let disposed = 0;
    first.addEventListener('dispose', () => disposed++);
    // The same mesh again, as a display that only restyles it carries it: drawn with the same geometry.
    own.setDisplay({ ...display, generation: display.generation + 1 }, { part });
    expect(geometryOf(own)).toBe(first);
    expect(disposed).toBe(0);
    // Another mesh object with the same geometry id, as a later evaluation sends a body shape it meshed before: the same geometry.
    const again = structuredClone(display);
    own.setDisplay(again, { part });
    expect(geometryOf(own)).toBe(first);
    expect(disposed).toBe(0);
    // A new mesh of the body: new geometry, and the old one let go.
    const copy = structuredClone(display);
    for (const d of copy.definitions) for (const b of d.bodies) b.geometry = (b.geometry ?? 0) + 1000;
    own.setDisplay(copy, { part });
    expect(geometryOf(own)).not.toBe(first);
    expect(disposed).toBe(1);
    own.dispose();
  });
});

describe('ModelScene with an assembly root', { timeout: 60_000 }, () => {
  it('draws each instance at its placement and picks through the instance', async () => {
    const dd = new Docs();
    const part = dd.part('Block');
    part.box('20 mm', '10 mm', '5 mm');
    const a = dd.assembly('Pair');
    a.instance({ part: { id: part.id } }, { grounded: true });
    a.instance({ part: { id: part.id } }, { at: [50, 0, 0] });
    const display = service.evaluate(dd.document({ assembly: { id: a.id } }));
    expect(display.pauses).toEqual([]);
    const scene = new ModelScene();
    scene.setDisplay(display, { assembly: a.id });
    const box = scene.bodiesBox();
    expect(box.max.x).toBeCloseTo(60, 3);
    expect(box.min.x).toBeCloseTo(-10, 3);
    const first = scene.pick(ray([1, 1, 100], [0, 0, -1]), 0.01);
    const second = scene.pick(ray([51, 1, 100], [0, 0, -1]), 0.01);
    expect(first).toMatchObject({ instance: { assembly: a.id, index: 0 } });
    expect(second).toMatchObject({ instance: { assembly: a.id, index: 1 } });
    // One definition, so both instances name the same face key.
    expect(first && 'key' in first && second && 'key' in second && first.key === second.key).toBe(true);
    scene.setSelection([second!]);
    expect(scene.overlayCount.selection).toBe(1);
    const picked = await pickReference(service, second!);
    expect(picked && 'reference' in picked).toBe(true);
  });
});

describe('ModelScene with cosmetic threads', { timeout: 60_000 }, () => {
  const fixtures = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../lib/testing/fixtures/v2');
  const fixture = (name: string) =>
    JSON.parse(readFileSync(resolvePath(fixtures, `${name}.cadjson`), 'utf8')) as Record<string, unknown>;

  it("draws the nut's tapped hole over its bore, unpickable, and fades it with the body", () => {
    const display = service.evaluate(fixture('hex-nut-iso4032'));
    const part = Object.keys(display.parts)[0]!;
    const thread = display.definitions[0]!.threads[0]!;
    const scene = new ModelScene();
    scene.setDisplay(display, { part });
    const [overlay] = scene.threadOverlays;
    expect(scene.threadOverlays).toHaveLength(1);
    expect(overlay!.parent).toBe(scene.root.getObjectByName(display.definitions[0]!.bodies[0]!.name));
    const material = overlay!.material as THREE.ShaderMaterial;
    expect(material.uniforms.pitch!.value).toBe(1);
    expect(material.uniforms.radius!.value).toBeCloseTo(2.5, 6);
    // Its triangles are the bore's: every vertex on the tapped cylinder.
    const positions = overlay!.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++)
      expect(Math.hypot(positions.getX(i), positions.getY(i))).toBeCloseTo(2.5, 3);
    // A ray from the axis lands on the bore face itself.
    const hit = scene.pick(ray([0, 0, 2.6], [1, 0, 0]), 0.01);
    expect(hit && 'key' in hit && thread.faces.includes(hit.key)).toBe(true);
    scene.setMode({ ghost: true, hiddenSketch: null });
    expect(material.uniforms.opacity!.value).toBeCloseTo(0.6 * 0.25, 6);
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    scene.setClipping([plane]);
    expect(material.clippingPlanes).toEqual([plane]);
  });

  it('draws the threads of the parts an assembly places', () => {
    const display = service.evaluate(fixture('bolted-joint'));
    const scene = new ModelScene();
    scene.setDisplay(display, { assembly: display.assemblies[0]!.id });
    const drawn = display.assemblies[0]!.instances.reduce(
      (n, inst) => n + (display.definitions[inst.definition]?.threads.length ?? 0),
      0,
    );
    expect(drawn).toBeGreaterThan(0);
    expect(scene.threadOverlays.length).toBe(drawn);
  });
});

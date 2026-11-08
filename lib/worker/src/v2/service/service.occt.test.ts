/**
 * The worker service driven the way the app drives it, on the real kernel:
 * evaluate, find a face through the pick tables as a raycast hits a
 * triangle, pick it, write the record and its names into the document, edit
 * a dimension, evaluate again and resolve the record, judged by geometry.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { isNameHash, readDocument, type EntityRecord } from '@tweakcad/format';
import { DocBuilder } from '../docBuilder';
import { Docs, instancePath, pathOf } from '../assemblyDocs';
import { BASE, attachmentModels } from '../attachmentDocs';
import { evaluateDocument, type Evaluation } from '../evaluate';
import type { Json } from '../context';
import { EvaluationService } from './service';
import { edgeAt, faceAt, matrixOf } from './picking';
import { meshArea, meshVolume, raycast, unzip } from './testKit';
import type { Display, EntityInfo, Key, PickedEntity, Progress } from './types';

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [4, 5, 6]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  service = new EvaluationService(k, gcs);
});
afterAll(() => {
  service.release();
  k.releaseAll();
});

const close = (a: readonly number[], b: readonly number[], tol = 1e-6) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol);

/** A 60 × 40 × 10 plate with its width a sketch dimension, and a 6 mm hole through it. */
function plate(): { d: DocBuilder; doc: Json; extrude: string } {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => {
    const r = x.rect(0, 0, 60, 40);
    x.fixed(r.points[0] as string);
    x.horizontal(r.lines[0] as string);
    x.vertical(r.lines[1] as string);
    x.horizontal(r.lines[2] as string);
    x.vertical(r.lines[3] as string);
    x.distanceX(r.points[0] as string, r.points[1] as string, '60 mm');
    x.distanceY(r.points[0] as string, r.points[3] as string, '40 mm');
  });
  const extrude = d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '10 mm' }] });
  const hole = d.sketch('xy', (x) => x.circle(45, 20, 3));
  d.extrude({ sketch: hole.feature, profiles: [hole.region([45, 20])], sides: [{ throughAll: true }], op: 'cut' });
  return { d, doc: d.document(), extrude };
}

/** Sets the plate sketch's width dimension: a plain JSON edit of its value. */
function setWidth(doc: Json, width: number): void {
  const sketch = ((doc.parts as Json[])[0]!.timeline as Json[])[0]!;
  const dim = ((sketch.inputs as Json).constraints as Json[]).find((c) => c.kind === 'distanceX')!;
  (((dim.value as Json).def as Json).expr as Json).text = `${width} mm`;
}

/** Writes a pick into the document as an attribute colouring its target, with the names it needs. */
function colour(d: DocBuilder, doc: Json, picked: PickedEntity, color: string): void {
  const part = (doc.parts as Json[])[0]!;
  (part.attributes as Json[]).push({
    id: d.id('attr'),
    target: picked.reference,
    properties: { color: d.val(JSON.stringify(color)) },
  });
  Object.assign(doc.names as Json, picked.names);
}

function readsClean(doc: Json): void {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
}

function hashesOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string' && isNameHash(v)) out.push(v);
  else if (Array.isArray(v)) for (const i of v) hashesOf(i, out);
  else if (v && typeof v === 'object') for (const i of Object.values(v)) hashesOf(i, out);
  return out;
}

describe('the evaluate, pick, edit, resolve loop', { timeout: 60_000 }, () => {
  it('keeps a face picked through the pick tables on the same face through a dimension edit', () => {
    const { d, doc, extrude } = plate();
    const first = service.evaluate(doc);
    expect(first.pauses).toEqual([]);
    // Everything crosses a worker boundary by structured cloning.
    expect(structuredClone(first)).toEqual(first);
    const def = first.parts[d.partId] as number;

    // A ray straight down onto the top, away from the hole.
    const hit = raycast(first, def, [5, 5, 50], [0, 0, -1]);
    expect(hit).toBeDefined();
    const info = first.entities[hit!.key]!;
    expect(info.kind).toBe('face');
    expect(info.feature).toBe(extrude);
    expect(first.entities[info.body!]!.kind).toBe('body');
    const top = service.properties(hit!.key)!.measures;
    expect(close(top.normal as number[], [0, 0, 1])).toBe(true);

    const picked = service.pick({ key: hit!.key }) as PickedEntity;
    // Every hash the record holds is in the document or comes with the pick.
    for (const h of hashesOf(picked.reference)) expect(h in (doc.names as Json) || h in picked.names).toBe(true);
    expect(Object.keys(picked.names).length).toBeGreaterThan(0);
    colour(d, doc, picked, '#ff0000');
    readsClean(doc);

    setWidth(doc, 80);
    const second = service.evaluate(doc);
    expect(second.pauses).toEqual([]);
    const found = service.resolve(picked.reference.entity, { part: d.partId });
    expect(found.outcome).toBe('same');
    const [key] = (found as { keys: Key[] }).keys;
    const m = service.properties(key!)!.measures;
    expect(close(m.normal as number[], [0, 0, 1])).toBe(true);
    expect(close(m.centroid as number[], [40, 20, 10], 0.5)).toBe(true);
    expect(m.area).toBeCloseTo(80 * 40 - Math.PI * 9, 6);
    // The attribute that references it colours that face.
    const body = second.definitions[second.parts[d.partId]!]!.bodies[0]!;
    expect(body.faceStyles).toEqual([{ key, color: '#ff0000', opacity: 1, visible: true }]);
  });

  it('picks with names for a feature being edited, against the part before it', () => {
    const { d, doc } = plate();
    const display = service.evaluate(doc);
    const def = display.parts[d.partId] as number;
    // The hole's wall exists only after the cut; before the cut the key has no entity.
    const wall = display.definitions[def]!.bodies[0]!.mesh;
    const keys = [...wall.faces].filter((_, i) => i % 3 === 2);
    const cylinder = keys.find((key) => service.properties(key)!.measures.surface === 'cylinder')!;
    const cut = ((doc.parts as Json[])[0]!.timeline as Json[])[3]!.id as string;
    expect(service.pick({ key: cylinder }, { before: cut })).toBeNull();
    expect(service.pick({ key: cylinder })).not.toBeNull();

    // The top face is another shape after the cut (it has the hole in it); picked as shown, it is written as the face before the cut.
    const top = raycast(display, def, [5, 5, 50], [0, 0, -1])!.key;
    const before = service.pick({ key: top }, { before: cut }) as PickedEntity;
    expect(before).not.toBeNull();
    const plateOnly = structuredClone(doc);
    ((plateOnly.parts as Json[])[0]!.timeline as Json[]).splice(3);
    const shown = service.evaluate(plateOnly);
    const found = service.resolve(before.reference.entity, { part: d.partId });
    expect(found.outcome).toBe('same');
    expect(service.properties((found as { keys: Key[] }).keys[0]!)!.measures.area).toBeCloseTo(60 * 40, 6);
    expect(shown.pauses).toEqual([]);
  });

  it('picks a sketch curve, point or region for a feature being edited only where the part before it holds the sketch', () => {
    const { d, doc, extrude } = plate();
    const display = service.evaluate(doc);
    const timeline = (doc.parts as Json[])[0]!.timeline as Json[];
    const [holeSketch, cut] = [timeline[2]!.id as string, timeline[3]!.id as string];
    const sketch = display.definitions[display.parts[d.partId] as number]!.sketches.find(
      (s) => s.feature === holeSketch,
    )!;
    for (const key of [sketch.curves[0]!.key, sketch.points[0]!.key, sketch.regions[0]!.key]) {
      expect(service.pick({ key }, { before: extrude })).toBeNull();
      expect(service.pick({ key }, { before: holeSketch })).toBeNull();
      expect(service.pick({ key }, { before: cut })).not.toBeNull();
    }
  });
});

describe('a display that fails to build', { timeout: 60_000 }, () => {
  it('leaves no key of the display before it naming another entity', () => {
    const dd = new Docs();
    const a = dd.part('A');
    a.box('10 mm', '10 mm', '10 mm');
    const b = dd.part('B');
    b.box('30 mm', '30 mm', '30 mm');
    const doc = dd.document({ part: { id: a.id } });
    const first = service.evaluate(doc);
    const key = first.definitions[first.parts[a.id] as number]!.bodies[0]!.key;
    expect(service.bodyMeasures(key)!.volume).toBeCloseTo(1000, 6);

    // The same parts the other way round, the second body's mesh failing.
    (doc.parts as Json[]).reverse();
    const mesh = k.meshShape.bind(k);
    let calls = 0;
    k.meshShape = ((...args: Parameters<typeof mesh>) => {
      if (++calls === 2) throw new Error('meshing failed');
      return mesh(...args);
    }) as typeof k.meshShape;
    try {
      expect(() => service.evaluate(doc)).toThrow('meshing failed');
    } finally {
      k.meshShape = mesh;
    }
    expect(service.entities([key])).toEqual([]);
    expect(service.pick({ key })).toBeNull();
    expect(service.bodyMeasures(key)).toBeNull();
    // The next evaluate shows the document again.
    const again = service.evaluate(doc);
    expect(again.generation).toBeGreaterThan(first.generation);
    expect(again.pauses).toEqual([]);
  });
});

describe('display output', { timeout: 60_000 }, () => {
  it('meshes each face to the kernel area and each body to its volume, and every triangle and segment has a key', () => {
    const builds: Evaluation[] = [];
    const font = new Uint8Array(
      readFileSync(
        resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../../src/assets/fonts/LilitaOne-Regular.ttf'),
      ),
    );
    const evaluate = (doc: Json) => {
      const ev = evaluateDocument(doc, k, { solver: gcs });
      builds.push(ev);
      return ev;
    };
    const models = attachmentModels(k, gcs, font, evaluate, (ev) => builds.push(ev));
    const b = models.model(BASE);
    const display = service.evaluate(models.documentOf(b));
    expect(display.pauses).toEqual([]);
    const def = display.definitions[display.parts[b.d.partId]!]!;
    expect(def.bodies.length).toBeGreaterThan(0);
    let faces = 0;
    for (const body of def.bodies) {
      const { mesh } = body;
      let covered = 0;
      for (let i = 0; i < mesh.faces.length; i += 3) {
        const [first, count, key] = [mesh.faces[i]!, mesh.faces[i + 1]!, mesh.faces[i + 2]!];
        covered += count;
        expect(faceAt(mesh, first)).toBe(key);
        const area = service.properties(key)!.measures.area as number;
        expect(Math.abs(meshArea(mesh, first, count) - area)).toBeLessThanOrEqual(0.01 * area + 1e-6);
        faces++;
      }
      expect(covered).toBe(mesh.indices.length / 3);
      for (let i = 0; i < mesh.edges.length; i += 3) {
        expect(display.entities[mesh.edges[i + 2]!]!.kind).toBe('edge');
        expect(edgeAt(mesh, mesh.edges[i]!)).toBe(mesh.edges[i + 2]);
      }
      expect(mesh.segments.length / 6).toBe([...mesh.edges].filter((_, i) => i % 3 === 1).reduce((s, n) => s + n, 0));
      for (const key of mesh.vertices) expect(display.entities[key]!.kind).toBe('vertex');
      const volume = service.properties(body.key)!.measures.volume as number;
      expect(Math.abs(meshVolume(mesh) - volume)).toBeLessThanOrEqual(0.01 * volume);
    }
    expect(faces).toBeGreaterThan(30);
    // Sketches in the part frame: the boss sketch lies on the plate's top, its regions drawn there.
    const boss = def.sketches[1]!;
    expect(boss.frame.origin[2]).toBe(BASE.depth);
    expect(boss.curves.every((c) => c.points.length >= 6)).toBe(true);
    expect(boss.regions.length).toBe(1);
    expect(boss.regions[0]!.row).not.toBeNull();
    const zs = [...boss.regions[0]!.loops[0]!].filter((_, i) => i % 3 === 2);
    expect(zs.every((z) => z === BASE.depth)).toBe(true);
    for (const b2 of builds) b2.adapter.dispose();
  });

  it('gives each sketch the degrees of freedom its solve leaves, without points nothing uses', () => {
    const { doc } = plate();
    const display = service.evaluate(doc);
    const sketches = display.definitions[0]?.sketches ?? [];
    expect(sketches.map((s) => s.dof)).toEqual([0, 3]);
    // A point no curve or constraint names (what a trim leaves) adds nothing.
    const d = new DocBuilder();
    d.sketch('xy', (x) => {
      x.point(5, 5);
      const c = x.point(30, 20);
      x.fixed(c);
    });
    expect(service.evaluate(d.document()).definitions[0]?.sketches.map((s) => s.dof)).toEqual([0]);
  });

  it('shows a part at its rollback and draws construction curves of a sketch', () => {
    const { d, doc } = plate();
    const part = (doc.parts as Json[])[0]!;
    const timeline = part.timeline as Json[];
    const sketch = timeline[0]!.inputs as Json;
    const [a, b] = [(sketch.points as Json[])[0]!.id, (sketch.points as Json[])[2]!.id];
    (sketch.curves as Json[]).push({
      id: d.id('crv'),
      kind: 'line',
      construction: d.val('true'),
      origin: { drawn: {} },
      start: a,
      end: b,
    });
    part.rollback = { before: { id: timeline[3]!.id } };
    const display = service.evaluate(doc);
    const def = display.definitions[display.parts[d.partId]!]!;
    expect(def.rollback).toBe(timeline[3]!.id);
    // Before the cut: no hole, so no cylinder among the faces.
    const keys = [...def.bodies[0]!.mesh.faces].filter((_, i) => i % 3 === 2);
    expect(keys.some((key) => service.properties(key)!.measures.surface === 'cylinder')).toBe(false);
    expect(def.sketches[0]!.curves.filter((c) => c.construction).length).toBe(1);
    // The sketch region picks as its row's reference.
    const region = def.sketches[0]!.regions[0]!;
    const picked = service.pick({ key: region.key }) as PickedEntity;
    expect(service.resolve(picked.reference.entity, { part: d.partId })).toEqual({
      outcome: 'same',
      keys: [region.key],
    });
  });
});

describe('a feature that leaves several solids in one shape', { timeout: 60_000 }, () => {
  /** Two 10 mm squares, 10 mm apart, extruded together as new bodies: one shape holding two solids. */
  function twoSquares(): { d: DocBuilder; doc: Json } {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 10, 10);
      x.rect(20, 0, 10, 10);
    });
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1]), s.region([21, 1])], sides: [{ distance: '10 mm' }] });
    return { d, doc: d.document() };
  }

  const minX = (positions: Float32Array) => Math.min(...[...positions].filter((_, i) => i % 3 === 0));

  it('shows each solid as a body of its own: its key, name, mesh and pick tables', () => {
    const { doc } = twoSquares();
    const display = service.evaluate(doc);
    const bodies = display.definitions[0]!.bodies;
    expect(bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2']);
    expect(new Set(bodies.map((b) => b.key)).size).toBe(2);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(2);
    for (const body of bodies) {
      expect(display.entities[body.key]!.kind).toBe('body');
      const { mesh } = body;
      expect(meshVolume(mesh)).toBeCloseTo(1000, 0);
      // Every face, edge and vertex it draws lies on it.
      const faces = [...mesh.faces].filter((_, i) => i % 3 === 2);
      const edges = [...mesh.edges].filter((_, i) => i % 3 === 2);
      expect(faces).toHaveLength(6);
      expect(edges).toHaveLength(12);
      expect(mesh.vertices).toHaveLength(8);
      for (const key of [...faces, ...edges, ...mesh.vertices]) expect(display.entities[key]!.body).toBe(body.key);
    }
    // A body's identity holds in the next evaluation, though its key is new.
    const again = service.evaluate(doc).definitions[0]!.bodies;
    expect(again.map((b) => b.id)).toEqual(bodies.map((b) => b.id));
  });

  it('hides and colours one body of the shape alone, and exports either alone', () => {
    const { d, doc } = twoSquares();
    const first = service.evaluate(doc).definitions[0]!.bodies;
    const right = first.find((b) => minX(b.mesh.positions) > 15)!;
    const left = first.find((b) => b !== right)!;
    const picked = {
      right: service.pick({ key: right.key }) as PickedEntity,
      left: service.pick({ key: left.key }) as PickedEntity,
    };
    const part = (doc.parts as Json[])[0]!;
    (part.attributes as Json[]).push({
      id: d.id('attr'),
      target: picked.right.reference,
      properties: { visible: d.val('false') },
    });
    colour(d, doc, picked.left, '#ff0000');
    Object.assign(doc.names as Json, picked.right.names);
    readsClean(doc);
    const display = service.evaluate(doc);
    const bodies = display.definitions[0]!.bodies;
    const shownRight = bodies.find((b) => b.id === right.id)!;
    const shownLeft = bodies.find((b) => b.id === left.id)!;
    expect([shownLeft.visible, shownLeft.color]).toEqual([true, '#ff0000']);
    expect(shownRight.visible).toBe(false);
    expect(shownRight.color).not.toBe('#ff0000');
    // An export writes the shown body; asked for the hidden one, that one alone.
    const triangles = (stl: Uint8Array) => new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(triangles(service.exportFile('stl', { part: d.partId }))).toBe(shownLeft.mesh.indices.length / 3);
    // The hidden body is not meshed for the display; the export meshes it as it was meshed while shown.
    expect(shownRight.unmeshed).toBe(true);
    expect(triangles(service.exportFile('stl', { part: d.partId }, { bodies: [shownRight.key] }))).toBe(
      right.mesh.indices.length / 3,
    );
  });

  it('patterns the one body picked, not the other solid of its shape', () => {
    const { d, doc } = twoSquares();
    const right = service.evaluate(doc).definitions[0]!.bodies.find((b) => minX(b.mesh.positions) > 15)!;
    const picked = service.pick({ key: right.key }) as PickedEntity;
    d.feature('core.pattern', {
      of: { bodies: { set: [picked.reference] } },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: d.val('"y"'), reversed: d.val('false') } },
              count: d.val('3'),
              spacing: { equal: { s: d.val('20 mm') } },
            },
          ],
        },
      },
      skip: { set: [] },
      vary: [],
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const patterned = d.document();
    Object.assign(patterned.names as Json, picked.names);
    readsClean(patterned);
    const display = service.evaluate(patterned);
    expect(display.pauses).toEqual([]);
    const bodies = display.definitions[0]!.bodies;
    expect(bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Body 3', 'Body 4']);
    // The copies stand at the right square's x.
    expect(bodies.filter((b) => minX(b.mesh.positions) > 15)).toHaveLength(3);
    // The copies are numbered in the order the pattern made them, slot by slot.
    const minY = (positions: Float32Array) => Math.min(...[...positions].filter((_, i) => i % 3 === 1));
    expect(bodies.slice(2).map((b) => Math.round(minY(b.mesh.positions)))).toEqual([20, 40]);
  });
});

describe('a part before a feature', { timeout: 60_000 }, () => {
  /** A post (Body 1), a plate (Body 2) and a second post (Body 3), each its own extrude, then a cut of the plate by both posts. */
  function postsAndPlate(): { d: DocBuilder; doc: Json; cut: string } {
    const d = new DocBuilder();
    const box = (x: number, w: number, h: number) => {
      const s = d.sketch('xy', (sk) => sk.rect(x, 0, w, 10));
      d.extrude({ sketch: s.feature, profiles: [s.region([x + 1, 1])], sides: [{ distance: `${h} mm` }] });
    };
    box(0, 10, 20);
    box(0, 40, 10);
    box(30, 10, 20);
    const first = service.evaluate(d.document()).definitions[0]!.bodies;
    const picked = first.map((b) => service.pick({ key: b.key }) as PickedEntity);
    const cut = d.feature('core.boolean', {
      target: picked[1]!.reference,
      tools: { set: [picked[0]!.reference, picked[2]!.reference] },
      op: d.val('"cut"'),
      keepTools: d.val('false'),
    });
    const doc = d.document();
    for (const p of picked) Object.assign(doc.names as Json, p.names);
    return { d, doc, cut };
  }

  it('numbers a body by creation order in every state, so a cut leaves the plate named Body 2', () => {
    const { doc } = postsAndPlate();
    const display = service.evaluate(doc);
    expect(display.pauses).toEqual([]);
    const bodies = display.definitions[0]!.bodies;
    expect(bodies.map((b) => b.name)).toEqual(['Body 2']);
    expect(meshVolume(bodies[0]!.mesh)).toBeCloseTo(40 * 10 * 10 - 2 * 10 * 10 * 10, 0);
  });

  it('lists the bodies just before a feature by their names, and where stored references land there', () => {
    const { d, doc, cut } = postsAndPlate();
    const display = service.evaluate(doc);
    const plateId = display.definitions[0]!.bodies[0]!.id;
    const inputs = ((doc.parts as Json[])[0]!.timeline as Json[]).find((f) => f.id === cut)!.inputs as Json;
    const target = (inputs.target as Json).entity as EntityRecord;
    const tools = ((inputs.tools as Json).set as Json[]).map((r) => r.entity as EntityRecord);
    const gone: EntityRecord = { ...target, id: [...target.id.slice(0, -1), 'h'.repeat(target.id.at(-1)!.length)] };
    const before = service.bodiesBefore({ part: d.partId, feature: cut }, [target, ...tools, gone], { picks: true });
    expect(before.generation).toBe(display.generation);
    expect(before.bodies.map((b) => b.name)).toEqual(['Body 1', 'Body 2', 'Body 3']);
    expect(before.bodies[1]!.id).toBe(plateId);
    // The consumed posts get keys the display does not show; the picks write them as the state before the cut holds them.
    for (const b of before.bodies) expect(service.entities([b.key])[0]!.kind).toBe('body');
    expect(service.entities([before.bodies[0]!.key])[0]!.shown).toBe(false);
    expect(before.bodies.every((b) => b.picked !== undefined)).toBe(true);
    expect(before.references.map((r) => [r.found, r.kind, r.body])).toEqual([
      [true, 'body', plateId],
      [true, 'body', before.bodies[0]!.id],
      [true, 'body', before.bodies[2]!.id],
      [false, null, null],
    ]);
    // Before the first feature nothing is there; a known name still says what it named.
    const first = ((doc.parts as Json[])[0]!.timeline as Json[])[0]!.id as string;
    const empty = service.bodiesBefore({ part: d.partId, feature: first }, [target]);
    expect(empty.bodies).toEqual([]);
    expect(empty.references).toEqual([{ found: false, kind: 'body', body: null }]);
    // A feature the part does not hold stands at its rollback: here, the end of the timeline.
    expect(service.bodiesBefore({ part: d.partId, feature: 'feat_new' }).bodies.map((b) => b.name)).toEqual(['Body 2']);
  });

  it('draws stored references where they lie just before a feature: bodies the feature consumed, and an edge', () => {
    const { d, doc, cut } = postsAndPlate();
    const shown = service.evaluate(doc).definitions[0]!.bodies[0]!.mesh;
    // An edge of the plate, picked against the state before the cut, as a panel on the cut picks it.
    const keys = [...new Set(Array.from({ length: shown.segments.length / 6 }, (_, i) => edgeAt(shown, i)!))];
    const edge = keys.map((key) => service.pick({ key }, { before: cut })).find((p) => p !== null) as PickedEntity;
    const inputs = ((doc.parts as Json[])[0]!.timeline as Json[]).find((f) => f.id === cut)!.inputs as Json;
    const tools = ((inputs.tools as Json).set as Json[]).map((r) => r.entity as EntityRecord);
    const gone: EntityRecord = {
      ...tools[0]!,
      id: [...tools[0]!.id.slice(0, -1), 'h'.repeat(tools[0]!.id.at(-1)!.length)],
    };
    const outlines = service.outlinesBefore({ part: d.partId, feature: cut }, [
      ...tools,
      edge.reference.entity as EntityRecord,
      gone,
    ]);
    for (const o of outlines.slice(0, 2)) {
      expect(o?.kind).toBe('body');
      if (o?.kind === 'body') expect(meshVolume(o)).toBeCloseTo(10 * 10 * 20, 0);
    }
    const line = outlines[2];
    expect(line?.kind).toBe('edge');
    if (line?.kind === 'edge') expect(line.segments.length % 6).toBe(0);
    expect(outlines[3]).toBeNull();
  });
});

describe('measures', { timeout: 60_000 }, () => {
  it('measures between picked keys as core.measure does', () => {
    const { d, doc } = plate();
    const display = service.evaluate(doc);
    const def = display.parts[d.partId]!;
    const top = raycast(display, def, [5, 5, 50], [0, 0, -1])!.key;
    const bottom = raycast(display, def, [5, 5, -50], [0, 0, 1])!.key;
    expect(service.measure('distance', [top, bottom])).toEqual({ value: 10, quantity: 'length' });
    expect(service.measure('angle', [top, bottom])).toEqual({ value: 180, quantity: 'angle' });
    const area = service.measure('area', [top]) as { value: number };
    expect(area.value).toBeCloseTo(60 * 40 - Math.PI * 9, 6);
    const body = display.entities[top]!.body!;
    expect((service.measure('volume', [body]) as { value: number }).value).toBeCloseTo((60 * 40 - Math.PI * 9) * 10, 4);
    expect(service.measure('radius', [top])).toEqual({
      pause: 'a radius is measured on one circle, arc, cylinder or sphere',
    });
  });

  it('gives the curves a plane cuts from a body, and keeps no kernel shape for them', () => {
    const { d, doc } = plate();
    const display = service.evaluate(doc);
    const body = display.definitions[display.parts[d.partId]!]!.bodies[0]!.key;
    const frame = { origin: [0, 20, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] } as const;
    const cut = () =>
      service.externalCurves(body, 'intersect', {
        origin: [...frame.origin],
        x: [...frame.x],
        y: [...frame.y],
        normal: [...frame.normal],
      });
    const first = cut();
    // The plate's section through the hole: a rectangle either side of it, eight lines.
    expect('shapes' in first && first.shapes.length).toBe(8);
    const held = k.shapeCount;
    for (let i = 0; i < 3; i++) expect(cut()).toEqual(first);
    expect(k.shapeCount).toBe(held);
  });

  it("reads a body's volume, surface area, centre of mass and bounding box", () => {
    const { d, doc } = plate();
    const display = service.evaluate(doc);
    const top = raycast(display, display.parts[d.partId]!, [5, 5, 50], [0, 0, -1])!.key;
    const m = service.bodyMeasures(display.entities[top]!.body!)!;
    const hole = Math.PI * 9;
    expect(m.volume).toBeCloseTo((60 * 40 - hole) * 10, 4);
    expect(m.area).toBeCloseTo(2 * (60 * 40 - hole) + 2 * (60 + 40) * 10 + 2 * Math.PI * 3 * 10, 4);
    // The hole at x 45 pulls the centre of mass towards x < 30.
    const x = (60 * 40 * 30 - hole * 45) / (60 * 40 - hole);
    expect(close(m.centroid, [x, 20, 5], 1e-4)).toBe(true);
    expect(close(m.bbox[0], [0, 0, 0], 1e-4) && close(m.bbox[1], [60, 40, 10], 1e-4)).toBe(true);
    expect(service.bodyMeasures(top)).toBeNull();
  });
});

/** Two bodies: the plate, coloured red with one face green, and a box made by a feature coloured blue. */
function coloured(): { d: DocBuilder; doc: Json; display: Display } {
  const { d, doc } = plate();
  const s = d.sketch('xy', (x) => x.rect(100, 0, 10, 10));
  const box = d.extrude({ sketch: s.feature, profiles: [s.region([101, 1])], sides: [{ distance: '10 mm' }] });
  const built = d.document();
  Object.assign(doc, { parts: built.parts, names: built.names });
  let display = service.evaluate(doc);
  const def = display.parts[d.partId]!;
  const top = raycast(display, def, [5, 5, 50], [0, 0, -1])!.key;
  colour(d, doc, service.pick({ key: display.entities[top]!.body! }) as PickedEntity, '#ff0000');
  colour(d, doc, service.pick({ key: top }) as PickedEntity, '#00ff00');
  const part = (doc.parts as Json[])[0]!;
  (part.attributes as Json[]).push({
    id: d.id('attr'),
    target: { object: { feature: { id: box } } },
    properties: { color: d.val('"#0000ff"') },
  });
  readsClean(doc);
  display = service.evaluate(doc);
  return { d, doc, display };
}

/** The box of a flat list of x, y, z coordinates. */
function boundsOf(xyz: ArrayLike<number>): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < xyz.length; i += 3)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, xyz[i + c]!);
      max[c] = Math.max(max[c]!, xyz[i + c]!);
    }
  return { min, max };
}

describe('exports', { timeout: 60_000 }, () => {
  it('writes STL with every display triangle', () => {
    const { d, display } = coloured();
    const triangles = display.definitions[display.parts[d.partId]!]!.bodies.reduce(
      (s, b) => s + b.mesh.indices.length / 3,
      0,
    );
    const stl = service.exportFile('stl', { part: d.partId });
    const count = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
    expect(stl.length).toBe(84 + 50 * count);
    expect(count).toBe(triangles);
  });

  it('writes STL and 3MF standing on Z, as slicers lay them out', () => {
    // A 10 x 20 block on the ground plane, 30 mm tall along the model's up (+Y).
    const d = new DocBuilder();
    const s = d.sketch('xz', (x) => x.rect(0, 0, 10, 20));
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '30 mm' }] });
    const doc = d.document();
    const own = new EvaluationService(k, gcs);
    try {
      const display = own.evaluate(doc);
      const part = (doc.parts as Json[])[0]!.id as string;
      const [body] = display.definitions[display.parts[part]!]!.bodies;
      const model = boundsOf(body!.mesh.positions);
      // The model stands 30 mm on Y.
      expect(model.max[1] - model.min[1]).toBeCloseTo(30, 3);
      const stl = own.exportFile('stl', { part });
      const view = new DataView(stl.buffer, stl.byteOffset);
      const points: number[] = [];
      for (let t = 0; t < view.getUint32(80, true); t++)
        for (let v = 0; v < 3; v++)
          for (let c = 0; c < 3; c++) points.push(view.getFloat32(84 + 50 * t + 12 + 12 * v + 4 * c, true));
      const files = unzip(own.exportFile('3mf', { part }, { name: 'Block' }));
      const vertices = [
        ...files.get('3D/3dmodel.model')!.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g),
      ].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
      for (const written of [boundsOf(points), boundsOf(vertices)]) {
        // Up is Z, from the ground at 0; the model's front (+Z) is the bed's front (-Y).
        expect(written.min[2]).toBeCloseTo(model.min[1], 3);
        expect(written.max[2]).toBeCloseTo(model.max[1], 3);
        expect(written.min[1]).toBeCloseTo(-model.max[2], 3);
        expect(written.max[1]).toBeCloseTo(-model.min[2], 3);
        expect(written.min[0]).toBeCloseTo(model.min[0], 3);
      }
    } finally {
      own.release();
    }
  });

  it('writes 3MF with closed meshes, each body on its colour slot and a face colour on its triangles', () => {
    const { d, display } = coloured();
    const bodies = display.definitions[display.parts[d.partId]!]!.bodies;
    expect(bodies.map((b) => b.color)).toEqual(['#ff0000', '#0000ff']);
    const files = unzip(service.exportFile('3mf', { part: d.partId }, { name: 'Plate' }));
    const model = files.get('3D/3dmodel.model')!;
    expect(model.match(/<m:colorgroup /g)?.length).toBe(3);
    const settings = files.get('Metadata/model_settings.config')!;
    expect([...settings.matchAll(/key="extruder" value="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '1', '2']);
    for (const object of model
      .split('<object ')
      .slice(1)
      .filter((o) => o.includes('<mesh>'))) {
      // Welded: every edge is shared by exactly two triangles.
      const uses = new Map<string, number>();
      for (const t of object.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
        const [a, b, c] = [Number(t[1]), Number(t[2]), Number(t[3])];
        for (const [p, q] of [
          [a, b],
          [b, c],
          [c, a],
        ] as [number, number][]) {
          const e = p < q ? `${p},${q}` : `${q},${p}`;
          uses.set(e, (uses.get(e) ?? 0) + 1);
        }
      }
      expect([...uses.values()].every((n) => n === 2)).toBe(true);
    }
    // The green face's triangles carry the green group (id 3: red and blue are the body colours, then green).
    const green = bodies[0]!.faceStyles[0]!;
    expect(green.color).toBe('#00ff00');
    const range = [...bodies[0]!.mesh.faces].findIndex((v, i) => i % 3 === 2 && v === green.key);
    const greenTriangles = bodies[0]!.mesh.faces[range - 1]!;
    expect(model.match(/pid="3" p1="0"/g)?.length).toBe(greenTriangles);
  });

  it('writes STEP that reads back with its volume and colours, and BREP with its volume', () => {
    const { d, display } = coloured();
    const volume = display.definitions[display.parts[d.partId]!]!.bodies.reduce(
      (s, b) => s + (service.properties(b.key)!.measures.volume as number),
      0,
    );
    const step = new TextDecoder().decode(service.exportFile('step', { part: d.partId }));
    const back = k.importStep(step);
    expect(k.getVolume(back)).toBeCloseTo(volume, 3);
    const xcaf = k.importXCAFFromSTEP(step);
    try {
      const colours = xcaf
        .getRoots()
        .map((r) => xcaf.getLabelInfo(r))
        .map((i) => (i.color ? i.color.map((c) => Math.round(c * 255)) : null));
      expect(colours).toEqual([
        [255, 0, 0],
        [0, 0, 255],
      ]);
    } finally {
      xcaf.close();
    }
    const brep = k.fromBREPBinary(service.exportFile('brep', { part: d.partId }));
    expect(k.getVolume(brep)).toBeCloseTo(volume, 6);
  });
});

describe('assemblies', { timeout: 60_000 }, () => {
  it('draws instances of one part from one mesh at their placements, and picks a face through an instance', () => {
    const dd = new Docs();
    const part = dd.part('Block');
    part.box('20 mm', '10 mm', '5 mm');
    const a = dd.assembly('Pair');
    a.instance({ part: { id: part.id } }, { grounded: true });
    const second = a.instance({ part: { id: part.id } }, { at: [50, 0, 0], turnZ: 90 });
    const apart = a.exploded('Apart', [{ instances: [pathOf(instancePath(second))], at: [0, 0, 30] }]);
    const doc = dd.document({ assembly: { id: a.id } });
    readsClean(doc);
    const display = service.evaluate(doc);
    expect(display.pauses).toEqual([]);
    const asm = display.assemblies[0]!;
    expect(asm.instances.length).toBe(2);
    expect(new Set(asm.instances.map((i) => i.definition)).size).toBe(1);
    expect(asm.instances[1]!.path).toEqual({ path: [{ instance: { id: second } }] });
    expect(close(asm.instances[1]!.placement.position, [50, 0, 0])).toBe(true);
    // The exploded view lifts the second block and leaves the first.
    expect(close(asm.exploded[apart]![1]!.position, [50, 0, 30])).toBe(true);
    expect(close(asm.exploded[apart]![0]!.position, [0, 0, 0])).toBe(true);
    // The matrix turns x onto y and moves by the placement.
    const m = matrixOf(asm.instances[1]!.placement);
    expect(close([m[0]!, m[1]!, m[2]!, m[12]!, m[13]!, m[14]!], [0, 1, 0, 50, 0, 0])).toBe(true);

    // The +x end of the block, picked on the second instance.
    const def = display.definitions[asm.instances[1]!.definition]!;
    const end = [...def.bodies[0]!.mesh.faces]
      .filter((_, i) => i % 3 === 2)
      .find((key) => close(service.properties(key)!.measures.normal as number[], [1, 0, 0]))!;
    const picked = service.pick({ key: end, instance: { assembly: a.id, index: 1 } }) as PickedEntity;
    const found = service.resolve(picked.reference.entity as EntityRecord, { assembly: a.id });
    expect(found.outcome).toBe('same');
    expect(found.instances).toEqual([{ index: 1, key: end }]);
    // In the assembly frame the end faces +y, half the block's 20 mm out from the second block's origin (a box is centred on its frame).
    const placed = service.properties((found as { keys: Key[] }).keys[0]!)!.measures;
    expect(close(placed.normal as number[], [0, 1, 0])).toBe(true);
    expect(close(placed.centroid as number[], [50, 10, 0])).toBe(true);

    // Measures read instances where they are placed: the two blocks' +x ends, one turned onto +y.
    const across = service.measure('angle', [
      { key: end, instance: { assembly: a.id, index: 0 } },
      { key: end, instance: { assembly: a.id, index: 1 } },
    ]);
    expect((across as { value: number }).value).toBeCloseTo(90, 9);
    expect(service.measure('distance', [end, { key: end, instance: { assembly: a.id, index: 1 } }])).toEqual({
      pause: 'the measured entities lie in different builds',
    });

    // Exports place each instance.
    const brep = k.fromBREPBinary(service.exportFile('brep', { assembly: a.id }));
    expect(k.getVolume(brep)).toBeCloseTo(2 * 20 * 10 * 5, 6);
  });

  it('writes a pick through an instance in the frame of another, and keeps no kernel shape for it', () => {
    const dd = new Docs();
    const part = dd.part('Block');
    part.box('20 mm', '10 mm', '5 mm');
    const a = dd.assembly('Pair');
    a.instance({ part: { id: part.id } }, { grounded: true });
    const second = a.instance({ part: { id: part.id } }, { at: [50, 0, 0], turnZ: 90 });
    const display = service.evaluate(dd.document({ assembly: { id: a.id } }));
    const def = display.definitions[display.assemblies[0]!.instances[1]!.definition]!;
    const end = [...def.bodies[0]!.mesh.faces]
      .filter((_, i) => i % 3 === 2)
      .find((key) => close(service.properties(key)!.measures.normal as number[], [1, 0, 0]))!;
    const pick = () =>
      service.pick(
        { key: end, instance: { assembly: a.id, index: 1 } },
        { frameOf: pathOf(instancePath(second)) },
      ) as PickedEntity;
    const snapshot = pick().reference.entity.snapshot;
    // Read in the second block's own frame, its +x end is where the part has it.
    expect(close(snapshot.normal as number[], [1, 0, 0])).toBe(true);
    expect(close(snapshot.centroid as number[], [10, 0, 0])).toBe(true);
    const held = k.shapeCount;
    for (let i = 0; i < 3; i++) expect(pick().reference.entity.snapshot).toEqual(snapshot);
    expect(k.shapeCount).toBe(held);
  });

  it("keeps a subassembly's own instance attributes where it is placed, under the outer assembly's", () => {
    const dd = new Docs();
    const part = dd.part('Block');
    part.box('20 mm', '10 mm', '5 mm');
    const inner = dd.assembly('Inner');
    const first = inner.instance({ part: { id: part.id } }, { grounded: true });
    const second = inner.instance({ part: { id: part.id } }, { at: [50, 0, 0] });
    const attr = (path: Json[], properties: Json) => ({
      id: dd.id('attr'),
      target: { object: { instance: { path } } },
      properties,
    });
    (inner.json.attributes as Json[]).push(
      attr([instancePath(second)], { visible: dd.val('false'), color: dd.val('"#ff0000"') }),
      attr([instancePath(first)], { color: dd.val('"#00ff00"') }),
    );
    const outer = dd.assembly('Outer');
    const placed = outer.instance({ assembly: { id: inner.id } }, { grounded: true });
    (outer.json.attributes as Json[]).push(
      attr([instancePath(placed), instancePath(first)], { color: dd.val('"#0000ff"') }),
    );
    const doc = dd.document({ assembly: { id: outer.id } });
    readsClean(doc);
    const display = service.evaluate(doc);
    expect(display.pauses).toEqual([]);
    const shown = (id: string) =>
      display.assemblies.find((x) => x.id === id)!.instances.map((i) => ({ visible: i.visible, override: i.override }));
    expect(shown(inner.id)).toEqual([
      { visible: true, override: { color: '#00ff00' } },
      { visible: false, override: { color: '#ff0000' } },
    ]);
    expect(shown(outer.id)).toEqual([
      { visible: true, override: { color: '#0000ff' } },
      { visible: false, override: { color: '#ff0000' } },
    ]);
    // The hidden block is not exported.
    const brep = k.fromBREPBinary(service.exportFile('brep', { assembly: outer.id }));
    expect(k.getVolume(brep)).toBeCloseTo(20 * 10 * 5, 6);
  });
});

describe("locating another program's edges", { timeout: 60_000 }, () => {
  it("finds a cylinder's circular rims, whatever point the other shape starts them at", () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.circle(0, 0, 5));
    d.extrude({ sketch: s.feature, profiles: [s.region([0, 0])], sides: [{ distance: '10 mm' }] });
    const doc = d.document();
    const part = ((doc.parts as Json[])[0] as Json).id as string;
    expect(service.evaluate(doc).pauses).toEqual([]);
    const body = k.fromBREPBinary(service.exportFile('brep', { part }));
    const turned = k.rotate(body, { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, Math.PI / 6);
    try {
      // Two rims and a seam; turned, the seam lies elsewhere and only the rims match.
      const found = (shape: number) => service.locate(part, undefined, k.toBREP(shape), 'edge', 'all');
      const same = found(body);
      expect(same).toHaveLength(3);
      expect(same.every((f) => f !== null)).toBe(true);
      const rims = found(turned).filter((f) => f !== null);
      expect(rims).toHaveLength(2);
      expect(new Set(rims.map((f) => JSON.stringify(f.reference))).size).toBe(2);
    } finally {
      k.release(turned);
      k.release(body);
    }
  });
});

describe("locating another program's faces", { timeout: 60_000 }, () => {
  const probe = (x: number) => k.translate(k.makeBox(4, 4, 10), x, 0, 0);

  it('takes the one planar face on the same plane when a face is trimmed otherwise', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(-10, -10, 20, 20));
    d.extrude({ sketch: s.feature, profiles: [s.region([0, 0])], sides: [{ distance: '10 mm' }] });
    const doc = d.document();
    const part = ((doc.parts as Json[])[0] as Json).id as string;
    expect(service.evaluate(doc).pauses).toEqual([]);
    const shape = probe(0);
    try {
      const found = service.locate(part, undefined, k.toBREP(shape), 'face', 'all').filter((f) => f !== null);
      // Its top and bottom lie on the block's; its sides on nothing.
      expect(found).toHaveLength(2);
      expect(new Set(found.map((f) => JSON.stringify(f.reference))).size).toBe(2);
    } finally {
      k.release(shape);
    }
  });

  it('leaves a face lost when two lie on its plane', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(-10, -10, 5, 20);
      x.rect(5, -10, 5, 20);
    });
    d.extrude({ sketch: s.feature, profiles: [s.region([-7, 0]), s.region([7, 0])], sides: [{ distance: '10 mm' }] });
    const doc = d.document();
    const part = ((doc.parts as Json[])[0] as Json).id as string;
    expect(service.evaluate(doc).pauses).toEqual([]);
    const shape = probe(-2);
    try {
      expect(service.locate(part, undefined, k.toBREP(shape), 'face', 'all').filter((f) => f !== null)).toEqual([]);
    } finally {
      k.release(shape);
    }
  });
});

describe('freezing a feature', { timeout: 60_000 }, () => {
  it('returns the frozen field with its assets and names, apart from the kept evaluation', () => {
    const { doc, extrude } = plate();
    const before = service.evaluate(doc);
    const frozen = service.freeze(doc, extrude);
    if (!frozen.ok) throw new Error(frozen.message);
    expect(Object.keys(frozen.frozen)).toEqual(['frozen']);
    expect(Object.keys(frozen.assets).length).toBeGreaterThan(0);
    // The kept evaluation is untouched: its keys still answer.
    expect(service.properties(before.definitions[0]!.bodies[0]!.mesh.faces[2]!)).not.toBeNull();

    // Written into the document, the frozen plate keeps its width when the sketch widens.
    const next = structuredClone(doc);
    const row = ((next.parts as Json[])[0]!.timeline as Json[]).find((f) => f.id === extrude)!;
    row.frozen = frozen.frozen;
    Object.assign(next.assets as Json, frozen.assets);
    Object.assign(next.names as Json, frozen.names);
    readsClean(next);
    setWidth(next, 80);
    const display = service.evaluate(next);
    expect(display.pauses).toEqual([]);
    expect(meshVolume(display.definitions[0]!.bodies[0]!.mesh)).toBeCloseTo(60 * 40 * 10 - Math.PI * 9 * 10, 0);

    // A sketch cannot be frozen; it says why.
    const sketch = ((doc.parts as Json[])[0]!.timeline as Json[])[0]!.id as string;
    expect(service.freeze(doc, sketch)).toEqual({ ok: false, message: 'a core.sketch feature cannot be frozen' });
  });
});

describe('progress', { timeout: 60_000 }, () => {
  it('reports reading, each feature before it builds with its name and count, and each body it meshes', () => {
    const { doc } = plate();
    const own = new EvaluationService(k, gcs);
    try {
      const seen: Progress[] = [];
      own.evaluate(doc, {}, (p) => seen.push(p));
      expect(seen[0]).toEqual({ phase: 'reading' });
      const timeline = (doc.parts as Json[])[0]!.timeline as Json[];
      const building = () =>
        seen.flatMap((p) => (p.phase === 'building' ? [[p.done, p.total, p.kept, p.feature, p.name]] : []));
      expect(building()).toEqual(timeline.map((f, i) => [i, 4, 0, f.id, f.name]));
      expect(seen.flatMap((p) => (p.phase === 'meshing' ? [[p.done, p.total]] : []))).toEqual([[0, 1]]);
      expect(seen.some((p) => p.phase === 'placing')).toBe(false);

      // The plate made deeper: the sketch before it is kept, and the three from it on build, counted after it.
      const deeper = structuredClone(doc);
      const side = (((deeper.parts as Json[])[0]!.timeline as Json[])[1]!.inputs as Json).sides as Json[];
      ((((side[0]!.extent as Json).distance as Json).d as Json).def as Json).expr = {
        text: '12 mm',
        grammar: 1,
        refs: {},
      };
      seen.length = 0;
      own.evaluate(deeper, {}, (p) => seen.push(p));
      expect(building()).toEqual(timeline.slice(1).map((f, i) => [i + 1, 4, 1, f.id, f.name]));
    } finally {
      own.release();
    }
  });

  it('reports the placement of an assembly between building and meshing', () => {
    const dd = new Docs();
    const part = dd.part('Block');
    part.box('20 mm', '10 mm', '5 mm');
    const a = dd.assembly('Pair');
    a.instance({ part: { id: part.id } }, { grounded: true });
    a.instance({ part: { id: part.id } }, { at: [50, 0, 0] });
    const doc = dd.document({ assembly: { id: a.id } });
    const own = new EvaluationService(k, gcs);
    try {
      const seen: string[] = [];
      own.evaluate(doc, {}, (p) => seen.push(p.phase));
      expect(seen.indexOf('placing')).toBeGreaterThan(seen.lastIndexOf('building'));
      expect(seen.indexOf('meshing')).toBeGreaterThan(seen.indexOf('placing'));
    } finally {
      own.release();
    }
  });
});

describe('a change only to what is shown', { timeout: 60_000 }, () => {
  /** Two 10 mm cubes side by side, one body each. */
  function twoCubes(): { d: DocBuilder; doc: Json } {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => {
      x.rect(0, 0, 10, 10);
      x.rect(20, 0, 10, 10);
    });
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])] });
    d.extrude({ sketch: s.feature, profiles: [s.region([21, 1])] });
    return { d, doc: d.document() };
  }

  /** `doc` with an attribute setting `property` on a picked body, and the names its target needs. */
  function withAttribute(d: DocBuilder, doc: Json, picked: PickedEntity, property: string, text: string): Json {
    const next = structuredClone(doc);
    const part = (next.parts as Json[])[0]!;
    part.attributes = [
      ...(part.attributes as Json[]),
      { id: d.id('attr'), target: picked.reference, properties: { [property]: d.val(text) } },
    ];
    next.names = { ...(next.names as Json), ...picked.names };
    return next;
  }

  const styleOf = (display: Display) =>
    display.definitions[0]!.bodies.map((b) => [b.id, b.key, b.visible, b.color, b.name]);
  /** The geometries a client given `display` holds. */
  const heldBy = (display: Display) =>
    display.definitions.flatMap((def) =>
      def.bodies.flatMap((b) => (b.geometry === undefined || b.unmeshed ? [] : [b.geometry])),
    );

  it('shows it from the kept evaluation with the same keys, meshing no body the client holds', () => {
    const { d, doc } = twoCubes();
    const own = new EvaluationService(k, gcs);
    try {
      const first = own.evaluate(doc);
      const kept = own.evaluation;
      const [a, b] = first.definitions[0]!.bodies;
      const picked = own.pick({ key: b!.key }) as PickedEntity;
      const hidden = withAttribute(d, doc, picked, 'visible', 'false');
      readsClean(hidden);
      const hide = own.evaluate(hidden, { restyle: first.generation, held: heldBy(first) });
      // Nothing was evaluated: the same evaluation, and every key of the display before names what it did.
      expect(own.evaluation).toBe(kept);
      expect(hide.restyled).toBe(first.generation);
      expect(hide.timing.evaluate).toBe(0);
      expect(hide.entities).toEqual(first.entities);
      // Both bodies' geometries are the client's already; their pick tables come again, with the same keys.
      expect(hide.definitions[0]!.bodies.map((x) => [x.kept, x.mesh.indices.length])).toEqual([
        [true, 0],
        [true, 0],
      ]);
      expect(hide.definitions[0]!.bodies.map((x) => [...x.mesh.faces])).toEqual(
        first.definitions[0]!.bodies.map((x) => [...x.mesh.faces]),
      );
      // As a full evaluation of the document shows it, keys apart.
      const plain = new EvaluationService(k, gcs);
      try {
        const full = plain.evaluate(hidden);
        expect(styleOf(hide).map(([id, , ...rest]) => [id, ...rest])).toEqual(
          styleOf(full).map(([id, , ...rest]) => [id, ...rest]),
        );
        expect(full.definitions[0]!.bodies.find((x) => x.id === b!.id)!.unmeshed).toBe(true);
      } finally {
        plain.release();
      }
      // Coloured, then shown again: still nothing evaluated.
      const red = own.evaluate(
        withAttribute(d, hidden, own.pick({ key: a!.key }) as PickedEntity, 'color', '"#ff0000"'),
        { restyle: hide.generation },
      );
      expect(red.restyled).toBe(hide.generation);
      expect(styleOf(red)).toEqual([
        [a!.id, a!.key, true, '#ff0000', 'Body 1'],
        [b!.id, b!.key, false, b!.color, 'Body 2'],
      ]);
      const back = own.evaluate(doc, { restyle: red.generation });
      expect(back.restyled).toBe(red.generation);
      expect(styleOf(back)).toEqual(styleOf(first));
    } finally {
      own.release();
    }
  });

  it('meshes a body hidden since the keys were handed out alone, once it shows', () => {
    const { d, doc } = twoCubes();
    const own = new EvaluationService(k, gcs);
    try {
      const first = own.evaluate(doc);
      const b = first.definitions[0]!.bodies[1]!;
      const hidden = withAttribute(d, doc, own.pick({ key: b.key }) as PickedEntity, 'visible', 'false');
      const start = own.evaluate(hidden);
      expect(start.restyled).toBeUndefined();
      expect(start.definitions[0]!.bodies.map((x) => [!!x.unmeshed, x.mesh.indices.length > 0])).toEqual([
        [false, true],
        [true, false],
      ]);
      const shown = own.evaluate(doc, { restyle: start.generation, held: heldBy(start) });
      expect(shown.restyled).toBe(start.generation);
      const [ka, kb] = shown.definitions[0]!.bodies;
      expect([ka!.kept, kb!.kept, kb!.unmeshed]).toEqual([true, undefined, undefined]);
      expect(meshVolume(kb!.mesh)).toBeCloseTo(1000, 0);
      // Its faces have keys of this evaluation, which pick.
      const face = kb!.mesh.faces[2]!;
      expect(shown.entities[face]!.body).toBe(kb!.key);
      expect(own.pick({ key: face })).not.toBeNull();
    } finally {
      own.release();
    }
  });

  it('evaluates when the kept evaluation is not that display, and shows a moved rollback from the kept one', () => {
    const { d, doc } = twoCubes();
    const own = new EvaluationService(k, gcs);
    try {
      const first = own.evaluate(doc);
      // A stale generation: evaluated.
      const second = own.evaluate(doc);
      const stale = own.evaluate(
        withAttribute(
          d,
          doc,
          own.pick({ key: second.definitions[0]!.bodies[0]!.key }) as PickedEntity,
          'visible',
          'false',
        ),
        { restyle: first.generation },
      );
      expect(stale.restyled).toBeUndefined();
      expect(stale.timing.resumed).toBe(3);
      // A rollback moved: the state before the second cube, from the kept evaluation, with keys of the display before still naming what they did.
      const kept = own.evaluation;
      const rolled = structuredClone(doc);
      (rolled.parts as Json[])[0]!.rollback = {
        before: { id: ((rolled.parts as Json[])[0]!.timeline as Json[])[2]!.id },
      };
      const back = own.evaluate(rolled, { restyle: stale.generation, held: heldBy(stale) });
      expect(back.restyled).toBe(stale.generation);
      expect(own.evaluation).toBe(kept);
      expect(back.definitions[0]!.rollback).toBe(((rolled.parts as Json[])[0]!.timeline as Json[])[2]!.id);
      expect(back.definitions[0]!.bodies.map((x) => x.id)).toEqual([stale.definitions[0]!.bodies[0]!.id]);
      const named = (e: EntityInfo) => ({ ...e, shown: undefined });
      expect(back.entities.slice(0, stale.entities.length).map(named)).toEqual(stale.entities.map(named));
      // What it shows is marked again: none of the second cube's entities is.
      const secondCube = ((doc.parts as Json[])[0]!.timeline as Json[])[2]!.id;
      const rolledAway = back.entities.filter((e) => e.feature === secondCube);
      expect(rolledAway.length).toBeGreaterThan(0);
      expect(rolledAway.some((e) => e.shown)).toBe(false);
      // And to the end again.
      const end = own.evaluate(doc, { restyle: back.generation, held: heldBy(back) });
      expect(end.restyled).toBe(back.generation);
      expect(end.definitions[0]!.rollback).toBeNull();
      expect(end.definitions[0]!.bodies).toHaveLength(2);
    } finally {
      own.release();
    }
  });

  it('sends a body an edit left alone with the geometry the client holds, and new pick tables', () => {
    const { doc } = twoCubes();
    const own = new EvaluationService(k, gcs);
    try {
      const first = own.evaluate(doc);
      const longer = structuredClone(doc);
      const timeline = (longer.parts as Json[])[0]!.timeline as Json[];
      timeline[2] = JSON.parse(JSON.stringify(timeline[2]).replace(/"text":"\d+ mm"/, '"text":"15 mm"')) as Json;
      const next = own.evaluate(longer, { held: heldBy(first) });
      expect(next.restyled).toBeUndefined();
      expect(next.timing.resumed).toBe(2);
      const [a, b] = next.definitions[0]!.bodies;
      const [a0, b0] = first.definitions[0]!.bodies;
      // The first cube is the same shape: its geometry is the client's, its pick tables come with keys of this display.
      expect([a!.kept, a!.geometry, a!.mesh.indices.length]).toEqual([true, a0!.geometry, 0]);
      expect(a!.mesh.faces.length).toBe(a0!.mesh.faces.length);
      const face = a!.mesh.faces[2]!;
      expect(next.entities[face]!.body).toBe(a!.key);
      expect(own.pick({ key: face })).not.toBeNull();
      // The second, made again, comes whole.
      expect(b!.kept).toBeUndefined();
      expect(b!.geometry).not.toBe(b0!.geometry);
      expect(meshVolume(b!.mesh)).toBeCloseTo(1500, 0);
      // Without the client holding it, the first comes whole as well.
      const whole = own.evaluate(doc);
      expect(whole.definitions[0]!.bodies.map((x) => [x.kept, x.mesh.indices.length > 0])).toEqual([
        [undefined, true],
        [undefined, true],
      ]);
    } finally {
      own.release();
    }
  });

  it('builds a preview only up to its rollback, and resumes a cancelled one from the committed evaluation', () => {
    const { doc } = twoCubes();
    const own = new EvaluationService(k, gcs);
    const partOf = (x: Json) => (x.parts as Json[])[0]!;
    const timelineOf = (x: Json) => partOf(x).timeline as Json[];
    /** `doc` with the first cube 15 mm tall, optionally rolled back to just after it. */
    const taller = (rolled: boolean) => {
      const next = structuredClone(doc);
      const timeline = timelineOf(next);
      timeline[1] = JSON.parse(JSON.stringify(timeline[1]).replace(/"text":"\d+ mm"/, '"text":"15 mm"')) as Json;
      if (rolled) partOf(next).rollback = { before: { id: timeline[2]!.id } };
      return next;
    };
    try {
      const first = own.evaluate(doc);
      // The preview builds the first cube again and stops before the second.
      const preview = own.evaluate(taller(true), { preview: true });
      expect(preview.timing.resumed).toBe(1);
      expect(own.evaluation!.parts.get(partOf(doc).id as string)!.state.bodies.size).toBe(1);
      expect(preview.definitions[0]!.bodies.map((b) => b.id)).toEqual([first.definitions[0]!.bodies[0]!.id]);
      expect(meshVolume(preview.definitions[0]!.bodies[0]!.mesh)).toBeCloseTo(1500, 0);
      // A second preview resumes from the first.
      const again = own.evaluate(taller(true), { preview: true });
      expect(again.timing.resumed).toBe(2);
      // Cancelled: the committed document takes every feature over from the committed evaluation.
      const back = own.evaluate(doc);
      expect(back.timing.resumed).toBe(3);
      expect(back.definitions[0]!.bodies).toHaveLength(2);
      // Committed: the preview's features are taken over, the second cube built.
      own.evaluate(taller(true), { preview: true });
      const done = own.evaluate(taller(false));
      expect(done.timing.resumed).toBe(2);
      expect(done.definitions[0]!.bodies.map((b) => Math.round(meshVolume(b.mesh)))).toEqual([1500, 1000]);
      // A preview's display is not restyled into the whole document: it is evaluated.
      const shown = own.evaluate(taller(true), { preview: true });
      // Nor is a preview a document to export.
      expect(() => own.exportFreeCad()).toThrow('a feature is being edited');
      const restyled = own.evaluate(taller(false), { restyle: shown.generation });
      expect(restyled.restyled).toBeUndefined();
      expect(restyled.definitions[0]!.bodies).toHaveLength(2);
    } finally {
      own.release();
    }
  });

  it('resumes a preview of an unchanged part only up to its rollback, as it builds one afresh', () => {
    const { doc } = twoCubes();
    const part = (doc.parts as Json[])[0]!;
    const rolled = structuredClone(doc);
    (rolled.parts as Json[])[0]!.rollback = { before: { id: (part.timeline as Json[])[2]!.id } };
    const own = new EvaluationService(k, gcs);
    try {
      own.evaluate(doc);
      const preview = own.evaluate(rolled, { preview: true });
      expect(preview.timing.resumed).toBe(2);
      expect(own.evaluation!.parts.get(part.id as string)!.state.bodies.size).toBe(1);
    } finally {
      own.release();
    }
  });

  it('evaluates a change to an attribute and a feature together, though asked to restyle it', () => {
    const { d, doc } = twoCubes();
    const own = new EvaluationService(k, gcs);
    try {
      const first = own.evaluate(doc);
      const [a] = first.definitions[0]!.bodies;
      const both = withAttribute(d, doc, own.pick({ key: a!.key }) as PickedEntity, 'color', '"#ff0000"');
      // In the same change the second extrude takes the first square too: a reference, no value, changes.
      const timeline = (both.parts as Json[])[0]!.timeline as Json[];
      (timeline[2]!.inputs as Json).profiles = structuredClone((timeline[1]!.inputs as Json).profiles);
      const shown = own.evaluate(both, { restyle: first.generation });
      expect(shown.restyled).toBeUndefined();
      // Nothing stands on the second square any more.
      const minX = (m: Float32Array) => Math.min(...[...m].filter((_, i) => i % 3 === 0));
      expect(shown.definitions[0]!.bodies.every((x) => minX(x.mesh.positions) < 15)).toBe(true);
    } finally {
      own.release();
    }
  });
});

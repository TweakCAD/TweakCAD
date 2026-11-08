/**
 * The adapter's contract with occt-wasm, against the real kernel. Each case
 * pins something the naming engine relies on, so a kernel bump that changes an
 * answer fails here first. Expected values come from the models' own numbers.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BooleanOp, OcctKernel, type EvolutionData, type ShapeHandle } from 'occt-wasm';
import type { OperationHistory, ShapeKey, ShapeRef, Vec3 } from '@tweakcad/format';
import { HASH_BOUND, NamingAdapter, NamingAdapterError } from './namingAdapter.ts';
import { decodeRunLength } from './namingAdapterHistory.ts';
import { cross, dot, sub } from './namingAdapterGeometry.ts';

let k: OcctKernel;
let adapter: NamingAdapter;

beforeAll(async () => {
  k = await OcctKernel.init();
});

function start(hashBound?: number): NamingAdapter {
  adapter = new NamingAdapter(k, hashBound);
  return adapter;
}

afterEach(() => {
  adapter?.dispose();
  k.releaseAll();
});

const box = (x: number, y: number, z: number, a: number, b: number, c: number): ShapeHandle =>
  k.makeBoxFromCorners({ x, y, z }, { x: x + a, y: y + b, z: z + c });

const close = (a: readonly number[], b: readonly number[], digits = 9): void => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, digits));
};

/** Keys of a shape's faces whose centroid passes a test. */
function facesWhere(ref: ShapeRef, test: (c: Vec3) => boolean): ShapeKey[] {
  return adapter.topology(ref).faces.filter((face) => test(adapter.measures(face).centroid as Vec3));
}

function faceAt(ref: ShapeRef, centroid: Vec3): ShapeKey {
  const found = facesWhere(ref, (c) => Math.hypot(c[0] - centroid[0], c[1] - centroid[1], c[2] - centroid[2]) < 1e-6);
  expect(found).toHaveLength(1);
  return found[0] as ShapeKey;
}

/** The input keys that an operation's result is built from, checked for the rule that every key exists. */
function expectKeysExist(history: OperationHistory): void {
  const inputs = history.inputs.map((input) => adapter.topology(input.shape));
  const inFaces = new Set(inputs.flatMap((t) => t.faces));
  const inEdges = new Set(inputs.flatMap((t) => t.edges.map((e) => e.edge)));
  const result = adapter.topology(history.result);
  const outFaces = new Set(result.faces);
  const outEdges = new Set(result.edges.map((e) => e.edge));

  for (const key of [...history.faces.deleted, ...history.faces.modified.keys()]) expect(inFaces.has(key)).toBe(true);
  for (const key of [...history.edges.deleted, ...history.edges.modified.keys()]) expect(inEdges.has(key)).toBe(true);
  for (const key of history.faces.kept) expect(inFaces.has(key) && outFaces.has(key)).toBe(true);
  for (const key of history.edges.kept) expect(inEdges.has(key) && outEdges.has(key)).toBe(true);
  for (const key of [...history.faces.added, ...[...history.faces.modified.values()].flat()])
    expect(outFaces.has(key)).toBe(true);
  for (const key of [...history.edges.added, ...[...history.edges.modified.values()].flat()])
    expect(outEdges.has(key)).toBe(true);
  for (const [from, faces] of history.facesFromFace) {
    expect(inFaces.has(from)).toBe(true);
    for (const face of faces) expect(outFaces.has(face)).toBe(true);
  }
  for (const [from, faces] of history.facesFromEdge) {
    expect(inEdges.has(from)).toBe(true);
    for (const face of faces) expect(outFaces.has(face)).toBe(true);
  }
}

/** Every input key is accounted for once: kept, modified or deleted. */
function expectInputsPartitioned(history: OperationHistory): void {
  const inputs = history.inputs.map((input) => adapter.topology(input.shape));
  const faces = new Set(inputs.flatMap((t) => t.faces));
  const edges = new Set(inputs.flatMap((t) => t.edges.map((e) => e.edge)));
  const count = (h: OperationHistory['faces']): number => h.kept.length + h.modified.size + h.deleted.length;
  expect(count(history.faces)).toBe(faces.size);
  expect(count(history.edges)).toBe(edges.size);
}

/** Run one `*WithHistory` call on registered inputs. */
function step(
  shapes: readonly ShapeHandle[],
  run: (hashes: number[], bound: number) => EvolutionData,
): { refs: ShapeRef[]; history: OperationHistory } {
  const refs = shapes.map((shape) => adapter.addShape(shape));
  const evolution = run(adapter.faceHashes(refs), adapter.hashBound);
  const history = adapter.history(
    evolution,
    refs.map((shape, i) => ({ shape, use: i === 0 ? ('target' as const) : ('tool' as const) })),
  );
  expectKeysExist(history);
  expectInputsPartitioned(history);
  return { refs, history };
}

/** The kernel shape a history's result was registered from. */
function evolutionResult(history: OperationHistory): ShapeHandle {
  return adapter.handleOf(adapter.subShapes(history.result)[0]?.key as ShapeKey);
}

/** A face's sample point really lies inside it. */
function expectSampleInside(face: ShapeKey): void {
  const p = adapter.samplePoint(face);
  expect(p).not.toBeNull();
  const point = { x: (p as Vec3)[0], y: (p as Vec3)[1], z: (p as Vec3)[2] };
  const h = adapter.handleOf(face);
  const { u, v } = k.uvFromPoint(h, point);
  const bounds = k.uvBounds(h);
  const wrapped = u < bounds.uMin ? u + 2 * Math.PI : u > bounds.uMax ? u - 2 * Math.PI : u;
  expect(k.classifyPointOnFace(h, wrapped, v)).toBe('in');
  const vertex = k.makeVertex(point.x, point.y, point.z);
  expect(k.distanceBetween(vertex, h)).toBeLessThan(1e-7);
}

describe('kernel behaviour the adapter relies on', () => {
  it('gives the same box built twice different hashes', () => {
    const a = k.subShapeHashes(box(0, 0, 0, 10, 10, 10), 'face', HASH_BOUND);
    const b = k.subShapeHashes(box(0, 0, 0, 10, 10, 10), 'face', HASH_BOUND);
    start();
    expect(a.filter((h) => b.includes(h))).toEqual([]);
  });

  it('keeps every hash below 2^31 and ignores orientation in it', () => {
    const shape = box(0, 0, 0, 10, 10, 10);
    const face = k.getSubShapes(shape, 'face')[0] as ShapeHandle;
    start();
    for (const h of k.subShapeHashes(shape, 'edge', HASH_BOUND)) expect(h).toBeLessThan(2 ** 31);
    expect(k.hashCode(k.reverseShape(face), HASH_BOUND)).toBe(k.hashCode(face, HASH_BOUND));
  });

  it('lists as deleted edges a fillet left in the result, which the adapter ignores', () => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const ref = adapter.addShape(shape);
    const edge = adapter.topology(ref).edges.find((e) => {
      const m = adapter.measures(e.edge).midpoint as Vec3;
      return m[2] === 10 && m[1] === 0;
    });
    const evolution = k.filletWithHistory(
      shape,
      [adapter.handleOf(edge?.edge as ShapeKey)],
      1,
      adapter.faceHashes([ref]),
      HASH_BOUND,
    );
    const resultHashes = new Set(k.subShapeHashes(evolution.result, 'edge', HASH_BOUND));
    expect(evolution.edgeDeleted.filter((h) => resultHashes.has(h)).length).toBeGreaterThan(0);

    const history = adapter.history(evolution, [{ shape: ref, use: 'target' }]);
    expectKeysExist(history);
    expect(history.edges.deleted).toEqual([edge?.edge]);
  });

  it('lists generated hashes outside the result in a boolean, which the adapter drops', () => {
    start();
    const a = box(0, 0, 0, 30, 10, 10);
    const b = box(10, -1, 5, 5, 12, 6);
    const refs = [adapter.addShape(a), adapter.addShape(b)];
    const evolution = k.cutWithHistory(a, b, adapter.faceHashes(refs), HASH_BOUND);
    const faces = new Set(k.subShapeHashes(evolution.result, 'face', HASH_BOUND));
    const listed = decodeRunLength(evolution.generated).flatMap(([, list]) => list);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((h) => !faces.has(h)).length).toBeGreaterThan(0);

    const history = adapter.history(evolution, [
      { shape: refs[0] as ShapeRef, use: 'target' },
      { shape: refs[1] as ShapeRef, use: 'tool' },
    ]);
    expectKeysExist(history);
    expect(history.facesFromFace.size).toBe(0);
  });

  it('counts a boundary point as inside a solid', () => {
    start();
    expect(k.containsPoint(box(0, 0, 0, 10, 10, 10), { x: 10, y: 5, z: 5 })).toBe(true);
  });

  it('does not trim a face projection, and stops an edge projection short of its ends', () => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const ref = adapter.addShape(shape);
    const top = faceAt(ref, [5, 5, 10]);
    const foot = k.projectPointOnFace(adapter.handleOf(top), { x: 50, y: 5, z: 20 });
    expect(foot.x).toBeCloseTo(50, 9);
    const edge = adapter.topology(ref).edges[0]?.edge as ShapeKey;
    expect(() => k.projectPointOnEdge(adapter.handleOf(edge), { x: 500, y: 600, z: 700 })).toThrow();
  });

  it('shares no hash through a rigid transform', () => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const moved = k.transform(shape, [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]);
    const before = k.subShapeHashes(shape, 'face', HASH_BOUND);
    expect(k.subShapeHashes(moved, 'face', HASH_BOUND).filter((h) => before.includes(h))).toEqual([]);
  });

  it('has no direct read of a circle or a cylinder', () => {
    start();
    const circle = k.makeCircleEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2);
    expect(() => k.getNurbsCurveData(circle)).toThrow();
    const wall = k
      .getSubShapes(k.makeCylinder(3, 20), 'face')
      .find((f) => k.surfaceType(f) === 'cylinder') as ShapeHandle;
    expect(Object.keys(k.getFaceCylinderData(wall) ?? {}).sort()).toEqual(['isDirect', 'radius']);
  });

  it('hands out a sub-shape handle that outlives its parent', () => {
    start();
    const shape = box(0, 0, 0, 2, 3, 4);
    const ref = adapter.addShape(shape);
    const solid = adapter.topology(ref).solids[0]?.solid as ShapeKey;
    k.release(shape);
    expect(adapter.measures(solid).volume).toBeCloseTo(24, 9);
  });
});

describe('keys', () => {
  it('refuses a shape whose sub-shapes collide', () => {
    start(2);
    const shape = box(0, 0, 0, 10, 10, 10);
    expect(() => adapter.addShape(shape)).toThrow(expect.objectContaining({ code: 'collision' }));
  });

  it('tells apart sub-shapes of two shapes that share a hash', () => {
    const a = box(0, 0, 0, 10, 10, 10);
    const b = box(30, 0, 0, 10, 10, 10);
    const KINDS = ['vertex', 'edge', 'wire', 'face', 'shell', 'solid'] as const;
    const hashes = (shape: ShapeHandle, bound: number) =>
      KINDS.map((kind) => {
        const subs = k.getSubShapes(shape, kind);
        const out = subs.map((s) => k.hashCode(s, bound));
        for (const s of subs) k.release(s);
        return out;
      });
    // A bound under which each box is clean on its own but a vertex, edge or face of one shares a hash with the other's.
    let bound = 0;
    for (let m = 50; m < 5000 && bound === 0; m++) {
      const [ha, hb] = [hashes(a, m), hashes(b, m)];
      const clean = (h: number[][]) => h.every((kind) => new Set(kind).size === kind.length);
      const shared = ha.some((kind, i) => kind.some((h) => (hb[i] as number[]).includes(h)));
      if (clean(ha) && clean(hb) && shared) bound = m;
    }
    expect(bound).toBeGreaterThan(0);
    start(bound);
    const [ra, rb] = [adapter.addShape(a), adapter.addShape(b)];
    k.release(a);
    k.release(b);
    const [fa, fb] = [adapter.topology(ra).faces, adapter.topology(rb).faces];
    expect([fa.length, fb.length]).toEqual([6, 6]);
    expect(fa.filter((f) => fb.includes(f))).toEqual([]);
    const area = (faces: ShapeKey[]) => faces.reduce((sum, f) => sum + (adapter.measures(f).area as number), 0);
    expect(area(fa)).toBeCloseTo(600, 6);
    expect(area(fb)).toBeCloseTo(600, 6);
  });

  it('releases every handle a refused shape took, once disposed', () => {
    start(2);
    const shape = box(0, 0, 0, 10, 10, 10);
    const held = k.shapeCount;
    expect(() => adapter.addShape(shape)).toThrow(expect.objectContaining({ code: 'collision' }));
    adapter.dispose();
    expect(k.shapeCount).toBe(held);
  });

  it('keeps one key for a sub-shape across shapes', () => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const a = adapter.addShape(shape);
    const b = adapter.addShape(shape);
    expect(adapter.topology(b).faces).toEqual(adapter.topology(a).faces);
    expect(adapter.topology(b).edges.map((e) => e.edge)).toEqual(adapter.topology(a).edges.map((e) => e.edge));
  });

  it('tells apart two placements of one shape, each read in its own place', () => {
    start();
    const shape = k.makeCylinder(3, 20);
    const placed = k.located(shape, [1, 0, 0, 40, 0, 1, 0, 0, 0, 0, 1, 0]);
    const a = adapter.addShape(shape);
    const b = adapter.addShape(placed);
    const keys = new Set(adapter.topology(a).faces);
    expect(adapter.topology(b).faces.filter((face) => keys.has(face))).toEqual([]);

    const wall = adapter.topology(b).faces.find((f) => adapter.measures(f).surface === 'cylinder') as ShapeKey;
    const surface = adapter.faceGeometry(wall).surface;
    if (surface.kind !== 'cylinder') throw new Error('kind');
    close(surface.origin, [40, 0, 0]);
    const rim = adapter.topology(b).edges.find((e) => e.form === 'normal')?.edge as ShapeKey;
    const curve = adapter.edgeGeometry(rim).curve;
    if (curve.kind !== 'circle') throw new Error('kind');
    close([curve.center[0], curve.center[1]], [40, 0]);
    expect((adapter.samplePoint(wall) as Vec3)[2]).toBeCloseTo(10, 9);
  });

  it('finds a sub-shape by handle, and refuses one from elsewhere', () => {
    start();
    const shape = box(0, 0, 0, 10, 20, 30);
    const ref = adapter.addShape(shape);
    const face = k.getSubShapes(shape, 'face')[0] as ShapeHandle;
    expect(adapter.handleOf(adapter.keyIn(ref, face))).toBeDefined();
    expect(k.isSame(adapter.handleOf(adapter.keyIn(ref, face)), face)).toBe(true);
    const other = k.getSubShapes(box(0, 0, 0, 1, 1, 1), 'face')[0] as ShapeHandle;
    expect(() => adapter.keyIn(ref, other)).toThrow(NamingAdapterError);
  });

  it('rejects keys and shapes it does not hold', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 1, 1, 1));
    expect(() => adapter.measures(99999)).toThrow(NamingAdapterError);
    expect(() => adapter.topology('nope')).toThrow(NamingAdapterError);
    expect(() => adapter.addShape(box(0, 0, 0, 1, 1, 1), ref)).toThrow(NamingAdapterError);
    const edge = adapter.topology(ref).edges[0]?.edge as ShapeKey;
    expect(() => adapter.faceGeometry(edge)).toThrow(NamingAdapterError);
  });

  it('releases everything it holds on dispose', () => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const before = k.shapeCount;
    const ref = adapter.addShape(shape);
    const face = adapter.topology(ref).faces[0] as ShapeKey;
    adapter.samplePoint(face);
    expect(k.shapeCount).toBeGreaterThan(before);
    adapter.dispose();
    expect(k.shapeCount).toBe(before);
  });
});

describe('a box', () => {
  it('has the topology of a box', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 10, 20, 30));
    const t = adapter.topology(ref);
    expect(t.faces).toHaveLength(6);
    expect(t.edges).toHaveLength(12);
    expect(t.vertices).toHaveLength(8);
    expect(t.solids).toHaveLength(1);
    expect(t.solids[0]?.faces).toHaveLength(6);
    for (const edge of t.edges) {
      expect(edge.form).toBe('normal');
      expect(edge.faces.map((f) => f.count)).toEqual([1, 1]);
      expect(edge.ends).toHaveLength(2);
    }
    for (const vertex of t.vertices) {
      expect(vertex.faces).toHaveLength(3);
      expect(vertex.edges).toHaveLength(3);
    }
  });

  it('measures faces, edges, vertices and the solid', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 10, 20, 30));
    const top = faceAt(ref, [5, 10, 30]);
    const m = adapter.measures(top);
    expect(m.area).toBeCloseTo(200, 9);
    expect(m.surface).toBe('plane');
    close(m.normal as Vec3, [0, 0, 1]);
    close((m.bbox as [Vec3, Vec3])[0], [0, 0, 30]);
    close((m.bbox as [Vec3, Vec3])[1], [10, 20, 30]);
    expect(m.vertices).toEqual([
      [0, 0, 30],
      [0, 20, 30],
      [10, 0, 30],
      [10, 20, 30],
    ]);

    const t = adapter.topology(ref);
    const edge = t.edges.find((e) => {
      const c = adapter.measures(e.edge).midpoint as Vec3;
      return c[0] === 10 && c[1] === 20;
    });
    const em = adapter.measures(edge?.edge as ShapeKey);
    expect(em.curve).toBe('line');
    expect(em.length).toBeCloseTo(30, 9);
    close(em.tangent as Vec3, [0, 0, 1]);
    close(em.quarter as Vec3, [10, 20, 7.5]);
    close(em.threeQuarter as Vec3, [10, 20, 22.5]);

    const vertex = t.vertices[0]?.vertex as ShapeKey;
    expect(adapter.measures(vertex).point).toHaveLength(3);
    expect(adapter.measures(t.solids[0]?.solid as ShapeKey).volume).toBeCloseTo(6000, 6);
  });

  it('measures every open edge from its smaller end', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 10, 20, 30));
    for (const edge of adapter.topology(ref).edges) {
      const m = adapter.measures(edge.edge);
      const t = m.tangent as Vec3;
      expect(t[0] + t[1] + t[2]).toBeCloseTo(1, 9);
    }
  });

  it('runs each loop with the face on the left of its outward normal', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 10, 20, 30));
    for (const face of adapter.topology(ref).faces) {
      const geometry = adapter.faceGeometry(face);
      expect(geometry.surface.kind).toBe('plane');
      expect(geometry.loops).toHaveLength(1);
      const loop = geometry.loops[0] ?? [];
      expect(loop).toHaveLength(4);
      const normal = (geometry.surface as { normal: Vec3 }).normal;
      const centroid = adapter.measures(face).centroid as Vec3;
      let previous: Vec3 | undefined;
      for (const use of loop) {
        const e = adapter.edgeGeometry(use.edge);
        const [from, to] = use.reversed ? [e.end, e.start] : [e.start, e.end];
        if (previous) close(from, previous);
        previous = to;
        const left = cross(normal, sub(to, from));
        expect(dot(left, sub(centroid, from))).toBeGreaterThan(0);
      }
      close(previous as Vec3, adapter.edgeGeometry(loop[0]?.edge as ShapeKey)[loop[0]?.reversed ? 'end' : 'start']);
    }
  });

  it('numbers sub-shapes in the 13.2 order', () => {
    start();
    const shape = box(0, 0, 0, 10, 20, 30);
    const ref = adapter.addShape(shape);
    const entries = adapter.subShapes(ref);
    // solid, shell, 6 faces, 6 wires, 12 edges, 8 vertices.
    expect(entries).toHaveLength(1 + 1 + 6 + 6 + 12 + 8);
    expect(entries[0]?.children).toEqual([1]);
    expect(entries[1]?.children).toEqual([2, 3, 4, 5, 6, 7]);
    for (let i = 2; i < 8; i++) expect(entries[i]?.children).toHaveLength(1);
    for (let i = 8; i < 14; i++) expect(entries[i]?.children).toHaveLength(4);
    for (let i = 14; i < 26; i++) expect(entries[i]?.children).toHaveLength(2);
    for (let i = 26; i < 34; i++) expect(entries[i]?.children).toHaveLength(0);

    // The kernel's own enumeration is TopExp::MapShapes, kind by kind.
    const hashes = entries.map((e) => k.hashCode(adapter.handleOf(e.key), HASH_BOUND));
    expect(hashes.slice(2, 8)).toEqual(k.subShapeHashes(shape, 'face', HASH_BOUND));
    expect(hashes.slice(8, 14)).toEqual(k.subShapeHashes(shape, 'wire', HASH_BOUND));
    expect(hashes.slice(14, 26)).toEqual(k.subShapeHashes(shape, 'edge', HASH_BOUND));
    expect(hashes.slice(26, 34)).toEqual(k.subShapeHashes(shape, 'vertex', HASH_BOUND));
  });

  it('samples the middle of a face, of an edge and of the solid', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 10, 20, 30));
    const t = adapter.topology(ref);
    expect(adapter.samplePoint(faceAt(ref, [5, 10, 30]))).toEqual([5, 10, 30]);
    const edge = t.edges[0]?.edge as ShapeKey;
    expect(adapter.samplePoint(edge)).toEqual(adapter.measures(edge).midpoint);
    expect(adapter.samplePoint(t.solids[0]?.solid as ShapeKey)).toEqual([5, 10, 15]);
    expect(adapter.samplePoint(t.vertices[0]?.vertex as ShapeKey)).toEqual(
      adapter.measures(t.vertices[0]?.vertex as ShapeKey).point,
    );
  });
});

describe('seams and degenerate edges', () => {
  it('reports a cylinder: one seam, counted twice on the wall', () => {
    start();
    const ref = adapter.addShape(k.makeCylinder(3, 20));
    const t = adapter.topology(ref);
    expect(t.faces).toHaveLength(3);
    expect(t.edges).toHaveLength(3);
    expect(t.vertices).toHaveLength(2);
    const seam = t.edges.filter((e) => e.form === 'seam');
    expect(seam).toHaveLength(1);
    expect(seam[0]?.faces).toHaveLength(1);
    expect(seam[0]?.faces[0]?.count).toBe(2);
    for (const circle of t.edges.filter((e) => e.form === 'normal')) {
      expect(circle.ends).toHaveLength(1);
      expect(circle.faces).toHaveLength(2);
    }
    const wall = seam[0]?.faces[0]?.face as ShapeKey;
    const loop = adapter.faceGeometry(wall).loops[0] ?? [];
    expect(loop).toHaveLength(4);
    expect(
      loop
        .filter((use) => use.edge === seam[0]?.edge)
        .map((use) => use.reversed)
        .sort(),
    ).toEqual([false, true]);
  });

  it('reports a sphere: a seam and two degenerate poles', () => {
    start();
    const ref = adapter.addShape(k.makeSphere(5));
    const t = adapter.topology(ref);
    expect(t.faces).toHaveLength(1);
    expect(t.edges.map((e) => e.form).sort()).toEqual(['degenerate', 'degenerate', 'seam']);
    const poles = t.edges.filter((e) => e.form === 'degenerate');
    for (const pole of poles) {
      const g = adapter.edgeGeometry(pole.edge);
      expect(g.curve.kind).toBe('line');
      expect(g.start).toEqual(g.end);
      close([Math.abs(g.start[2])], [5]);
      expect(adapter.measures(pole.edge).length).toBe(0);
      expect(adapter.samplePoint(pole.edge)).toEqual(g.start);
    }
    expect(adapter.faceGeometry(t.faces[0] as ShapeKey).loops[0]).toHaveLength(4);
  });

  it('reports a cone: the apex is degenerate though the kernel calls it a circle', () => {
    start();
    const ref = adapter.addShape(k.makeCone(5, 0, 10));
    const t = adapter.topology(ref);
    const apex = t.edges.filter((e) => e.form === 'degenerate');
    expect(apex).toHaveLength(1);
    expect(k.curveType(adapter.handleOf(apex[0]?.edge as ShapeKey))).toBe('circle');
    close(adapter.edgeGeometry(apex[0]?.edge as ShapeKey).start, [0, 0, 10]);
    expect(t.edges.filter((e) => e.form === 'seam')).toHaveLength(1);
  });

  it('reports a torus: two seams on one vertex', () => {
    start();
    const ref = adapter.addShape(k.makeTorus(10, 2));
    const t = adapter.topology(ref);
    expect(t.edges.map((e) => e.form)).toEqual(['seam', 'seam']);
    expect(t.vertices).toHaveLength(1);
  });
});

describe('exact geometry', () => {
  it('reads circles, arcs and ellipses', () => {
    start();
    const ref = adapter.addShape(k.makeCircleEdge({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 }, 5));
    const circle = adapter.edgeGeometry(adapter.topology(ref).edges[0]?.edge as ShapeKey);
    expect(circle.closed).toBe(true);
    expect(circle.curve).toMatchObject({ kind: 'circle' });
    if (circle.curve.kind !== 'circle') throw new Error('kind');
    close(circle.curve.center, [1, 2, 3]);
    close(circle.curve.axis, [0, 0, 1]);
    expect(circle.curve.radius).toBeCloseTo(5, 9);

    const arcRef = adapter.addShape(k.makeCircleArc({ x: 7, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 4, 1, 2));
    const arcKey = adapter.topology(arcRef).edges[0]?.edge as ShapeKey;
    const arc = adapter.edgeGeometry(arcKey);
    expect(arc.closed).toBe(false);
    if (arc.curve.kind !== 'circle') throw new Error('kind');
    close(arc.curve.center, [7, 0, 0]);
    expect(arc.curve.radius).toBeCloseTo(4, 9);
    expect(adapter.measures(arcKey).length).toBeCloseTo(4, 9);

    const ellipseRef = adapter.addShape(k.makeEllipseEdge({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 }, 5, 2));
    const ellipse = adapter.edgeGeometry(adapter.topology(ellipseRef).edges[0]?.edge as ShapeKey);
    if (ellipse.curve.kind !== 'ellipse') throw new Error('kind');
    close(ellipse.curve.center, [1, 2, 3]);
    close(ellipse.curve.major, [1, 0, 0]);
    close([...ellipse.curve.radii], [5, 2]);
  });

  it('reads a B-spline, with the shape location applied, and a Bezier as one', () => {
    start();
    const spline = k.interpolatePoints([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 2, z: 0 },
      { x: 3, y: 0, z: 1 },
    ]);
    const moved = adapter.addShape(k.translate(spline, 100, 0, 0));
    const g = adapter.edgeGeometry(adapter.topology(moved).edges[0]?.edge as ShapeKey);
    if (g.curve.kind !== 'bspline') throw new Error('kind');
    expect(g.curve.degree).toBe(2);
    close(g.curve.poles[0] as Vec3, [100, 0, 0]);
    expect(g.curve.weights).toEqual(g.curve.poles.map(() => 1));
    expect(g.curve.first).toBe(0);
    expect(g.curve.last).toBeCloseTo(g.curve.knots[g.curve.knots.length - 1] as number, 9);

    const bezier = adapter.addShape(
      k.makeBezierEdge([
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 2, z: 0 },
        { x: 3, y: 0, z: 0 },
      ]),
    );
    const key = adapter.topology(bezier).edges[0]?.edge as ShapeKey;
    expect(adapter.edgeGeometry(key).curve.kind).toBe('bspline');
    expect(adapter.measures(key).curve).toBe('freeform');
  });

  it('reads cylinders, cones, spheres and tori in a moved frame', () => {
    start();
    const shift = (s: ShapeHandle): ShapeHandle => k.translate(s, 10, 20, 30);
    const surfaceOf = (shape: ShapeHandle, kind: string) => {
      const ref = adapter.addShape(shift(shape));
      for (const face of adapter.topology(ref).faces) {
        const surface = adapter.faceGeometry(face).surface;
        if (surface.kind === kind) return { surface, face };
      }
      throw new Error(`no ${kind}`);
    };

    const cylinder = surfaceOf(k.makeCylinder(3, 20), 'cylinder').surface;
    if (cylinder.kind !== 'cylinder') throw new Error('kind');
    close(cylinder.origin, [10, 20, 30]);
    close(cylinder.axis, [0, 0, 1]);
    close([...cylinder.radii], [3]);

    const cone = surfaceOf(k.makeCone(5, 2, 6), 'cone').surface;
    if (cone.kind !== 'cone') throw new Error('kind');
    close(cone.origin, [10, 20, 30]);
    close(cone.axis, [0, 0, 1]);
    close([...cone.radii], [5]);
    expect(cone.halfAngle).toBeCloseTo((Math.atan2(-3, 6) * 180) / Math.PI, 9);

    const apexCone = surfaceOf(k.makeCone(0, 4, 8), 'cone').surface;
    if (apexCone.kind !== 'cone') throw new Error('kind');
    close([...apexCone.radii], [0]);
    expect(apexCone.halfAngle).toBeCloseTo((Math.atan2(4, 8) * 180) / Math.PI, 9);

    const sphere = surfaceOf(k.makeSphere(5), 'sphere').surface;
    if (sphere.kind !== 'sphere') throw new Error('kind');
    close(sphere.origin, [10, 20, 30]);
    close([...sphere.radii], [5]);

    const torus = surfaceOf(k.makeTorus(10, 2), 'torus');
    if (torus.surface.kind !== 'torus') throw new Error('kind');
    close(torus.surface.origin, [10, 20, 30]);
    close(torus.surface.axis, [0, 0, 1]);
    close([...torus.surface.radii], [10, 2]);
    close(adapter.measures(torus.face).axis as Vec3, [0, 0, 1]);
  });

  it('reads a mirrored cylinder, whose frame is left-handed', () => {
    start();
    const { history } = step([k.makeCylinder(3, 10)], (hashes, bound) =>
      k.mirrorWithHistory(k.makeCylinder(3, 10), { x: 15, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, hashes, bound),
    );
    const wall = facesWhere(history.result, (c) => c[2] === 5)[0] as ShapeKey;
    const surface = adapter.faceGeometry(wall).surface;
    if (surface.kind !== 'cylinder') throw new Error('kind');
    close(surface.origin, [30, 0, 0]);
    close([...surface.radii], [3]);
  });

  it('refuses a free-form surface by name, and still measures it', () => {
    start();
    const pts = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) pts.push({ x: i, y: j, z: (i - 1.5) * (j - 1.5) });
    const ref = adapter.addShape(k.bsplineSurface(pts, 4, 4));
    const face = adapter.topology(ref).faces[0] as ShapeKey;
    expect(() => adapter.faceGeometry(face)).toThrow(expect.objectContaining({ code: 'unsupported' }));
    expect(() => adapter.faceGeometry(face)).toThrow(/No exact data for a surface of kind "bspline"/);
    expect(adapter.measures(face).surface).toBe('freeform');
    expect(adapter.samplePoint(face)).not.toBeNull();
  });
});

describe('a box with a cylinder cut through it', () => {
  function cut() {
    const target = box(0, 0, 0, 30, 30, 10);
    const tool = k.translate(k.makeCylinder(5, 20), 15, 15, -5);
    return step([target, tool], (hashes, bound) => k.cutWithHistory(target, tool, hashes, bound));
  }

  it('gives the top and bottom an inner loop and adds the bore', () => {
    start();
    const { history, refs } = cut();
    const t = adapter.topology(history.result);
    expect(t.faces).toHaveLength(7);
    expect(t.solids).toHaveLength(1);
    expect(t.edges.filter((e) => e.form === 'seam')).toHaveLength(1);

    const top = faceAt(history.result, [15, 15, 10]);
    const geometry = adapter.faceGeometry(top);
    expect(geometry.loops).toHaveLength(2);
    expect(geometry.loops[0]).toHaveLength(4);
    expect(geometry.loops[1]).toHaveLength(1);

    // The target's top became the holed top; its side walls were left alone.
    const inputTop = faceAt(refs[0] as ShapeRef, [15, 15, 10]);
    expect(history.faces.modified.get(inputTop)).toEqual([top]);
    expect(history.faces.kept).toHaveLength(4);
    expect(adapter.measures(top).area).toBeCloseTo(900 - Math.PI * 25, 6);

    // The cutter's wall became the bore, turned to face into the hole.
    const inputWall = faceAt(refs[1] as ShapeRef, [15, 15, 5]);
    const bore = history.faces.modified.get(inputWall);
    expect(bore).toHaveLength(1);
    expect(adapter.measures(bore?.[0] as ShapeKey).surface).toBe('cylinder');
    expect(adapter.side([15, 15, 5], bore?.[0] as ShapeKey, 'normal')).toBe(1);
    expect(adapter.side([0, 0, 5], bore?.[0] as ShapeKey, 'normal')).toBe(-1);
  });

  it('samples every face inside it, and never in the hole', () => {
    start();
    const { history } = cut();
    for (const face of adapter.topology(history.result).faces) expectSampleInside(face);
    // The centre of the holed top is the first try and it is in the hole.
    const top = faceAt(history.result, [15, 15, 10]);
    expect(adapter.samplePoint(top)).not.toEqual([15, 15, 10]);

    const solid = adapter.topology(history.result).solids[0]?.solid as ShapeKey;
    const p = adapter.samplePoint(solid) as Vec3;
    expect(Math.hypot(p[0] - 15, p[1] - 15)).toBeGreaterThan(5);
  });
});

describe('a fillet on four vertical edges', () => {
  function fillet() {
    const shape = box(0, 0, 0, 10, 10, 10);
    const ref = adapter.addShape(shape);
    const vertical = adapter
      .topology(ref)
      .edges.filter((e) => (adapter.measures(e.edge).midpoint as Vec3)[2] === 5)
      .map((e) => e.edge);
    expect(vertical).toHaveLength(4);
    const evolution = k.filletWithHistory(
      shape,
      vertical.map((e) => adapter.handleOf(e)),
      1,
      adapter.faceHashes([ref]),
      HASH_BOUND,
    );
    const history = adapter.history(evolution, [{ shape: ref, use: 'target' }]);
    expectKeysExist(history);
    expectInputsPartitioned(history);
    return { ref, vertical, history };
  }

  it('maps each edge to its blend and each face to its trimmed self', () => {
    start();
    const { vertical, history } = fillet();
    const t = adapter.topology(history.result);
    expect(t.faces).toHaveLength(10);
    expect(t.edges).toHaveLength(24);

    expect(history.faces.kept).toEqual([]);
    expect(history.faces.deleted).toEqual([]);
    expect(history.faces.added).toEqual([]);
    expect(history.faces.modified.size).toBe(6);
    for (const images of history.faces.modified.values()) expect(images).toHaveLength(1);

    expect([...history.facesFromEdge.keys()].sort()).toEqual([...vertical].sort());
    for (const [edge, blends] of history.facesFromEdge) {
      expect(blends).toHaveLength(1);
      const blend = blends[0] as ShapeKey;
      expect(adapter.measures(blend).surface).toBe('cylinder');
      close([adapter.measures(blend).area as number], [(Math.PI / 2) * 10]);
      const m = adapter.measures(edge).midpoint as Vec3;
      const axis = adapter.faceGeometry(blend).surface as { origin: Vec3 };
      // The blend's axis runs one radius in from the edge, on both sides.
      close([Math.abs(axis.origin[0] - m[0]), Math.abs(axis.origin[1] - m[1])], [1, 1]);
    }
    expect(history.edges.deleted.sort()).toEqual([...vertical].sort());
    expect(history.edges.modified.size).toBe(8);
  });

  it('samples every face inside it', () => {
    start();
    const { history } = fillet();
    for (const face of adapter.topology(history.result).faces) expectSampleInside(face);
  });
});

describe('corners', () => {
  it.each(['fillet', 'chamfer'])('finds no history for a %s corner: it is added', (kind) => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const ref = adapter.addShape(shape);
    const atCorner = adapter.topology(ref).edges.filter((e) => {
      const m = adapter.measures(e.edge).midpoint as Vec3;
      return [
        [5, 0, 10],
        [0, 5, 10],
        [0, 0, 5],
      ].some((p) => p[0] === m[0] && p[1] === m[1] && p[2] === m[2]);
    });
    expect(atCorner).toHaveLength(3);
    const edges = atCorner.map((e) => adapter.handleOf(e.edge));
    const hashes = adapter.faceHashes([ref]);
    const evolution =
      kind === 'fillet'
        ? k.filletWithHistory(shape, edges, 1, hashes, HASH_BOUND)
        : k.chamferWithHistory(shape, edges, 1, hashes, HASH_BOUND);
    const history = adapter.history(evolution, [{ shape: ref, use: 'target' }]);
    expectKeysExist(history);
    expect(history.facesFromEdge.size).toBe(3);
    expect(history.faces.added).toHaveLength(1);
    const corner = history.faces.added[0] as ShapeKey;
    const c = adapter.measures(corner).centroid as Vec3;
    expect(c[0]).toBeLessThan(1);
    expect(c[1]).toBeLessThan(1);
    expect(c[2]).toBeGreaterThan(9);
  });
});

describe('a shell', () => {
  it('keeps the outside, generates the inner walls and reports the rim as the removed face', () => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const ref = adapter.addShape(shape);
    const top = faceAt(ref, [5, 5, 10]);
    const evolution = k.shellWithHistory(
      shape,
      [adapter.handleOf(top)],
      1,
      1e-3,
      adapter.faceHashes([ref]),
      HASH_BOUND,
    );
    const history = adapter.history(evolution, [{ shape: ref, use: 'target' }]);
    expectKeysExist(history);
    expectInputsPartitioned(history);

    const t = adapter.topology(history.result);
    expect(t.faces).toHaveLength(11);
    expect(history.faces.kept).toHaveLength(5);
    expect(history.faces.added).toEqual([]);

    const rim = history.faces.modified.get(top);
    expect(rim).toHaveLength(1);
    expect(history.faces.modified.size).toBe(1);
    expect(adapter.measures(rim?.[0] as ShapeKey).area).toBeCloseTo(100 - 64, 6);

    expect(history.facesFromFace.size).toBe(5);
    for (const [outer, inner] of history.facesFromFace) {
      expect(history.faces.kept).toContain(outer);
      expect(inner).toHaveLength(1);
      const normal = adapter.measures(outer).normal as Vec3;
      close(
        adapter.measures(inner[0] as ShapeKey).normal as Vec3,
        normal.map((v) => -v + 0),
      );
    }
    for (const face of t.faces) expectSampleInside(face);
  });
});

describe('a translate and a rotate', () => {
  it('carries every face and edge one to one through both', () => {
    start();
    const shape = box(0, 0, 0, 10, 20, 30);
    const moved = step([shape], (hashes, bound) => k.translateWithHistory(shape, 5, 0, 0, hashes, bound));
    const input = moved.refs[0] as ShapeRef;
    expect(moved.history.faces.kept).toEqual([]);
    expect(moved.history.faces.modified.size).toBe(6);
    expect(moved.history.edges.modified.size).toBe(12);
    expect(moved.history.faces.added).toEqual([]);
    expect(moved.history.edges.added).toEqual([]);

    const top = faceAt(input, [5, 10, 30]);
    const carried = moved.history.faces.modified.get(top)?.[0] as ShapeKey;
    close(adapter.measures(carried).centroid as Vec3, [10, 10, 30]);

    const axis = { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };
    const shapeAfter = adapter.handleOf(adapter.topology(moved.history.result).solids[0]?.solid as ShapeKey);
    const evolution = k.rotateWithHistory(
      shapeAfter,
      axis,
      Math.PI / 2,
      adapter.faceHashes([moved.history.result]),
      HASH_BOUND,
    );
    const turned = adapter.history(evolution, [{ shape: moved.history.result, use: 'target' }]);
    expectKeysExist(turned);
    expect(turned.faces.modified.size).toBe(6);
    expect(turned.edges.modified.size).toBe(12);
    const after = turned.faces.modified.get(carried)?.[0] as ShapeKey;
    close(adapter.measures(after).centroid as Vec3, [-10, 10, 30]);
    close(adapter.measures(after).normal as Vec3, [0, 0, 1]);
  });
});

describe('a mirror', () => {
  it('pairs faces and edges and keeps normals outward', () => {
    start();
    const shape = box(0, 0, 0, 10, 20, 30);
    const { history, refs } = step([shape], (hashes, bound) =>
      k.mirrorWithHistory(shape, { x: 15, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, hashes, bound),
    );
    expect(history.faces.modified.size).toBe(6);
    expect(history.edges.modified.size).toBe(12);
    const right = faceAt(refs[0] as ShapeRef, [10, 10, 15]);
    const image = history.faces.modified.get(right)?.[0] as ShapeKey;
    close(adapter.measures(image).centroid as Vec3, [20, 10, 15]);
    close(adapter.measures(image).normal as Vec3, [-1, 0, 0]);
    expect(adapter.side([25, 10, 15], image, 'normal')).toBe(-1);
    expect(adapter.side([15, 10, 15], image, 'normal')).toBe(1);

    // A mirrored loop still runs with the face on its left.
    const geometry = adapter.faceGeometry(image);
    const loop = geometry.loops[0] ?? [];
    const e = adapter.edgeGeometry(loop[0]?.edge as ShapeKey);
    const [from, to] = loop[0]?.reversed ? [e.end, e.start] : [e.start, e.end];
    const left = cross(adapter.measures(image).normal as Vec3, sub(to, from));
    expect(dot(left, sub(adapter.measures(image).centroid as Vec3, from))).toBeGreaterThan(0);
  });
});

describe('a fuse of two touching boxes', () => {
  it('leaves coplanar faces apart and drops the shared wall', () => {
    start();
    const a = box(0, 0, 0, 10, 10, 10);
    const b = box(10, 0, 0, 10, 10, 10);
    const { history, refs } = step([a, b], (hashes, bound) => k.fuseWithHistory(a, b, hashes, bound));
    const t = adapter.topology(history.result);
    expect(t.solids).toHaveLength(1);
    expect(t.faces).toHaveLength(10);
    expect(history.faces.deleted.sort()).toEqual(
      [faceAt(refs[0] as ShapeRef, [10, 5, 5]), faceAt(refs[1] as ShapeRef, [10, 5, 5])].sort(),
    );
    // Faces of both inputs live on, each with its own image.
    expect(history.faces.kept.length + history.faces.modified.size).toBe(10);
    expect(history.faces.added).toEqual([]);
  });

  it('with a simplifying tolerance merges both inputs into one result face', () => {
    start();
    const a = box(0, 0, 0, 10, 10, 10);
    const b = box(10, 0, 0, 10, 10, 10);
    const { history, refs } = step([a, b], (hashes, bound) =>
      k.booleanOp(BooleanOp.Fuse, [a], [b], {
        simplifyAngularTolerance: 1e-6,
        inputFaceHashes: hashes,
        hashUpperBound: bound,
      }),
    );
    expect(adapter.topology(history.result).faces).toHaveLength(6);
    const topA = faceAt(refs[0] as ShapeRef, [5, 5, 10]);
    const topB = faceAt(refs[1] as ShapeRef, [15, 5, 10]);
    const images = history.faces.modified.get(topA);
    expect(images).toHaveLength(1);
    expect(history.faces.modified.get(topB)).toEqual(images);
    close(adapter.measures(images?.[0] as ShapeKey).centroid as Vec3, [10, 5, 10]);
  });
});

describe('cut pieces', () => {
  function slot() {
    const target = box(0, 0, 0, 30, 10, 10);
    const tool = box(10, -1, 5, 5, 12, 6);
    const cut = step([target, tool], (hashes, bound) => k.cutWithHistory(target, tool, hashes, bound));
    // The builder is done with its shapes: the tool's solid is gone before pieces are signed against it.
    k.release(target);
    k.release(tool);
    return cut;
  }

  it('splits the top into two pieces of one input face', () => {
    start();
    const { history, refs } = slot();
    const top = faceAt(refs[0] as ShapeRef, [15, 5, 10]);
    const pieces = history.faces.modified.get(top);
    expect(pieces).toHaveLength(2);
    const centers = (pieces as readonly ShapeKey[])
      .map((p) => (adapter.measures(p).centroid as Vec3)[0])
      .sort((x, y) => x - y);
    close(centers, [5, 22.5]);
  });

  it('tells the left and right pieces apart with the normal test, not the solid test', () => {
    start();
    const { history, refs } = slot();
    const tool = refs[1] as ShapeRef;
    const left = faceAt(tool, [10, 5, 8]);
    const right = faceAt(tool, [15, 5, 8]);
    const pieces = history.faces.modified.get(faceAt(refs[0] as ShapeRef, [15, 5, 10])) as readonly ShapeKey[];
    const leftPiece = pieces.find((p) => (adapter.measures(p).centroid as Vec3)[0] < 10) as ShapeKey;
    const rightPiece = pieces.find((p) => (adapter.measures(p).centroid as Vec3)[0] > 15) as ShapeKey;

    const leftPoint = adapter.samplePoint(leftPiece) as Vec3;
    const rightPoint = adapter.samplePoint(rightPiece) as Vec3;
    expect([adapter.side(leftPoint, left, 'normal'), adapter.side(leftPoint, right, 'normal')]).toEqual([1, -1]);
    expect([adapter.side(rightPoint, left, 'normal'), adapter.side(rightPoint, right, 'normal')]).toEqual([-1, 1]);

    expect([adapter.side(leftPoint, left, 'solid'), adapter.side(rightPoint, left, 'solid')]).toEqual([1, 1]);
  });

  it('gives every piece of a round cutter the same sign', () => {
    start();
    const target = box(0, 0, 0, 30, 4, 10);
    const tool = k.translate(k.makeCylinder(5, 20), 15, 2, -5);
    const { history, refs } = step([target, tool], (hashes, bound) => k.cutWithHistory(target, tool, hashes, bound));
    expect(adapter.topology(history.result).solids).toHaveLength(2);
    const wall = adapter
      .topology(refs[1] as ShapeRef)
      .faces.find((f) => adapter.measures(f).surface === 'cylinder') as ShapeKey;
    expect([adapter.side([5, 2, 10], wall, 'normal'), adapter.side([25, 2, 10], wall, 'normal')]).toEqual([1, 1]);
  });
});

describe('a body in two solids', () => {
  it('reports each solid, samples each one and the whole, and classifies against the right one', () => {
    start();
    const target = box(0, 0, 0, 30, 10, 10);
    const tool = box(10, -1, -1, 5, 12, 12);
    const { history } = step([target, tool], (hashes, bound) => k.cutWithHistory(target, tool, hashes, bound));
    const t = adapter.topology(history.result);
    expect(t.solids).toHaveLength(2);
    expect(t.solids.map((s) => s.faces.length)).toEqual([6, 6]);
    expect(new Set(t.solids.flatMap((s) => s.faces)).size).toBe(12);

    const samples = t.solids.map((s) => adapter.samplePoint(s.solid) as Vec3);
    expect(samples.map((p) => p[0]).sort((a, b) => a - b)).toEqual([5, 22.5]);

    // The root is a compound: a body made of both.
    const root = adapter.subShapes(history.result)[0]?.key as ShapeKey;
    expect(adapter.measures(root).volume).toBeCloseTo(2500, 6);
    expect(adapter.samplePoint(root)).toEqual([7.5, 5, 5]);

    // 13.2's order holds through a compound: the kernel's enumeration is TopExp::MapShapes.
    const entries = adapter.subShapes(history.result);
    expect(entries[0]?.children).toEqual([1, 2]);
    const hashes = entries.map((e) => k.hashCode(adapter.handleOf(e.key), HASH_BOUND));
    const ownHash = k.hashCode(adapter.handleOf(root), HASH_BOUND);
    const kinds = ['solid', 'shell', 'face', 'wire', 'edge', 'vertex'] as const;
    expect(hashes).toEqual([
      ownHash,
      ...kinds.flatMap((kind) => k.subShapeHashes(evolutionResult(history), kind, HASH_BOUND)),
    ]);

    const left = t.solids.find((s) => adapter.samplePoint(s.solid)?.[0] === 5);
    const face = left?.faces[0] as ShapeKey;
    expect(adapter.side([5, 5, 5], face, 'solid')).toBe(-1);
    expect(adapter.side([22.5, 5, 5], face, 'solid')).toBe(1);
  });

  it('samples past the void of a hollow solid', () => {
    start();
    const shape = box(0, 0, 0, 10, 10, 10);
    const ref = adapter.addShape(shape);
    const top = faceAt(ref, [5, 5, 10]);
    const evolution = k.shellWithHistory(
      shape,
      [adapter.handleOf(top)],
      1,
      1e-3,
      adapter.faceHashes([ref]),
      HASH_BOUND,
    );
    const history = adapter.history(evolution, [{ shape: ref, use: 'target' }]);
    const solid = adapter.topology(history.result).solids[0]?.solid as ShapeKey;
    const p = adapter.samplePoint(solid) as Vec3;
    const inVoid = p[0] > 1 && p[0] < 9 && p[1] > 1 && p[1] < 9 && p[2] > 1;
    expect(inVoid).toBe(false);
    expect(k.containsPoint(adapter.handleOf(solid), { x: p[0], y: p[1], z: p[2] })).toBe(true);
  });
});

describe('a curved face with a hole', () => {
  it('puts the seam loop first and the hole second', () => {
    start();
    const round = k.makeCylinder(10, 40);
    const tool = k.translate(box(-2, -2, -2, 4, 4, 4), -10, 0, 20);
    const { history } = step([round, tool], (hashes, bound) => k.cutWithHistory(round, tool, hashes, bound));
    const t = adapter.topology(history.result);
    const wall = t.faces.find((f) => adapter.measures(f).surface === 'cylinder') as ShapeKey;
    const seam = t.edges.find((e) => e.form === 'seam')?.edge;
    const loops = adapter.faceGeometry(wall).loops;
    expect(loops).toHaveLength(2);
    expect(loops[0]?.some((use) => use.edge === seam)).toBe(true);
    expect(loops[1]?.some((use) => use.edge === seam)).toBe(false);
    expectSampleInside(wall);
  });
});

describe('side', () => {
  it('is 0 for a point in the face or in its surface beyond the trim', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 10, 10, 10));
    const top = faceAt(ref, [5, 5, 10]);
    expect(adapter.side([5, 5, 10], top, 'normal')).toBe(0);
    expect(adapter.side([50, 5, 10], top, 'normal')).toBe(0);
  });

  it('uses the closest point of the trimmed face, not of its surface', () => {
    start();
    const ref = adapter.addShape(k.makeCylinder(3, 20));
    const wall = facesWhere(ref, (c) => c[2] === 10 && Math.hypot(c[0], c[1]) < 3)[0] as ShapeKey;
    // Beyond the wall's end the closest point is on the rim.
    expect(adapter.side([10, 0, 30], wall, 'normal')).toBe(1);
    expect(adapter.side([1, 0, 30], wall, 'normal')).toBe(-1);
  });

  it('answers past a face whose parameters do not start at the seam', () => {
    start();
    const quarter = box(0, 0, 0, 10, 10, 20);
    const round = k.makeCylinder(5, 20);
    const { history } = step([round, quarter], (hashes, bound) =>
      k.intersectWithHistory(round, quarter, hashes, bound),
    );
    const wall = adapter
      .topology(history.result)
      .faces.find((f) => adapter.measures(f).surface === 'cylinder') as ShapeKey;
    const bounds = k.uvBounds(adapter.handleOf(wall));
    expect(bounds.uMax - bounds.uMin).toBeCloseTo(Math.PI / 2, 6);
    expect(adapter.side([6, 6, 10], wall, 'normal')).toBe(1);
    expect(adapter.side([1, 1, 10], wall, 'normal')).toBe(-1);
  });

  it('classifies against the solid, and gives a boundary point 0', () => {
    start();
    const ref = adapter.addShape(box(0, 0, 0, 10, 10, 10));
    const top = faceAt(ref, [5, 5, 10]);
    expect(adapter.side([5, 5, 5], top, 'solid')).toBe(-1);
    expect(adapter.side([5, 5, 11], top, 'solid')).toBe(1);
    expect(adapter.side([5, 5, 10], top, 'solid')).toBe(0);
    expect(adapter.side([0, 5, 5], top, 'solid')).toBe(0);
  });

  it('gives a sign right over a sphere pole', () => {
    start();
    const ref = adapter.addShape(k.makeSphere(5));
    const face = adapter.topology(ref).faces[0] as ShapeKey;
    expect(adapter.side([0, 0, 10], face, 'normal')).toBe(1);
    expect(adapter.side([0, 0, 2], face, 'normal')).toBe(-1);
    expect(adapter.side([10, 0, 0], face, 'normal')).toBe(1);
    expect(adapter.side([2, 0, 0], face, 'normal')).toBe(-1);
  });

  it('needs a solid for the solid test', () => {
    start();
    const lone = k.getSubShapes(box(0, 0, 0, 10, 10, 10), 'face')[0] as ShapeHandle;
    const ref = adapter.addShape(lone);
    const face = adapter.topology(ref).faces[0] as ShapeKey;
    expect(() => adapter.side([1, 1, 1], face, 'solid')).toThrow(NamingAdapterError);
  });
});

describe('a face that turns over', () => {
  it('gives a cutter floor left in a pocket a key of its own, so each side keeps its outward normal', () => {
    start();
    const target = box(0, 0, 0, 30, 30, 10);
    const tool = box(10, 10, 5, 10, 10, 10);
    const { history, refs } = step([target, tool], (hashes, bound) => k.cutWithHistory(target, tool, hashes, bound));

    const toolFloor = faceAt(refs[1] as ShapeRef, [15, 15, 5]);
    expect(history.faces.kept).not.toContain(toolFloor);
    const images = history.faces.modified.get(toolFloor) as readonly ShapeKey[];
    expect(images).toHaveLength(1);
    const pocketFloor = images[0] as ShapeKey;
    expect(pocketFloor).not.toBe(toolFloor);
    expect(k.isSame(adapter.handleOf(pocketFloor), adapter.handleOf(toolFloor))).toBe(true);

    close(adapter.measures(toolFloor).normal as Vec3, [0, 0, -1]);
    close(adapter.measures(pocketFloor).normal as Vec3, [0, 0, 1]);
    expect(adapter.side([15, 15, 8], toolFloor, 'normal')).toBe(-1);
    expect(adapter.side([15, 15, 8], pocketFloor, 'normal')).toBe(1);
  });
});

describe('a sweep', () => {
  const profile = (): ShapeHandle => {
    const rect = k.makeRectangle(2, 2);
    return k.isFace(rect) ? rect : k.makeFace(rect);
  };
  const extruded = (face: ShapeHandle, ref: string, z: number) =>
    adapter.sweepHistory(k.extrudeWithHistory(face, 0, 0, z, adapter.faceHashes([ref]), adapter.hashBound), ref);
  const revolved = (face: ShapeHandle, ref: string, axis: Parameters<OcctKernel['revolve']>[1], angle: number) =>
    adapter.sweepHistory(k.revolveWithHistory(face, axis, angle, adapter.faceHashes([ref]), adapter.hashBound), ref);

  it("reports an extrude's caps and walls", () => {
    start();
    const face = profile();
    const ref = adapter.addShape(face);
    const history = extruded(face, ref, 5);
    const t = adapter.topology(history.result);
    expect(t.faces).toHaveLength(6);

    const edges = adapter.topology(ref).edges.map((e) => e.edge);
    expect(history.edges.kept.sort()).toEqual([...edges].sort());
    expect(history.facesFromEdge.size).toBe(4);
    for (const edge of edges) {
      const walls = history.facesFromEdge.get(edge) as readonly ShapeKey[];
      expect(walls).toHaveLength(1);
      expect(adapter.measures(walls[0] as ShapeKey).area).toBeCloseTo(10, 9);
      // The wall stands on its profile edge.
      const m = adapter.measures(edge).midpoint as Vec3;
      const c = adapter.measures(walls[0] as ShapeKey).centroid as Vec3;
      close([m[0], m[1]], [c[0], c[1]]);
    }
    expect(history.caps?.first).toHaveLength(1);
    expect(history.caps?.last).toHaveLength(1);
    expect((adapter.measures(history.caps?.first[0] as ShapeKey).centroid as Vec3)[2]).toBeCloseTo(0, 9);
    expect((adapter.measures(history.caps?.last[0] as ShapeKey).centroid as Vec3)[2]).toBeCloseTo(5, 9);
    // The start cap faces away from the extrusion, so it is the profile turned over.
    close(adapter.measures(history.caps?.first[0] as ShapeKey).normal as Vec3, [0, 0, -1]);
    expect(history.faces.added).toEqual([]);
  });

  it("reports a partial revolve's caps and walls", () => {
    start();
    const face = k.translate(profile(), 10, 0, 0);
    const ref = adapter.addShape(face);
    const axis = { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
    const history = revolved(face, ref, axis, 1);
    expect(adapter.topology(history.result).faces).toHaveLength(6);
    expect(history.facesFromEdge.size).toBe(4);
    expect(history.caps?.last).toHaveLength(1);
  });

  it('leaves a profile edge on the axis without a wall, between the two caps', () => {
    start();
    const corners = [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ].map(([x, y]) => ({ x: x as number, y: y as number, z: 0 }));
    const face = k.makeFace(k.makeWire(corners.map((p, i) => k.makeLineEdge(p, corners[(i + 1) % 4] as typeof p))));
    const ref = adapter.addShape(face);
    const axis = { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
    const onAxis = adapter
      .topology(ref)
      .edges.map((e) => e.edge)
      .filter((e) => Math.abs((adapter.samplePoint(e) as Vec3)[0]) < 1e-9);
    expect(onAxis).toHaveLength(1);
    const history = revolved(face, ref, axis, 1);
    expect(adapter.topology(history.result).faces).toHaveLength(5);
    expect(history.facesFromEdge.get(onAxis[0] as ShapeKey) ?? []).toEqual([]);
    expect(history.caps?.last).toHaveLength(1);
    close([adapter.measures(history.caps?.last[0] as ShapeKey).area as number], [50]);
  });

  it('takes a holed circular profile: one wall per edge', () => {
    start();
    const outer = k.makeWire([k.makeCircleEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 10)]);
    const inner = k.makeWire([k.makeCircleEdge({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 4)]);
    const face = k.addHolesInFace(k.makeFace(outer), [inner]);
    const ref = adapter.addShape(face);
    const history = extruded(face, ref, 5);
    expect(adapter.topology(history.result).faces).toHaveLength(4);
    expect(history.facesFromEdge.size).toBe(2);
    const areas = [...history.facesFromEdge.values()]
      .flat()
      .map((w) => adapter.measures(w).area as number)
      .sort((a, b) => a - b);
    close(areas, [2 * Math.PI * 4 * 5, 2 * Math.PI * 10 * 5], 6);
    expect(history.caps?.last).toHaveLength(1);
  });

  it('reports every wall of a full revolve, flat ones included, and no caps', () => {
    start();
    const face = k.translate(profile(), 10, 0, 0);
    const ref = adapter.addShape(face);
    const axis = { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
    const history = revolved(face, ref, axis, 2 * Math.PI);
    expect(history.caps).toEqual({ first: [], last: [] });
    expect(history.faces.added).toEqual([]);
    const walls = [...history.facesFromEdge.values()].flat();
    expect(walls).toHaveLength(4);
    expect([...walls].sort()).toEqual([...adapter.topology(history.result).faces].sort());
  });
});

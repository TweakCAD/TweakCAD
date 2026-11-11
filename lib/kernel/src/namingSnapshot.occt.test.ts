/**
 * Snapshots and shape maps on the real kernel, through the adapter: look-alike
 * edges told apart by geometry alone, and a stored shape's identities surviving
 * a trip through BREP under new keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel, type ShapeHandle } from 'occt-wasm';
import {
  NameTable,
  NamedState,
  NamingPause,
  checkShapeMap,
  describeEdge,
  describeFace,
  matchesDescription,
  numberingRows,
  resolve,
  sameNumbering,
  shapeFingerprint,
  startFeature,
  tightTolerance,
  writeRecord,
  writeShapeMap,
  type EntityRecord,
  type OperationHistory,
  type Resolution,
  type ShapeKey,
  type ShapeMapEntry,
  type ShapeRef,
  type Vec3,
} from '@tweakcad/format';
import { HASH_BOUND, NamingAdapter } from './namingAdapter.ts';

let k: OcctKernel;
const adapters: NamingAdapter[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});

afterAll(() => {
  for (const a of adapters) a.dispose();
  k.releaseAll();
});

const F_BOX = 'feat_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const F_TOOL = 'feat_aeaqcaibaeaqcaibaeaqcaibae';
const F_CUT = 'feat_aiaqeaibaiaqeaibaiaqeaibai';
const F_FROZEN = 'feat_amaqgaibamaqgaibamaqgaibam';
const F_FILLET = 'feat_aqaqiaibaqaqiaibaqaqiaibaq';

function newAdapter(): NamingAdapter {
  const adapter = new NamingAdapter(k);
  adapters.push(adapter);
  return adapter;
}

const box = (x: number, y: number, z: number, a: number, b: number, c: number): ShapeHandle =>
  k.makeBoxFromCorners({ x, y, z }, { x: x + a, y: y + b, z: z + c });

const fresh = (shape: ShapeRef, adapter: NamingAdapter): OperationHistory => {
  const t = adapter.topology(shape);
  return {
    result: shape,
    inputs: [],
    faces: { kept: [], modified: new Map(), deleted: [], added: t.faces },
    edges: { kept: [], modified: new Map(), deleted: [], added: t.edges.map((e) => e.edge) },
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
};

/** Names a kernel shape as a primitive: `role` gives each face its name. */
function primitive(
  adapter: NamingAdapter,
  names: NameTable,
  state: NamedState,
  handle: ShapeHandle,
  ref: ShapeRef,
  feature: string,
  ordinal: number,
  role: (face: ShapeKey) => string,
) {
  const shape = adapter.addShape(handle, ref);
  const t = adapter.topology(shape);
  const namer = startFeature(state, { feature, ordinal }, adapter, names);
  namer.step(fresh(shape, adapter), {
    outputs: t.faces.map((f) => ({ entity: f, role: role(f), src: [] })),
    dividers: [],
  });
  return { shape, state: namer.finish(t.solids.map((s) => ({ solid: s.solid, from: { create: [{ index: 0 }] } }))) };
}

const boxRole =
  (adapter: NamingAdapter) =>
  (f: ShapeKey): string => {
    const n = adapter.measures(f).normal as Vec3;
    const axis = n.findIndex((c) => Math.abs(c) > 0.5);
    return `${(n[axis] as number) > 0 ? '+' : '-'}${'xyz'[axis]}`;
  };

/** The one face or edge of a shape passing `where`. */
function only(keys: readonly ShapeKey[], where: (key: ShapeKey) => boolean): ShapeKey {
  const found = keys.filter(where);
  expect(found).toHaveLength(1);
  return found[0] as ShapeKey;
}

const midpoint = (adapter: NamingAdapter, edge: ShapeKey) => adapter.measures(edge).midpoint as Vec3;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Two cylinders' common part: two walls meeting along two straight edges at x = ±4 for `offset` 3, radius 5. */
function lens(offset = 3) {
  const adapter = newAdapter();
  const names = new NameTable();
  const cylinder = k.makeCylinder(5, 10);
  const handle = k.common(k.translate(cylinder, 0, -offset, 0), k.translate(cylinder, 0, offset, 0));
  const role = (f: ShapeKey): string => {
    const m = adapter.measures(f);
    if (m.surface === 'plane') return (m.normal as Vec3)[2] > 0 ? 'top' : 'bottom';
    return (m.centroid as Vec3)[1] > 0 ? 'wallA' : 'wallB';
  };
  const { shape, state } = primitive(adapter, names, NamedState.empty(), handle, 'lens', F_BOX, 0, role);
  const walls = adapter.topology(shape).edges.filter((e) => adapter.measures(e.edge).curve === 'line');
  return { adapter, names, shape, state, walls: walls.map((e) => e.edge) };
}

function keyOf(found: Resolution): ShapeKey {
  if (found.outcome !== 'same') throw new Error(`expected same, got ${found.outcome}`);
  return found.entities[0]?.key as ShapeKey;
}

describe('rule 5 on the real kernel', () => {
  it('finds two look-alike edges by geometry alone', () => {
    const first = lens();
    expect(first.adapter.topology(first.shape).faces).toHaveLength(4);
    expect(first.walls).toHaveLength(2);
    const [a, b] = first.walls.map((e) => first.state.get(e)!);
    // Everything but geometry agrees.
    expect(a?.ladder).toEqual(b?.ladder);
    expect(a?.branch).toEqual(b?.branch);
    const right = only(first.walls, (e) => midpoint(first.adapter, e)[0] > 0);
    const left = only(first.walls, (e) => midpoint(first.adapter, e)[0] < 0);
    const records = [right, left].map((e) => writeRecord(first.state.get(e)!, first.state, first.adapter));
    expect(records[0]?.n).toBe(2);
    expect(records[0]?.nb).toEqual(records[1]?.nb);
    expect(records[0]?.side).toEqual(records[1]?.side);
    expect(records[0]?.snapshot.geometry).toBeDefined();

    const again = lens();
    const [toRight, toLeft] = records.map((r) => resolve(r as EntityRecord, again.state, again.adapter));
    expect(midpoint(again.adapter, keyOf(toRight as Resolution))[0]).toBeGreaterThan(0);
    expect(midpoint(again.adapter, keyOf(toLeft as Resolution))[0]).toBeLessThan(0);
  });

  it('asks once the same edges have moved', () => {
    const first = lens();
    const right = only(first.walls, (e) => midpoint(first.adapter, e)[0] > 0);
    const record = writeRecord(first.state.get(right)!, first.state, first.adapter);
    const moved = lens(3.5);
    expect(resolve(record, moved.state, moved.adapter).outcome).toBe('ask');
  });

  it('describes a B-spline edge, which the adapter reads exactly', () => {
    const adapter = newAdapter();
    const edge = k.interpolatePoints([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 3, y: 1, z: 0 },
    ]);
    const ref = adapter.addShape(edge, 'curve');
    const key = adapter.subShapes(ref).find((s) => s.kind === 'edge')?.key as ShapeKey;
    const description = describeEdge(key, adapter);
    expect(description).not.toBeNull();
    expect(description).toHaveProperty('edge.curve.bspline.poles');
    expect(matchesDescription(description, describeEdge(key, adapter), tightTolerance(10))).toBe(true);
  });
});

describe('canonical geometry on the real kernel', () => {
  it("writes a face's loops with the face on the left: outer counter-clockwise, hole clockwise", () => {
    const adapter = newAdapter();
    const plate = box(0, 0, 0, 20, 20, 5);
    const drill = k.translate(k.makeCylinder(3, 10), 10, 10, -2);
    const ref = adapter.addShape(k.cut(plate, drill), 'plate');
    const faces = adapter.topology(ref).faces;
    const top = only(faces, (f) => {
      const n = adapter.measures(f).normal;
      return n !== undefined && n[2] > 0.5;
    });
    interface Written {
      face: {
        loops: { edge: { closed: boolean; curve: { line?: { start: Vec3; end: Vec3 }; circle?: { axis: Vec3 } } } }[][];
      };
    }
    const { loops } = (describeFace(top, adapter) as unknown as Written).face;
    expect(loops).toHaveLength(2);
    const [outer, inner] = loops as [Written['face']['loops'][number], Written['face']['loops'][number]];

    expect(outer).toHaveLength(4);
    let twiceArea = 0;
    outer.forEach((use, i) => {
      const { start, end } = use.edge.curve.line as { start: Vec3; end: Vec3 };
      expect(end).toEqual((outer[(i + 1) % 4] as typeof use).edge.curve.line?.start);
      twiceArea += start[0] * end[1] - end[0] * start[1];
    });
    expect(twiceArea).toBeCloseTo(2 * 400, 9);

    const hole = inner.find((use) => use.edge.curve.circle)?.edge.curve.circle;
    expect(hole?.axis).toEqual([0, 0, -1]);
  });

  it('gives identical bytes for the same model built twice', () => {
    const write = () => {
      const adapter = newAdapter();
      const ref = adapter.addShape(box(1, 2, 3, 4, 5, 6), 'box');
      return adapter.topology(ref).faces.map((f) => describeFace(f, adapter));
    };
    expect(write()).toEqual(write());
  });
});

/** A named box. */
function boxBuild() {
  const adapter = newAdapter();
  const names = new NameTable();
  const handle = box(0, 0, 0, 10, 20, 30);
  const { shape, state } = primitive(adapter, names, NamedState.empty(), handle, 'box', F_BOX, 0, boxRole(adapter));
  return { adapter, names, shape, state, handle };
}

/** Writes the map of the given solids wrapped as 13.2 stores them, the asset's BREP and its fingerprint as decoded. */
function freeze(adapter: NamingAdapter, state: NamedState, solids: readonly ShapeHandle[]) {
  const compound = k.makeCompound([...solids]);
  const ref = adapter.addShape(compound, 'stored');
  // Through JSON, as a document would hold it.
  const map = JSON.parse(JSON.stringify(writeShapeMap(state, ref, adapter))) as ShapeMapEntry[];
  const brep = k.toBREP(compound);
  const decoded = thaw(brep);
  expect(sameNumbering(numberingRows(ref, adapter), numberingRows(decoded.ref, decoded.adapter))).toBe(true);
  return { map, brep, fingerprint: shapeFingerprint(decoded.ref, decoded.adapter) };
}

/** Reloads an asset in a new build whose keys do not line up with the old one. */
function thaw(brep: string) {
  const adapter = newAdapter();
  adapter.addShape(box(100, 100, 100, 1, 1, 1), 'unrelated');
  return { adapter, ref: adapter.addShape(k.fromBREP(brep), 'loaded') };
}

function loadInto(adapter: NamingAdapter, names: NameTable, ref: ShapeRef, map: ShapeMapEntry[], fingerprint: string) {
  const namer = startFeature(NamedState.empty(), { feature: F_FROZEN, ordinal: 1 }, adapter, names);
  namer.load(ref, map, fingerprint);
  return namer.finish([]);
}

describe('a frozen box', () => {
  it('keeps its names and references under new keys', () => {
    const built = boxBuild();
    const { adapter, state } = built;
    const top = only(adapter.topology(built.shape).faces, (f) => boxRole(adapter)(f) === '+z');
    const edge = only(
      adapter.topology(built.shape).edges.map((e) => e.edge),
      (e) => {
        const m = midpoint(adapter, e);
        return near(m[0], 10) && near(m[2], 30);
      },
    );
    const corner = only(
      adapter.topology(built.shape).vertices.map((v) => v.vertex),
      (v) => {
        const p = adapter.measures(v).point as Vec3;
        return near(p[0], 10) && near(p[1], 20) && near(p[2], 30);
      },
    );
    const body = adapter.topology(built.shape).solids[0]?.solid as ShapeKey;
    const picks = [top, edge, corner, body].map((key) => ({
      key,
      record: writeRecord(state.get(key)!, state, adapter),
    }));

    const { map, brep, fingerprint } = freeze(adapter, state, [built.handle]);
    const later = thaw(brep);
    const loaded = loadInto(later.adapter, built.names, later.ref, map, fingerprint);

    expect(loaded.entities.size).toBe(state.entities.size);
    for (const { key, record } of picks) {
      const found = keyOf(resolve(record, loaded, later.adapter));
      expect(loaded.get(found)?.ladder).toEqual(state.get(key)?.ladder);
      expect(
        later.adapter.measures(found).centroid ??
          later.adapter.measures(found).point ??
          later.adapter.measures(found).midpoint,
      ).toEqual(adapter.measures(key).centroid ?? adapter.measures(key).point ?? adapter.measures(key).midpoint);
    }
    // Keys really are new.
    expect(later.adapter.subShapes(later.ref).map((s) => s.key)).not.toEqual(
      adapter.subShapes('stored').map((s) => s.key),
    );
  });

  it('pauses on a mismatching map', () => {
    const built = boxBuild();
    const { map, fingerprint } = freeze(built.adapter, built.state, [built.handle]);

    // Another shape altogether: the same topology, numbered the same, with other points.
    const other = thaw(k.toBREP(k.makeCompound([box(0, 0, 0, 10, 20, 31)])));
    expect(checkShapeMap(map, other.ref, other.adapter, fingerprint)).toEqual({ index: null, field: 'fingerprint' });
    expect(() => loadInto(other.adapter, built.names, other.ref, map, fingerprint)).toThrow(NamingPause);

    // Another count.
    const two = thaw(k.toBREP(k.makeCompound([box(0, 0, 0, 10, 20, 30), box(50, 0, 0, 1, 1, 1)])));
    expect(() => loadInto(two.adapter, built.names, two.ref, map, fingerprint)).toThrow(NamingPause);
  });

  it('lets a later live feature keep names: a fillet after the freeze leaves the other picks alone', () => {
    const built = boxBuild();
    const { adapter, state } = built;
    const edges = adapter.topology(built.shape).edges.map((e) => e.edge);
    const other = only(edges, (e) => {
      const m = midpoint(adapter, e);
      return near(m[0], 0) && near(m[2], 0);
    });
    const record = writeRecord(state.get(other)!, state, adapter);
    const { map, brep, fingerprint } = freeze(adapter, state, [built.handle]);

    const later = thaw(brep);
    const loaded = loadInto(later.adapter, built.names, later.ref, map, fingerprint);
    const solidKey = later.adapter.topology(later.ref).solids[0]?.solid as ShapeKey;
    const solid = later.adapter.handleOf(solidKey);
    const input = later.adapter.addShape(solid, 'solid');
    const target = only(
      later.adapter.topology(input).edges.map((e) => e.edge),
      (e) => {
        const m = midpoint(later.adapter, e);
        return near(m[0], 10) && near(m[2], 30);
      },
    );
    const evolution = k.filletWithHistory(
      solid,
      [later.adapter.handleOf(target)],
      1,
      later.adapter.faceHashes([input]),
      HASH_BOUND,
    );
    const history = later.adapter.history(evolution, [{ shape: input, use: 'target' }]);
    const outputs = [...history.facesFromEdge].flatMap(([from, faces]) =>
      faces.map((f) => ({ entity: f, role: 'blend', src: [{ entity: from }] })),
    );
    const namer = startFeature(loaded, { feature: F_FILLET, ordinal: 2 }, later.adapter, built.names);
    namer.step(history, { outputs, dividers: [] });
    const solids = later.adapter.topology(history.result).solids;
    const after = namer.finish(solids.map((s) => ({ solid: s.solid, from: { carry: [input] } })));

    const found = keyOf(resolve(record, after, later.adapter));
    const m = midpoint(later.adapter, found);
    expect(near(m[0], 0) && near(m[2], 0)).toBe(true);
    expect(after.get(found)?.ladder).toEqual(state.get(other)?.ladder);
  });
});

describe('a frozen slotted box', () => {
  it('keeps two pieces apart, each pick on its own piece', () => {
    const adapter = newAdapter();
    const names = new NameTable();
    const handle = box(0, 0, 0, 10, 10, 10);
    const first = primitive(adapter, names, NamedState.empty(), handle, 'box', F_BOX, 0, boxRole(adapter));
    const toolHandle = box(4.9, -1, -1, 0.2, 12, 12);
    const tool = primitive(adapter, names, first.state, toolHandle, 'tool', F_TOOL, 1, boxRole(adapter));
    const evolution = k.cutWithHistory(handle, toolHandle, adapter.faceHashes([first.shape, tool.shape]), HASH_BOUND);
    const history = adapter.history(evolution, [
      { shape: first.shape, use: 'target' },
      { shape: tool.shape, use: 'tool' },
    ]);
    const namer = startFeature(tool.state, { feature: F_CUT, ordinal: 2 }, adapter, names);
    namer.step(history, { outputs: [], dividers: adapter.topology(tool.shape).faces }, 'normal');
    const solids = adapter.topology(history.result).solids;
    const state = namer.finish(solids.map((s) => ({ solid: s.solid, from: { carry: [first.shape] } })));

    const walls = adapter.topology(history.result).faces.filter((f) => adapter.measures(f).normal?.[1] === 1);
    expect(walls).toHaveLength(2);
    const onLeft = (a: NamingAdapter, f: ShapeKey) => (a.measures(f).centroid as Vec3)[0] < 4.9;
    const left = only(walls, (f) => onLeft(adapter, f));
    const right = only(walls, (f) => !onLeft(adapter, f));
    const records = [left, right].map((f) => writeRecord(state.get(f)!, state, adapter));

    const { map, brep, fingerprint } = freeze(
      adapter,
      state,
      solids.map((s) => adapter.handleOf(s.solid)),
    );
    const stored = adapter.subShapes('stored');
    expect(stored[0]?.kind).toBe('compound');
    expect(stored[0]?.children).toHaveLength(2);

    const later = thaw(brep);
    const loaded = loadInto(later.adapter, names, later.ref, map, fingerprint);
    expect(loaded.splits.has(F_CUT)).toBe(true);
    expect(loaded.bodies.size).toBe(2);
    const [toLeft, toRight] = records.map((r) => keyOf(resolve(r, loaded, later.adapter)));
    expect(onLeft(later.adapter, toLeft as ShapeKey)).toBe(true);
    expect(onLeft(later.adapter, toRight as ShapeKey)).toBe(false);
  });
});

describe('the fingerprint across a BREP round trip', () => {
  const wrapped = (solid: ShapeHandle) => {
    const adapter = newAdapter();
    const compound = k.makeCompound([solid]);
    const ref = adapter.addShape(compound, 'stored');
    const map = writeShapeMap(NamedState.empty(), ref, adapter);
    const brep = k.toBREP(compound);
    const later = thaw(brep);
    return { map, adapter, ref, brep, later };
  };

  const free = () => {
    const profile = k.interpolatePoints([
      { x: 10, y: 0, z: 0 },
      { x: 5, y: 3, z: 0 },
      { x: 0, y: 0, z: 0 },
    ]);
    const closing = k.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
    return k.extrude(k.makeFace(k.makeWire([profile, closing])), 0, 0, 5);
  };

  it.each([
    ['a cylinder', () => k.makeCylinder(5, 10)],
    ['a cone', () => k.makeCone(5, 2, 10)],
    ['a sphere', () => k.makeSphere(7)],
    ['a torus', () => k.makeTorus(10, 2)],
    [
      'a mirrored fillet',
      () => {
        const b = box(0, 0, 0, 10, 10, 10);
        const edges = k.getSubShapes(b, 'edge');
        return k.mirror(k.fillet(b, [edges[0] as ShapeHandle], 1), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      },
    ],
    ['a free-form face', free],
  ])('numbers %s the same once decoded, and decodes it to the same fingerprint every time', (_, make) => {
    const { map, adapter, ref, brep, later } = wrapped(make());
    // The text keeps 15 digits, so the values may differ in the last bits, never the numbering.
    expect(sameNumbering(numberingRows(ref, adapter), numberingRows(later.ref, later.adapter))).toBe(true);
    const fingerprint = shapeFingerprint(later.ref, later.adapter);
    const again = thaw(k.toBREP(k.fromBREP(brep)));
    expect(shapeFingerprint(again.ref, again.adapter)).toBe(fingerprint);
    expect(checkShapeMap(map, later.ref, later.adapter, fingerprint)).toBeNull();
  });
});

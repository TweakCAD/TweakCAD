/**
 * The naming module on the real kernel, through the adapter: names stay the
 * same across rebuilds whose kernel hashes differ, and saved picks land on
 * the same faces after everyday edits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel, type ShapeHandle } from 'occt-wasm';
import {
  NameTable,
  NamedState,
  resolve,
  startFeature,
  writeRecord,
  type BuilderReport,
  type OperationHistory,
  type ShapeKey,
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

const box = (x: number, y: number, z: number, a: number, b: number, c: number): ShapeHandle =>
  k.makeBoxFromCorners({ x, y, z }, { x: x + a, y: y + b, z: z + c });

const ROLE = (n: Vec3): string => {
  const axis = n.findIndex((c) => Math.abs(c) > 0.5);
  return `${(n[axis] as number) > 0 ? '+' : '-'}${'xyz'[axis]}`;
};

interface Build {
  adapter: NamingAdapter;
  names: NameTable;
  state: NamedState;
  shape: ShapeRef;
  handle: ShapeHandle;
}

/** Names a box made by the kernel as a primitive: one role per face from its outward normal. */
function primitive(
  adapter: NamingAdapter,
  names: NameTable,
  state: NamedState,
  handle: ShapeHandle,
  ref: ShapeRef,
  feature: string,
  ordinal: number,
) {
  const shape = adapter.addShape(handle, ref);
  const t = adapter.topology(shape);
  const history: OperationHistory = {
    result: shape,
    inputs: [],
    faces: { kept: [], modified: new Map(), deleted: [], added: t.faces },
    edges: { kept: [], modified: new Map(), deleted: [], added: t.edges.map((e) => e.edge) },
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
  const report: BuilderReport = {
    outputs: t.faces.map((f) => ({ entity: f, role: ROLE(adapter.measures(f).normal as Vec3), src: [] })),
    dividers: [],
  };
  const namer = startFeature(state, { feature, ordinal }, adapter, names);
  namer.step(history, report);
  return { shape, state: namer.finish([{ solid: t.solids[0]?.solid as ShapeKey, from: { create: [{ index: 0 }] } }]) };
}

function start(): Build {
  const adapter = new NamingAdapter(k);
  adapters.push(adapter);
  const names = new NameTable();
  const handle = box(0, 0, 0, 10, 10, 10);
  const { shape, state } = primitive(adapter, names, NamedState.empty(), handle, 'box', F_BOX, 0);
  return { adapter, names, state, shape, handle };
}

/** Cuts a thin slot through x = 5, splitting the box in two. */
function slot(b: Build): Build {
  const toolHandle = box(4.9, -1, -1, 0.2, 12, 12);
  const tool = primitive(b.adapter, b.names, b.state, toolHandle, 'tool', F_TOOL, 1);
  const evolution = k.cutWithHistory(b.handle, toolHandle, b.adapter.faceHashes([b.shape, tool.shape]), HASH_BOUND);
  const history = b.adapter.history(evolution, [
    { shape: b.shape, use: 'target' },
    { shape: tool.shape, use: 'tool' },
  ]);
  const namer = startFeature(tool.state, { feature: F_CUT, ordinal: 2 }, b.adapter, b.names);
  namer.step(history, { outputs: [], dividers: b.adapter.topology(tool.shape).faces }, 'normal');
  const solids = b.adapter.topology(history.result).solids;
  const state = namer.finish(solids.map((s) => ({ solid: s.solid, from: { carry: [b.shape] } })));
  return { ...b, state, shape: history.result, handle: evolution.result };
}

/** Rounds the edge along y at x = 10, z = 10. */
function fillet(b: Build): Build {
  const edge = b.adapter.topology(b.shape).edges.find((e) => {
    const m = b.adapter.measures(e.edge).midpoint as Vec3;
    return Math.abs(m[0] - 10) < 1e-9 && Math.abs(m[2] - 10) < 1e-9;
  });
  if (!edge) throw new Error('no edge at x = 10, z = 10');
  const evolution = k.filletWithHistory(
    b.handle,
    [b.adapter.handleOf(edge.edge)],
    1,
    b.adapter.faceHashes([b.shape]),
    HASH_BOUND,
  );
  const history = b.adapter.history(evolution, [{ shape: b.shape, use: 'target' }]);
  const outputs = [...history.facesFromEdge].flatMap(([from, faces]) =>
    faces.map((f) => ({ entity: f, role: 'blend', src: [{ entity: from }] })),
  );
  const namer = startFeature(b.state, { feature: F_CUT, ordinal: 2 }, b.adapter, b.names);
  namer.step(history, { outputs, dividers: [] });
  const solids = b.adapter.topology(history.result).solids;
  const state = namer.finish(solids.map((s) => ({ solid: s.solid, from: { carry: [b.shape] } })));
  return { ...b, state, shape: history.result, handle: evolution.result };
}

/** The face of `b`'s current shape with this outward normal, whose centroid passes `where`. */
function faceAt(b: Build, normal: string, where: (c: Vec3) => boolean): ShapeKey {
  const found = b.adapter.topology(b.shape).faces.filter((f) => {
    const m = b.adapter.measures(f);
    return ROLE(m.normal as Vec3) === normal && where(m.centroid as Vec3);
  });
  expect(found).toHaveLength(1);
  return found[0] as ShapeKey;
}

describe('naming on the real kernel', () => {
  it('names a kernel box the same in two builds', () => {
    const first = start();
    const second = start();
    const ladders = (b: Build) =>
      ['+x', '-x', '+y', '-y', '+z', '-z'].map((r) => b.state.get(faceAt(b, r, () => true))?.ladder);
    expect(ladders(first)).toEqual(ladders(second));
  });

  it('keeps a pick on one piece of a slotted box through a full rebuild', () => {
    const first = slot(start());
    const left = faceAt(first, '+y', (c) => c[0] < 4.9);
    const right = faceAt(first, '+y', (c) => c[0] > 5.1);
    expect(first.state.get(left)?.ladder).toEqual(first.state.get(right)?.ladder);
    expect(first.state.get(left)?.branch).not.toEqual(first.state.get(right)?.branch);
    const record = writeRecord(first.state.get(left)!, first.state, first.adapter);

    const again = slot(start());
    const found = resolve(record, again.state, again.adapter);
    expect(found.outcome).toBe('same');
    const key = found.outcome === 'same' ? (found.entities[0]?.key as ShapeKey) : -1;
    expect((again.adapter.measures(key).centroid as Vec3)[0]).toBeLessThan(4.9);
  });

  it('keeps a pick on the top face when an edge of it is filleted', () => {
    const plain = start();
    const record = writeRecord(plain.state.get(faceAt(plain, '+z', () => true))!, plain.state, plain.adapter);
    const rounded = fillet(start());
    const found = resolve(record, rounded.state, rounded.adapter);
    expect(found.outcome).toBe('same');
    const key = found.outcome === 'same' ? (found.entities[0]?.key as ShapeKey) : -1;
    expect(ROLE(rounded.adapter.measures(key).normal as Vec3)).toBe('+z');
    // The blend is named from its edge, the same in every build.
    const roleOf = (b: Build, level: string | undefined) =>
      level === undefined ? undefined : (b.names.get(level) as { role?: string } | undefined)?.role;
    const blend = (b: Build) => [...b.state.entities.values()].find((e) => roleOf(b, e.ladder[1]) === 'blend')?.ladder;
    expect(blend(rounded)).toBeDefined();
    expect(blend(rounded)).toEqual(blend(fillet(start())));
  });
});

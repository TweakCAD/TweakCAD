import { describe, expect, it } from 'vitest';
import { canonicalize, type JsonValue } from '../canonical';
import { Reader } from '../model/reader';
import { readStoredShape } from '../model/storage';
import { NameTable } from '../names';
import { addBox, addCompound, FACE_ROLES, FakeKernel, type FakeBox } from './fakeKernel';
import type { ShapeKey, ShapeRef } from './facts';
import { NamingPause, startFeature } from './namer';
import type { CopyStep } from './names';
import { resolve, writeRecord } from './resolve';
import {
  checkShapeMap,
  entrySnapshot,
  numberingRows,
  sameNumbering,
  shapeFingerprint,
  writeShapeMap,
  type ShapeMapEntry,
} from './shapeMap';
import { NamedState } from './state';

const F_BOX = 'feat_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const F_CUT = 'feat_aiaqeaibaiaqeaibaiaqeaibai';
const F_FROZEN = 'feat_amaqgaibamaqgaibamaqgaibam';
const F_LATER = 'feat_aqaqiaibaqaqiaibaqaqiaibaq';

const empty = () => ({ kept: [], modified: new Map<ShapeKey, ShapeKey[]>(), deleted: [], added: [] });

function nameBox(
  kernel: FakeKernel,
  names: NameTable,
  state: NamedState,
  box: FakeBox,
  feature: string,
  ordinal: number,
) {
  const namer = startFeature(state, { feature, ordinal }, kernel, names);
  namer.step(
    {
      result: box.shape,
      inputs: [],
      faces: empty(),
      edges: empty(),
      facesFromFace: new Map(),
      facesFromEdge: new Map(),
    },
    { outputs: FACE_ROLES.map((role) => ({ entity: box.faces[role], role, src: [] })), dividers: [] },
  );
  return namer.finish([{ solid: box.solid, from: { create: [{ index: 0 }] } }]);
}

/** A box named live, its map written as if frozen, and the same box again under new keys in a fresh kernel. */
function frozen() {
  const kernel = new FakeKernel();
  const names = new NameTable();
  const box = addBox(kernel, 'box', 100, [0, 0, 0], [10, 20, 30]);
  const state = nameBox(kernel, names, NamedState.empty(), box, F_BOX, 0);
  addCompound(kernel, 'stored', 99, ['box']);
  const map = writeShapeMap(state, 'stored', kernel);

  const later = new FakeKernel();
  const copy = addBox(later, 'copy', 5000, [0, 0, 0], [10, 20, 30]);
  addCompound(later, 'loaded', 4999, ['copy']);
  return { kernel, names, box, state, map, later, copy };
}

/** Loads `map` into `shape` of `later`, which stands for the stored bytes decoded: its fingerprint is the stored one. */
function load(later: FakeKernel, names: NameTable, map: ShapeMapEntry[], shape: ShapeRef = 'loaded') {
  const namer = startFeature(NamedState.empty(), { feature: F_FROZEN, ordinal: 1 }, later, names);
  namer.load(shape, map, shapeFingerprint(shape, later));
  return namer.finish([]);
}

describe('writing a shape map', () => {
  it('has one entry per sub-shape in index order, with direct children', () => {
    const { kernel, map, box, state } = frozen();
    const subs = kernel.subShapes('stored');
    expect(map).toHaveLength(1 + 1 + 1 + 6 + 6 + 12 + 8);
    expect(subs.map((s) => s.kind).slice(0, 4)).toEqual(['compound', 'solid', 'shell', 'face']);
    expect(map[0]?.children).toEqual({ set: [1] });
    expect(map[1]?.ladder).toEqual(state.get(box.solid)?.ladder);
    expect(new Set(map[2]?.children.set)).toEqual(new Set([3, 4, 5, 6, 7, 8]));
  });

  it('leaves what no reference can name with an empty ladder', () => {
    const { kernel, map } = frozen();
    const subs = kernel.subShapes('stored');
    for (const [i, sub] of subs.entries()) {
      const named = sub.kind === 'solid' || sub.kind === 'face' || sub.kind === 'edge' || sub.kind === 'vertex';
      expect((map[i]?.ladder.length ?? 0) > 0).toBe(named);
    }
  });

  it('holds no snapshots: the fingerprint of the stored shape checks it', () => {
    const { map } = frozen();
    expect(map.every((e) => e.snapshot === undefined)).toBe(true);
  });

  it('is what the document reader accepts, with its fingerprint, byte-stable', () => {
    const { map, kernel } = frozen();
    const r = new Reader();
    const fingerprint = shapeFingerprint('stored', kernel);
    const stored = { asset: 'a'.repeat(64), representation: { name: 'brep', version: 1 }, map, fingerprint };
    readStoredShape(r, stored, '/stored');
    expect(r.diagnostics.list).toEqual([]);
    expect(canonicalize(map as unknown as JsonValue)).toBe(canonicalize(frozen().map as unknown as JsonValue));
  });
});

describe('loading a shape map', () => {
  it('gives every sub-shape its identity under new keys', () => {
    const { names, box, state, map, later, copy } = frozen();
    const loaded = load(later, names, map);
    for (const role of FACE_ROLES)
      expect(loaded.get(copy.faces[role])?.ladder).toEqual(state.get(box.faces[role])?.ladder);
    expect(loaded.get(copy.edge('+x', '+z'))?.ladder).toEqual(state.get(box.edge('+x', '+z'))?.ladder);
    expect(loaded.get(copy.solid)).toMatchObject({
      kind: 'body',
      ladder: state.get(box.solid)?.ladder,
      body: 'loaded',
    });
    expect(loaded.bodies.get(copy.solid)).toBe('loaded');
    expect(loaded.entities.size).toBe(state.entities.size);
  });

  it('loads an edge whose name stops at its role, as a loose edge on no face has', () => {
    const { kernel, names, map, later } = frozen();
    const at = kernel.subShapes('stored').findIndex((s) => s.kind === 'edge');
    const entry = map[at] as ShapeMapEntry;
    const loose = map.with(at, { ...entry, ladder: entry.ladder.slice(0, 2) });
    expect(() => load(later, names, loose)).not.toThrow();
  });

  it('resolves references made before freezing', () => {
    const { kernel, names, box, state, map, later, copy } = frozen();
    const loaded = load(later, names, map);
    for (const key of [box.faces['+y'], box.edge('+x', '+z'), box.solid]) {
      const record = writeRecord(state.get(key)!, state, kernel);
      const found = resolve(record, loaded, later);
      expect(found.outcome).toBe('same');
      const wanted =
        key === box.solid ? copy.solid : key === box.faces['+y'] ? copy.faces['+y'] : copy.edge('+x', '+z');
      expect(found).toMatchObject({ entities: [{ key: wanted }] });
    }
  });

  it('keeps pieces apart: the split stays in effect, branch and aliases come through', () => {
    const { kernel, names, box, state } = frozen();
    const branch = [
      { split: F_CUT, side: [{ of: state.get(box.faces['-x'])?.ladder.at(-1) as string, sign: 1 as const }] },
    ];
    const alias = { hash: state.get(box.faces['-z'])?.ladder.at(-1) as string, branch: [{ split: F_LATER, side: [] }] };
    const entities = new Map(state.entities);
    const top = state.get(box.faces['+z'])!;
    entities.set(top.key, { ...top, branch, aliases: [alias, alias] });
    const split = new NamedState(entities, state.bodies, new Set([F_CUT]), state.producers);
    const map = writeShapeMap(split, 'stored', kernel);
    const reader = new Reader();
    const fingerprint = shapeFingerprint('stored', kernel);
    readStoredShape(
      reader,
      { asset: 'a'.repeat(64), representation: { name: 'brep', version: 1 }, map, fingerprint },
      '/stored',
    );
    expect(reader.diagnostics.list).toEqual([]);

    const later = new FakeKernel();
    const copy = addBox(later, 'copy', 5000, [0, 0, 0], [10, 20, 30]);
    addCompound(later, 'loaded', 4999, ['copy']);
    const loaded = load(later, names, map);
    expect(loaded.splits).toEqual(new Set([F_CUT, F_LATER]));
    expect(loaded.get(copy.faces['+z'])).toMatchObject({ branch, aliases: [alias] });

    const piece = writeRecord(split.get(top.key)!, split, kernel);
    expect(resolve(piece, loaded, later)).toMatchObject({ outcome: 'same', entities: [{ key: copy.faces['+z'] }] });
    const merged = {
      ...piece,
      id: [alias.hash],
      branch: alias.branch.map((b) => ({ split: { id: b.split }, side: b.side })),
      n: 1,
    };
    expect(resolve(merged, loaded, later)).toMatchObject({ outcome: 'same', entities: [{ key: copy.faces['+z'] }] });
  });

  it("names a later live feature's edges as if the frozen feature had built", () => {
    const live = frozen();
    const namerAfter = (
      kernel: FakeKernel,
      names: NameTable,
      before: NamedState,
      input: ShapeRef,
      faces: readonly ShapeKey[],
      result: FakeBox,
    ) => {
      const namer = startFeature(before, { feature: F_LATER, ordinal: 2 }, kernel, names);
      const keep = new Map(faces.map((f, i) => [f, [Object.values(result.faces)[i] as ShapeKey]]));
      namer.step(
        {
          result: result.shape,
          inputs: [{ shape: input, use: 'target' }],
          faces: { kept: [], modified: keep, deleted: [], added: [] },
          edges: empty(),
          facesFromFace: new Map(),
          facesFromEdge: new Map(),
        },
        { outputs: [], dividers: [] },
      );
      return namer.finish([{ solid: result.solid, from: { carry: [input] } }]);
    };

    // A later feature that carries every face into a new shape, once after the live box, once after the frozen one.
    const moved = addBox(live.kernel, 'moved', 700, [0, 0, 0], [10, 20, 30]);
    const afterLive = namerAfter(live.kernel, live.names, live.state, 'box', Object.values(live.box.faces), moved);

    const loaded = load(live.later, live.names, live.map);
    const movedAgain = addBox(live.later, 'moved', 800, [0, 0, 0], [10, 20, 30]);
    const afterFrozen = namerAfter(
      live.later,
      live.names,
      loaded,
      'loaded',
      Object.values(live.copy.faces),
      movedAgain,
    );

    expect(afterFrozen.get(movedAgain.edge('+x', '+z'))?.ladder).toEqual(afterLive.get(moved.edge('+x', '+z'))?.ladder);
    expect(afterFrozen.get(movedAgain.solid)?.ladder).toEqual(afterLive.get(moved.solid)?.ladder);
    expect(afterFrozen.get(movedAgain.edge('+x', '+z'))?.ladder).toEqual(
      live.state.get(live.box.edge('+x', '+z'))?.ladder,
    );
  });

  it('recovers what a blend stands for from its name', () => {
    const { kernel, names, box, state } = frozen();
    // A blend face made from the edge between +x and +z.
    const edgeName = state.get(box.edge('+x', '+z'))?.ladder.at(-1) as string;
    const blended = names.intern({
      kind: 'face',
      chain: [],
      feature: { id: F_CUT },
      role: 'blend',
      src: [{ name: { hash: edgeName } }],
    });
    const entities = new Map(state.entities);
    const face = state.get(box.faces['-x'])!;
    const names2 = [state.get(box.faces['+x'])?.ladder.at(-1), state.get(box.faces['+z'])?.ladder.at(-1)];
    entities.set(face.key, { ...face, ladder: [blended], standsFor: names2 as string[] });
    const map = writeShapeMap(new NamedState(entities, state.bodies, state.splits, state.producers), 'stored', kernel);

    const later = new FakeKernel();
    const copy = addBox(later, 'copy', 5000, [0, 0, 0], [10, 20, 30]);
    addCompound(later, 'loaded', 4999, ['copy']);
    const loaded = load(later, names, map);
    expect([...(loaded.get(copy.faces['-x'])?.standsFor ?? [])].sort()).toEqual([...names2].sort());
    expect(loaded.get(copy.faces['+y'])?.standsFor).toEqual([]);
  });

  it("keeps a replaced body's place in creation order and drops the body it replaces", () => {
    const { kernel, names, box, state, map } = frozen();
    const stored = addBox(kernel, 'copy', 5000, [0, 0, 0], [10, 20, 30]);
    addCompound(kernel, 'loaded', 4999, ['copy']);
    const namer = startFeature(state, { feature: F_FROZEN, ordinal: 5 }, kernel, names);
    namer.retire('box');
    namer.load('loaded', map, shapeFingerprint('loaded', kernel));
    const after = namer.finish([]);
    expect(after.get(box.faces['+z'])).toBeUndefined();
    expect(after.get(box.solid)).toBeUndefined();
    expect(after.bodies.has(box.solid)).toBe(false);
    expect(after.lookup(state.get(box.faces['+z'])?.ladder.at(-1) as string)).toHaveLength(1);
    expect(after.get(stored.solid)).toMatchObject({ createdBy: F_BOX, createdAt: 0 });
  });

  it('retires a body with no replacement: a frozen remove', () => {
    const { kernel, names, box, state } = frozen();
    const namer = startFeature(state, { feature: F_FROZEN, ordinal: 5 }, kernel, names);
    namer.retire('box');
    const after = namer.finish([]);
    expect(after.bodies.size).toBe(0);
    expect(after.entities.has(box.solid)).toBe(false);
    expect(after.entities.has(box.faces['+x'])).toBe(false);
  });

  it('holds several bodies, each a child of the root', () => {
    const kernel = new FakeKernel();
    const names = new NameTable();
    const a = addBox(kernel, 'a', 100, [0, 0, 0], [1, 1, 1]);
    const b = addBox(kernel, 'b', 200, [5, 0, 0], [6, 1, 1]);
    let state = nameBox(kernel, names, NamedState.empty(), a, F_BOX, 0);
    state = nameBox(kernel, names, state, b, F_CUT, 1);
    addCompound(kernel, 'stored', 99, ['a', 'b']);
    const map = writeShapeMap(state, 'stored', kernel);
    expect(map[0]?.children.set).toHaveLength(2);

    const later = new FakeKernel();
    const a2 = addBox(later, 'a2', 1100, [0, 0, 0], [1, 1, 1]);
    const b2 = addBox(later, 'b2', 1200, [5, 0, 0], [6, 1, 1]);
    addCompound(later, 'loaded', 1099, ['a2', 'b2']);
    const loaded = load(later, names, map);
    expect(loaded.bodies.size).toBe(2);
    expect(loaded.get(b2.faces['+z'])?.ladder).toEqual(state.get(b.faces['+z'])?.ladder);
    expect(loaded.get(a2.faces['+z'])?.ladder).toEqual(state.get(a.faces['+z'])?.ladder);
  });
});

describe('the load check', () => {
  it('passes a map against its own shape, by the fingerprint of the stored shape', () => {
    const { kernel, map, later } = frozen();
    const fingerprint = shapeFingerprint('stored', kernel);
    expect(checkShapeMap(map, 'stored', kernel, fingerprint)).toBeNull();
    expect(checkShapeMap(map, 'loaded', later, fingerprint)).toBeNull();
  });

  it('pauses on the wrong length', () => {
    const { names, map, later } = frozen();
    expect(checkShapeMap(map.slice(1), 'loaded', later)).toEqual({ index: null, field: 'length' });
    expect(() => load(later, names, map.slice(1))).toThrow(NamingPause);
  });

  it("pauses when an entry's children differ", () => {
    const { names, map, later } = frozen();
    const broken = map.map((e, i) => (i === 2 ? { ...e, children: { set: [3, 4] } } : e));
    expect(checkShapeMap(broken, 'loaded', later)).toEqual({ index: 2, field: 'children' });
    expect(() => load(later, names, broken)).toThrow(NamingPause);
  });

  it('pauses when a decoder numbers the shape differently, or reads it otherwise', () => {
    const { kernel, names, map, later } = frozen();
    const fingerprint = shapeFingerprint('stored', kernel);
    // Two faces of the decoded shape in each other's place.
    const tree = [...(later.trees.get('loaded') ?? [])];
    const faces = tree.flatMap((n, i) => (n.kind === 'face' ? [i] : []));
    const [a, b] = [faces[0] as number, faces[2] as number];
    [tree[a], tree[b]] = [tree[b] as (typeof tree)[number], tree[a] as (typeof tree)[number]];
    later.trees.set('loaded', tree);
    expect(checkShapeMap(map, 'loaded', later, fingerprint)).not.toBeNull();
    // A shape whose points moved.
    const moved = new FakeKernel();
    addBox(moved, 'c', 7000, [0, 0, 0], [10, 20, 30 + 1e-9]);
    addCompound(moved, 'loaded', 6999, ['c']);
    expect(checkShapeMap(map, 'loaded', moved, fingerprint)).toEqual({ index: null, field: 'fingerprint' });
    const namer = startFeature(NamedState.empty(), { feature: F_FROZEN, ordinal: 1 }, moved, names);
    expect(() => namer.load('loaded', map, fingerprint)).toThrow(NamingPause);
  });

  it('checks a map written before fingerprints by its snapshots, at the load tolerance', () => {
    const { kernel, map } = frozen();
    const subs = kernel.subShapes('stored');
    const older = map.map((e, i) => ({ ...e, snapshot: entrySnapshot(subs[i] as (typeof subs)[number], kernel) }));
    const shape = (hi: number, base = 7000) => {
      const k = new FakeKernel();
      addBox(k, 'c', base, [0, 0, 0], [10, 20, hi]);
      addCompound(k, 'loaded', base - 1, ['c']);
      return k;
    };
    expect(checkShapeMap(older, 'loaded', shape(30 + 1e-6))).toBeNull(); // 37 mm part: under 3.7e-5 mm
    expect(checkShapeMap(older, 'loaded', shape(30.001))).toMatchObject({ field: 'snapshot' });
    // Without a fingerprint, an entry with no snapshot does not pass.
    expect(checkShapeMap(map, 'loaded', shape(30))).toMatchObject({ field: 'snapshot' });
  });
});

describe('the fingerprint of a stored shape', () => {
  /** Two edges between the same two vertices, the halves of a circle, listed in `order`. */
  function halves(order: readonly number[]): FakeKernel {
    const k = new FakeKernel();
    const edges = [11, 12];
    k.trees.set('s', [
      { key: 1, kind: 'compound', children: order.map((i) => edges[i] as number) },
      ...order.map((i) => ({ key: edges[i] as number, kind: 'edge' as const, children: [21, 22] })),
      { key: 21, kind: 'vertex', children: [] },
      { key: 22, kind: 'vertex', children: [] },
    ]);
    k.points.set(21, [5, 0, 0]);
    k.points.set(22, [-5, 0, 0]);
    k.ranges.set(11, [0, Math.PI]);
    k.ranges.set(12, [Math.PI, 2 * Math.PI]);
    return k;
  }

  it('is the same for the same numbering', () => {
    expect(shapeFingerprint('s', halves([0, 1]))).toBe(shapeFingerprint('s', halves([0, 1])));
  });

  it('tells apart two edges with the same vertices by their parameter ranges', () => {
    expect(shapeFingerprint('s', halves([1, 0]))).not.toBe(shapeFingerprint('s', halves([0, 1])));
  });

  it('changes when a vertex moves', () => {
    const moved = halves([0, 1]);
    moved.points.set(21, [5, 1e-12, 0]);
    expect(shapeFingerprint('s', moved)).not.toBe(shapeFingerprint('s', halves([0, 1])));
  });

  it('lets a writer check the decoded shape is numbered as the live one, up to the digits text keeps', () => {
    const live = numberingRows('s', halves([0, 1]));
    const decoded = halves([0, 1]);
    decoded.ranges.set(12, [Math.PI, 6.28318530717959]); // 15 digits, as BREP text writes it
    expect(sameNumbering(live, numberingRows('s', decoded))).toBe(true);
    expect(sameNumbering(live, numberingRows('s', halves([1, 0])))).toBe(false);
    decoded.points.set(21, [5, 1e-6, 0]);
    expect(sameNumbering(live, numberingRows('s', decoded))).toBe(false);
  });
});

describe('a captured instance', () => {
  const step: CopyStep = {
    op: { id: 'inst_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    key: { instance: { id: 'inst_aaaaaaaaaaaaaaaaaaaaaaaaaa' } },
  };

  it("extends every name's chain and leaves branch and src alone", () => {
    const { kernel, names, state, box } = frozen();
    const map = writeShapeMap(state, 'stored', kernel, { chain: [step], names });
    const index = kernel.subShapes('stored').findIndex((s) => s.key === box.edge('+x', '+z'));
    const entry = map[index] as ShapeMapEntry;
    const original = state.get(box.edge('+x', '+z'))?.ladder as readonly string[];
    expect(entry.ladder).toHaveLength(original.length);
    entry.ladder.forEach((hash, i) => {
      const was = names.get(original[i] as string) as Record<string, JsonValue>;
      expect(names.get(hash)).toEqual({ ...was, chain: [step as unknown as JsonValue] });
    });
  });

  it('resolves a reference holding the extended names, and not the bare ones', () => {
    const { kernel, names, state, box, later, copy } = frozen();
    const captured = writeShapeMap(state, 'stored', kernel, { chain: [step], names });
    const loaded = load(later, names, captured);
    const top = loaded.get(copy.faces['+z'])!;
    const inContext = writeRecord(top, loaded, later);
    expect(resolve(inContext, loaded, later)).toMatchObject({ outcome: 'same', entities: [{ key: copy.faces['+z'] }] });
    const bare = writeRecord(state.get(box.faces['+z'])!, state, kernel);
    expect(resolve(bare, loaded, later).outcome).toBe('gone');
  });
});

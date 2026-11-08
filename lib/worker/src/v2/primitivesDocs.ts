/**
 * Composes test documents with primitives, booleans, construction features and
 * imports on top of `DocBuilder`. Body references are written as the editor
 * would, from the name the body's feature gives it.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import {
  NamedState,
  contentHash,
  indexItem,
  ladderOf,
  makeSet,
  startFeature,
  writeShapeMap,
  type OperationHistory,
  type SrcItem,
} from '@tweakcad/format';
import { NamingAdapter } from '@tweakcad/kernel/src/namingAdapter.ts';
import type { DocBuilder } from './docBuilder';

type Json = Record<string, unknown>;

export interface Placed {
  /** Where the frame's origin lies, as `x, y, z` in mm. */
  at?: readonly [number, number, number];
  /** An angle in degrees about the part's x axis. */
  turnX?: number;
  op?: 'new' | 'join' | 'cut' | 'intersect';
  /** The bodies an operation acts on; all of them without this. */
  targets?: Json[];
}

export function placement(d: DocBuilder, at: readonly number[] = [0, 0, 0], turnX = 0): Json {
  const [x, y, z] = at;
  return d.val(`placement(vector(${x} mm, ${y} mm, ${z} mm), rotate(vector(1, 0, 0), ${turnX} deg))`);
}

export const fixedFrame = (d: DocBuilder, at?: readonly number[], turnX?: number): Json => ({
  fixed: { placement: placement(d, at, turnX) },
});

/** An attached frame on one support, in mode `plane`. */
export const planeFrame = (
  d: DocBuilder,
  support: Json,
  more: { at?: readonly number[]; flip?: boolean; xAxis?: Json } = {},
): Json => ({
  attach: {
    support: [support],
    mode: d.val('"plane"'),
    offset: placement(d, more.at),
    flip: d.val(more.flip ? 'true' : 'false'),
    ...(more.xAxis ? { xAxis: more.xAxis } : {}),
  },
});

/** A primitive of `shape`: dimensions by field, as value text. */
export function primitive(d: DocBuilder, tag: string, dims: Record<string, string>, o: Placed = {}): string {
  const fields = Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, d.val(v)]));
  return d.feature('core.primitive', {
    shape: { [tag]: fields },
    frame: fixedFrame(d, o.at, o.turnX),
    operation: {
      op: d.val(`"${o.op ?? 'new'}"`),
      targets: o.targets ? { bodies: makeSet(o.targets) } : { all: {} },
      keepTools: d.val('false'),
    },
  });
}

export const box = (d: DocBuilder, width: number, depth: number, height: number, o?: Placed) =>
  primitive(d, 'box', { width: `${width} mm`, depth: `${depth} mm`, height: `${height} mm` }, o);

export const cylinder = (d: DocBuilder, radius: number, height: number, o?: Placed) =>
  primitive(d, 'cylinder', { radius: `${radius} mm`, height: `${height} mm` }, o);

/** A reference to the body a feature made; a primitive's body has `src` `[index(0)]`. */
export function bodyRef(d: DocBuilder, feature: string, src: readonly SrcItem[] = [indexItem(0)]): Json {
  const id = ladderOf({ kind: 'body', chain: [], feature, role: 'body', src }, d.names);
  return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
}

export function boolean(
  d: DocBuilder,
  op: 'join' | 'cut' | 'intersect',
  target: Json,
  tools: Json[],
  keepTools = false,
): string {
  return d.feature('core.boolean', {
    target,
    tools: makeSet(tools),
    op: d.val(`"${op}"`),
    keepTools: d.val(String(keepTools)),
  });
}

export const removeBody = (d: DocBuilder, bodies: Json[]): string =>
  d.feature('core.removeBody', { bodies: makeSet(bodies) });

/** The name of a construction feature's output, as a reference (9.4: levels 0 and 1). */
export function constructionRef(d: DocBuilder, feature: string, kind: 'plane' | 'axis' | 'point' | 'frame'): Json {
  const id = ladderOf({ kind, chain: [], feature, role: kind, src: [] }, d.names);
  return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
}

export interface ImportFixture {
  feature: string;
  /** The rows to add to the document's `assets`. */
  assets: Json;
  /** The stored shape in the feature's inputs, to tamper with. */
  stored: Json;
}

/**
 * A `core.import` of `solids`, written as an importer would: a compound rooted
 * stored shape, faces and bodies named by map index (the file has no ids of its
 * own), edges and vertices by the rules of 9.4 from those faces, and the asset
 * without any mesh.
 */
export function imported(d: DocBuilder, k: OcctKernel, solids: ShapeHandle[]): ImportFixture {
  const stored: Json = {};
  const feature = d.feature('core.import', {
    source: { kept: {} },
    stored,
    importer: { format: 'test', version: '1' },
    units: d.val('"mm"'),
    upAxis: d.val('"z"'),
  });

  const adapter = new NamingAdapter(k);
  const root = k.makeCompound(solids);
  const ref = adapter.addShape(root, 'stored');
  const index = new Map(adapter.subShapes(ref).map((s, i) => [s.key, i]));
  const at = (key: number) => ({ index: index.get(key) as number });
  const none = { kept: [], modified: new Map(), deleted: [], added: [] };
  const history: OperationHistory = {
    result: ref,
    inputs: [],
    faces: none,
    edges: none,
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
  const topology = adapter.topology(ref);
  const namer = startFeature(NamedState.empty(), { feature, ordinal: 0 }, adapter, d.names);
  namer.step(history, {
    outputs: topology.faces.map((f) => ({ entity: f, role: 'face', src: [at(f)] })),
    dividers: [],
  });
  const state = namer.finish(topology.solids.map((s) => ({ solid: s.solid, from: { create: [at(s.solid)] } })));

  const text = k.toBREP(k.copy(root));
  const bytes = new TextEncoder().encode(text);
  const hash = contentHash(bytes);
  Object.assign(stored, {
    asset: hash,
    representation: { name: 'brep', version: 1 },
    map: writeShapeMap(state, ref, adapter),
  });
  adapter.dispose();
  const base64 = btoa(String.fromCharCode(...bytes));
  return {
    feature,
    stored,
    assets: {
      [hash]: { mediaType: 'model/x-brep', name: 'fixture.brep', size: bytes.length, data: { inline: { base64 } } },
    },
  };
}

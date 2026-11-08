/**
 * What `core.fillet` and `core.chamfer` share: target sets resolved to the
 * edges they stand for, one kernel call per live shape, and the naming of
 * blends and corners (9.4).
 */
import { OcctError, type EvolutionData, type ShapeHandle } from 'occt-wasm';
import {
  finest,
  startFeature,
  type BodyOutcome,
  type BuilderReport,
  type NamedEntity,
  type OperationHistory,
  type ShapeKey,
  type ShapeRef,
  type ShapeTopology,
} from '@tweakcad/format';
import { FeaturePause, norm, sub, unit, type BuildContext, type Json, type V3 } from './context';
import { entitiesOf } from './references';

/** Outward normals closer than this along an edge, in radians, make it smooth. */
const SMOOTH = 1e-4;

/** One target edge, with the size its set gives it. */
export interface TargetEdge<S> {
  edge: ShapeKey;
  size: S;
  /** The faces of its set that stand for this edge. */
  through: readonly ShapeKey[];
}

function targetEntities(ctx: BuildContext, ref: Json): readonly NamedEntity[] {
  if ('inContext' in ref) throw new FeaturePause('a target lies in another part');
  return entitiesOf(ctx, ref, 'a target');
}

/** Whether an edge's two faces meet without a crease at its sample point, leaving nothing to blend. */
function isSmooth(ctx: BuildContext, edge: ShapeTopology['edges'][number]): boolean {
  const { kernel: k, adapter } = ctx.ev;
  const point = adapter.samplePoint(edge.edge);
  if (!point || edge.faces.length !== 2) return false;
  const normalOn = (face: ShapeKey): V3 => {
    const handle = adapter.handleOf(face);
    const { u, v } = k.uvFromPoint(handle, { x: point[0], y: point[1], z: point[2] });
    const n = k.surfaceNormal(handle, u, v);
    return unit([n.x, n.y, n.z]);
  };
  try {
    const [a, b] = edge.faces.map((f) => normalOn(f.face)) as [V3, V3];
    return norm(sub(a, b)) < SMOOTH;
  } catch (e) {
    // No normal here: the kernel decides when it gets the edge.
    if (e instanceof OcctError) return false;
    throw e;
  }
}

/**
 * The target edges of every set, grouped by the live shape holding them and
 * in name order, so a rebuild makes the same call whatever order the kernel
 * lists edges in. A face stands for its creased edges: seams and edges smooth
 * with the next face have nothing to blend. An edge in two sets has no one
 * size, so the feature pauses.
 */
export function targetEdges<S>(
  ctx: BuildContext,
  sets: readonly { targets: Json; size: S }[],
): Map<ShapeRef, TargetEdge<S>[]> {
  const { part, ev } = ctx;
  const claimed = new Map<ShapeKey, { set: number; target: TargetEdge<S>; body: ShapeRef }>();
  sets.forEach(({ targets, size }, set) => {
    const claim = (edge: ShapeKey, body: ShapeRef, face?: ShapeKey) => {
      const held = claimed.get(edge);
      if (held && held.set !== set) throw new FeaturePause('an edge is in two sets');
      const target = held?.target ?? { edge, size, through: [] };
      claimed.set(edge, {
        set,
        body,
        target: face === undefined ? target : { ...target, through: [...target.through, face] },
      });
    };
    for (const ref of targets.set as Json[]) {
      for (const e of targetEntities(ctx, ref)) {
        if (e.kind === 'edge') claim(e.key, e.body);
        else if (e.kind === 'face') {
          for (const edge of ev.adapter.topology(e.body).edges) {
            if (edge.form === 'normal' && edge.faces.some((f) => f.face === e.key) && !isSmooth(ctx, edge))
              claim(edge.edge, e.body, e.key);
          }
        } else throw new FeaturePause('a target is neither an edge nor a face');
      }
    }
  });

  const nameOf = (edge: ShapeKey) => finest((part.state.get(edge) as NamedEntity).ladder);
  const groups = new Map<ShapeRef, TargetEdge<S>[]>();
  const ordered = [...claimed.values()].sort((x, y) => {
    const [a, b] = [nameOf(x.target.edge), nameOf(y.target.edge)];
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const { target, body } of ordered) {
    if (!part.shapes.has(body)) throw new FeaturePause('a target is on a body with no shape');
    groups.set(body, [...(groups.get(body) ?? []), target]);
  }
  return groups;
}

/**
 * The face of an edge's two that takes a chamfer's first distance: a target
 * face of its set if just one of the two is one, otherwise the one with the
 * lower name. Names, unlike the kernel's face order, hold across rebuilds.
 */
export function referenceFace<S>(ctx: BuildContext, shape: ShapeRef, target: TargetEdge<S>): ShapeKey {
  const { part, ev } = ctx;
  const faces =
    ev.adapter
      .topology(shape)
      .edges.find((e) => e.edge === target.edge)
      ?.faces.map((f) => f.face) ?? [];
  const [a, b] = faces;
  if (faces.length !== 2 || a === undefined || b === undefined)
    throw new FeaturePause('a chamfer edge does not lie between two faces');
  const through = faces.filter((f) => target.through.includes(f));
  if (through.length === 1) return through[0] as ShapeKey;
  const [nameA, nameB] = [a, b].map((f) => finest((part.state.get(f) as NamedEntity).ladder)) as [string, string];
  if (nameA === nameB)
    throw new FeaturePause('the two faces of a chamfer edge share a name, so neither can take the first distance');
  return nameA < nameB ? a : b;
}

/** Input faces of each result face, kept or modified. */
function sourcesOf(history: OperationHistory): Map<ShapeKey, ShapeKey[]> {
  const sources = new Map<ShapeKey, ShapeKey[]>();
  for (const f of history.faces.kept) sources.set(f, [f]);
  for (const [from, to] of history.faces.modified)
    for (const t of to) sources.set(t, [...(sources.get(t) ?? []), from]);
  return sources;
}

/** The input vertex a face with no history rounds off, when its neighbours say so exactly. */
function cornerVertex(
  face: ShapeKey,
  result: ShapeTopology,
  input: ShapeTopology,
  blendEdge: ReadonlyMap<ShapeKey, ShapeKey>,
  sources: ReadonlyMap<ShapeKey, readonly ShapeKey[]>,
): ShapeKey | undefined {
  const near = new Set(
    result.edges.filter((e) => e.faces.some((f) => f.face === face)).flatMap((e) => e.faces.map((f) => f.face)),
  );
  near.delete(face);
  const ends = (edge: ShapeKey) => input.edges.find((e) => e.edge === edge)?.ends ?? [];
  const [first, ...rest] = [...near].flatMap((f) => blendEdge.get(f) ?? []);
  if (first === undefined) return undefined;
  let shared = ends(first).filter((v) => rest.every((edge) => ends(edge).includes(v)));
  if (shared.length > 1) {
    // Blends of edges with both ends in common: the corner's plain neighbours tell the end.
    const plain = [...near].filter((f) => !blendEdge.has(f)).flatMap((f) => sources.get(f) ?? []);
    shared = shared.filter((v) => {
      const around = input.vertices.find((x) => x.vertex === v)?.faces ?? [];
      return plain.every((f) => around.includes(f));
    });
  }
  return shared.length === 1 ? shared[0] : undefined;
}

/** Blends and chamfer faces under `role` from their edges, corners from the input vertex (9.4). */
function outputsOf(
  ctx: BuildContext,
  history: OperationHistory,
  shape: ShapeRef,
  role: string,
): BuilderReport['outputs'] {
  const { adapter } = ctx.ev;
  const outputs: { entity: ShapeKey; role: string; src: { entity: ShapeKey }[] }[] = [];
  const blendEdge = new Map<ShapeKey, ShapeKey>();
  for (const [edge, faces] of history.facesFromEdge) {
    for (const face of faces) {
      if (blendEdge.has(face)) throw new FeaturePause('one blend face came from two edges');
      blendEdge.set(face, edge);
      outputs.push({ entity: face, role, src: [{ entity: edge }] });
    }
  }
  const sources = sourcesOf(history);
  const result = adapter.topology(history.result);
  const input = adapter.topology(shape);
  for (const face of history.faces.added) {
    const vertex = cornerVertex(face, result, input, blendEdge, sources);
    if (vertex !== undefined) outputs.push({ entity: face, role: 'corner', src: [{ entity: vertex }] });
  }
  return outputs;
}

/** Each solid of the result is the input solid its surviving faces came from. */
function outcomesOf(ctx: BuildContext, history: OperationHistory, shape: ShapeRef): BodyOutcome[] {
  const { adapter } = ctx.ev;
  const solidOf = new Map<ShapeKey, ShapeKey>();
  for (const s of adapter.topology(shape).solids) for (const f of s.faces) solidOf.set(f, s.solid);
  const sources = sourcesOf(history);
  return adapter.topology(history.result).solids.map((solid) => {
    const inputs = new Set(solid.faces.flatMap((f) => sources.get(f) ?? []).flatMap((f) => solidOf.get(f) ?? []));
    const [same] = inputs;
    if (inputs.size !== 1 || same === undefined)
      throw new FeaturePause('a solid of the result does not come from one body');
    return { solid: solid.solid, from: { same } };
  });
}

/**
 * Runs `make` once for each live shape holding targets, names each result,
 * and replaces the shapes. A kernel refusal or an invalid result pauses the
 * feature, leaving the part as it was.
 */
export function buildBlends<S>(
  ctx: BuildContext,
  role: 'blend' | 'chamfer',
  groups: ReadonlyMap<ShapeRef, readonly TargetEdge<S>[]>,
  make: (handle: ShapeHandle, shape: ShapeRef, edges: readonly TargetEdge<S>[]) => EvolutionData,
): void {
  const { id, ordinal, part } = ctx;
  const { kernel: k, adapter, names } = ctx.ev;
  const label = role === 'blend' ? 'fillet' : 'chamfer';
  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const outcomes: BodyOutcome[] = [];
  const replaced: { from: ShapeRef; to: ShapeRef; handle: ShapeHandle }[] = [];
  for (const [shape, edges] of groups) {
    const handle = part.shapes.get(shape) as ShapeHandle;
    let evolution: EvolutionData;
    try {
      evolution = make(handle, shape, edges);
    } catch (e) {
      if (e instanceof OcctError) throw new FeaturePause(`the kernel could not build this ${label}: ${e.message}`);
      throw e;
    }
    if (!k.isValid(evolution.result)) throw new FeaturePause(`the kernel built an invalid shape for this ${label}`);
    const history = adapter.history(evolution, [{ shape, use: 'target' }]);
    namer.step(history, { outputs: outputsOf(ctx, history, shape, role), dividers: [] });
    outcomes.push(...outcomesOf(ctx, history, shape));
    replaced.push({ from: shape, to: history.result, handle: evolution.result });
  }
  part.state = namer.finish(outcomes);
  for (const r of replaced) {
    part.shapes.delete(r.from);
    part.shapes.set(r.to, r.handle);
  }
}

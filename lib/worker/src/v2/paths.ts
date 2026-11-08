/**
 * A path as a sweep runs along it (appendix A `core.sweep`): a curve chain of
 * sketch curves and model edges, or a region standing for its outer loop, as
 * one kernel wire, and what each stretch of it is named after.
 */
import type { ShapeHandle } from 'occt-wasm';
import { prepareCurve, type CurveShape, type SrcFact } from '@tweakcad/format';
import {
  FeaturePause,
  kv,
  norm,
  sub,
  type BuildContext,
  type Frame,
  type Json,
  type SketchResult,
  type V3,
} from './context';
import { stretchEdge } from './curveEdges';
import { sketchRowOf } from './places';
import { buildProfiles, edgeRoot, lift, segmentOf } from './profiles';
import { entitiesOf, membersOrSelf } from './references';

/** Two ends of a chain closer than this (mm) meet. */
const MEETS = 1e-6;

/** One edge of a path, with the `src` items of its path segment root. */
interface PathEdge {
  edge: ShapeHandle;
  src: SrcFact[];
}

export interface Path {
  wire: ShapeHandle;
  edges: PathEdge[];
  /** Where the path starts, and the unit direction it leaves that point in. */
  start: { point: V3; direction: V3 };
}

/** A whole sketch curve as one kernel edge. */
function curveEdge(ctx: BuildContext, frame: Frame, shape: CurveShape): ShapeHandle {
  const k = ctx.ev.kernel;
  const curve = prepareCurve(shape, false);
  if (!curve) throw new FeaturePause('a path curve has no length');
  const p = (t: number) => kv(lift(frame, curve.point(t)));
  const { form, tMin, tMax } = curve;
  if (form.kind === 'line') return k.makeLineEdge(p(tMin), p(tMax));
  if (form.kind === 'circular') {
    if (curve.closed) return k.makeCircleEdge(kv(lift(frame, form.center)), kv(frame.normal), form.radius);
    return k.makeArcEdge(p(tMin), p((tMin + tMax) / 2), p(tMax));
  }
  return stretchEdge(k, frame, shape, curve, tMin, tMax);
}

/** The drawn curve `id` of a sketch: a live curve, whether it bounds a region or not. */
function sketchCurve(sketch: SketchResult, id: string): CurveShape {
  const curve = [...sketch.solved.curves, ...sketch.others].find((c) => 'drawn' in c.key && c.key.drawn.id === id);
  if (!curve) throw new FeaturePause('a path curve is missing: the sketch curve it used is gone');
  return curve.shape;
}

/** Whether a reference names a sketch region. */
function isRegion(ctx: BuildContext, ref: Json): boolean {
  const record = ref.entity as Json | undefined;
  const finest = (record?.id as string[] | undefined)?.at(-1);
  return finest !== undefined && (ctx.ev.names.get(finest) as Json | undefined)?.kind === 'region';
}

/** The edges of a region's outer loop, each named after its sketch curve. */
function regionEdges(ctx: BuildContext, ref: Json): PathEdge[] {
  const { kernel: k } = ctx.ev;
  return buildProfiles(ctx, { set: [ref] }).flatMap((profile) =>
    k.getSubShapes(k.outerWire(profile.face), 'edge').map((edge) => {
      const { first, last } = k.curveParameters(edge);
      const p = k.curvePointAtParam(edge, (first + last) / 2);
      return { edge, src: segmentOf(profile, edgeRoot(profile, [p.x, p.y, p.z])) };
    }),
  );
}

function edgesOf(ctx: BuildContext, ref: Json): PathEdge[] {
  if (isRegion(ctx, ref)) return regionEdges(ctx, ref);
  const row = sketchRowOf(ctx, ref);
  if (row?.kind === 'curve')
    return [{ edge: curveEdge(ctx, row.sketch.frame, sketchCurve(row.sketch, row.id)), src: [{ id: row.id }] }];
  if (row) throw new FeaturePause('a path names a sketch point');
  return entitiesOf(ctx, ref, 'a path').map((e) => {
    if (e.kind !== 'edge') throw new FeaturePause('a path names something that is not a curve');
    return { edge: ctx.ev.adapter.handleOf(e.key), src: [{ entity: e.key }] };
  });
}

/** The two ends of an edge, the same point twice for a closed one. */
function endsOf(ctx: BuildContext, edge: ShapeHandle): [V3, V3] {
  const k = ctx.ev.kernel;
  const { first, last } = k.curveParameters(edge);
  const at = (t: number): V3 => {
    const p = k.curvePointAtParam(edge, t);
    return [p.x, p.y, p.z];
  };
  return [at(first), at(last)];
}

const meets = (a: V3, b: V3) => norm(sub(a, b)) <= MEETS;

/** The edges end to end, from a free end, or from the first edge of a loop. */
function endToEnd(ctx: BuildContext, edges: readonly PathEdge[]): { edges: PathEdge[]; start: V3 } {
  const ends = edges.map((e) => endsOf(ctx, e.edge));
  const free = (p: V3, i: number) => !ends.some((other, j) => j !== i && other.some((q) => meets(p, q)));
  let index = ends.findIndex((pair, i) => pair.some((p) => free(p, i)));
  if (index < 0) index = 0;
  const [a, b] = ends[index] as [V3, V3];
  const start = edges.length > 1 && !free(a, index) && free(b, index) ? b : a;
  const out = [edges[index] as PathEdge];
  const used = new Set([index]);
  let tip = start === a ? b : a;
  while (used.size < edges.length) {
    const next = ends.flatMap((pair, i) => (!used.has(i) && pair.some((p) => meets(p, tip)) ? [i] : []));
    if (next.length !== 1) throw new FeaturePause('the path does not run through its curves one after another');
    const i = next[0] as number;
    const [p, q] = ends[i] as [V3, V3];
    tip = meets(p, tip) ? q : p;
    used.add(i);
    out.push(edges[i] as PathEdge);
  }
  return { edges: out, start };
}

/** The curve chain `chain` as one wire. */
export function pathOf(ctx: BuildContext, chain: readonly Json[]): Path {
  const { kernel: k } = ctx.ev;
  const found = chain.flatMap((ref) => membersOrSelf(ctx, ref)).flatMap((ref) => edgesOf(ctx, ref));
  if (found.length === 0) throw new FeaturePause('the path is empty');
  const { edges, start } = endToEnd(ctx, found);
  const first = (edges[0] as PathEdge).edge;
  const { first: t0, last: t1 } = k.curveParameters(first);
  const leaves = meets(endsOf(ctx, first)[0], start);
  const d = k.curveTangent(first, leaves ? t0 : t1);
  const sign = (leaves ? 1 : -1) / Math.hypot(d.x, d.y, d.z);
  return {
    wire: k.makeWire(edges.map((e) => e.edge)),
    edges,
    start: { point: start, direction: [d.x * sign, d.y * sign, d.z * sign] },
  };
}

/** The path edge that `p`, a point of the path, lies on. */
export function pathEdgeAt(ctx: BuildContext, path: Path, p: readonly number[]): PathEdge | undefined {
  const k = ctx.ev.kernel;
  const point = k.makeVertex(p[0] as number, p[1] as number, p[2] as number);
  const found = path.edges.find((e) => k.distanceBetween(point, e.edge) <= MEETS);
  k.release(point);
  return found;
}

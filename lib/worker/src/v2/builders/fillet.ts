/**
 * `core.fillet` (appendix A): constant-radius sets and variable sets given by
 * their two end radii, all of a shape's edges in one kernel call so corners
 * between sets are built together. Variable sets with other points, chord and
 * setback sets pause.
 */
import type { FilletRadius } from 'occt-wasm';
import { finest, type NamedEntity, type ShapeKey, type ShapeRef } from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { buildBlends, targetEdges, type TargetEdge } from '../blend';
import {
  FeaturePause,
  LENGTH,
  RATIO,
  norm,
  registerBuilder,
  sub,
  type BuildContext,
  type Json,
  type V3,
} from '../context';

/** A set's radius: one size, or the radii at ratio 0 and ratio 1 along each edge. */
type Radius = { constant: number } | { variable: { from: number; to: number } };

function radiusOf(ctx: BuildContext, radius: Json): Radius {
  const { values } = ctx.ev;
  if ('chord' in radius) throw new FeaturePause('chord-length fillets are not built yet');
  if ('constant' in radius) {
    const size = values.number((radius.constant as Json).s, LENGTH);
    if (size <= 0) throw new FeaturePause('a fillet radius is positive');
    return { constant: size };
  }
  const points = ((radius.variable as Json).points as Json[]).map((p) => ({
    at: values.number(p.at, RATIO),
    radius: values.number(p.radius, LENGTH),
  }));
  if (points.length > 2) throw new FeaturePause('variable-radius fillets with more than two points are not built yet');
  const [a, b] = points;
  if (!a || !b) throw new FeaturePause('a variable radius has a point at each end of the edge');
  const ends = [a, b].sort((x, y) => x.at - y.at);
  const [first, last] = ends as [typeof a, typeof b];
  if (first.at !== 0 || last.at !== 1)
    throw new FeaturePause('variable-radius points between the ends of an edge are not built yet');
  if (first.radius < 0 || last.radius < 0 || (first.radius === 0 && last.radius === 0)) {
    throw new FeaturePause('a variable fillet radius is not negative, and positive at one end at least');
  }
  return { variable: { from: first.radius, to: last.radius } };
}

/**
 * The kernel's radius for one edge. A variable radius runs from ratio 0 at the
 * end whose vertex has the lower finest name (names, unlike the kernel's edge
 * direction, hold across rebuilds); the kernel takes `start` at the vertex at
 * the curve's first parameter.
 */
function kernelRadius(ctx: BuildContext, shape: ShapeRef, target: TargetEdge<Radius>): FilletRadius {
  const size = target.size;
  if ('constant' in size) return size.constant;
  const { adapter } = ctx.ev;
  const ends = adapter.topology(shape).edges.find((e) => e.edge === target.edge)?.ends ?? [];
  const [a, b] = ends;
  if (ends.length !== 2 || a === undefined || b === undefined)
    throw new FeaturePause('a variable radius needs an edge with two ends');
  const nameOf = (v: ShapeKey) => finest((ctx.part.state.get(v) as NamedEntity).ladder);
  const [nameA, nameB] = [nameOf(a), nameOf(b)];
  if (nameA === nameB)
    throw new FeaturePause('the two ends of a variable fillet edge share a name, so neither can be its start');
  const low = nameA < nameB ? a : b;
  const point = adapter.measures(low).point as V3;
  const { start, end } = adapter.edgeGeometry(target.edge);
  const lowAtStart = norm(sub(point, start as V3)) <= norm(sub(point, end as V3));
  const { from, to } = size.variable;
  return lowAtStart ? { start: from, end: to } : { start: to, end: from };
}

registerBuilder('core.fillet', (ctx) => {
  const { kernel: k, adapter, values } = ctx.ev;
  const sets = (ctx.inputs.sets as Json[]).map((set) => {
    const size = radiusOf(ctx, set.radius as Json);
    if (values.number(set.setback, LENGTH) !== 0) throw new FeaturePause('fillet setbacks are not built yet');
    return { targets: set.targets as Json, size };
  });
  buildBlends(ctx, 'blend', targetEdges(ctx, sets), (handle, shape, edges) =>
    k.filletWithHistory(
      handle,
      edges.map((e) => adapter.handleOf(e.edge)),
      edges.map((e) => kernelRadius(ctx, shape, e)),
      adapter.faceHashes([shape]),
      HASH_BOUND,
    ),
  );
});

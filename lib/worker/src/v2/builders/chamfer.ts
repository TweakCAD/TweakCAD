/**
 * `core.chamfer` (appendix A): all of a shape's edges in one kernel call, so
 * corners between sets are built together. A distance-and-angle set needs a
 * different kernel call from the other sizes, so mixing them pauses.
 */
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { buildBlends, referenceFace, targetEdges } from '../blend';
import { ANGLE, FLAG, FeaturePause, LENGTH, registerBuilder, type BuildContext, type Json } from '../context';

/** A flipped distance-and-angle size puts `d` on the other face, the angle measured from it. */
type Size = { d: number } | { d1: number; d2: number } | { d: number; angle: number; flipped: boolean };

function sizeOf(ctx: BuildContext, size: Json): Size {
  const { values } = ctx.ev;
  const length = (v: unknown): number => {
    const d = values.number(v, LENGTH);
    if (d <= 0) throw new FeaturePause('a chamfer distance is positive');
    return d;
  };
  if ('distance' in size) return { d: length((size.distance as Json).d) };
  if ('twoDistances' in size) {
    const s = size.twoDistances as Json;
    return { d1: length(s.d1), d2: length(s.d2) };
  }
  const s = size.distanceAngle as Json;
  const angle = values.number(s.angle, ANGLE);
  if (angle <= 0 || angle >= 90) throw new FeaturePause('a chamfer angle lies between 0 and 90 degrees');
  return { d: length(s.d), angle, flipped: s.flipped !== undefined && values.literal(s.flipped, FLAG) === true };
}

registerBuilder('core.chamfer', (ctx) => {
  const { kernel: k, adapter } = ctx.ev;
  const sets = (ctx.inputs.sets as Json[]).map((set) => ({
    targets: set.targets as Json,
    size: sizeOf(ctx, set.size as Json),
  }));
  const angled = sets.filter((s) => 'angle' in s.size).length;
  if (angled > 0 && angled < sets.length)
    throw new FeaturePause('a chamfer mixing distance-and-angle sets with other sizes is not built yet');

  buildBlends(ctx, 'chamfer', targetEdges(ctx, sets), (handle, shape, edges) => {
    const handles = edges.map((e) => adapter.handleOf(e.edge));
    const hashes = adapter.faceHashes([shape]);
    const reference = (e: (typeof edges)[number]) => adapter.handleOf(referenceFace(ctx, shape, e));
    /** The face `d` lies on: the reference face, or the edge's other face when the size is flipped. */
    const distanceFace = (e: (typeof edges)[number]) => {
      const face = referenceFace(ctx, shape, e);
      if (!('flipped' in e.size && e.size.flipped)) return adapter.handleOf(face);
      const faces =
        adapter
          .topology(shape)
          .edges.find((x) => x.edge === e.edge)
          ?.faces.map((f) => f.face) ?? [];
      return adapter.handleOf(faces.find((f) => f !== face) ?? face);
    };
    if (angled > 0) {
      const sizes = edges.map((e) => e.size as { d: number; angle: number });
      return k.chamferDistAngleWithHistory(
        handle,
        handles,
        sizes.map((s) => s.d),
        sizes.map((s) => s.angle),
        hashes,
        HASH_BOUND,
        edges.map(distanceFace),
      );
    }
    const distances = edges.map((e) =>
      'd1' in e.size
        ? { distance1: e.size.d1, distance2: e.size.d2, referenceFace: reference(e) }
        : (e.size as { d: number }).d,
    );
    return k.chamferWithHistory(handle, handles, distances, hashes, HASH_BOUND);
  });
});

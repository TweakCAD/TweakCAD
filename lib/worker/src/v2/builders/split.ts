/**
 * `core.split` (appendix A): each target body divided by a plane (a default
 * plane, a construction plane or a planar face, taken as its whole plane).
 * The kept side is the body intersected with a box on that side of the plane
 * that holds all of the body there; the new faces on the plane take the role
 * `split`. Keeping both sides, the positive piece is the body itself so cut,
 * and the negative piece a copy of the body made in place, named with the
 * `split` copy step (9.5), so cut: the kernel's one-boolean split leaves the
 * pieces sharing their faces, edges and vertices on the plane, and two
 * bodies never share a name.
 */
import type { ShapeHandle } from 'occt-wasm';
import { startFeature, type BodyOutcome, type ShapeKey, type ShapeRef } from '@tweakcad/format';
import { FeaturePause, TEXT, registerBuilder, type BuildContext, type Frame, type Json, type V3 } from '../context';
import { copyInPlace, liveBodies, madeHistory, namedBoolean, type Live } from '../operation';
import { planeFrameOf } from '../places';
import { entitiesOf, membersOrSelf } from '../references';

type Keep = 'both' | 'positive' | 'negative';

/** A piece whose volume differs from the body's by less than this fraction is the whole body. */
const SAME_VOLUME = 1e-9;

/** Distance (mm) within which a tool face lies on the split plane. */
const ON_PLANE = 1e-7;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The split plane: a frame whose normal points to the positive side. */
function splitPlane(ctx: BuildContext, tool: Json): Frame {
  try {
    return planeFrameOf(ctx, tool);
  } catch (e) {
    if (e instanceof FeaturePause)
      throw new FeaturePause(`the split tool is not a plane or a planar face: ${e.message}`);
    throw e;
  }
}

/**
 * A box on the `side` of `frame` that holds all of `body` there. It reaches
 * past the body's bounding box, so only its face on the plane meets the body.
 */
function sideBox(ctx: BuildContext, body: Live, frame: Frame, side: 'positive' | 'negative'): ShapeHandle {
  const k = ctx.ev.kernel;
  const b = k.getBoundingBox(body.handle);
  const corners: V3[] = [];
  for (const x of [b.xmin, b.xmax])
    for (const y of [b.ymin, b.ymax]) for (const z of [b.zmin, b.zmax]) corners.push([x, y, z]);
  const reach = 2 * Math.max(1, ...corners.map((c) => Math.hypot(...sub(c, frame.origin))));
  const { origin: o, x, y, normal: n } = frame;
  const matrix = [x[0], y[0], n[0], o[0], x[1], y[1], n[1], o[1], x[2], y[2], n[2], o[2]];
  const box = (z0: number, z1: number): ShapeHandle => {
    const local = k.makeBoxFromCorners({ x: -reach, y: -reach, z: z0 }, { x: reach, y: reach, z: z1 });
    const placed = k.transform(local, matrix);
    k.release(local);
    return placed;
  };
  return side === 'positive' ? box(0, reach) : box(-reach, 0);
}

/** The faces of `shape` on the plane of `frame`. */
function facesOnPlane(ctx: BuildContext, shape: ShapeRef, frame: Frame): ShapeKey[] {
  const { adapter } = ctx.ev;
  return adapter.topology(shape).faces.filter((f) => {
    const m = adapter.measures(f);
    return (
      m.surface === 'plane' &&
      Math.abs(Math.abs(dot(m.normal as V3, frame.normal)) - 1) < 1e-9 &&
      Math.abs(dot(sub(m.centroid as V3, frame.origin), frame.normal)) < ON_PLANE
    );
  });
}

registerBuilder('core.split', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { kernel: k, adapter, values, names } = ctx.ev;
  const keepInput = inputs.keep as Json;
  const keep: Keep =
    'side' in keepInput ? (values.literal((keepInput.side as Json).sign, TEXT) as 'positive' | 'negative') : 'both';
  const refs = (inputs.targets as Json).set as Json[];
  const named = refs.flatMap((r) => membersOrSelf(ctx, r)).filter((r) => !('inContext' in r));
  if (named.some((r) => entitiesOf(ctx, r, 'a split target').some((e) => e.kind === 'face')))
    throw new FeaturePause('splitting faces is not built yet');
  const frame = splitPlane(ctx, inputs.tool as Json);

  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  /** `body` on the `side` of the plane, named as a step; the tag keeps tool shapes apart. */
  const cut = (body: Live, side: 'positive' | 'negative', tag: string): Live => {
    const handle = sideBox(ctx, body, frame, side);
    const shape = adapter.addShape(handle, `split:${id}:${tag}`);
    const onPlane = facesOnPlane(ctx, shape, frame);
    namer.step(madeHistory(ctx, shape), {
      outputs: onPlane.map((entity) => ({ entity, role: 'split', src: [] })),
      dividers: [],
    });
    const before = Math.abs(k.getVolume(body.handle));
    const { live } = namedBoolean(ctx, namer, 'intersect', body, { shape, handle }, 'tool', onPlane);
    const after = adapter.topology(live.shape).solids.length > 0 ? Math.abs(k.getVolume(live.handle)) : 0;
    if (after === 0 || Math.abs(before - after) <= SAME_VOLUME * before)
      throw new FeaturePause('the split plane does not cross a target body');
    return live;
  };

  const outcomes: BodyOutcome[] = [];
  const keepPiece = (from: Live, piece: Live) => {
    part.shapes.set(piece.shape, piece.handle);
    for (const s of adapter.topology(piece.shape).solids)
      outcomes.push({ solid: s.solid, from: { carry: [from.shape] } });
  };
  liveBodies(ctx, namer, refs, 'a split target').forEach((body, i) => {
    part.shapes.delete(body.shape);
    if (keep !== 'both') return keepPiece(body, cut(body, keep, `${i}`));
    const copy = copyInPlace(ctx, namer, body, { op: { id }, key: { split: {} } });
    keepPiece(body, cut(body, 'positive', `${i}:positive`));
    keepPiece(copy, cut(copy, 'negative', `${i}:negative`));
  });
  part.state = namer.finish(outcomes);
});

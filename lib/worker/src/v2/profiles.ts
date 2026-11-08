/** Profile sets (7.3): sketch regions as kernel faces, and which sketch curve each edge came from. */
import type { ShapeHandle } from 'occt-wasm';
import { finest, resolveRegion, type CurveKey, type DetectedRegion, type SrcFact } from '@tweakcad/format';
import {
  FeaturePause,
  add,
  dot,
  kv,
  scale,
  sub,
  type BuildContext,
  type Frame,
  type Json,
  type SketchResult,
  type V3,
} from './context';
import { contourEdges, stretchEdge, stretchMeasures } from './curveEdges';

type P2 = readonly [number, number];

interface ProfileEdge {
  /** The segment root as a key: a curve root id, or a glyph contour's segment. */
  root: string;
  /** The segment root as `src` items (9.4): `id(curve root)`, or for a glyph segment `id(text), index(glyph), index(contour), index(segment)`. */
  segment: SrcFact[];
  /** Distance from a sketch-plane point to this stretch of its curve. */
  distance: (p: P2) => number;
  /** The smallest and largest `q · along` over this stretch, `along` a unit vector of the sketch plane. */
  span: (along: P2) => readonly [number, number];
}

/** One profile region built as a face. */
export interface Profile {
  sketch: SketchResult;
  sketchId: string;
  regionId: string;
  face: ShapeHandle;
  edges: ProfileEdge[];
}

/** A sketch-plane point in the part frame. */
export function lift(frame: Frame, p: P2): V3 {
  return add(add(frame.origin, scale(frame.x, p[0])), scale(frame.y, p[1]));
}

function segmentDistance(p: P2, a: P2, b: P2): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Which side of the line a→b `p` lies on: the sign of (b − a) × (p − a). */
function sideOfChord(p: P2, a: P2, b: P2): number {
  return Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
}

/** The smallest and largest `q · along` over `points`. */
function spanOf(points: readonly P2[], along: P2): readonly [number, number] {
  const at = points.map((q) => q[0] * along[0] + q[1] * along[1]);
  return [Math.min(...at), Math.max(...at)];
}

type Arrangement = SketchResult['detection']['arrangement'];

/**
 * A cycle's half-edges joined into stretches: half-edges that run on along
 * one curve, through a place where the cycle does not turn (a spline's through
 * point, a curve touching it), make one stretch, so one kernel edge and one
 * side face. Each stretch runs from `t0` to `t1`, against the curve when not `forward`.
 */
function stretches(arrangement: Arrangement, halfEdges: readonly number[]) {
  const edgeOf = (h: number) => {
    const edge = arrangement.edges[h >> 1];
    if (!edge) throw new Error('half-edge out of range');
    return edge;
  };
  const runsOn = (a: number, b: number) => {
    const [ea, eb] = [edgeOf(a), edgeOf(b)];
    if (ea.curve !== eb.curve || (a & 1) !== (b & 1)) return false;
    return (a & 1) === 0 ? ea.to === eb.from : ea.from === eb.to;
  };
  const count = halfEdges.length;
  // Start where a stretch starts, so none wraps past the cycle's first half-edge.
  const first = Math.max(
    0,
    halfEdges.findIndex((h, i) => !runsOn(halfEdges[(i + count - 1) % count] as number, h)),
  );
  const out: { live: Arrangement['curves'][number]; forward: boolean; t0: number; t1: number }[] = [];
  for (let i = 0; i < count; i++) {
    const h = halfEdges[(first + i) % count] as number;
    const edge = edgeOf(h);
    const forward = (h & 1) === 0;
    const last = out[out.length - 1];
    if (i > 0 && last && runsOn(halfEdges[(first + i - 1) % count] as number, h)) {
      last.t1 += forward ? edge.t1 - edge.t0 : edge.t0 - edge.t1;
      continue;
    }
    const live = arrangement.curves[edge.curve];
    if (!live) throw new Error('curve out of range');
    out.push(forward ? { live, forward, t0: edge.t0, t1: edge.t1 } : { live, forward, t0: edge.t1, t1: edge.t0 });
  }
  return out;
}

/** A glyph contour's segment as a segment root (9.4): no curve id, but its text, glyph, contour and segment numbers. */
function glyphSegment(
  key: Extract<CurveKey, { glyph: unknown }>,
  segment: number,
): Pick<ProfileEdge, 'root' | 'segment'> {
  const { text, glyph, contour } = key.glyph;
  return {
    root: `${text}/${glyph}/${contour}/${segment}`,
    segment: [{ id: text }, { index: glyph }, { index: contour }, { index: segment }],
  };
}

/** The `src` items of the segment root `root` of a profile's edges. */
export function segmentOf(profile: Profile, root: string): SrcFact[] {
  const edge = profile.edges.find((e) => e.root === root);
  if (!edge) throw new FeaturePause('a profile edge lies on no sketch curve');
  return edge.segment;
}

/** One region of a sketch as a kernel face. */
function regionFace(
  ctx: BuildContext,
  sketch: SketchResult,
  region: DetectedRegion,
): { face: ShapeHandle; edges: ProfileEdge[] } {
  const k = ctx.ev.kernel;
  const { arrangement } = sketch.detection;
  const edges: ProfileEdge[] = [];
  const wire = (halfEdges: readonly number[]) => {
    const handles: ShapeHandle[] = [];
    for (const { live, forward, t0, t1 } of stretches(arrangement, halfEdges)) {
      const q = (t: number) => live.curve.point(t);
      const p = (t: number) => lift(sketch.frame, q(t));
      const form = live.curve.form;
      const key = live.source.key;
      const root = 'drawn' in key ? key.drawn.id : '';
      const segment: SrcFact[] = [{ id: root }];
      const full = live.curve.closed && Math.abs(Math.abs(t1 - t0) - (live.curve.tMax - live.curve.tMin)) < 1e-12;
      if (form.kind === 'line') {
        handles.push(k.makeLineEdge(kv(p(t0)), kv(p(t1))));
        const [a, b] = [q(t0), q(t1)];
        edges.push({ root, segment, distance: (x) => segmentDistance(x, a, b), span: (n) => spanOf([a, b], n) });
      } else if (form.kind === 'circular') {
        const center = form.center;
        const off = (x: P2) => Math.abs(Math.hypot(x[0] - center[0], x[1] - center[1]) - form.radius);
        // The circle's two points furthest along ±n.
        const crests = (n: P2): P2[] =>
          [1, -1].map((s) => [center[0] + s * form.radius * n[0], center[1] + s * form.radius * n[1]]);
        if (full) {
          const n = forward ? sketch.frame.normal : scale(sketch.frame.normal, -1);
          handles.push(k.makeCircleEdge(kv(lift(sketch.frame, center)), kv(n), form.radius));
          edges.push({ root, segment, distance: off, span: (n) => spanOf(crests(n), n) });
        } else {
          handles.push(k.makeArcEdge(kv(p(t0)), kv(p((t0 + t1) / 2)), kv(p(t1))));
          // The arc is the part of its circle on the same side of the chord as its midpoint.
          const [a, m, b] = [q(t0), q((t0 + t1) / 2), q(t1)];
          const side = sideOfChord(m, a, b);
          edges.push({
            root,
            segment,
            distance: (x) =>
              sideOfChord(x, a, b) === side ? off(x) : Math.min(segmentDistance(x, a, a), segmentDistance(x, b, b)),
            span: (n) => spanOf([a, b, ...crests(n).filter((x) => sideOfChord(x, a, b) === side)], n),
          });
        }
      } else if (live.source.shape.kind === 'contour' && 'glyph' in key) {
        // One edge per segment, each named after its segment.
        const [lo, hi] = forward ? [t0, t1] : [t1, t0];
        const pieces = contourEdges(k, sketch.frame, live.source.shape, lo, hi);
        for (const piece of forward ? pieces : [...pieces].reverse()) {
          handles.push(forward ? piece.edge : k.reverseShape(piece.edge));
          edges.push({ ...glyphSegment(key, piece.segment), ...stretchMeasures(live.curve, piece.lo, piece.hi) });
        }
      } else {
        const [lo, hi] = forward ? [t0, t1] : [t1, t0];
        const stretch = stretchEdge(k, sketch.frame, live.source.shape, live.curve, lo, hi);
        handles.push(forward ? stretch : k.reverseShape(stretch));
        edges.push({ root, segment, ...stretchMeasures(live.curve, lo, hi) });
      }
    }
    return k.makeWire(handles);
  };
  let face = k.makeFace(wire(region.outer.halfEdges));
  if (region.inner.length > 0)
    face = k.addHolesInFace(
      face,
      region.inner.map((c) => wire(c.halfEdges)),
    );
  return { face, edges };
}

/** The sketch and region a profile reference names (9.4 `region` names). */
function profileRegion(ctx: BuildContext, ref: Json): { sketch: string; region: string } {
  const record = (ref.entity ?? null) as Json | null;
  if (!record) throw new FeaturePause('only region profiles are built yet');
  if ((record.id as string[]).length === 0) throw new FeaturePause('a profile is to be reconnected');
  const level = ctx.ev.names.get(finest(record.id as string[])) as Json | undefined;
  const src = level?.src as Json[] | undefined;
  const first = src?.[0] as Json | undefined;
  if (!level || level.kind !== 'region' || !first || !('id' in first)) {
    throw new FeaturePause('the profile is not a sketch region');
  }
  return { sketch: (level.feature as Json).id as string, region: (first.id as Json).id as string };
}

/**
 * Every region a profile set names, as faces. A divided region gives all its
 * pieces (8.3); a region that resolves to nothing pauses the feature.
 */
export function buildProfiles(ctx: BuildContext, profiles: Json): Profile[] {
  const out: Profile[] = [];
  for (const ref of (profiles.set as Json[]) ?? []) {
    const { sketch: sketchId, region } = profileRegion(ctx, ref);
    const sketch = ctx.part.sketches.get(sketchId);
    if (!sketch) throw new FeaturePause('the profile sketch did not build');
    const regions = resolveRegion(region, sketch.table, sketch.matching);
    if (regions.length === 0) throw new FeaturePause('a profile is missing: the sketch region it used is gone');
    for (const r of regions) out.push({ sketch, sketchId, regionId: region, ...regionFace(ctx, sketch, r) });
  }
  if (out.length === 0) throw new FeaturePause('the profile set is empty');
  return out;
}

/**
 * How far apart two positions of a sketch may be and still be the same place:
 * a millionth of the size of the sketch's points' box, at least a millionth of
 * a millimetre. It does not change where the sketch lies or how many points it has.
 */
export function sketchTolerance(sketch: SketchResult): number {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const q of sketch.solved.points) {
    [x0, x1, y0, y1] = [Math.min(x0, q.x), Math.max(x1, q.x), Math.min(y0, q.y), Math.max(y1, q.y)];
  }
  const size = x1 >= x0 ? Math.hypot(x1 - x0, y1 - y0) : 0;
  return 1e-6 * Math.max(size, 1) + 1e-9;
}

/**
 * The sketch curve a profile edge came from: the one its sample point `p`
 * lies on, exactly, never the nearest.
 */
export function edgeRoot(profile: Profile, p: readonly number[]): string {
  const { frame } = profile.sketch;
  const rel = sub([p[0] as number, p[1] as number, p[2] as number], frame.origin);
  const uv: P2 = [dot(rel, frame.x), dot(rel, frame.y)];
  const tolerance = sketchTolerance(profile.sketch);
  const roots = new Set(profile.edges.filter((e) => e.distance(uv) <= tolerance).map((e) => e.root));
  const [root] = roots;
  if (roots.size !== 1 || root === undefined)
    throw new FeaturePause('a profile edge lies on no sketch curve, or on several');
  return root;
}

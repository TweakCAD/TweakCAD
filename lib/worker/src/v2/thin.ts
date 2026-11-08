/**
 * Thin walls of swept features (appendix A `thin`): a closed profile region
 * becomes the band between its boundary and the boundary offset by the
 * thickness, and each face the band sweeps is told by where its edge lies:
 * on a profile curve (`side`), offset into the region (`inner`) or out of it
 * (`outer`).
 */
import { JoinType, type ShapeHandle } from 'occt-wasm';
import { FeaturePause, LENGTH, TEXT, dot, sub, type BuildContext, type Json, type V3 } from './context';
import { sketchTolerance, type Profile } from './profiles';

export interface Thin {
  thickness: number;
  placement: 'inside' | 'outside' | 'center';
}

/** The thin wall a `thin` input asks for, or undefined for a solid. */
export function thinOf(ctx: BuildContext, thin: Json): Thin | undefined {
  if ('solid' in thin) return undefined;
  const t = thin.thin as Json;
  const thickness = ctx.ev.values.number(t.thickness, LENGTH);
  if (!(thickness > 0)) throw new FeaturePause('a thin wall has a positive thickness');
  return { thickness, placement: ctx.ev.values.literal(t.placement, TEXT) as Thin['placement'] };
}

/** One face a profile sweeps: the region itself, or one piece of its thin band. */
export interface SweptFace {
  face: ShapeHandle;
  /** How far the band reaches into the region and out of it; both 0 for a solid profile. */
  inner: number;
  outer: number;
}

const area = (ctx: BuildContext, wire: ShapeHandle) => ctx.ev.kernel.getSurfaceArea(ctx.ev.kernel.makeFace(wire));

/**
 * The region grown by `delta` (shrunk when negative): every loop offset by
 * |delta| with sharp corners, the outer loop outwards and the holes inwards
 * for a positive `delta`. Undefined when nothing is left.
 */
function grown(ctx: BuildContext, region: ShapeHandle, delta: number): ShapeHandle | undefined {
  const k = ctx.ev.kernel;
  const outer = k.outerWire(region);
  const faces = (wire: ShapeHandle, isOuter: boolean): ShapeHandle[] => {
    const before = area(ctx, wire);
    // The sign the kernel takes depends on the wire's orientation; keep the one that moves the loop the right way.
    const wanted = (isOuter ? 1 : -1) * Math.sign(delta);
    // A loop can shrink away only if every point of it is within |delta| of its boundary.
    const vanishes = wanted < 0 && before <= k.getLength(wire) * Math.abs(delta);
    for (const signed of [Math.abs(delta), -Math.abs(delta)]) {
      let offset: ShapeHandle;
      try {
        offset = k.offsetWire2D(wire, signed, JoinType.Intersection);
      } catch {
        continue;
      }
      const wires = k.getShapeType(offset) === 'wire' ? [offset] : k.getSubShapes(offset, 'wire');
      if (wires.length === 0) continue;
      const total = wires.reduce((s, w) => s + area(ctx, w), 0);
      if (Math.sign(total - before) === wanted) return wires.map((w) => k.makeFace(w));
    }
    if (vanishes) return [];
    throw new FeaturePause('the kernel could not offset a profile loop for the thin wall');
  };
  const outside = faces(outer, true);
  if (outside.length === 0) return undefined;
  const holes = k
    .getSubShapes(region, 'wire')
    .filter((w) => !k.isSame(w, outer))
    .flatMap((w) => faces(w, false));
  const body = outside.length === 1 ? (outside[0] as ShapeHandle) : k.fuseAll(outside);
  return holes.length === 0 ? body : k.cutAll(body, holes);
}

/** The faces a profile sweeps: its region, or the pieces of the band a thin wall makes of it. */
export function sweptFaces(ctx: BuildContext, profile: Profile, thin: Thin | undefined): SweptFace[] {
  if (!thin) return [{ face: profile.face, inner: 0, outer: 0 }];
  const k = ctx.ev.kernel;
  const t = thin.thickness;
  const [inner, outer] = thin.placement === 'inside' ? [t, 0] : thin.placement === 'outside' ? [0, t] : [t / 2, t / 2];
  const high = outer > 0 ? grown(ctx, profile.face, outer) : profile.face;
  const low = inner > 0 ? grown(ctx, profile.face, -inner) : profile.face;
  if (!high) throw new FeaturePause('the kernel could not offset a profile loop for the thin wall');
  if (!low) throw new FeaturePause('the thin wall is thicker than the profile');
  const faces = k.getSubShapes(k.cut(high, low), 'face');
  if (faces.length === 0) throw new FeaturePause('the thin wall is thicker than the profile');
  return faces.map((face) => ({ face, inner, outer }));
}

/**
 * Which wall a swept edge makes, from a point of the edge in the sketch plane:
 * the face on a profile curve is `side`, an offset one `inner` or `outer`,
 * each named after the one curve it lies on or runs at the offset from.
 */
export function wallOf(ctx: BuildContext, profile: Profile, swept: SweptFace, p: V3): { role: string; root: string } {
  const { frame } = profile.sketch;
  const rel = sub(p, frame.origin);
  const uv = [dot(rel, frame.x), dot(rel, frame.y)] as const;
  const tolerance = sketchTolerance(profile.sketch);
  const at = (distance: number) =>
    new Set(profile.edges.filter((e) => Math.abs(e.distance(uv) - distance) <= tolerance).map((e) => e.root));
  const one = (roots: Set<string>, role: string) => {
    const [root] = roots;
    if (roots.size !== 1 || root === undefined)
      throw new FeaturePause('a profile edge lies on no sketch curve, or on several');
    return { role, root };
  };
  const on = at(0);
  if (on.size > 0 || (swept.inner === 0 && swept.outer === 0)) return one(on, 'side');
  const k = ctx.ev.kernel;
  const inside = k.distanceBetween(k.makeVertex(p[0], p[1], p[2]), profile.face) <= tolerance;
  return inside ? one(at(swept.inner), 'inner') : one(at(swept.outer), 'outer');
}

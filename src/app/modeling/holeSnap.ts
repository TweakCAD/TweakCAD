/**
 * Where a hole's position snaps on a planar face, as hole placement infers
 * it: to the centre of a circular edge lying in the face's plane when the
 * pointer is near that edge or its centre, to a shown sketch point in the
 * plane, or to the face frame's origin; otherwise it stays the point under
 * the pointer. Everything is read from the shown display's meshes, in the
 * face's placement frame (`planarFrame`).
 */
import type { BodyMesh, Display, FrameDisplay, Vec3 } from '@tweakcad/worker/src/v2/service/types';

export type Vec2 = [number, number];

export interface SnapTarget {
  kind: 'centre' | 'point' | 'origin';
  /** Where it lies in the face frame. */
  uv: Vec2;
  /** For a centre: the radius of its circular edge. */
  radius?: number;
}

/** Screen pixels from a target, or from a circular edge, within which a position snaps. */
export const SNAP_PIXELS = 10;

/** Millimetres off the face's plane a mesh point may lie and still count as in it. */
const IN_PLANE = 1e-3;

const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

/** A part-frame point in the face frame, with its height off the face's plane. */
export function inFrame(frame: FrameDisplay, p: readonly number[]): { uv: Vec2; height: number } {
  const d = [(p[0] ?? 0) - frame.origin[0], (p[1] ?? 0) - frame.origin[1], (p[2] ?? 0) - frame.origin[2]];
  return { uv: [dot(d, frame.x), dot(d, frame.y)], height: dot(d, frame.normal) };
}

/** A face-frame point in the part frame. */
export function fromFrame(frame: FrameDisplay, uv: Vec2): Vec3 {
  const [u, v] = uv;
  return [
    frame.origin[0] + frame.x[0] * u + frame.y[0] * v,
    frame.origin[1] + frame.x[1] * u + frame.y[1] * v,
    frame.origin[2] + frame.x[2] * u + frame.y[2] * v,
  ];
}

/**
 * The circle every point lies on, or null when they do not lie on one (a
 * line, an ellipse, a freeform curve) or are fewer than three. Points of a
 * tessellated edge lie on the curve, so a circle fits them to within a small
 * fraction of its radius.
 */
export function circleThrough(points: readonly Vec2[]): { centre: Vec2; radius: number } | null {
  if (points.length < 3) return null;
  const a = points[0] as Vec2;
  const b = points[Math.floor(points.length / 3)] as Vec2;
  const c = points[Math.floor((2 * points.length) / 3)] as Vec2;
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const span = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  if (span === 0 || Math.abs(d) <= 1e-9 * span * span) return null;
  const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
  const centre: Vec2 = [
    (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d,
    (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d,
  ];
  const radius = Math.hypot(a[0] - centre[0], a[1] - centre[1]);
  const tolerance = 1e-4 * radius + 1e-4;
  if (points.some((p) => Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - radius) > tolerance)) return null;
  return { centre, radius };
}

/** The centres of a body's circular edges (whole circles or arcs) that lie in the face frame's plane. */
export function circleCentres(mesh: Pick<BodyMesh, 'segments' | 'edges'>, frame: FrameDisplay): SnapTarget[] {
  const out: SnapTarget[] = [];
  for (let e = 0; e + 2 < mesh.edges.length; e += 3) {
    const first = mesh.edges[e] as number;
    const count = mesh.edges[e + 1] as number;
    const points: Vec2[] = [];
    let flat = true;
    for (let s = first * 2; s < (first + count) * 2 && flat; s++) {
      const at = inFrame(frame, [
        mesh.segments[s * 3] as number,
        mesh.segments[s * 3 + 1] as number,
        mesh.segments[s * 3 + 2] as number,
      ]);
      if (Math.abs(at.height) > IN_PLANE) flat = false;
      else points.push(at.uv);
    }
    const circle = flat ? circleThrough(points) : null;
    if (circle) out.push({ kind: 'centre', uv: circle.centre, radius: circle.radius });
  }
  return out;
}

/**
 * What a position on a face snaps to: the centres of the circular edges of
 * the face's body in its plane, the points of the part's shown sketches in
 * that plane, and the frame's origin.
 */
export function snapTargets(display: Display | null, body: number | null, frame: FrameDisplay): SnapTarget[] {
  const out: SnapTarget[] = [];
  for (const definition of display?.definitions ?? []) {
    const shown = definition.bodies.find((b) => b.key === body);
    if (!shown) continue;
    out.push(...circleCentres(shown.mesh, frame));
    for (const sketch of definition.sketches) {
      if (!sketch.visible) continue;
      for (const p of sketch.points) {
        const at = inFrame(frame, p.at);
        if (Math.abs(at.height) <= IN_PLANE) out.push({ kind: 'point', uv: at.uv });
      }
    }
  }
  out.push({ kind: 'origin', uv: [0, 0] });
  return out;
}

/**
 * The target `uv` snaps to within `tolerance` (face-frame units): a point
 * when `uv` is that near it, a centre when `uv` is that near the centre or
 * its circular edge; the nearest of those, or null.
 */
export function snapAt(uv: Vec2, targets: readonly SnapTarget[], tolerance: number): SnapTarget | null {
  let best: SnapTarget | null = null;
  let bestDistance = Infinity;
  for (const t of targets) {
    const toCentre = Math.hypot(uv[0] - t.uv[0], uv[1] - t.uv[1]);
    const distance = t.radius === undefined ? toCentre : Math.min(toCentre, Math.abs(toCentre - t.radius));
    if (distance <= tolerance && distance < bestDistance) {
      best = t;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Where a position on the face `key` lands for a pointer at `uv`: snapped
 * to a target within `tolerance`, or `uv` itself. A face seen through
 * another instance (a part edited in context) snaps to the frame's origin
 * only, as its meshes lie in another frame.
 */
export function snapOnFace(
  display: Display | null,
  face: { key: number; instance?: unknown },
  frame: FrameDisplay,
  uv: Vec2,
  tolerance: number,
): { uv: Vec2; target: SnapTarget | null } {
  const body = display?.entities[face.key]?.body ?? null;
  const targets =
    face.instance === undefined ? snapTargets(display, body, frame) : [{ kind: 'origin' as const, uv: [0, 0] as Vec2 }];
  const target = snapAt(uv, targets, tolerance);
  return { uv: target ? target.uv : uv, target };
}

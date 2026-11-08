/**
 * Rigid placements (2.7): `p ↦ R · p + T`, the rotation a unit quaternion
 * `[x, y, z, w]`. Composing `a ∘ b` applies `b` first, as a child's placement
 * is applied before its parent's.
 */
import { add, cross, dot, norm, rotate, scale, sub, type Frame, type V3 } from './context';

export type Quat = [number, number, number, number];

export interface Rigid {
  position: V3;
  rotation: Quat;
}

export const IDENTITY: Rigid = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** The Hamilton product `a · b`: turning by `b`, then by `a`. */
export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** A quaternion scaled to unit length, in the canonical sign of 2.7. */
export function qnormal(q: Quat): Quat {
  const n = Math.hypot(...q);
  let u = q.map((c) => c / n) as Quat;
  const first = u.find((c, i) => i === 3 || Math.abs(c) > 0) ?? 0;
  if (u[3] < 0 || (u[3] === 0 && first < 0)) u = u.map((c) => -c) as Quat;
  return u.map((c) => (c === 0 ? 0 : c)) as Quat;
}

/** A turn by `radians` about the unit vector `axis`. */
export function qaxis(axis: V3, radians: number): Quat {
  const s = Math.sin(radians / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(radians / 2)];
}

/** The rotation whose columns are the unit axes `x`, `y`, `z` (right-handed). */
export function qfromAxes(x: V3, y: V3, z: V3): Quat {
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return qnormal(q);
}

export function apply(p: Rigid, v: V3): V3 {
  return add(rotate(p.rotation, v), p.position);
}

export function applyVector(p: Rigid, v: V3): V3 {
  return rotate(p.rotation, v);
}

/** `a ∘ b`: `b` first, then `a`. */
export function compose(a: Rigid, b: Rigid): Rigid {
  return { position: apply(a, b.position), rotation: qnormal(qmul(a.rotation, b.rotation)) };
}

export function inverse(p: Rigid): Rigid {
  const r = qconj(p.rotation);
  return { position: scale(rotate(r, p.position), -1), rotation: r };
}

/** The placement taking the standard frame to `f` (2.7: a frame's local coordinates to its part's). */
export function fromFrame(f: Frame): Rigid {
  return { position: f.origin, rotation: qfromAxes(f.x, f.y, f.normal) };
}

export function toFrame(p: Rigid): Frame {
  return {
    origin: p.position,
    x: applyVector(p, [1, 0, 0]),
    y: applyVector(p, [0, 1, 0]),
    normal: applyVector(p, [0, 0, 1]),
  };
}

/** A stored numeric placement (`{position, rotation}`). */
export function readRigid(v: unknown): Rigid {
  const o = v as { position: number[]; rotation: number[] };
  return { position: [...o.position] as V3, rotation: [...o.rotation] as Quat };
}

export function writeRigid(p: Rigid): { position: V3; rotation: Quat } {
  return { position: [...p.position], rotation: qnormal(p.rotation) };
}

/** The 3 × 4 row-major matrix of a placement, as the kernel's `transform` takes it. */
export function matrixOf(p: Rigid): number[] {
  const x = applyVector(p, [1, 0, 0]);
  const y = applyVector(p, [0, 1, 0]);
  const z = applyVector(p, [0, 0, 1]);
  const t = p.position;
  return [x[0], y[0], z[0], t[0], x[1], y[1], z[1], t[1], x[2], y[2], z[2], t[2]];
}

export function isIdentity(p: Rigid): boolean {
  return norm(p.position) === 0 && p.rotation[0] === 0 && p.rotation[1] === 0 && p.rotation[2] === 0;
}

/**
 * The difference `b⁻¹ ∘ a` of two placements as six numbers: its translation
 * (mm), then its rotation vector (axis × angle in radians).
 */
export function difference(a: Rigid, b: Rigid): number[] {
  const d = compose(inverse(b), a);
  return [...d.position, ...rotationVector(d.rotation)];
}

export function rotationVector(q: Quat): V3 {
  const [x, y, z, w] = qnormal(q);
  const s = Math.hypot(x, y, z);
  if (s < 1e-15) return [2 * x, 2 * y, 2 * z];
  const angle = 2 * Math.atan2(s, w);
  return [(x / s) * angle, (y / s) * angle, (z / s) * angle];
}

/** A plane's reflection, `p ↦ p − 2 ((p − o) · n) n`, applied to a point. */
export function reflect(point: V3, normal: V3, p: V3): V3 {
  return sub(p, scale(normal, 2 * dot(sub(p, point), normal)));
}

/**
 * The rigid placement a mirror makes of a frame: its origin and x and y axes
 * reflected in the plane, its z their cross product, so the frame stays
 * right-handed (a reflected z would make it left-handed).
 */
export function mirrorFrame(point: V3, normal: V3, f: Frame): Frame {
  const reflectVector = (v: V3) => sub(v, scale(normal, 2 * dot(v, normal)));
  const x = reflectVector(f.x);
  const y = reflectVector(f.y);
  return { origin: reflect(point, normal, f.origin), x, y, normal: cross(x, y) };
}

/** A plane by a point and a unit normal. */
export interface Plane {
  point: V3;
  normal: V3;
}

/**
 * `m ∘ x ∘ l`, with `m` the reflection in `world` and `l` the reflection in
 * `local`: two reflections and a rigid placement make a rigid placement.
 */
export function mirrored(world: Plane, x: Rigid, local: Plane): Rigid {
  const reflectVector = (n: V3, v: V3): V3 => sub(v, scale(n, 2 * dot(v, n)));
  const [cx, cy, cz] = (
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as V3[]
  ).map((e) => reflectVector(world.normal, applyVector(x, reflectVector(local.normal, e)))) as [V3, V3, V3];
  const origin = reflect(world.point, world.normal, apply(x, reflect(local.point, local.normal, [0, 0, 0])));
  return { position: origin, rotation: qfromAxes(cx, cy, cz) };
}

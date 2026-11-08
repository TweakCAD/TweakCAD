/**
 * FreeCAD placements (a position and a rotation quaternion) and the frames
 * and placement values the converter writes from them.
 */
import type { FcPlacement, Vec3 } from './document';

type Quat = FcPlacement['rotation'];

/** Below this a coordinate or component is solver noise, not geometry. */
const SNAP = 1e-9;

export function snap(v: number): number {
  if (Math.abs(v) < SNAP) return 0;
  const r = Math.round(v);
  return Math.abs(v - r) < SNAP ? r : Number(v.toPrecision(12));
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** `inner` given in the frame of `outer`, in the frame `outer` is given in. */
export function compose(outer: FcPlacement, inner: FcPlacement): FcPlacement {
  const moved = rotate(outer.rotation, inner.position);
  return {
    position: [outer.position[0] + moved[0], outer.position[1] + moved[1], outer.position[2] + moved[2]],
    rotation: multiply(outer.rotation, inner.rotation),
  };
}

export function invert(p: FcPlacement): FcPlacement {
  const [x, y, z, w] = p.rotation;
  const rotation: Quat = [-x, -y, -z, w];
  const back = rotate(rotation, p.position);
  return { position: [-back[0], -back[1], -back[2]], rotation };
}

/** A point given in a placement's frame, in the frame the placement is given in. */
export function apply(p: FcPlacement, v: Vec3): Vec3 {
  const r = rotate(p.rotation, v);
  return [p.position[0] + r[0], p.position[1] + r[1], p.position[2] + r[2]];
}

export function isIdentity(p: FcPlacement): boolean {
  const [x, y, z] = p.rotation;
  return p.position.every((c) => Math.abs(c) < SNAP) && Math.abs(x) < SNAP && Math.abs(y) < SNAP && Math.abs(z) < SNAP;
}

/** A frame as a placement: origin, x direction and normal. */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  normal: Vec3;
}

export function frameOf(p: FcPlacement): Frame {
  return { origin: p.position, x: rotate(p.rotation, [1, 0, 0]), normal: rotate(p.rotation, [0, 0, 1]) };
}

/** The placement whose frame has `x` and `normal` (unit, square) at `origin`. */
export function placementOfFrame(origin: Vec3, x: Vec3, normal: Vec3): FcPlacement {
  const y: Vec3 = [
    normal[1] * x[2] - normal[2] * x[1],
    normal[2] * x[0] - normal[0] * x[2],
    normal[0] * x[1] - normal[1] * x[0],
  ];
  // Rotation matrix with columns x, y, normal, to a quaternion.
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = normal;
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
  return { position: origin, rotation: q };
}

/** A number as expression text: snapped, never in exponent form. */
export function numberText(v: number): string {
  const s = snap(v);
  if (Number.isInteger(s)) return String(s);
  const text = String(s);
  return text.includes('e') ? s.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** A length as expression text in mm. */
export const mm = (v: number): string => `${numberText(v)} mm`;
/** An angle in degrees as expression text. */
export const deg = (v: number): string => `${numberText(v)} deg`;

/** A vector of lengths as expression text. */
export const vectorText = (v: Vec3): string => `vector(${mm(v[0])}, ${mm(v[1])}, ${mm(v[2])})`;
/** A direction as expression text: a vector of plain numbers. */
export const directionText = (v: Vec3): string =>
  `vector(${numberText(v[0])}, ${numberText(v[1])}, ${numberText(v[2])})`;

/** A placement as the expression text of a placement value (6.3). */
export function placementText(p: FcPlacement): string {
  const [x, y, z, w] = p.rotation;
  const s = Math.hypot(x, y, z);
  const angle = (2 * Math.atan2(s, w) * 180) / Math.PI;
  const axis: Vec3 = s < SNAP ? [0, 0, 1] : [x / s, y / s, z / s];
  return `placement(${vectorText(p.position)}, rotate(${directionText(axis)}, ${deg(s < SNAP ? 0 : angle)}))`;
}

/** The canonical-sign unit quaternion (2.7): w not negative. */
export function canonical(q: Quat): Quat {
  const len = Math.hypot(...q);
  const n = q.map((c) => snap(c / len)) as Quat;
  const sign =
    n[3] < 0 || (n[3] === 0 && (n[0] < 0 || (n[0] === 0 && (n[1] < 0 || (n[1] === 0 && n[2] < 0))))) ? -1 : 1;
  return n.map((c) => (c === 0 ? 0 : c * sign)) as Quat;
}

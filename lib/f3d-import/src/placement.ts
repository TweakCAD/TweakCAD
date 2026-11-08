/**
 * Placements (a position and a rotation quaternion) from the file's matrices,
 * and the expression text of the values the converter writes. The file works
 * in centimetres and radians; a document in millimetres and degrees.
 */
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface Placement {
  position: Vec3;
  rotation: Quat;
}

export const CM_TO_MM = 10;

/** Below this a coordinate is noise, not geometry. */
const SNAP = 1e-9;

export function snap(v: number): number {
  if (Math.abs(v) < SNAP) return 0;
  const r = Math.round(v);
  return Math.abs(v - r) < SNAP ? r : Number(v.toPrecision(12));
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function rotate(q: Quat, v: Vec3): Vec3 {
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
export function compose(outer: Placement, inner: Placement): Placement {
  const moved = rotate(outer.rotation, inner.position);
  return {
    position: [outer.position[0] + moved[0], outer.position[1] + moved[1], outer.position[2] + moved[2]],
    rotation: multiply(outer.rotation, inner.rotation),
  };
}

export function invert(p: Placement): Placement {
  const [x, y, z, w] = p.rotation;
  const rotation: Quat = [-x, -y, -z, w];
  const back = rotate(rotation, p.position);
  return { position: [-back[0], -back[1], -back[2]], rotation };
}

/** The placement whose frame has `x` and `normal` (unit, square) at `origin`. */
export function placementOfFrame(origin: Vec3, x: Vec3, normal: Vec3): Placement {
  const y = cross(normal, x);
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

export interface SketchFrame {
  placement: Placement;
  /** The frame's normal, the x axis crossed with the y axis. */
  normal: Vec3;
  /** Position in millimetres. */
  origin: Vec3;
}

/**
 * A sketch's row-major sketch-to-model matrix as a frame. Curves keep the
 * sketch's own coordinates, so only its x and y axes matter: a matrix whose z
 * axis points the other way gets the normal they make.
 */
export function frameOfMatrix(matrix: readonly number[] | null): SketchFrame {
  const m = matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const at = (i: number) => m[i] as number;
  const x = unit([at(0), at(4), at(8)]);
  const y: Vec3 = [at(1), at(5), at(9)];
  const normal = unit(cross(x, y));
  const origin: Vec3 = [at(3) * CM_TO_MM, at(7) * CM_TO_MM, at(11) * CM_TO_MM];
  return { placement: placementOfFrame(origin, x, normal), normal, origin };
}

/** A rigid row-major matrix's inverse. */
export function invertMatrix(m: readonly number[]): number[] {
  const at = (i: number) => m[i] as number;
  const r = [at(0), at(4), at(8), at(1), at(5), at(9), at(2), at(6), at(10)] as const;
  const t = [at(3), at(7), at(11)] as const;
  const moved = [0, 1, 2].map(
    (row) => -((r[row * 3] as number) * t[0] + (r[row * 3 + 1] as number) * t[1] + (r[row * 3 + 2] as number) * t[2]),
  );
  return [
    r[0],
    r[1],
    r[2],
    moved[0] as number,
    r[3],
    r[4],
    r[5],
    moved[1] as number,
    r[6],
    r[7],
    r[8],
    moved[2] as number,
    0,
    0,
    0,
    1,
  ];
}

/** A row-major matrix product. */
export function multiplyMatrix(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 4; k++)
        out[r * 4 + c] = (out[r * 4 + c] as number) + (a[r * 4 + k] as number) * (b[k * 4 + c] as number);
    }
  }
  return out;
}

/** A direction under a matrix's rotation. */
export function rotateByMatrix(m: readonly number[], v: Vec3): Vec3 {
  const at = (i: number) => m[i] as number;
  return [
    at(0) * v[0] + at(1) * v[1] + at(2) * v[2],
    at(4) * v[0] + at(5) * v[1] + at(6) * v[2],
    at(8) * v[0] + at(9) * v[1] + at(10) * v[2],
  ];
}

/** A number as expression text: snapped, never in exponent form. */
export function numberText(v: number): string {
  const s = snap(v);
  if (Number.isInteger(s)) return String(s);
  const text = String(s);
  return text.includes('e') ? s.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : text;
}

export const mm = (v: number): string => `${numberText(v)} mm`;
export const deg = (v: number): string => `${numberText(v)} deg`;
export const vectorText = (v: Vec3): string => `vector(${mm(v[0])}, ${mm(v[1])}, ${mm(v[2])})`;
const directionText = (v: Vec3): string => `vector(${numberText(v[0])}, ${numberText(v[1])}, ${numberText(v[2])})`;

/** A placement as the expression text of a placement value (6.3). */
export function placementText(p: Placement): string {
  const [x, y, z, w] = p.rotation;
  const s = Math.hypot(x, y, z);
  const angle = (2 * Math.atan2(s, w) * 180) / Math.PI;
  const axis: Vec3 = s < SNAP ? [0, 0, 1] : [x / s, y / s, z / s];
  return `placement(${vectorText(p.position)}, rotate(${directionText(axis)}, ${deg(s < SNAP ? 0 : angle)}))`;
}

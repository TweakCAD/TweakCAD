/**
 * A placement as the Edit Component panel shows it: a translation and a
 * rotation as three angles in degrees: a turn about X, then about the
 * turned Y, then about the turned Z. An instance stores its placement as numbers (a unit
 * quaternion, 2.7); a derive's frame is a `placement(...)` expression, whose
 * rotation is one turn about an axis, `rotate(vector(x, y, z), a deg)`.
 */
import type { Placement } from '@tweakcad/worker/src/v2/service/types';
import { vectorParts } from '../modeling/hole';

type V3 = [number, number, number];
type Quat = [number, number, number, number];

const RAD = Math.PI / 180;

/** The rotation of angles `x`, `y`, `z` (deg): about X, then the turned Y, then the turned Z. */
export function quaternionFromAngles(x: number, y: number, z: number): Quat {
  const hx = (x * RAD) / 2;
  const hy = (y * RAD) / 2;
  const hz = (z * RAD) / 2;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(hx), Math.sin(hx), Math.cos(hy), Math.sin(hy), Math.cos(hz), Math.sin(hz)];
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/**
 * The angles (deg) of a rotation, as `quaternionFromAngles` takes them. At
 * Y = ±90° the X and Z turns are one turn; Z is then 0 and X takes it all,
 * so the rotation reads back the same while the numbers may not.
 */
export function anglesOf(q: readonly number[]): V3 {
  const [x, y, z, w] = q as Quat;
  const sinY = Math.min(1, Math.max(-1, 2 * (x * z + w * y)));
  const pole = Math.abs(sinY) > 0.99999;
  const rx = pole
    ? Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + z * z))
    : Math.atan2(-2 * (y * z - w * x), w * w - x * x - y * y + z * z);
  const rz = pole ? 0 : Math.atan2(-2 * (x * y - w * z), w * w + x * x - y * y - z * z);
  return [rx / RAD, Math.asin(sinY) / RAD, rz / RAD];
}

/** A number as a field shows it: no float noise from a round trip, no "-0". */
export function tidy(n: number): string {
  return String(Math.round(n * 1e6) / 1e6 + 0);
}

/** Three field texts as numbers, or null when one is not a number. */
export function parseTriple(values: readonly string[]): V3 | null {
  const parsed = values.map((v) => (v.trim() === '' ? NaN : Number(v)));
  return parsed.length === 3 && parsed.every(Number.isFinite) ? (parsed as V3) : null;
}

/** The numbers of a placement as the panel shows them. */
export function placementFields(p: Placement): { position: V3; rotation: V3 } {
  return { position: [...p.position] as V3, rotation: anglesOf(p.rotation) };
}

/** The placement a translation (mm) and angles (deg) make. */
export function placementOf(position: V3, angles: V3): Placement {
  return { position, rotation: quaternionFromAngles(...angles) };
}

const num = (n: number): string => String(Math.round(n * 1e12) / 1e12 + 0);

/** A rotation by angles (deg) as one turn about an axis: `rotate(vector(x, y, z), a deg)`. */
export function rotationText(angles: V3): string {
  const [x, y, z, w] = quaternionFromAngles(...angles);
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return 'rotate(vector(0, 0, 1), 0 deg)';
  const angle = (2 * Math.atan2(s, w)) / RAD;
  return `rotate(vector(${num(x / s)}, ${num(y / s)}, ${num(z / s)}), ${num(angle)} deg)`;
}

/** The angles (deg) of a rotation written as `rotate(vector(x, y, z), a deg)` with numbers; null for any other text. */
export function anglesOfRotationText(text: string): V3 | null {
  const m = /^\s*rotate\((.*)\)\s*$/s.exec(text);
  const args = m ? splitArguments(m[1] as string) : null;
  if (!args || args.length !== 2) return null;
  const axis = vectorParts(args[0] as string);
  const angle = /^(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*deg$/i.exec((args[1] as string).trim());
  const a = axis ? parseTriple(axis) : null;
  if (!a || !angle) return null;
  const length = Math.hypot(...a);
  if (length === 0) return null;
  const half = (Number(angle[1]) * RAD) / 2;
  const s = Math.sin(half) / length;
  return anglesOf([a[0] * s, a[1] * s, a[2] * s, Math.cos(half)]);
}

/** The top-level arguments of a call's argument text. */
export function splitArguments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

/** A `placement(vector(...), rotation)` expression's translation parts and rotation text; null for any other text. */
export function readPlacementText(text: string): { position: string[]; rotation: string } | null {
  const m = /^\s*placement\((.*)\)\s*$/s.exec(text);
  const args = m ? splitArguments(m[1] as string) : null;
  if (!args || args.length !== 2) return null;
  const position = vectorParts(args[0] as string);
  return position && position.length === 3 ? { position, rotation: args[1] as string } : null;
}

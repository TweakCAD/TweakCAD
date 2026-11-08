/**
 * Exact curve and surface data, read from a live kernel shape, and the small
 * pure routines the naming adapter builds on.
 *
 * occt-wasm has no call for a circle's centre or a cylinder's axis. Each
 * analytic kind is a fixed parametric formula, though, and the kernel evaluates
 * it at any parameter, inside the edge or face or not, with the shape's
 * location applied. So the frame comes from a few evaluations at known
 * parameters, exact to rounding, for mirrored (left-handed) frames as well.
 */

import type { CurveFacts, SurfaceFacts, Vec3 } from '@tweakcad/format';
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { NamingAdapterError } from './namingAdapterHistory.ts';

export const toVec3 = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit = (a: Vec3): Vec3 => scale(a, 1 / length(a));
const middle = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);

/** Order by x, then y, then z (9.7). */
export function compareVec3(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** A 3D curve's exact data. `kind` is the kernel's curve type. */
export function curveFacts(k: OcctKernel, edge: ShapeHandle, kind: string): CurveFacts {
  const at = (t: number): Vec3 => toVec3(k.curvePointAtParam(edge, t));
  switch (kind) {
    case 'line':
      return { kind: 'line' };
    case 'circle': {
      // C(t) = O + R cos t X + R sin t Y.
      const a = at(0);
      const center = middle(a, at(Math.PI));
      const x = sub(a, center);
      const y = sub(at(Math.PI / 2), center);
      return { kind: 'circle', center, axis: unit(cross(x, y)), radius: length(x) };
    }
    case 'ellipse': {
      // C(t) = O + A cos t X + B sin t Y.
      const a = at(0);
      const center = middle(a, at(Math.PI));
      const x = sub(a, center);
      const y = sub(at(Math.PI / 2), center);
      return { kind: 'ellipse', center, axis: unit(cross(x, y)), major: unit(x), radii: [length(x), length(y)] };
    }
    case 'bspline':
    case 'bezier': {
      const data = k.getNurbsCurveData(edge);
      const { first, last } = k.curveParameters(edge);
      const poles: Vec3[] = [];
      for (let i = 0; i + 2 < data.poles.length; i += 3) {
        poles.push([data.poles[i] ?? 0, data.poles[i + 1] ?? 0, data.poles[i + 2] ?? 0]);
      }
      return {
        kind: 'bspline',
        first,
        last,
        degree: data.degree,
        poles,
        weights: data.weights.length > 0 ? data.weights : poles.map(() => 1),
        knots: data.knots,
        multiplicities: data.multiplicities,
      };
    }
    default:
      throw new NamingAdapterError('unsupported', `No exact data for a curve of kind "${kind}"`);
  }
}

/** A surface's exact data. `kind` is the kernel's surface type; `halfAngle` is in degrees. */
export function surfaceFacts(k: OcctKernel, face: ShapeHandle, kind: string): SurfaceFacts {
  const at = (u: number, v: number): Vec3 => toVec3(k.pointOnSurface(face, u, v));
  switch (kind) {
    case 'plane':
      return { kind: 'plane', point: at(0, 0), normal: toVec3(k.surfaceNormal(face, 0, 0)) };
    case 'cylinder': {
      // S(u, v) = O + R (cos u X + sin u Y) + v Z.
      const a = at(0, 0);
      const origin = middle(a, at(Math.PI, 0));
      const x = sub(a, origin);
      return { kind, origin, axis: unit(sub(at(0, 1), a)), x: unit(x), radii: [length(x)] };
    }
    case 'cone': {
      // S(u, v) = O + (R + v sin A) (cos u X + sin u Y) + v cos A Z.
      const a0 = at(0, 0);
      const origin = middle(a0, at(Math.PI, 0));
      const a1 = at(0, 1);
      const mid1 = middle(a1, at(Math.PI, 1));
      const along = sub(mid1, origin);
      const reach0 = sub(a0, origin);
      const reach1 = sub(a1, mid1);
      const radius = length(reach0);
      // At an apex O the frame's x is only known from the next section.
      const x = unit(radius > 0 ? reach0 : reach1);
      const halfAngle = Math.atan2(dot(sub(reach1, reach0), x), length(along));
      return { kind, origin, axis: unit(along), x, radii: [radius], halfAngle: (halfAngle * 180) / Math.PI };
    }
    case 'sphere': {
      // S(u, v) = O + R cos v (cos u X + sin u Y) + R sin v Z.
      const a = at(0, 0);
      const origin = middle(a, at(Math.PI, 0));
      const x = sub(a, origin);
      return { kind, origin, axis: unit(sub(at(0, Math.PI / 2), origin)), x: unit(x), radii: [length(x)] };
    }
    case 'torus': {
      // S(u, v) = O + (R + r cos v) (cos u X + sin u Y) + r sin v Z.
      const a = at(0, 0);
      const origin = middle(a, at(Math.PI, 0));
      const x = unit(sub(a, origin));
      const outer = dot(sub(a, origin), x);
      const inner = dot(sub(at(0, Math.PI), origin), x);
      const major = (outer + inner) / 2;
      const axis = unit(sub(sub(at(0, Math.PI / 2), origin), scale(x, major)));
      return { kind, origin, axis, x, radii: [major, (outer - inner) / 2] };
    }
    default:
      throw new NamingAdapterError('unsupported', `No exact data for a surface of kind "${kind}"`);
  }
}

/** A tried sample point inside its entity. */
export interface SampleCandidate {
  point: Vec3;
  /** Distance to the entity's boundary. */
  clearance: number;
}

/**
 * The 9.6 walk. The first tried point farther than `required` from the
 * boundary wins; failing that, the inside point farthest from it, the earliest
 * on ties; null only when no tried point is inside. `probe` returns null for a
 * point outside the entity.
 */
export function firstClearPoint(
  sequence: Iterable<readonly number[]>,
  probe: (tuple: readonly number[]) => SampleCandidate | null,
  required: number,
  limit = 2 ** 20,
): Vec3 | null {
  let best: SampleCandidate | null = null;
  let tried = 0;
  for (const tuple of sequence) {
    if (tried++ >= limit) break;
    const candidate = probe(tuple);
    if (!candidate) continue;
    if (candidate.clearance > required) return candidate.point;
    if (!best || candidate.clearance > best.clearance) best = candidate;
  }
  return best?.point ?? null;
}

/** The one sign every closest point gives. Null when they disagree, when any has none, or when there are none. */
export function agreedSign(signs: readonly (1 | -1 | 0)[]): 1 | -1 | null {
  const [sign] = signs;
  return sign && signs.every((s) => s === sign) ? sign : null;
}

/** One use of an edge in a wire, with its end vertices in the direction of travel. */
export interface LoopUse<Key> {
  edge: Key;
  reversed: boolean;
  from: Key;
  to: Key;
}

/**
 * A wire's edge uses as one connected cycle from its first use, keeping stored
 * order where there is a choice. A wire need not be stored as a cycle: a
 * cylinder wall's holds its two circles and both passes of the seam, in an
 * order that dead-ends if walked greedily, so this is Hierholzer's walk. Anything
 * that does not close is an error, since a loop in the wrong order would
 * describe a different boundary.
 */
export function orderLoop<Key>(uses: readonly LoopUse<Key>[]): LoopUse<Key>[] {
  const [first, ...rest] = uses;
  if (!first) return [];
  const leaving = new Map<Key, LoopUse<Key>[]>();
  for (const use of rest) leaving.set(use.from, [...(leaving.get(use.from) ?? []), use]);

  const path = [first];
  const reversedCycle: LoopUse<Key>[] = [];
  for (let at = path.at(-1); at; at = path.at(-1)) {
    const next = leaving.get(at.to)?.shift();
    if (next) path.push(next);
    else reversedCycle.push(path.pop() as LoopUse<Key>);
  }

  const cycle = reversedCycle.reverse();
  const closes = cycle.every((use, i) => use.to === cycle[(i + 1) % cycle.length]?.from);
  if (cycle.length !== uses.length || !closes) {
    throw new NamingAdapterError('malformed', 'A wire does not form one closed loop');
  }
  return cycle;
}

/**
 * Finding what another program's reference names by its geometry: edges lying
 * on two surfaces, and the constraints of a sketch a solver can hold.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { ValueEvaluator } from '@tweakcad/format';
import { MAX_SOLVER_SYSTEM_SIZE, solveSketchPositions, solverSystemSize } from '../sketchSolve';

type V3 = readonly [number, number, number];
type Json = Record<string, unknown>;

/** A surface by its geometry, in mm. */
export type SurfaceSpec =
  | { kind: 'plane'; origin: V3; normal: V3 }
  | { kind: 'cone'; origin: V3; axis: V3; radius: number; sine: number; cosine: number }
  | { kind: 'sphere'; center: V3; radius: number }
  | { kind: 'torus'; center: V3; axis: V3; major: number; minor: number };

/** How far an edge may sit from a surface and still count as lying on it, in mm. */
export const ON_SURFACE_TOLERANCE = 1e-3;
/** How far a solved point may drift before a constraint counts as moving it, in mm. */
const MOVE_TOLERANCE = 1e-4;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Height along `axis` from `origin`, and distance from the axis. */
function cylindrical(p: V3, origin: V3, axis: V3): { height: number; radial: number } {
  const a = unit(axis);
  const d = sub(p, origin);
  const height = dot(d, a);
  return { height, radial: Math.hypot(d[0] - height * a[0], d[1] - height * a[1], d[2] - height * a[2]) };
}

export function distanceToSurface(p: V3, s: SurfaceSpec): number {
  switch (s.kind) {
    case 'plane':
      return Math.abs(dot(sub(p, s.origin), unit(s.normal)));
    case 'cone': {
      const { height, radial } = cylindrical(p, s.origin, s.axis);
      return Math.abs(radial - (s.radius + (height * s.sine) / s.cosine)) * Math.abs(s.cosine);
    }
    case 'sphere':
      return Math.abs(Math.hypot(...sub(p, s.center)) - s.radius);
    case 'torus': {
      const { height, radial } = cylindrical(p, s.center, s.axis);
      return Math.abs(Math.hypot(radial - s.major, height) - s.minor);
    }
  }
}

/** Whether every sample of an edge lies on a surface. */
export const onSurface = (samples: readonly V3[], s: SurfaceSpec): boolean =>
  samples.length > 0 && samples.every((p) => distanceToSurface(p, s) <= ON_SURFACE_TOLERANCE);

/**
 * The constraints of a sketch that take it away from its stored positions or
 * stop it solving, by id. Candidates are tried together and a failing group is
 * halved, so a clean sketch costs one solve and only the offenders are singled
 * out.
 */
export function unheldConstraints(inputs: Json, values: ValueEvaluator, gcs: GcsWrapper): string[] {
  const stored = new Map((inputs.points as { id: string; x: number; y: number }[]).map((p) => [p.id, p]));
  const holds = (list: readonly Json[]): boolean => {
    const trial = { ...inputs, constraints: list };
    if (solverSystemSize(trial) > MAX_SOLVER_SYSTEM_SIZE) return false;
    try {
      const { points } = solveSketchPositions(trial, values, gcs);
      for (const [id, at] of points) {
        const before = stored.get(id);
        if (before && Math.hypot(at.x - before.x, at.y - before.y) > MOVE_TOLERANCE) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const held: Json[] = [];
  const out: string[] = [];
  const attempt = (list: readonly Json[]): void => {
    if (list.length === 0) return;
    if (holds([...held, ...list])) held.push(...list);
    else if (list.length === 1) out.push((list[0] as Json).id as string);
    else {
      const half = list.length >> 1;
      attempt(list.slice(0, half));
      attempt(list.slice(half));
    }
  };
  attempt(inputs.constraints as Json[]);
  return out;
}

/**
 * Unit test for `computeSolverPoints` — the pre-pass that keeps the planegcs
 * system to the constrained skeleton. The solver itself can't be unit-tested
 * (no WASM in vitest), but this pure helper is the part that prevents dense
 * imported sketches (thousands of free spline/bezier control points) from
 * blowing the solver's heap.
 */

import { describe, it, expect } from 'vitest';
import { computeSolverPoints, excludedPointDof } from './PlaneGCSSolver.ts';
import type {
  SketchPoint,
  SketchGeometry,
  SketchConstraint,
  SketchPointId,
  SketchGeometryId,
  SketchConstraintId,
} from '../types.ts';

const pid = (s: string): SketchPointId => s as SketchPointId;
const gid = (s: string): SketchGeometryId => s as SketchGeometryId;
const cid = (s: string): SketchConstraintId => s as SketchConstraintId;

function ptMap(ids: string[]): Map<SketchPointId, SketchPoint> {
  const m = new Map<SketchPointId, SketchPoint>();
  ids.forEach((id, i) => m.set(pid(id), { id: pid(id), x: i, y: 0 } as SketchPoint));
  return m;
}

describe('computeSolverPoints', () => {
  it('excludes free spline control points, keeps line endpoints + constrained points', () => {
    // A line (p1→p2), a free spline (s1,s2,s3), and a coincident joining p2 to j1.
    const points = ptMap(['p1', 'p2', 's1', 's2', 's3', 'j1']);
    const geometries = new Map<SketchGeometryId, SketchGeometry>([
      [gid('L'), { id: gid('L'), type: 'line', startId: pid('p1'), endId: pid('p2') } as SketchGeometry],
      [gid('S'), { id: gid('S'), type: 'spline', pointIds: [pid('s1'), pid('s2'), pid('s3')] } as SketchGeometry],
    ]);
    const constraints = new Map<SketchConstraintId, SketchConstraint>([
      [cid('c1'), { id: cid('c1'), type: 'coincident', pointA: pid('p2'), pointB: pid('j1') } as SketchConstraint],
    ]);

    const needed = computeSolverPoints(points, geometries, constraints, new Set());
    expect([...needed].sort()).toEqual(['j1', 'p1', 'p2']);
    // The free spline points are not in the solver system.
    expect(needed.has(pid('s1'))).toBe(false);
    expect(needed.has(pid('s2'))).toBe(false);
    expect(needed.has(pid('s3'))).toBe(false);
  });

  it('keeps fixed and anchored points even when otherwise free', () => {
    const points = ptMap(['a', 'b']);
    points.set(pid('a'), { id: pid('a'), x: 0, y: 0, fixed: true } as SketchPoint);
    const needed = computeSolverPoints(points, new Map(), new Map(), new Set([pid('b')]));
    expect([...needed].sort()).toEqual(['a', 'b']);
  });

  it('keeps circle center and arc center/start/end', () => {
    const points = ptMap(['c', 'ac', 'as', 'ae', 'free']);
    const geometries = new Map<SketchGeometryId, SketchGeometry>([
      [gid('C'), { id: gid('C'), type: 'circle', centerId: pid('c'), radius: 5 } as SketchGeometry],
      [gid('A'), { id: gid('A'), type: 'arc', centerId: pid('ac'), startId: pid('as'), endId: pid('ae'), radius: 3 } as SketchGeometry],
    ]);
    const needed = computeSolverPoints(points, geometries, new Map(), new Set());
    expect([...needed].sort()).toEqual(['ac', 'ae', 'as', 'c']);
    expect(needed.has(pid('free'))).toBe(false);
  });
});

describe('excludedPointDof', () => {
  it('reports 2 DOF per skipped free control pole (all-free spline → under-constrained)', () => {
    // A closed spline of free control poles — the shape an imported DXF of
    // closed splines produces. None enter the solver, so `dof()` alone would
    // read 0 and the Lock badge would falsely show "fully constrained".
    const points = ptMap(['s1', 's2', 's3', 's4']);
    const geometries = new Map<SketchGeometryId, SketchGeometry>([
      [gid('S'), { id: gid('S'), type: 'spline', pointIds: [pid('s1'), pid('s2'), pid('s3'), pid('s4')] } as SketchGeometry],
    ]);
    const solverPoints = computeSolverPoints(points, geometries, new Map(), new Set());
    expect(solverPoints.size).toBe(0);
    // Four free poles × 2 coordinates = 8 DOF of real remaining freedom.
    expect(excludedPointDof(points, solverPoints)).toBe(8);
  });

  it('reports 0 when every point is in the solver (genuinely constrained skeleton)', () => {
    // A line whose endpoints both enter the solver — nothing is skipped, so
    // the reported dof is exactly what `GcsSystem.dof()` returns (no padding).
    const points = ptMap(['p1', 'p2']);
    const geometries = new Map<SketchGeometryId, SketchGeometry>([
      [gid('L'), { id: gid('L'), type: 'line', startId: pid('p1'), endId: pid('p2') } as SketchGeometry],
    ]);
    const solverPoints = computeSolverPoints(points, geometries, new Map(), new Set());
    expect(solverPoints.size).toBe(2);
    expect(excludedPointDof(points, solverPoints)).toBe(0);
  });

  it('counts only the skipped poles in a mixed line + free-spline sketch', () => {
    // Line endpoints enter the solver; the three free spline poles do not.
    const points = ptMap(['p1', 'p2', 's1', 's2', 's3']);
    const geometries = new Map<SketchGeometryId, SketchGeometry>([
      [gid('L'), { id: gid('L'), type: 'line', startId: pid('p1'), endId: pid('p2') } as SketchGeometry],
      [gid('S'), { id: gid('S'), type: 'spline', pointIds: [pid('s1'), pid('s2'), pid('s3')] } as SketchGeometry],
    ]);
    const solverPoints = computeSolverPoints(points, geometries, new Map(), new Set());
    // Three skipped poles × 2 = 6 DOF added on top of whatever the line contributes.
    expect(excludedPointDof(points, solverPoints)).toBe(6);
  });
});

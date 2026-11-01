/**
 * Solve-level tests for `PlaneGCSSolver` that need a live planegcs (attached
 * by `testSetup.ts` for the `core` project).
 */

import { describe, it, expect } from 'vitest';
import { getSolver } from './index.ts';
import { applyConstraintWithSolver } from '../applyConstraintPipeline.ts';
import type { EditorState } from '../operations.ts';
import type {
  SketchPoint,
  SketchGeometry,
  SketchConstraint,
  SketchConstraintInput,
  SketchPointId,
  SketchGeometryId,
  SketchConstraintId,
} from '../types.ts';

const pid = (s: string): SketchPointId => s as SketchPointId;
const gid = (s: string): SketchGeometryId => s as SketchGeometryId;
const cid = (s: string): SketchConstraintId => s as SketchConstraintId;

function sketch(
  points: [string, number, number, boolean?][],
  geometries: SketchGeometry[],
  constraints: SketchConstraint[] = [],
): EditorState {
  return {
    points: new Map(points.map(([id, x, y, fixed]) => [pid(id), { id: pid(id), x, y, fixed: fixed ?? false } as SketchPoint])),
    geometries: new Map(geometries.map(g => [g.id, g])),
    constraints: new Map(constraints.map(c => [c.id, c])),
  };
}

const arc = (id: string, c: string, s: string, e: string, radius: number): SketchGeometry =>
  ({ id: gid(id), type: 'arc', centerId: pid(c), startId: pid(s), endId: pid(e), radius, construction: false });
const line = (id: string, s: string, e: string): SketchGeometry =>
  ({ id: gid(id), type: 'line', startId: pid(s), endId: pid(e), construction: false });

describe('PlaneGCSSolver arc radius', () => {
  it('reads the solved arc radius back, so a radius change converges', () => {
    const s = sketch(
      [['c', 0, 0, true], ['s', 5, 0], ['e', 0, 5]],
      [arc('a', 'c', 's', 'e', 5)],
      [{ id: cid('r'), type: 'radius', geometryId: gid('a'), value: 8 }],
    );
    const result = getSolver().solve(s.points, s.geometries, s.constraints, new Set());
    expect(result.diagnostic.converged).toBe(true);
    expect(result.diagnostic.unsatisfied.size).toBe(0);
    const g = result.geometries.get(gid('a'));
    expect(g?.type === 'arc' && g.radius).toBeCloseTo(8, 6);
    const start = result.points.get(pid('s'))!;
    expect(Math.hypot(start.x, start.y)).toBeCloseTo(8, 6);
  });

  it('applies a radius dimension that changes an arc', () => {
    const s = sketch([['c', 0, 0, true], ['s', 5, 0], ['e', 0, 5]], [arc('a', 'c', 's', 'e', 5)]);
    const input = { type: 'radius', geometryId: gid('a'), value: 8 } as SketchConstraintInput;
    const result = applyConstraintWithSolver(s, input, getSolver());
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    const g = result.state.geometries.get(gid('a'));
    expect(g?.type === 'arc' && g.radius).toBeCloseTo(8, 6);
  });

  it('resizes a slot whose end arcs are tangent to its sides', () => {
    // Bottom-left fixed; right arc CCW bottom → top, left arc CCW top → bottom.
    const s = sketch(
      [
        ['bl', 0, 0, true], ['br', 30, 0], ['tr', 30, 10], ['tl', 0, 10],
        ['rc', 30, 5], ['rs', 30, 0], ['re', 30, 10],
        ['lc', 0, 5], ['ls', 0, 10], ['le', 0, 0],
      ],
      [line('bot', 'bl', 'br'), line('top', 'tr', 'tl'), arc('ra', 'rc', 'rs', 're', 5), arc('la', 'lc', 'ls', 'le', 5)],
      [
        { id: cid('h1'), type: 'horizontal', geometryId: gid('bot') },
        { id: cid('h2'), type: 'horizontal', geometryId: gid('top') },
        { id: cid('c1'), type: 'coincident', pointA: pid('br'), pointB: pid('rs') },
        { id: cid('c2'), type: 'coincident', pointA: pid('tr'), pointB: pid('re') },
        { id: cid('c3'), type: 'coincident', pointA: pid('tl'), pointB: pid('ls') },
        { id: cid('c4'), type: 'coincident', pointA: pid('bl'), pointB: pid('le') },
        { id: cid('t1'), type: 'tangent', lineId: gid('bot'), circleId: gid('ra') },
        { id: cid('t2'), type: 'tangent', lineId: gid('top'), circleId: gid('ra') },
        { id: cid('t3'), type: 'tangent', lineId: gid('bot'), circleId: gid('la') },
        { id: cid('t4'), type: 'tangent', lineId: gid('top'), circleId: gid('la') },
        { id: cid('eq'), type: 'equal', geometryA: gid('ra'), geometryB: gid('la') },
        { id: cid('len'), type: 'length', geometryId: gid('bot'), value: 30 },
        { id: cid('r'), type: 'radius', geometryId: gid('ra'), value: 12 },
      ],
    );
    const result = getSolver().solve(s.points, s.geometries, s.constraints, new Set());
    expect(result.diagnostic.converged).toBe(true);
    expect(result.diagnostic.unsatisfied.size).toBe(0);
    expect(result.points.get(pid('tl'))!.y).toBeCloseTo(24, 6);
    const la = result.geometries.get(gid('la'));
    expect(la?.type === 'arc' && la.radius).toBeCloseTo(12, 6);
  });
});

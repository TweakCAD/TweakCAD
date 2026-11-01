import { beforeAll, describe, it, expect } from 'vitest';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { resolveSketchDimensions } from './resolveSketchDimensions.ts';
import type { EditorState } from '@tweakcad/core/src/sketch/operations.ts';
import type {
  SketchConstraint,
  SketchGeometry,
  SketchPoint,
  SketchPointId,
  SketchGeometryId,
  SketchConstraintId,
} from '@tweakcad/core/src/sketch/types.ts';

beforeAll(attachTestSolver, 30_000);

const pid = (s: string): SketchPointId => s as SketchPointId;
const gid = (s: string): SketchGeometryId => s as SketchGeometryId;
const cid = (s: string): SketchConstraintId => s as SketchConstraintId;

describe('resolveSketchDimensions', () => {
  it('drives an arc and a circle radius from one parameter', () => {
    const points: SketchPoint[] = [
      { id: pid('c'), x: 0, y: 0, fixed: true },
      { id: pid('s'), x: 5, y: 0, fixed: false },
      { id: pid('e'), x: 0, y: 5, fixed: false },
      { id: pid('k'), x: 20, y: 0, fixed: true },
    ];
    const geometries: SketchGeometry[] = [
      { id: gid('a'), type: 'arc', centerId: pid('c'), startId: pid('s'), endId: pid('e'), radius: 5, construction: false },
      { id: gid('circ'), type: 'circle', centerId: pid('k'), radius: 5, construction: false },
    ];
    const constraints: SketchConstraint[] = [
      { id: cid('ra'), type: 'radius', geometryId: gid('a'), value: 5, expression: 'R' },
      { id: cid('rc'), type: 'radius', geometryId: gid('circ'), value: 5, expression: 'R' },
    ];
    const state: EditorState = {
      points: new Map(points.map(p => [p.id, p])),
      geometries: new Map(geometries.map(g => [g.id, g])),
      constraints: new Map(constraints.map(c => [c.id, c])),
    };

    const result = resolveSketchDimensions(state, { R: 8 });

    expect(result.diagnostics).toEqual([]);
    expect(result.solved).toBe(true);
    const a = result.state.geometries.get(gid('a'));
    const circ = result.state.geometries.get(gid('circ'));
    expect(a?.type === 'arc' && a.radius).toBeCloseTo(8, 6);
    expect(circ?.type === 'circle' && circ.radius).toBeCloseTo(8, 6);
    const s = result.state.points.get(pid('s'))!;
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(8, 6);
  });
});

/**
 * Parameter-driven sketch dimensions, against real planegcs.
 *
 * Lives here rather than beside `resolveSketchDimensions` because it needs a
 * live solver, and the WASM loader is browser-side — the same reason
 * `PlaneGCSSolver.smoke.test.ts` and the constraint suite live in this
 * directory.
 *
 * This is the behaviour that did not exist before: feature inputs have always
 * been `Expression`, so a parameter could change how far a profile was
 * extruded, but every sketch constraint value was a bare number and nothing
 * in the build path could solve. A parameter could not move a line.
 *
 * The distinction worth testing is **solve, not substitute**. Writing the
 * resolved number onto the constraint says what the dimension is; it says
 * nothing about where the points go. Only the solver answers that, and only
 * while respecting every other constraint.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { initPlaneGCS } from './planegcsLoader.ts';
import { resolveSketchDimensions } from '@tweakcad/worker/src/resolveSketchDimensions.ts';
import type { EditorState } from '@tweakcad/core/src/sketch/operations.ts';
import {
  sketchPointId, sketchGeometryId, sketchConstraintId,
  type SketchPoint, type SketchPointId,
  type SketchGeometry, type SketchGeometryId,
  type SketchConstraint, type SketchConstraintId,
} from '@tweakcad/core/src/sketch/types.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

function findWasm(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [
    resolve(here, '../../../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    resolve(here, '../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
  ]) {
    if (existsSync(c)) return realpathSync(c);
  }
  throw new Error('planegcs.wasm not found');
}

const A = sketchPointId('p_a');
const B = sketchPointId('p_b');
const LINE = sketchGeometryId('g_line');
const DIM = sketchConstraintId('c_dim');

/**
 * A horizontal line from a pinned origin, with its length dimensioned.
 * `expression` drives that dimension; `value` is the last solved number.
 */
function lineWithDrivenLength(expression?: string, value = 10): EditorState {
  const points = new Map<SketchPointId, SketchPoint>([
    [A, { id: A, x: 0, y: 0, fixed: true }],
    [B, { id: B, x: value, y: 0, fixed: false }],
  ]);
  const geometries = new Map<SketchGeometryId, SketchGeometry>([
    [LINE, { id: LINE, type: 'line', startId: A, endId: B, construction: false }],
  ]);
  const dim = {
    id: DIM, type: 'distance', pointA: A, pointB: B, value,
    ...(expression ? { expression } : {}),
  } as SketchConstraint;
  const constraints = new Map<SketchConstraintId, SketchConstraint>([[DIM, dim]]);
  return { points, geometries, constraints };
}

const lengthOf = (s: EditorState): number => {
  const a = s.points.get(A)!;
  const b = s.points.get(B)!;
  return Math.hypot(b.x - a.x, b.y - a.y);
};

describe('parameter-driven sketch dimensions', () => {
  beforeAll(async () => {
    await initPlaneGCS(findWasm());
  }, 30_000);

  it('moves the geometry when a parameter drives the dimension', () => {
    const state = lineWithDrivenLength('width', 10);
    const out = resolveSketchDimensions(state, { width: 25 });

    expect(out.solved).toBe(true);
    expect(out.diagnostics).toEqual([]);
    // The point actually moved — the dimension was solved, not just recorded.
    expect(lengthOf(out.state)).toBeCloseTo(25, 6);
    // The pinned end stayed pinned: the solver respected the other constraint.
    expect(out.state.points.get(A)!.x).toBeCloseTo(0, 6);
  });

  it('evaluates arithmetic, not just bare parameter names', () => {
    const out = resolveSketchDimensions(lineWithDrivenLength('width * 2 + 5', 10), { width: 10 });
    expect(lengthOf(out.state)).toBeCloseTo(25, 6);
  });

  it('leaves a sketch with no expressions completely untouched', () => {
    // The common case, and the reason this is cheap: no solve runs at all.
    const state = lineWithDrivenLength(undefined, 10);
    const out = resolveSketchDimensions(state, { width: 99 });
    expect(out.solved).toBe(false);
    expect(out.state).toBe(state); // same object, not a copy
  });

  it('keeps the last solved value when the expression cannot be evaluated', () => {
    // An unknown parameter must not collapse the dimension to zero. The
    // sketch keeps the shape it had and the build reports why.
    const out = resolveSketchDimensions(lineWithDrivenLength('nonexistent', 10), {});
    expect(out.solved).toBe(false);
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]).toMatch(/nonexistent/);
    expect(lengthOf(out.state)).toBeCloseTo(10, 6);
  });

  it('reports rather than throws when the parameters over-constrain the sketch', () => {
    // Both endpoints pinned, so no length other than the current one is
    // satisfiable. Building the authored shape with a diagnostic beats
    // failing the feature and showing nothing.
    const state = lineWithDrivenLength('width', 10);
    state.points.set(B, { id: B, x: 10, y: 0, fixed: true });
    const out = resolveSketchDimensions(state, { width: 25 });

    expect(out.solved).toBe(false);
    expect(out.diagnostics.join(' ')).toMatch(/could not be solved/i);
    expect(lengthOf(out.state)).toBeCloseTo(10, 6);
  });

  it('applies every dimension before solving once', () => {
    // Solving per constraint would let an early solve move geometry a later
    // constraint is about to re-pin, making the result depend on iteration
    // order. Two driven dimensions on one sketch must both land.
    const C = sketchPointId('p_c');
    const state = lineWithDrivenLength('width', 10);
    state.points.set(C, { id: C, x: 0, y: 5, fixed: false });
    const VERT = sketchConstraintId('c_vert');
    state.constraints.set(VERT, {
      id: VERT, type: 'distance', pointA: A, pointB: C, value: 5, expression: 'height',
    } as SketchConstraint);

    const out = resolveSketchDimensions(state, { width: 25, height: 40 });
    expect(out.solved).toBe(true);
    const a = out.state.points.get(A)!;
    const c = out.state.points.get(C)!;
    expect(lengthOf(out.state)).toBeCloseTo(25, 6);
    expect(Math.hypot(c.x - a.x, c.y - a.y)).toBeCloseTo(40, 6);
  });
});

describe('parameter-driven sketch dimensions — angles', () => {
  beforeAll(async () => {
    await initPlaneGCS(findWasm());
  }, 30_000);

  // Expressions follow the document's units, so an angle parameter is written
  // in degrees; the constraint's `value` is radians for the solver.
  function twoLinesAtAngle(expression: string): EditorState {
    const O = sketchPointId('p_o');
    const X = sketchPointId('p_x');
    const Y = sketchPointId('p_y');
    const L1 = sketchGeometryId('g_l1');
    const L2 = sketchGeometryId('g_l2');
    const ANG = sketchConstraintId('c_ang');
    const LEN = sketchConstraintId('c_len');
    return {
      points: new Map<SketchPointId, SketchPoint>([
        [O, { id: O, x: 0, y: 0, fixed: true }],
        [X, { id: X, x: 10, y: 0, fixed: true }],
        [Y, { id: Y, x: 10 * Math.cos(0.5), y: 10 * Math.sin(0.5), fixed: false }],
      ]),
      geometries: new Map<SketchGeometryId, SketchGeometry>([
        [L1, { id: L1, type: 'line', startId: O, endId: X, construction: false }],
        [L2, { id: L2, type: 'line', startId: O, endId: Y, construction: false }],
      ]),
      constraints: new Map<SketchConstraintId, SketchConstraint>([
        [ANG, { id: ANG, type: 'angle', geometryA: L1, geometryB: L2, value: 0.5, expression } as SketchConstraint],
        [LEN, { id: LEN, type: 'distance', pointA: O, pointB: Y, value: 10 } as SketchConstraint],
      ]),
    };
  }

  it('reads an angle expression in degrees', () => {
    const out = resolveSketchDimensions(twoLinesAtAngle('theta'), { theta: 30 });
    expect(out.solved).toBe(true);
    const y = out.state.points.get(sketchPointId('p_y'))!;
    // Used to be taken as 30 rad, settling the line at about −81°.
    expect((Math.atan2(y.y, y.x) * 180) / Math.PI).toBeCloseTo(30, 4);
  });

  it('stores the solved angle in radians', () => {
    const out = resolveSketchDimensions(twoLinesAtAngle('theta * 2'), { theta: 22.5 });
    const ang = out.state.constraints.get(sketchConstraintId('c_ang')) as { value: number };
    expect(ang.value).toBeCloseTo(Math.PI / 4, 9);
  });
});

describe('parameter-driven sketch dimensions — through a rebuild', () => {
  beforeAll(async () => {
    await initPlaneGCS(findWasm());
  }, 30_000);

  it('reports a dimension that cannot be evaluated as a warning on the sketch', async () => {
    const { incrementalRebuild, clearRebuildCache } = await import('@tweakcad/worker/src/rebuilder.ts');
    const { MockKernel } = await import('@tweakcad/kernel/src/mockKernel.ts');
    const { newProjectWithPart } = await import('@tweakcad/core/src/document/factory.ts');
    const { toSnapshot } = await import('@tweakcad/core/src/sketch/operations.ts');
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = newProjectWithPart('P', 'Part 1');
    const part = Object.values(project.parts)[0]!;
    part.timeline = [{
      id: 'f_sketch',
      type: 'sketch',
      name: 'Sketch 1',
      version: 1,
      enabled: true,
      visible: true,
      // `width` is not a parameter of this project — deleted, say.
      inputs: { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: toSnapshot(lineWithDrivenLength('width', 10)) },
      dependsOn: [],
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    } as never];

    const result = await incrementalRebuild(part, project, kernel, 0);

    const sketch = result.featureResults[0]!;
    expect(sketch.status).toBe('success');
    expect(sketch.status === 'success' ? sketch.warnings : undefined).toEqual([
      expect.stringContaining('could not be evaluated'),
    ]);
  });
});

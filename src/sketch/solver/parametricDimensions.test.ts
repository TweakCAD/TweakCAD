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

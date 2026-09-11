/**
 * Integration tests for the drag-solve ladder against the real planegcs
 * WASM — a mock solver can't reproduce the behaviour under test, which is
 * precisely how planegcs responds to a system whose free parameters have
 * been removed by anchoring.
 *
 * The first test reproduces the reported bug: dragging a horizontally
 * constrained line whose other end is the fixed origin tore the sketch
 * apart, because the anchored solve had no free parameter left to satisfy
 * `horizontal` and planegcs therefore never applied a solution — leaving
 * every other point, including unrelated coincident partners, wherever it
 * had been pushed.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { initPlaneGCS, getPlaneGCSSolver } from './planegcsLoader.ts';
import { solveDrag } from '@tweakcad/core/src/sketch/solver/index.ts';
import {
  sketchConstraintId,
  sketchGeometryId,
  sketchPointId,
  type SketchConstraint,
  type SketchGeometry,
  type SketchPoint,
  type SketchPointId,
  type SketchGeometryId,
  type SketchConstraintId,
} from '@tweakcad/core/src/sketch/types.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

// Same WASM resolution as the smoke test — Emscripten in Node reads from the
// filesystem, and pnpm symlinks the package through its content store.
function findWasm(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    resolve(here, '../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return realpathSync(c);
  }
  throw new Error('planegcs.wasm not found in any expected node_modules location');
}

const P = (n: string): SketchPointId => sketchPointId(n);
const G = (n: string): SketchGeometryId => sketchGeometryId(n);
const C = (n: string): SketchConstraintId => sketchConstraintId(n);

const origin = P('pt_origin');
const p1 = P('p1');
const p2 = P('p2');
const p3 = P('p3');
const p4 = P('p4');

const l1 = G('l1'); // origin -> p1, horizontal
const l2 = G('l2'); // p2 -> p3, vertical
const l3 = G('l3'); // p4 -> origin

/**
 * The reported sketch: a closed three-sided figure hanging off the fixed
 * sketch origin. `l1` carries `horizontal`, `l2` carries `vertical`, and the
 * corners are joined by `coincident` rather than shared points — which is
 * what made the tear visible, since the partners drifted independently.
 */
function triangle(): {
  points: Map<SketchPointId, SketchPoint>;
  geometries: Map<SketchGeometryId, SketchGeometry>;
  constraints: Map<SketchConstraintId, SketchConstraint>;
} {
  const points = new Map<SketchPointId, SketchPoint>([
    [origin, { id: origin, x: 0, y: 0, fixed: true }],
    [p1, { id: p1, x: -72, y: 0, fixed: false }],
    [p2, { id: p2, x: -72, y: 0, fixed: false }],
    [p3, { id: p3, x: -72, y: 60, fixed: false }],
    [p4, { id: p4, x: -72, y: 60, fixed: false }],
  ]);
  const geometries = new Map<SketchGeometryId, SketchGeometry>([
    [l1, { id: l1, type: 'line', startId: origin, endId: p1, construction: false }],
    [l2, { id: l2, type: 'line', startId: p2, endId: p3, construction: false }],
    [l3, { id: l3, type: 'line', startId: p4, endId: origin, construction: false }],
  ]);
  const constraints = new Map<SketchConstraintId, SketchConstraint>([
    [C('c_h'), { id: C('c_h'), type: 'horizontal', geometryId: l1 }],
    [C('c_co1'), { id: C('c_co1'), type: 'coincident', pointA: p2, pointB: p1 }],
    [C('c_v'), { id: C('c_v'), type: 'vertical', geometryId: l2 }],
    [C('c_co2'), { id: C('c_co2'), type: 'coincident', pointA: p4, pointB: p3 }],
  ]);
  return { points, geometries, constraints };
}

describe('solveDrag', () => {
  beforeAll(async () => {
    await initPlaneGCS(findWasm());
  }, 30_000);

  it('anchors the drag when the sketch can absorb it', () => {
    const { points, geometries, constraints } = triangle();
    // Drag p3 sideways. `vertical` on l2 can follow by moving p2 (and its
    // coincident partner p1) — there is freedom to spend, so the anchor holds
    // and p3 lands exactly where it was dropped.
    points.set(p3, { id: p3, x: -40, y: 60, fixed: false });

    const result = solveDrag(getPlaneGCSSolver(), points, geometries, constraints, new Set([p3]));

    expect(result).not.toBeNull();
    expect(result!.diagnostic.converged).toBe(true);
    expect(result!.points.get(p3)!.x).toBeCloseTo(-40, 6);
    expect(result!.points.get(p3)!.y).toBeCloseTo(60, 6);
    // vertical held: l2's endpoints share an x.
    expect(result!.points.get(p2)!.x).toBeCloseTo(-40, 6);
  });

  it('slides along the constraint instead of tearing the sketch apart', () => {
    const { points, geometries, constraints } = triangle();
    // Drag p1 down and to the right. `horizontal` on l1 needs origin.y == p1.y
    // and the origin is fixed, so with p1 anchored too there is no free
    // parameter left and the anchored solve cannot succeed.
    points.set(p1, { id: p1, x: -40, y: -30, fixed: false });

    const anchoredOnly = getPlaneGCSSolver().solve(points, geometries, constraints, new Set([p1]));
    expect(anchoredOnly.diagnostic.converged).toBe(false);

    const result = solveDrag(getPlaneGCSSolver(), points, geometries, constraints, new Set([p1]));

    expect(result).not.toBeNull();
    expect(result!.diagnostic.converged).toBe(true);
    expect(result!.diagnostic.unsatisfied.size).toBe(0);

    const out = result!.points;
    // The constrained axis wins: p1 slid back onto the horizontal.
    expect(out.get(p1)!.y).toBeCloseTo(0, 6);
    // The free axis still follows the cursor — without a soft drag target the
    // least-squares correction pulls p1 all the way back and the drag is inert.
    expect(out.get(p1)!.x).toBeCloseTo(-40, 1);
    // The origin never moved.
    expect(out.get(origin)!.x).toBeCloseTo(0, 6);
    expect(out.get(origin)!.y).toBeCloseTo(0, 6);
    // The regression: both coincident pairs stay joined. Before the fix these
    // drifted apart and the split was written to the document.
    expect(out.get(p2)!.x).toBeCloseTo(out.get(p1)!.x, 6);
    expect(out.get(p2)!.y).toBeCloseTo(out.get(p1)!.y, 6);
    expect(out.get(p4)!.x).toBeCloseTo(out.get(p3)!.x, 6);
    expect(out.get(p4)!.y).toBeCloseTo(out.get(p3)!.y, 6);
  });

  it('refuses the drag when no anchoring produces a consistent sketch', () => {
    const { points, geometries, constraints } = triangle();
    // Two contradictory distances on the same pair — unsatisfiable however the
    // solver distributes the correction, so both tiers fail.
    constraints.set(C('c_d1'), { id: C('c_d1'), type: 'distance', pointA: origin, pointB: p1, value: 50 });
    constraints.set(C('c_d2'), { id: C('c_d2'), type: 'distance', pointA: origin, pointB: p1, value: 80 });
    points.set(p1, { id: p1, x: -65, y: -10, fixed: false });

    const result = solveDrag(getPlaneGCSSolver(), points, geometries, constraints, new Set([p1]));

    // null tells the caller to discard the gesture — better an ignored drag
    // than a torn sketch persisted to the document.
    expect(result).toBeNull();
  });

  it('does not re-solve when there was nothing anchored to drop', () => {
    const { points, geometries, constraints } = triangle();
    let calls = 0;
    const real = getPlaneGCSSolver();
    const counting = {
      kind: real.kind,
      ready: real.ready,
      solve: (...args: Parameters<typeof real.solve>) => {
        calls++;
        return real.solve(...args);
      },
    };

    const result = solveDrag(counting, points, geometries, constraints, new Set());

    expect(calls).toBe(1);
    expect(result).not.toBeNull();
  });
});

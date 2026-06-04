/**
 * planegcs constraint-adapter acceptance tests.
 *
 * One scenario per constraint kind we translate (horizontal,
 * perpendicular, equal, tangent + internal tangent, angle, distanceX,
 * symmetric, midpoint, concentric), driven through the real
 * `applyConstraintWithSolver` pipeline against planegcs. (planegcs is
 * the only solver.)
 *
 * Tests assert user-visible outcomes (constraint applied vs rejected;
 * key geometry preserved), not solver internals. Failing here means
 * planegcs is mis-translating one of our constraint kinds — fix the
 * adapter (`PlaneGCSSolver.translateConstraint`), not the test.
 *
 * The pipeline under test is the same one the bus runs:
 * `applyConstraintWithSolver` from
 * `@tweakcad/core/src/sketch/applyConstraintPipeline.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  emptyEditorState,
  addPoint,
  addGeometry,
  makeCounterIdFactory,
} from '@tweakcad/core/src/sketch/operations.ts';
import type { EditorState } from '@tweakcad/core/src/sketch/operations.ts';
import { applyConstraintWithSolver } from '@tweakcad/core/src/sketch/applyConstraintPipeline.ts';
import type { SketchConstraintInput, SketchGeometryId } from '@tweakcad/core/src/sketch/types.ts';
import { initPlaneGCS } from './planegcsLoader.ts';
import { getPlaneGCSSolver } from './planegcsLoader.ts';
import { getSolver } from '@tweakcad/core/src/sketch/solver/index.ts';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function findWasm(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    resolve(here, '../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
  ];
  for (const c of candidates) if (existsSync(c)) return realpathSync(c);
  throw new Error('planegcs.wasm not found');
}

beforeAll(async () => {
  await initPlaneGCS(findWasm());
  // Sanity check: if WASM didn't load, `getSolver()` would throw
  // `PlaneGCSNotReadyError` on every scenario and we'd see a cryptic
  // failure cascade instead of a clear setup error.
  expect(getPlaneGCSSolver().ready).toBe(true);
});

function applyOrReject(
  state: EditorState,
  input: SketchConstraintInput,
): ReturnType<typeof applyConstraintWithSolver> {
  return applyConstraintWithSolver(state, input, getSolver(), new Set());
}

describe('applyConstraintWithSolver via planegcs', () => {
  it('commits a horizontal constraint and snaps the line flat', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const a = addPoint(s, 0, 0, { idFactory: f }); s = a.state;
    const b = addPoint(s, 10, 5, { idFactory: f }); s = b.state;
    const line = addGeometry(s, { type: 'line', startId: a.id, endId: b.id, construction: false }, { idFactory: f });
    s = line.state;

    const result = applyOrReject(s, { type: 'horizontal', geometryId: line.id });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    const pa = result.state.points.get(a.id)!;
    const pb = result.state.points.get(b.id)!;
    expect(Math.abs(pa.y - pb.y)).toBeLessThan(1e-3);
  });

  it('rejects perpendicular added to two already-vertical lines', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const l1a = addPoint(s, 0, 0, { idFactory: f }); s = l1a.state;
    const l1b = addPoint(s, 0.5, 20, { idFactory: f }); s = l1b.state;
    const L1 = addGeometry(s, { type: 'line', startId: l1a.id, endId: l1b.id, construction: false }, { idFactory: f });
    s = L1.state;
    const l2a = addPoint(s, 10, 0, { idFactory: f }); s = l2a.state;
    const l2b = addPoint(s, 10.5, 20, { idFactory: f }); s = l2b.state;
    const L2 = addGeometry(s, { type: 'line', startId: l2a.id, endId: l2b.id, construction: false }, { idFactory: f });
    s = L2.state;

    const r1 = applyOrReject(s, { type: 'vertical', geometryId: L1.id });
    expect(r1.kind).toBe('applied');
    if (r1.kind !== 'applied') return;
    s = r1.state;
    const r2 = applyOrReject(s, { type: 'vertical', geometryId: L2.id });
    expect(r2.kind).toBe('applied');
    if (r2.kind !== 'applied') return;
    s = r2.state;

    // Parallel lines cannot be perpendicular — adapter must surface this
    // as an unsatisfied constraint so the pipeline rejects it.
    const perp = applyOrReject(s, { type: 'perpendicular', geometryA: L1.id, geometryB: L2.id });
    expect(perp.kind).toBe('rejected');
  });

  it('equal-radius links two circles bidirectionally', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const a = addPoint(s, 0, 0, { idFactory: f }); s = a.state;
    const C1 = addGeometry(s, { type: 'circle', centerId: a.id, radius: 10, construction: false }, { idFactory: f });
    s = C1.state;
    const b = addPoint(s, 30, 0, { idFactory: f }); s = b.state;
    const C2 = addGeometry(s, { type: 'circle', centerId: b.id, radius: 4, construction: false }, { idFactory: f });
    s = C2.state;

    const result = applyOrReject(s, { type: 'equal', geometryA: C1.id, geometryB: C2.id });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    const r1 = (result.state.geometries.get(C1.id) as { radius: number }).radius;
    const r2 = (result.state.geometries.get(C2.id) as { radius: number }).radius;
    expect(Math.abs(r1 - r2)).toBeLessThan(1e-3);
  });

  it('equal-length links two lines bidirectionally', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const a1 = addPoint(s, 0, 0, { idFactory: f }); s = a1.state;
    const a2 = addPoint(s, 10, 0, { idFactory: f }); s = a2.state;
    const L1 = addGeometry(s, { type: 'line', startId: a1.id, endId: a2.id, construction: false }, { idFactory: f });
    s = L1.state;
    const b1 = addPoint(s, 0, 20, { idFactory: f }); s = b1.state;
    const b2 = addPoint(s, 4, 20, { idFactory: f }); s = b2.state;
    const L2 = addGeometry(s, { type: 'line', startId: b1.id, endId: b2.id, construction: false }, { idFactory: f });
    s = L2.state;

    const result = applyOrReject(s, { type: 'equal', geometryA: L1.id, geometryB: L2.id });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    const len = (id: SketchGeometryId): number => {
      const g = result.state.geometries.get(id) as { startId: string; endId: string };
      const p = result.state.points.get(g.startId as never)!;
      const q = result.state.points.get(g.endId as never)!;
      return Math.hypot(q.x - p.x, q.y - p.y);
    };
    expect(Math.abs(len(L1.id) - len(L2.id))).toBeLessThan(1e-3);
  });

  it('auto-resizes free radii when a tangent network needs r1 = r2 (belt-and-pulleys)', () => {
    // Two parallel vertical lines, each tangent to two circles of unequal
    // radius. Geometric constraint network requires r1 = r2 (distance
    // between parallel lines = 2*r for tangent to each). With radii free
    // (no explicit `radius` constraint), the pipeline's two-pass solve
    // should perturb radii and find r1 = r2, committing the last tangent
    // instead of rejecting it.
    let s = emptyEditorState();
    const f = makeCounterIdFactory();

    const l1a = addPoint(s, -10, 0, { idFactory: f }); s = l1a.state;
    const l1b = addPoint(s, -10, 20, { idFactory: f }); s = l1b.state;
    const L1 = addGeometry(s, { type: 'line', startId: l1a.id, endId: l1b.id, construction: false }, { idFactory: f });
    s = L1.state;
    const v1 = applyOrReject(s, { type: 'vertical', geometryId: L1.id });
    if (v1.kind === 'applied') s = v1.state;

    const l2a = addPoint(s, 10, 0, { idFactory: f }); s = l2a.state;
    const l2b = addPoint(s, 10, 20, { idFactory: f }); s = l2b.state;
    const L2 = addGeometry(s, { type: 'line', startId: l2a.id, endId: l2b.id, construction: false }, { idFactory: f });
    s = L2.state;
    const v2 = applyOrReject(s, { type: 'vertical', geometryId: L2.id });
    if (v2.kind === 'applied') s = v2.state;

    // Big circle (initial r=10 — matches distance/2 between lines).
    const cBig = addPoint(s, 0, 10, { idFactory: f }); s = cBig.state;
    const big = addGeometry(s, { type: 'circle', centerId: cBig.id, radius: 10, construction: false }, { idFactory: f });
    s = big.state;
    for (const lineId of [L1.id, L2.id]) {
      const r = applyOrReject(s, { type: 'tangent', lineId, circleId: big.id });
      expect(r.kind).toBe('applied');
      if (r.kind === 'applied') s = r.state;
    }

    // Small circle (initial r=5 — incompatible with line spacing of 20).
    const cSmall = addPoint(s, 0, -20, { idFactory: f }); s = cSmall.state;
    const small = addGeometry(s, { type: 'circle', centerId: cSmall.id, radius: 5, construction: false }, { idFactory: f });
    s = small.state;
    const t1 = applyOrReject(s, { type: 'tangent', lineId: L1.id, circleId: small.id });
    expect(t1.kind).toBe('applied');
    if (t1.kind === 'applied') s = t1.state;

    // The over-constraining add — without perturbation this would reject.
    const lastTangent = applyOrReject(s, { type: 'tangent', lineId: L2.id, circleId: small.id });
    expect(lastTangent.kind).toBe('applied');
    if (lastTangent.kind !== 'applied') return;
    // Both radii are now equal (within tolerance).
    const rBig = (lastTangent.state.geometries.get(big.id) as { radius: number }).radius;
    const rSmall = (lastTangent.state.geometries.get(small.id) as { radius: number }).radius;
    expect(Math.abs(rBig - rSmall)).toBeLessThan(1e-2);
  });

  it('solves a line tangent to a circle without exploding either', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const la = addPoint(s, -20, 5, { idFactory: f }); s = la.state;
    const lb = addPoint(s, 20, 5, { idFactory: f }); s = lb.state;
    const line = addGeometry(s, { type: 'line', startId: la.id, endId: lb.id, construction: false }, { idFactory: f });
    s = line.state;
    const cc = addPoint(s, 0, -5, { idFactory: f }); s = cc.state;
    const circ = addGeometry(s, { type: 'circle', centerId: cc.id, radius: 5, construction: false }, { idFactory: f });
    s = circ.state;
    const h = applyOrReject(s, { type: 'horizontal', geometryId: line.id });
    expect(h.kind).toBe('applied');
    if (h.kind === 'applied') s = h.state;

    const tan = applyOrReject(s, { type: 'tangent', lineId: line.id, circleId: circ.id });
    expect(tan.kind).toBe('applied');
    if (tan.kind !== 'applied') return;
    const a = tan.state.points.get(la.id)!;
    const b = tan.state.points.get(lb.id)!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(1e-2);
    const centre = tan.state.points.get(cc.id)!;
    const c = tan.state.geometries.get(circ.id) as { type: 'circle'; radius: number };
    const lineY = (a.y + b.y) * 0.5;
    expect(Math.abs(Math.abs(centre.y - lineY) - c.radius)).toBeLessThan(1e-2);
  });

  // `internal: true` is wired through planegcs via the
  // `tangent_circumf` primitive (the inner-tangency variant).
  it('drives a nested circle to internal tangency', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    // Big circle at origin, radius 20. Small circle inside, radius 5,
    // centered at (10, 0) — its centre is inside the big disk so
    // `detectInternalTangent` would pick `internal: true` from the UI.
    const cBig = addPoint(s, 0, 0, { idFactory: f }); s = cBig.state;
    const big = addGeometry(s, { type: 'circle', centerId: cBig.id, radius: 20, construction: false }, { idFactory: f });
    s = big.state;
    const cSmall = addPoint(s, 10, 0, { idFactory: f }); s = cSmall.state;
    const small = addGeometry(s, { type: 'circle', centerId: cSmall.id, radius: 5, construction: false }, { idFactory: f });
    s = small.state;
    // Lock both radii so the solver can't satisfy by resizing.
    const rBigC = applyOrReject(s, { type: 'radius', geometryId: big.id, value: 20 });
    if (rBigC.kind === 'applied') s = rBigC.state;
    const rSmallC = applyOrReject(s, { type: 'radius', geometryId: small.id, value: 5 });
    if (rSmallC.kind === 'applied') s = rSmallC.state;

    const result = applyOrReject(s, {
      type: 'tangent',
      circleId: big.id,
      secondCircleId: small.id,
      internal: true,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    // Internal tangent residual: |cA − cB| − |rA − rB| = 0.
    // With rBig=20, rSmall=5, that means |cA − cB| = 15.
    const ca = result.state.points.get(cBig.id)!;
    const cb = result.state.points.get(cSmall.id)!;
    const d = Math.hypot(cb.x - ca.x, cb.y - ca.y);
    expect(Math.abs(d - 15)).toBeLessThan(1e-2);
  });

  // Angle constraint translates to planegcs `l2l_angle_ll`.
  // Two lines meeting at a shared point: target 90° between them.
  it('drives two lines to a 90° angle when constrained', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    // Line A: origin → (10, 0). Line B starts at origin and angles up
    // slightly off-90° so the solver has work to do.
    const o = addPoint(s, 0, 0, { idFactory: f }); s = o.state;
    const aEnd = addPoint(s, 10, 0, { idFactory: f }); s = aEnd.state;
    const A = addGeometry(s, { type: 'line', startId: o.id, endId: aEnd.id, construction: false }, { idFactory: f });
    s = A.state;
    const bEnd = addPoint(s, 1, 10, { idFactory: f }); s = bEnd.state;  // near-vertical
    const B = addGeometry(s, { type: 'line', startId: o.id, endId: bEnd.id, construction: false }, { idFactory: f });
    s = B.state;

    const result = applyOrReject(s, {
      type: 'angle',
      geometryA: A.id,
      geometryB: B.id,
      value: Math.PI / 2,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;

    const a1 = result.state.points.get(o.id)!;
    const a2 = result.state.points.get(aEnd.id)!;
    const b2 = result.state.points.get(bEnd.id)!;
    const angA = Math.atan2(a2.y - a1.y, a2.x - a1.x);
    const angB = Math.atan2(b2.y - a1.y, b2.x - a1.x);
    let diff = angB - angA;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    expect(Math.abs(Math.abs(diff) - Math.PI / 2)).toBeLessThan(1e-3);
  });

  // Signed distanceX. Emitting `p2p_distance` with `Math.abs(value)`
  // would resolve negative targets to the positive
  // configuration (Δx = +value, not −value). With `difference` the
  // sign survives.
  it('preserves the sign of distanceX when value is negative', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const a = addPoint(s, 0, 0, { idFactory: f }); s = a.state;
    const b = addPoint(s, 5, 0, { idFactory: f }); s = b.state;

    const result = applyOrReject(s, { type: 'distanceX', pointA: a.id, pointB: b.id, value: -3 });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    const pa = result.state.points.get(a.id)!;
    const pb = result.state.points.get(b.id)!;
    // Δx = pB.x − pA.x = −3 (sign preserved).
    expect(pb.x - pa.x).toBeCloseTo(-3, 5);
  });

  // Symmetric across an axis, via
  // midpoint_on_line_pppp + perpendicular_pppp.
  it('drives two points to mirror positions across a y-axis line', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    // Vertical axis line at x = 0 (no pins — the symmetric constraint
    // is purely about pA/pB's relationship to the axis, not the axis's
    // location).
    const ls = addPoint(s, 0, -10, { idFactory: f }); s = ls.state;
    const le = addPoint(s, 0, 10, { idFactory: f }); s = le.state;
    const axis = addGeometry(s, { type: 'line', startId: ls.id, endId: le.id, construction: true }, { idFactory: f });
    s = axis.state;
    // Two points that aren't mirror images yet.
    const pA = addPoint(s, 4, 3, { idFactory: f }); s = pA.state;
    const pB = addPoint(s, -5, 6, { idFactory: f }); s = pB.state;

    const result = applyOrReject(s, {
      type: 'symmetric',
      pointA: pA.id,
      pointB: pB.id,
      geometryId: axis.id,
    });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    const lsP = result.state.points.get(ls.id)!;
    const leP = result.state.points.get(le.id)!;
    const a = result.state.points.get(pA.id)!;
    const b = result.state.points.get(pB.id)!;
    // After solve: axis direction (dx, dy), midpoint of (a,b) on the axis,
    // (b−a) perpendicular to (le−ls). Check both conditions; we can't
    // hard-code coords because the whole system has translational
    // freedom along the unconstrained axis.
    const dx = leP.x - lsP.x, dy = leP.y - lsP.y;
    const mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;
    // Midpoint on axis (cross product → 0).
    expect(Math.abs((mx - lsP.x) * dy - (my - lsP.y) * dx)).toBeLessThan(1e-3);
    // (b−a) ⊥ (le−ls) → dot product → 0.
    expect(Math.abs((b.x - a.x) * dx + (b.y - a.y) * dy)).toBeLessThan(1e-3);
  });

  // Midpoint maps onto planegcs `p2p_symmetric_ppp(A, B, P)`,
  // which says A,B are symmetric about P — equivalent to "P is the
  // midpoint of segment AB". Single primitive, no helper points.
  it('drives a point to the midpoint of a line under midpoint', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const a = addPoint(s, 0, 0, { idFactory: f }); s = a.state;
    const b = addPoint(s, 10, 4, { idFactory: f }); s = b.state;
    const line = addGeometry(s, { type: 'line', startId: a.id, endId: b.id, construction: false }, { idFactory: f });
    s = line.state;
    // Standalone point starting off-segment so the solver has to move it.
    const p = addPoint(s, 2, 8, { idFactory: f }); s = p.state;

    const result = applyOrReject(s, { type: 'midpoint', pointId: p.id, geometryId: line.id });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;

    const pa = result.state.points.get(a.id)!;
    const pb = result.state.points.get(b.id)!;
    const pp = result.state.points.get(p.id)!;
    expect(pp.x).toBeCloseTo((pa.x + pb.x) * 0.5, 5);
    expect(pp.y).toBeCloseTo((pa.y + pb.y) * 0.5, 5);
  });

  // Concentric translates to `p2p_coincident` on the two
  // centres. Different radii are fine (different from "equal radius").
  it('drives two circles to a shared centre under concentric', () => {
    let s = emptyEditorState();
    const f = makeCounterIdFactory();
    const cA = addPoint(s, 0, 0, { idFactory: f }); s = cA.state;
    const A = addGeometry(s, { type: 'circle', centerId: cA.id, radius: 10, construction: false }, { idFactory: f });
    s = A.state;
    const cB = addPoint(s, 30, 5, { idFactory: f }); s = cB.state;
    const B = addGeometry(s, { type: 'circle', centerId: cB.id, radius: 3, construction: false }, { idFactory: f });
    s = B.state;

    const result = applyOrReject(s, { type: 'concentric', geometryA: A.id, geometryB: B.id });
    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;

    const pA = result.state.points.get(cA.id)!;
    const pB = result.state.points.get(cB.id)!;
    expect(Math.hypot(pB.x - pA.x, pB.y - pA.y)).toBeLessThan(1e-3);
    // Radii unchanged — concentric != equal.
    expect((result.state.geometries.get(A.id) as { radius: number }).radius).toBeCloseTo(10, 6);
    expect((result.state.geometries.get(B.id) as { radius: number }).radius).toBeCloseTo(3, 6);
  });
});

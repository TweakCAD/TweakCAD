/**
 * planegcs adapter — Real implementation.
 *
 * Wraps the salusoft89/planegcs WASM constraint solver behind our
 * [[ISketchSolver]] interface. The translation layer maps
 * our point-first [[sketch types|@tweakcad/core/sketch/types]] onto planegcs's
 * primitive-first model:
 *
 *   - Each SketchPoint  →  one planegcs `point` primitive (shared by id; our
 *     shared-point convention means no synthetic P2PCoincident is needed).
 *   - Each SketchGeometry → one planegcs primitive (line / circle / arc /
 *     ellipse). Slot / polygon / spline are expanded into constituent
 *     lines + arcs — TODO once we exercise those in tests.
 *   - Each SketchConstraint → one planegcs constraint with the field names
 *     in `node_modules/@salusoft89/planegcs/dist/planegcs_dist/constraints.d.ts`.
 *
 * IDs are prefixed (`p:` / `g:` / `c:`) before being pushed into planegcs so
 * the three id spaces can't collide in planegcs's single oid namespace.
 *
 * Lifecycle: the GcsWrapper is loaded once at app boot via
 * `planegcsLoader.initPlaneGCS()` and attached via `attach()`. Each
 * `solve()` clears the wrapper, rebuilds the primitive set, runs solve(),
 * and reads back updated coordinates. We don't try to incrementally update
 * the wrapper — at sketch scale (hundreds of constraints) the rebuild cost
 * is negligible and the code stays stateless.
 */

import type {
  SketchConstraint,
  SketchConstraintId,
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from '../types.ts';
import { sketchConstraintId } from '../types.ts';
import { Algorithm, SolveStatus } from '@salusoft89/planegcs';
import type { GcsWrapper, SketchPrimitive } from '@salusoft89/planegcs';
import type { ISketchSolver, SolveResult, SolverKind } from './ISketchSolver.ts';

export class PlaneGCSNotReadyError extends Error {
  constructor() {
    super('PlaneGCS solver not initialised — call initPlaneGCS() at app boot');
  }
}

const PID = (id: SketchPointId): string => `p:${id}`;
const GID = (id: SketchGeometryId): string => `g:${id}`;
const CID = (id: SketchConstraintId): string => `c:${id}`;

/**
 * The subset of points that must enter the planegcs system: any point that is
 * fixed/anchored, is an endpoint/center of a solver-modeled geometry
 * (line / circle / arc), or is referenced by a constraint. Free points — e.g.
 * the control points of a spline or bezier with no constraint on them — are
 * left out: they constrain nothing, so pushing them only bloats the system.
 * A dense imported sketch (flattened SVG curves → thousands of free points)
 * would otherwise blow the WASM heap; omitted points pass through `solve()`'s
 * readback unchanged.
 *
 * Constraint point references are found by a generic field scan (any string /
 * string-array field whose value is a key in `points`), so this stays correct
 * as constraint variants are added without re-enumerating them here.
 */
export function computeSolverPoints(
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
  constraints: ReadonlyMap<SketchConstraintId, SketchConstraint>,
  anchored: ReadonlySet<SketchPointId>,
): Set<SketchPointId> {
  const needed = new Set<SketchPointId>();
  for (const [id, pt] of points) {
    if (pt.fixed || anchored.has(id)) needed.add(id);
  }
  for (const g of geometries.values()) {
    switch (g.type) {
      case 'line': needed.add(g.startId); needed.add(g.endId); break;
      case 'circle': needed.add(g.centerId); break;
      case 'arc': needed.add(g.centerId); needed.add(g.startId); needed.add(g.endId); break;
      // ellipse / spline / point / bezier aren't pushed as planegcs primitives,
      // so their points enter the system only when a constraint references them.
      default: break;
    }
  }
  const addIfPoint = (v: unknown): void => {
    if (typeof v === 'string' && points.has(v as SketchPointId)) needed.add(v as SketchPointId);
  };
  for (const c of constraints.values()) {
    for (const v of Object.values(c as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach(addIfPoint);
      else addIfPoint(v);
    }
  }
  return needed;
}

/**
 * Tolerance the post-solve residual check uses to decide "satisfied
 * enough." Chosen so over-constraint rejection in
 * `applyConstraintPipeline.ts` behaves predictably (pin two endpoints,
 * click horizontal → rejected, not silently accepted with a non-zero
 * residual).
 */
const RESIDUAL_TOL = 1e-3;

/**
 * Evaluate a single constraint's residual against the solved state.
 * Returns the signed residual (interpretation: |residual| > TOL means
 * unsatisfied) or `null` when the constraint kind isn't checked here
 * (planegcs's own conflict detector covers the rest).
 *
 * Uses the residual definitions documented in the TangentConstraint
 * doc. Runs as a second pass after planegcs returns a least-squares
 * solution, since `get_gcs_conflicting_constraints()` doesn't flag
 * "I solved it as best I could but the residual is non-zero" cases.
 */
function evaluateResidual(
  c: SketchConstraint,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
): number | null {
  // V11 · driven dimensions report current value, they don't enforce
  // it. Skip the residual check so a non-zero deviation doesn't trip
  // the post-solve "unsatisfied" set.
  if ((c as { driven?: boolean }).driven === true) return null;
  const pt = (id: SketchPointId): SketchPoint | undefined => points.get(id);
  switch (c.type) {
    case 'horizontal': {
      const g = geometries.get(c.geometryId);
      if (!g || g.type !== 'line') return null;
      const a = pt(g.startId); const b = pt(g.endId);
      if (!a || !b) return null;
      return b.y - a.y;
    }
    case 'vertical': {
      const g = geometries.get(c.geometryId);
      if (!g || g.type !== 'line') return null;
      const a = pt(g.startId); const b = pt(g.endId);
      if (!a || !b) return null;
      return b.x - a.x;
    }
    case 'coincident': {
      const a = pt(c.pointA); const b = pt(c.pointB);
      if (!a || !b) return null;
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    case 'fixed': {
      const p = pt(c.pointId);
      if (!p) return null;
      return Math.hypot(p.x - c.x, p.y - c.y);
    }
    case 'distance': {
      const a = pt(c.pointA); const b = pt(c.pointB);
      if (!a || !b) return null;
      return Math.hypot(b.x - a.x, b.y - a.y) - c.value;
    }
    case 'distanceX': {
      const a = pt(c.pointA); const b = pt(c.pointB);
      if (!a || !b) return null;
      return (b.x - a.x) - c.value;
    }
    case 'distanceY': {
      const a = pt(c.pointA); const b = pt(c.pointB);
      if (!a || !b) return null;
      return (b.y - a.y) - c.value;
    }
    case 'radius': {
      const g = geometries.get(c.geometryId);
      if (!g || (g.type !== 'circle' && g.type !== 'arc')) return null;
      return g.radius - c.value;
    }
    case 'length': {
      const g = geometries.get(c.geometryId);
      if (!g || g.type !== 'line') return null;
      const a = pt(g.startId); const b = pt(g.endId);
      if (!a || !b) return null;
      return Math.hypot(b.x - a.x, b.y - a.y) - c.value;
    }
    case 'parallel': {
      const ga = geometries.get(c.geometryA);
      const gb = geometries.get(c.geometryB);
      if (!ga || !gb || ga.type !== 'line' || gb.type !== 'line') return null;
      const a1 = pt(ga.startId); const a2 = pt(ga.endId);
      const b1 = pt(gb.startId); const b2 = pt(gb.endId);
      if (!a1 || !a2 || !b1 || !b2) return null;
      const ax = a2.x - a1.x, ay = a2.y - a1.y;
      const bx = b2.x - b1.x, by = b2.y - b1.y;
      // Normalise by leg lengths so the threshold is angle-like, not
      // length-scaled. A bare cross product on long lines reads huge
      // even at near-parallel.
      const la = Math.hypot(ax, ay) || 1;
      const lb = Math.hypot(bx, by) || 1;
      return (ax * by - ay * bx) / (la * lb);
    }
    case 'perpendicular': {
      const ga = geometries.get(c.geometryA);
      const gb = geometries.get(c.geometryB);
      if (!ga || !gb || ga.type !== 'line' || gb.type !== 'line') return null;
      const a1 = pt(ga.startId); const a2 = pt(ga.endId);
      const b1 = pt(gb.startId); const b2 = pt(gb.endId);
      if (!a1 || !a2 || !b1 || !b2) return null;
      const ax = a2.x - a1.x, ay = a2.y - a1.y;
      const bx = b2.x - b1.x, by = b2.y - b1.y;
      const la = Math.hypot(ax, ay) || 1;
      const lb = Math.hypot(bx, by) || 1;
      return (ax * bx + ay * by) / (la * lb);
    }
    case 'angle': {
      // Signed CCW angle from line A's direction (start→end) to line B's.
      // Residual = (current_angle − target). Matches `l2l_angle_ll`'s
      // convention in planegcs.
      const ga = geometries.get(c.geometryA);
      const gb = geometries.get(c.geometryB);
      if (!ga || !gb || ga.type !== 'line' || gb.type !== 'line') return null;
      const a1 = pt(ga.startId); const a2 = pt(ga.endId);
      const b1 = pt(gb.startId); const b2 = pt(gb.endId);
      if (!a1 || !a2 || !b1 || !b2) return null;
      const angA = Math.atan2(a2.y - a1.y, a2.x - a1.x);
      const angB = Math.atan2(b2.y - b1.y, b2.x - b1.x);
      // Wrap residual into [-π, π] so the post-solve sanity check
      // doesn't false-positive when angA is near +π and angB is near
      // −π (same geometric angle, different atan2 representation).
      let diff = (angB - angA) - c.value;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      return diff;
    }
    case 'equal': {
      const ga = geometries.get(c.geometryA);
      const gb = geometries.get(c.geometryB);
      if (!ga || !gb) return null;
      const sizeOf = (g: SketchGeometry): number | null => {
        if (g.type === 'line') {
          const a = pt(g.startId); const b = pt(g.endId);
          if (!a || !b) return null;
          return Math.hypot(b.x - a.x, b.y - a.y);
        }
        if (g.type === 'circle' || g.type === 'arc') return g.radius;
        return null;
      };
      const sa = sizeOf(ga); const sb = sizeOf(gb);
      if (sa === null || sb === null) return null;
      return sa - sb;
    }
    case 'pointOnLine': {
      const g = geometries.get(c.geometryId);
      if (!g || g.type !== 'line') return null;
      const a = pt(g.startId); const b = pt(g.endId); const p = pt(c.pointId);
      if (!a || !b || !p) return null;
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      return ((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
    }
    case 'pointOnCircle': {
      const g = geometries.get(c.geometryId);
      if (!g || (g.type !== 'circle' && g.type !== 'arc')) return null;
      const cp = pt(g.centerId); const p = pt(c.pointId);
      if (!cp || !p) return null;
      return Math.hypot(p.x - cp.x, p.y - cp.y) - g.radius;
    }
    case 'symmetric': {
      const g = geometries.get(c.geometryId);
      if (!g || g.type !== 'line') return null;
      const a = pt(g.startId); const b = pt(g.endId);
      const pA = pt(c.pointA); const pB = pt(c.pointB);
      if (!a || !b || !pA || !pB) return null;
      // Two-part residual: midpoint on axis + perpendicular to axis.
      // Sum-of-squares so we get one scalar.
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const mx = (pA.x + pB.x) * 0.5, my = (pA.y + pB.y) * 0.5;
      const midResidual = ((mx - a.x) * dy - (my - a.y) * dx) / L;
      const perpResidual = ((pB.x - pA.x) * dx + (pB.y - pA.y) * dy) / L;
      return Math.hypot(midResidual, perpResidual);
    }
    case 'tangent': {
      const ga = geometries.get(c.circleId);
      if (!ga || (ga.type !== 'circle' && ga.type !== 'arc')) return null;
      const cA = pt(ga.centerId);
      if (!cA) return null;
      if (c.lineId !== undefined && c.secondCircleId === undefined) {
        const gl = geometries.get(c.lineId);
        if (!gl || gl.type !== 'line') return null;
        const a = pt(gl.startId); const b = pt(gl.endId);
        if (!a || !b) return null;
        const dx = b.x - a.x, dy = b.y - a.y;
        const L = Math.hypot(dx, dy) || 1;
        const perpDist = Math.abs((cA.x - a.x) * dy - (cA.y - a.y) * dx) / L;
        return perpDist - ga.radius;
      }
      if (c.secondCircleId !== undefined && c.lineId === undefined) {
        const gb = geometries.get(c.secondCircleId);
        if (!gb || (gb.type !== 'circle' && gb.type !== 'arc')) return null;
        const cB = pt(gb.centerId);
        if (!cB) return null;
        const d = Math.hypot(cB.x - cA.x, cB.y - cA.y);
        return c.internal === true
          ? d - Math.abs(ga.radius - gb.radius)
          : d - (ga.radius + gb.radius);
      }
      return null;
    }
    case 'concentric': {
      const ga = geometries.get(c.geometryA);
      const gb = geometries.get(c.geometryB);
      if (!ga || !gb) return null;
      if (ga.type !== 'circle' && ga.type !== 'arc') return null;
      if (gb.type !== 'circle' && gb.type !== 'arc') return null;
      const cA = pt(ga.centerId); const cB = pt(gb.centerId);
      if (!cA || !cB) return null;
      // Distance between the two centres — zero iff concentric.
      return Math.hypot(cB.x - cA.x, cB.y - cA.y);
    }
    case 'midpoint': {
      const g = geometries.get(c.geometryId);
      if (!g || g.type !== 'line') return null;
      const a = pt(g.startId); const b = pt(g.endId); const p = pt(c.pointId);
      if (!a || !b || !p) return null;
      // |P − (A+B)/2| — zero iff P is exactly the midpoint.
      const mx = (a.x + b.x) * 0.5; const my = (a.y + b.y) * 0.5;
      return Math.hypot(p.x - mx, p.y - my);
    }
  }
}

/** Strip the `c:` prefix off a planegcs constraint id, returning our branded id. */
function unwrapCID(prefixed: string): SketchConstraintId {
  return sketchConstraintId(prefixed.startsWith('c:') ? prefixed.slice(2) : prefixed);
}

export class PlaneGCSSolver implements ISketchSolver {
  readonly kind: SolverKind = 'planegcs';
  private wrapper: GcsWrapper | null = null;
  private nextSynthId = 0;

  get ready(): boolean {
    return this.wrapper !== null;
  }

  attach(wrapper: GcsWrapper): void {
    this.wrapper = wrapper;
  }

  solve(
    points: ReadonlyMap<SketchPointId, SketchPoint>,
    geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
    constraints: ReadonlyMap<SketchConstraintId, SketchConstraint>,
    anchored: ReadonlySet<SketchPointId>,
  ): SolveResult {
    if (!this.wrapper) throw new PlaneGCSNotReadyError();
    const w = this.wrapper;
    w.clear_data();
    this.nextSynthId = 0;

    // Track which constraint IDs we actually pushed (one of ours may produce
    // multiple planegcs constraints; the inverse mapping helps when reading
    // conflicting/redundant ids back).
    const ourIdByPlanegcsId = new Map<string, SketchConstraintId>();

    // ---- 1. Push points ----
    // Only points that participate in the system (see `computeSolverPoints`).
    // Free points — unconstrained spline/bezier control points and the like —
    // are skipped; readback (step 5) passes them through unchanged.
    const solverPoints = computeSolverPoints(points, geometries, constraints, anchored);
    for (const [id, pt] of points) {
      if (!solverPoints.has(id)) continue;
      // planegcs `fixed: true` removes the point's x/y from the param vector,
      // matching the semantics our `anchored` / `fixed` flags have always had.
      const isFixed = pt.fixed || anchored.has(id);
      w.push_primitive({
        type: 'point',
        id: PID(id),
        x: pt.x,
        y: pt.y,
        fixed: isFixed,
      });
    }

    // ---- 2. Push geometry primitives ----
    // Skip kinds planegcs doesn't model natively yet (slot, polygon, spline,
    // standalone point). They still render fine; they just won't take part
    // in constraint solving until we expand them into lines/arcs.
    for (const [gid, g] of geometries) {
      switch (g.type) {
        case 'line':
          w.push_primitive({
            type: 'line',
            id: GID(gid),
            p1_id: PID(g.startId),
            p2_id: PID(g.endId),
          });
          break;
        case 'circle':
          w.push_primitive({
            type: 'circle',
            id: GID(gid),
            c_id: PID(g.centerId),
            radius: g.radius,
          });
          break;
        case 'arc': {
          // planegcs's arc needs explicit start/end angles. Derive from the
          // current point positions; arc_rules enforces |c-s|=|c-e|=radius.
          const c = points.get(g.centerId);
          const s = points.get(g.startId);
          const e = points.get(g.endId);
          if (!c || !s || !e) break;
          const start_angle = Math.atan2(s.y - c.y, s.x - c.x);
          const end_angle = Math.atan2(e.y - c.y, e.x - c.x);
          w.push_primitive({
            type: 'arc',
            id: GID(gid),
            c_id: PID(g.centerId),
            start_id: PID(g.startId),
            end_id: PID(g.endId),
            radius: g.radius,
            start_angle,
            end_angle,
          });
          // Constrain |c-s|=|c-e|=radius so dragging stays consistent.
          w.push_primitive({
            type: 'arc_rules',
            id: `c:__arc_rules_${gid}`,
            a_id: GID(gid),
          });
          break;
        }
        case 'ellipse':
          // planegcs ellipse takes a focus point. Our schema stores the
          // major-axis endpoint instead; for now push the ellipse without
          // the focus binding and skip ellipse-specific constraints. Full
          // support is a follow-up — most constraints (parallel, tangent,
          // etc.) target lines/circles, so the gap is small.
          // TODO: derive focus from center + major endpoint + minor radius.
          break;
        case 'spline':
        case 'bezier':
        case 'point':
          // Not directly representable as a single planegcs primitive;
          // these participate only via their underlying points (constrained
          // ones were pushed in step 1; free control poles are intentionally
          // omitted by `computeSolverPoints`). Modelling a bezier as a real
          // planegcs B-spline (control poles + internal alignment, enabling
          // tangent-to-curve / point-on-curve) is a separate project — the
          // JS wrapper we use doesn't expose B-splines yet. There are no
          // `slot` / `polygon` editor geometries; their tools decompose at
          // draw time so the solver sees the constituent lines + arcs.
          break;
      }
    }

    // ---- 3. Push constraints ----
    //
    // No hidden radius preservation: faking it as a hard `circle_radius`
    // constraint here would make the radius field act like an invisible
    // constraint — user can't see it, can't remove it, and it'd block
    // auto-resize. Treat radius as fully free and let an explicit
    // `radius` constraint pin it when the user wants that.
    for (const [cid, c] of constraints) {
      const pushed = this.translateConstraint(w, c, cid, geometries);
      for (const pid of pushed) ourIdByPlanegcsId.set(pid, cid);
    }

    // ---- 4. Solve ----
    const status = w.solve(Algorithm.DogLeg);
    const converged = status === SolveStatus.Success || status === SolveStatus.Converged;

    const unsatisfied = new Set<SketchConstraintId>();
    if (converged) {
      w.apply_solution();
      // Conflicting = constraints planegcs proved unsatisfiable.
      // Redundant = consistent but provides no new info — NOT a failure.
      for (const pid of w.get_gcs_conflicting_constraints()) {
        const ourId = ourIdByPlanegcsId.get(pid) ?? unwrapCID(pid);
        // Filter synthetic ids (arc_rules, etc.) so user-facing diagnostics
        // only mention user constraints.
        if (!String(ourId).startsWith('__')) unsatisfied.add(ourId);
      }
    } else {
      // Failed to converge — treat every user constraint as unsatisfied so
      // the store rolls back the offending add cleanly.
      for (const id of constraints.keys()) unsatisfied.add(id);
    }

    // ---- 5. Read back updated points + geometries ----
    const outPoints = new Map<SketchPointId, SketchPoint>();
    for (const [id, pt] of points) {
      const updated = w.sketch_index.get_primitive(PID(id));
      if (updated && updated.type === 'point') {
        outPoints.set(id, { ...pt, x: updated.x, y: updated.y });
      } else {
        outPoints.set(id, { ...pt });
      }
    }

    // Geometry params (radius, etc.) — only circle radius is currently free
    // in our schema. Return the input map by reference when nothing changed
    // so React's identity check skips a re-render.
    let geomChanged = false;
    const outGeoms = new Map<SketchGeometryId, SketchGeometry>(geometries);
    for (const [gid, g] of geometries) {
      if (g.type !== 'circle') continue;
      const updated = w.sketch_index.get_primitive(GID(gid));
      if (updated && updated.type === 'circle') {
        const newR = Math.max(1e-4, updated.radius);
        if (Math.abs(newR - g.radius) > 1e-9) {
          outGeoms.set(gid, { ...g, radius: newR });
          geomChanged = true;
        }
      }
    }

    // ---- 6. Post-solve residual sanity check ----
    //
    // planegcs's `get_gcs_conflicting_constraints()` returns only what the
    // solver marks as algebraically conflicting; it does NOT include
    // constraints that converged in least-squares with a non-zero
    // residual. Example: pin two line endpoints with `fixed`, then add
    // `horizontal` — the solver returns Success because it found a
    // least-squares minimum, but the
    // horizontal residual is still |Δy| > 0. Without this check the
    // pipeline would treat that as 'applied' and the constraint would
    // silently land with no visible effect.
    //
    // Re-evaluate each user constraint against the solved state and add
    // any whose residual exceeds RESIDUAL_TOL to `unsatisfied`, so the
    // checkAddFailure path in applyConstraintPipeline keeps rejecting
    // over-constrained adds.
    for (const [cid, c] of constraints) {
      if (unsatisfied.has(cid)) continue;
      const r = evaluateResidual(c, outPoints, outGeoms);
      if (r === null) continue;
      if (Math.abs(r) > RESIDUAL_TOL) unsatisfied.add(cid);
    }

    // DOF readout — `GcsSystem.dof()` returns the number of remaining
    // free parameters after `solve_system()`. Zero = fully defined (every
    // free coordinate / radius pinned by some constraint). Defensive `??`
    // for the unlikely path where the underlying solver returns a
    // non-number (e.g. WASM in a partial-failure state mid-rebuild).
    const dofRaw = (w as unknown as { gcs?: { dof?: () => number } }).gcs?.dof?.();
    const dof = typeof dofRaw === 'number' && Number.isFinite(dofRaw) ? Math.max(0, dofRaw) : undefined;

    return {
      points: outPoints,
      geometries: geomChanged ? outGeoms : (geometries as Map<SketchGeometryId, SketchGeometry>),
      diagnostic: {
        converged: converged && unsatisfied.size === 0,
        finalCost: 0, // planegcs doesn't expose residual cost; bus-level rollback uses `unsatisfied` instead
        unsatisfied,
        ...(dof !== undefined ? { dof } : {}),
      },
    };
  }

  /**
   * Push the planegcs constraint(s) for one of our SketchConstraints.
   * Returns the planegcs ids of every pushed constraint so the caller can
   * map conflicting-ids back to our id space.
   *
   * One of our constraints may produce multiple planegcs constraints — e.g.
   * `coincident` collapses to two `equal` constraints (one per axis). This
   * matters because get_gcs_conflicting_constraints returns the planegcs
   * ids, not ours.
   */
  private translateConstraint(
    w: GcsWrapper,
    c: SketchConstraint,
    cid: SketchConstraintId,
    geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
  ): string[] {
    const out: string[] = [];
    const synth = (): string => `c:${cid}__${this.nextSynthId++}`;

    const push = (prim: SketchPrimitive): void => {
      w.push_primitive(prim);
      out.push(prim.id);
    };

    switch (c.type) {
      case 'horizontal':
        push({ type: 'horizontal_l', id: CID(cid), l_id: GID(c.geometryId) });
        break;
      case 'vertical':
        push({ type: 'vertical_l', id: CID(cid), l_id: GID(c.geometryId) });
        break;
      case 'coincident':
        // planegcs has no single "two points coincide" — emit one `equal`
        // per axis. Both use synthetic ids so neither overwrites the other.
        push({
          type: 'equal',
          id: synth(),
          param1: { o_id: PID(c.pointA), prop: 'x' },
          param2: { o_id: PID(c.pointB), prop: 'x' },
        });
        push({
          type: 'equal',
          id: synth(),
          param1: { o_id: PID(c.pointA), prop: 'y' },
          param2: { o_id: PID(c.pointB), prop: 'y' },
        });
        break;
      case 'fixed':
        // Already enforced via the point's `fixed: true` flag in step 1.
        // Emit nothing — planegcs's coordinate_x/coordinate_y on a fixed
        // point would be a redundant constraint, not a no-op.
        break;
      case 'distance':
        push({
          type: 'p2p_distance',
          id: CID(cid),
          p1_id: PID(c.pointA),
          p2_id: PID(c.pointB),
          distance: c.value,
          // V11 · driving:false makes planegcs report the current value
          // instead of enforcing it. The wrapper still registers the
          // parameter so pull_constraint can read it post-solve.
          driving: !c.driven,
        });
        break;
      case 'distanceX':
        // Signed Δx = (pB.x − pA.x) = value. planegcs `difference`
        // residual is `param2 − param1 − difference`, so for
        // B.x − A.x = value we set param1 = A.x, param2 = B.x,
        // difference = value. This
        // preserves the sign of the constraint — earlier code emitted
        // `p2p_distance` with `Math.abs(value)` which lost direction
        // and let the solver flip orientation on resolve.
        push({
          type: 'difference',
          id: CID(cid),
          param1: { o_id: PID(c.pointA), prop: 'x' },
          param2: { o_id: PID(c.pointB), prop: 'x' },
          difference: c.value,
          driving: !c.driven,
        });
        break;
      case 'distanceY':
        push({
          type: 'difference',
          id: CID(cid),
          param1: { o_id: PID(c.pointA), prop: 'y' },
          param2: { o_id: PID(c.pointB), prop: 'y' },
          difference: c.value,
          driving: !c.driven,
        });
        break;
      case 'length': {
        // Length on a line = distance between its endpoints.
        const line = geometries.get(c.geometryId);
        if (!line || line.type !== 'line') break;
        push({
          type: 'p2p_distance',
          id: CID(cid),
          p1_id: PID(line.startId),
          p2_id: PID(line.endId),
          distance: c.value,
          driving: !c.driven,
        });
        break;
      }
      case 'radius': {
        // Works for both circles and arcs; planegcs has dedicated ops.
        const g = geometries.get(c.geometryId);
        if (!g) break;
        if (g.type === 'circle') {
          push({ type: 'circle_radius', id: CID(cid), c_id: GID(c.geometryId), radius: c.value, driving: !c.driven });
        } else if (g.type === 'arc') {
          push({ type: 'arc_radius', id: CID(cid), a_id: GID(c.geometryId), radius: c.value, driving: !c.driven });
        }
        break;
      }
      case 'parallel':
        push({
          type: 'parallel',
          id: CID(cid),
          l1_id: GID(c.geometryA),
          l2_id: GID(c.geometryB),
        });
        break;
      case 'perpendicular':
        push({
          type: 'perpendicular_ll',
          id: CID(cid),
          l1_id: GID(c.geometryA),
          l2_id: GID(c.geometryB),
        });
        break;
      case 'angle': {
        // planegcs has `l2l_angle_ll` (line-to-line by geometry id,
        // signed CCW angle parameter). Same direction convention as
        // ours: angle measured from line A's direction (start→end) to
        // line B's. No helper point needed — earlier comment about
        // requiring `angle_via_point` + a virtual intersection was
        // wrong; that variant is for curve-curve angles where the
        // tangent at a specific point is what's constrained.
        const ga = geometries.get(c.geometryA);
        const gb = geometries.get(c.geometryB);
        if (!ga || !gb) break;
        if (ga.type !== 'line' || gb.type !== 'line') break;
        push({
          type: 'l2l_angle_ll',
          id: CID(cid),
          l1_id: GID(c.geometryA),
          l2_id: GID(c.geometryB),
          angle: c.value,
          driving: !c.driven,
        });
        break;
      }
      case 'tangent':
        if (c.lineId !== undefined && c.secondCircleId === undefined) {
          // Line-circle: no inside/outside distinction — a straight line
          // either touches the disk boundary or not. `internal` is
          // meaningless here and the type doc says so.
          push({
            type: 'tangent_lc',
            id: CID(cid),
            l_id: GID(c.lineId),
            c_id: GID(c.circleId),
          });
        } else if (c.secondCircleId !== undefined && c.lineId === undefined) {
          if (c.internal === true) {
            // Internal tangent — use planegcs's lower-level
            // `tangent_circumf` primitive which exposes the
            // `internal: boolean` flag. The high-level `tangent_cc`
            // convenience wrapper hardcodes external. Need
            // explicit center-points + radii because tangent_circumf
            // works at the parameter level, not the shape level.
            const gA = geometries.get(c.circleId);
            const gB = geometries.get(c.secondCircleId);
            if ((gA?.type === 'circle' || gA?.type === 'arc') &&
                (gB?.type === 'circle' || gB?.type === 'arc')) {
              push({
                type: 'tangent_circumf',
                id: CID(cid),
                p1_id: PID(gA.centerId),
                p2_id: PID(gB.centerId),
                rd1: gA.radius,
                rd2: gB.radius,
                internal: true,
              });
            }
          } else {
            push({
              type: 'tangent_cc',
              id: CID(cid),
              c1_id: GID(c.circleId),
              c2_id: GID(c.secondCircleId),
            });
          }
        }
        break;
      case 'pointOnLine':
        push({
          type: 'point_on_line_pl',
          id: CID(cid),
          p_id: PID(c.pointId),
          l_id: GID(c.geometryId),
        });
        break;
      case 'pointOnCircle':
        push({
          type: 'point_on_circle',
          id: CID(cid),
          p_id: PID(c.pointId),
          c_id: GID(c.geometryId),
        });
        break;
      case 'symmetric': {
        // "pA and pB are mirror images across axis line (Ls→Le)"
        // decomposes cleanly into two planegcs constraints, both
        // shipping in the *_pppp (point-point-point-point) family:
        //
        //   1. midpoint_on_line_pppp(pA, pB, Ls, Le) — the midpoint of
        //      segment (pA, pB) sits on the axis line.
        //   2. perpendicular_pppp(pA, pB, Ls, Le) — segment (pA, pB)
        //      is perpendicular to the axis line.
        //
        // Together those pin pA and pB into a mirror-image relationship
        // across the axis. The earlier TODO was right about the shape
        // of the decomposition — just never landed because we hadn't
        // confirmed planegcs ships both _pppp primitives. It does.
        //
        // Both constraints share `CID(cid)` so the unsatisfied-set
        // logic treats them as one user-facing constraint.
        const g = geometries.get(c.geometryId);
        if (!g || g.type !== 'line') break;
        // First push uses CID(cid) so the unsatisfied-set logic
        // can attribute either primitive's failure to the user's
        // symmetric constraint; the second uses `synth()` to give
        // planegcs a distinct internal id (`push_primitive` rejects
        // duplicates). `unwrapCID` strips the synth suffix when
        // reading conflicts back out.
        push({
          type: 'midpoint_on_line_pppp',
          id: CID(cid),
          l1p1_id: PID(c.pointA),
          l1p2_id: PID(c.pointB),
          l2p1_id: PID(g.startId),
          l2p2_id: PID(g.endId),
        });
        push({
          type: 'perpendicular_pppp',
          id: synth(),
          l1p1_id: PID(c.pointA),
          l1p2_id: PID(c.pointB),
          l2p1_id: PID(g.startId),
          l2p2_id: PID(g.endId),
        });
        break;
      }
      case 'equal': {
        // Pick the planegcs constraint that matches the entity pair:
        //   line ↔ line   → equal_length
        //   circle ↔ circle → equal_radius_cc
        //   circle ↔ arc   → equal_radius_ca (planegcs requires c first)
        //   arc ↔ circle   → equal_radius_ca (swap order)
        //   arc ↔ arc      → equal_radius_aa
        const ga = geometries.get(c.geometryA);
        const gb = geometries.get(c.geometryB);
        if (!ga || !gb) break;
        if (ga.type === 'line' && gb.type === 'line') {
          push({ type: 'equal_length', id: CID(cid), l1_id: GID(c.geometryA), l2_id: GID(c.geometryB) });
          break;
        }
        if (ga.type === 'circle' && gb.type === 'circle') {
          push({ type: 'equal_radius_cc', id: CID(cid), c1_id: GID(c.geometryA), c2_id: GID(c.geometryB) });
          break;
        }
        if (ga.type === 'arc' && gb.type === 'arc') {
          push({ type: 'equal_radius_aa', id: CID(cid), a1_id: GID(c.geometryA), a2_id: GID(c.geometryB) });
          break;
        }
        if (ga.type === 'circle' && gb.type === 'arc') {
          push({ type: 'equal_radius_ca', id: CID(cid), c1_id: GID(c.geometryA), a2_id: GID(c.geometryB) });
          break;
        }
        if (ga.type === 'arc' && gb.type === 'circle') {
          push({ type: 'equal_radius_ca', id: CID(cid), c1_id: GID(c.geometryB), a2_id: GID(c.geometryA) });
          break;
        }
        // Mixed kind (line ↔ circle) is rejected at the dispatcher; if
        // it sneaks in, emit nothing so the constraint becomes a no-op
        // that the store can roll back.
        break;
      }
      case 'concentric': {
        // planegcs has no `concentric` primitive — the natural
        // equivalent is `p2p_coincident` on the two circles' centre
        // points. Our point-graph already treats centres as
        // first-class `SketchPointId`s, so this collapses to a single
        // planegcs constraint. Skips silently if either geometry
        // isn't a circle/arc (dispatcher should have rejected, but
        // be conservative).
        const ga = geometries.get(c.geometryA);
        const gb = geometries.get(c.geometryB);
        if (!ga || !gb) break;
        if (ga.type !== 'circle' && ga.type !== 'arc') break;
        if (gb.type !== 'circle' && gb.type !== 'arc') break;
        push({
          type: 'p2p_coincident',
          id: CID(cid),
          p1_id: PID(ga.centerId),
          p2_id: PID(gb.centerId),
        });
        break;
      }
      case 'midpoint': {
        // "P at midpoint of AB" maps cleanly onto planegcs's
        // `p2p_symmetric_ppp(A, B, P)` — "A and B are symmetric about
        // P" is the same geometric statement. Single primitive,
        // no helper points.
        const g = geometries.get(c.geometryId);
        if (!g || g.type !== 'line') break;
        push({
          type: 'p2p_symmetric_ppp',
          id: CID(cid),
          p1_id: PID(g.startId),
          p2_id: PID(g.endId),
          p_id: PID(c.pointId),
        });
        break;
      }
    }
    return out;
  }
}


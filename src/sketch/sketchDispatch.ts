/**
 * Sketch dispatch helpers — thin wrappers that route UI tool actions
 * through the CadCommand bus instead of mutating SketchEditorStore directly.
 *
 * **Why this file exists.** If the in-app sketch tools
 * (`sketchTools.ts`, `sketchToolsExt.ts`, `sketchConstraints.ts`,
 * `DimensionsOverlay.tsx`) called `store.addPoint` / `store.addGeometry`
 * / `store.addConstraint` directly, the undo manager would only see the
 * coarse "create sketch" / "finish sketch" envelope, so an undo inside a
 * sketch couldn't unwind individual draws or constraints.
 *
 * Routing every tool action through `bus.dispatch` puts each mutation
 * on the undo stack as its own entry, AND makes the UI path
 * structurally identical to the MCP client path — same handlers, same
 * primitives, same conflict rejection. Hydration back into the
 * editor store happens through the document → editor subscriber
 * (in [SketchEditor.tsx](./SketchEditor.tsx)).
 *
 * **What the helpers do.** Each `dispatch*` function:
 *
 *   1. Resolves the active sketch id from the global `sketchStore`
 *      (set by `enterSketch` / `exitSketch` in Shell). Bails out with a
 *      console warning if no sketch is open — that's a programmer error
 *      (the tool shouldn't be invocable outside a sketch).
 *   2. Builds the corresponding `Sketch...` command and dispatches it.
 *   3. For `SketchApplyConstraint`, inspects the result and surfaces
 *      `CONSTRAINT_REJECTED` as a toast (same UX the old store-side
 *      addConstraint had — kept here so every UI entry-point shares
 *      one rejection path).
 *
 * **What they don't do.** No direct store mutation. No solver. No
 * id allocation. All of that lives in the core handler / pipeline and
 * is reflected back into the editor store by the hydration subscriber.
 *
 * Mid-drag transient mutations (rubber-band previews, live drag
 * coordinates) still use `store.setPreview` / `store.movePoint`
 * directly — they're per-frame UI state, not persisted, and adding
 * them to undo would be useless noise. Only the **drag-end** commits
 * dispatch through the bus.
 */

import { getAppState } from '../appInit.ts';
import { enqueueToast } from '../components/toastStore.ts';
import { consoleLog } from '@tweakcad/core/src/store/consoleStore.ts';
import type { CadCommand } from '@tweakcad/core/src/commands/types.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';
import type { DxfPrimitive } from '@tweakcad/core/src/sketch/io/dxfImport.ts';
import type {
  SketchConstraintInput,
  SketchGeometryId,
  SketchPointId,
} from '@tweakcad/core/src/sketch/types.ts';

// ---- Resolver ------------------------------------------------------------

/**
 * Resolve the active sketch id. Returns null + warns if none — every
 * dispatch helper checks this so the tools fail loudly if invoked outside
 * a sketch (which would mean the UI bound a tool handler in the wrong
 * mode and we should fix the binding, not silently no-op).
 */
function activeSketchId(): FeatureId | null {
  const id = getAppState().sketchStore.getState().activeSketchId;
  if (!id) {
    consoleLog('warn', 'sketch dispatch invoked with no active sketch', 'sketch');
    return null;
  }
  return id;
}

/** Tiny helper to forward to bus.dispatch with active sketch resolution. */
function dispatchInSketch(
  build: (sketchId: FeatureId) => CadCommand,
): { ok: true } | { ok: false; reason: string } {
  const sketchId = activeSketchId();
  if (!sketchId) return { ok: false, reason: 'no active sketch' };
  const result = getAppState().commandBus.dispatch(build(sketchId));
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.error.message };
}

// ---- Draw helpers --------------------------------------------------------

export function dispatchDrawLine(
  from: [number, number],
  to: [number, number],
  construction: boolean,
  chainFrom?: SketchPointId,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawLine',
    sketchId,
    from,
    to,
    construction,
    ...(chainFrom !== undefined ? { chainFrom } : {}),
  })).ok;
}

export function dispatchDrawRectangle(
  corner: [number, number],
  width: number,
  height: number,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawRectangle',
    sketchId,
    corner,
    width,
    height,
    construction,
  })).ok;
}

export function dispatchDrawCircle(
  center: [number, number],
  radius: number,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawCircle',
    sketchId,
    center,
    radius,
    construction,
  })).ok;
}

export function dispatchDrawArcCenter(
  center: [number, number],
  radius: number,
  startAngle: number,
  endAngle: number,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawArc',
    sketchId,
    center,
    radius,
    startAngle,
    endAngle,
    construction,
  })).ok;
}

export function dispatchDrawArc3Point(
  start: [number, number],
  mid: [number, number],
  end: [number, number],
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawArc3Point',
    sketchId,
    start,
    mid,
    end,
    construction,
  })).ok;
}

export function dispatchDrawPolygon(
  center: [number, number],
  vertex: [number, number],
  sides: number,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawPolygon',
    sketchId,
    center,
    vertex,
    sides,
    construction,
  })).ok;
}

export function dispatchDrawSlot(
  center1: [number, number],
  center2: [number, number],
  width: number,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawSlot',
    sketchId,
    center1,
    center2,
    width,
    construction,
  })).ok;
}

export function dispatchDrawEllipse(
  center: [number, number],
  major: [number, number],
  minorRadius: number,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawEllipse',
    sketchId,
    center,
    major,
    minorRadius,
    construction,
  })).ok;
}

export function dispatchDrawSpline(
  points: ReadonlyArray<[number, number]>,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawSpline',
    sketchId,
    points,
    construction,
  })).ok;
}

/** Insert ready-made primitives (e.g. text outlines) as one undo entry. */
export function dispatchInsertPrimitives(
  primitives: ReadonlyArray<DxfPrimitive>,
  label?: string,
): boolean {
  const r = dispatchInSketch((sketchId) => ({
    type: 'SketchInsertPrimitives',
    sketchId,
    primitives,
    ...(label !== undefined ? { label } : {}),
  }));
  if (!r.ok) enqueueToast({ tone: 'warning', title: 'Insert failed', message: r.reason });
  return r.ok;
}

export function dispatchDrawPoint(
  at: [number, number],
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchDrawPoint',
    sketchId,
    at,
    construction,
  })).ok;
}

// ---- Move helper ---------------------------------------------------------

/**
 * Dispatch a `SketchMovePoint` for the drag-end commit. Called once per
 * moved point. To group multiple moves (e.g. a geometry-level drag where
 * an entire shape's points shift together) into ONE undo step, callers
 * wrap a batch in `bus.beginTransaction` / `endTransaction` —
 * {@link dispatchMovePointsBatch} does exactly that.
 */
export function dispatchMovePoint(
  pointId: SketchPointId,
  to: [number, number],
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchMovePoint',
    sketchId,
    pointId,
    to,
  })).ok;
}

/**
 * Batch drag-end commit. Dispatches one `SketchMovePointsBatch` which:
 *   - applies every move atomically (one Immer patch set),
 *   - runs the solver ONCE with the moved set anchored so constraint
 *     neighbours (coincident-linked rectangle corners, etc.) adjust to
 *     keep the sketch consistent without overriding the drag,
 *   - lands as ONE undo entry.
 *
 * Used for both single-point and geometry-level drag-end. Empty `moves`
 * is a no-op (no undo entry written — see `documentStore.mutate` empty-
 * patch skip). Returns `true` on success.
 */
export function dispatchMovePointsBatch(
  moves: ReadonlyArray<{ pointId: SketchPointId; to: [number, number] }>,
): boolean {
  if (moves.length === 0) return true;
  return dispatchInSketch((sketchId) => ({
    type: 'SketchMovePointsBatch',
    sketchId,
    moves,
  })).ok;
}

/**
 * Dispatch a `SketchSetRadius` — the commit half of a circumference drag.
 *
 * Radius isn't a point, so this can't ride on `dispatchMovePointsBatch` the
 * way every other drag does.
 */
export function dispatchSetRadius(
  geometryId: SketchGeometryId,
  radius: number,
): boolean {
  if (!Number.isFinite(radius) || radius <= 0) return false;
  return dispatchInSketch((sketchId) => ({
    type: 'SketchSetRadius',
    sketchId,
    geometryId,
    radius,
  })).ok;
}

// ---- Constraint helper ---------------------------------------------------

/**
 * Dispatch a `SketchApplyConstraint`. On `CONSTRAINT_REJECTED` we emit
 * the same toast + console.error the legacy `SketchEditorStore.addConstraint`
 * used to fire (kept here so every UI entry-point — ribbon, drawing
 * tool snap, dimension popup — gets identical UX without per-site wiring).
 *
 * Returns `{ ok: true }` on accept (including silent dedupe no-op),
 * `{ ok: false, reason }` on rejection so callers like the ribbon
 * dispatcher can count committed vs conflicted.
 */
export function dispatchApplyConstraint(
  constraint: SketchConstraintInput,
): { ok: true } | { ok: false; reason: string } {
  const sketchId = activeSketchId();
  if (!sketchId) return { ok: false, reason: 'no active sketch' };
  const result = getAppState().commandBus.dispatch({
    type: 'SketchApplyConstraint',
    sketchId,
    constraint,
  });
  if (result.ok) return { ok: true };
  if (result.error.code === 'CONSTRAINT_REJECTED') {
    const msg = result.error.message;
    consoleLog('error', msg, 'sketch');
    enqueueToast({ tone: 'warning', title: 'Constraint not applied', message: msg });
  } else {
    consoleLog('error', `apply ${constraint.type}: ${result.error.message}`, 'sketch');
  }
  return { ok: false, reason: result.error.message };
}

/**
 * Dispatch a `SketchRemoveConstraint`. Used by the sketch browser's
 * delete button.
 */
export function dispatchRemoveConstraint(
  constraintId: string,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchRemoveConstraint',
    sketchId,
    constraintId: constraintId as never,
  })).ok;
}

/**
 * Dispatch a `RemoveSketchEntity` so the deletion reaches the document
 * (not just the editor store). Without this, browser-side
 * `removeGeometry` would mutate the editor only; the next bus
 * dispatch (e.g. drawing a new circle) would trigger the hydration
 * subscriber to re-sync the editor from the doc, restoring the
 * "deleted" geometry. Same wiring rule as `dispatchRemoveConstraint`.
 *
 * Entity id is the geometry id — `editorModelToBuildGeometry` emits one
 * entity per geometry with matching ids.
 */
export function dispatchRemoveSketchEntity(
  geometryId: string,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'RemoveSketchEntity',
    sketchId,
    entityId: geometryId as never,
  })).ok;
}

/**
 * Toggle a geometry between construction and real.
 *
 * Through the bus, not the editor store: construction lives in
 * `editorModel`, and writing `state.geometries` directly never persisted it.
 */
export function dispatchSetConstruction(
  geometryId: string,
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchSetConstruction',
    sketchId,
    geometryId: geometryId as never,
    construction,
  })).ok;
}

// ---- Modify-tool helpers -------------------------------------------------
//
// The UI tool sessions collect screen clicks (sketchToolsExt.ts) then
// commit through one of these helpers. Each lands one undo entry — the
// modify primitive in core does the splitting / mirroring / etc.
// atomically. Hydration rebuilds the editor store from
// the post-dispatch editorModel, including any GC'd orphan points and
// the constraints cascaded with the geometry a trim removed.

/** Trim the picked geometry at the cursor location. */
export function dispatchTrim(
  geometryId: SketchGeometryId,
  cursor: [number, number],
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchTrim',
    sketchId,
    geometryId,
    cursor,
  })).ok;
}

/** Extend the picked line to the nearest other line's infinite extension. */
export function dispatchExtend(
  geometryId: SketchGeometryId,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchExtend',
    sketchId,
    geometryId,
  })).ok;
}

/** Fillet the corner where two lines meet at a shared endpoint. */
export function dispatchFillet(
  geometryAId: SketchGeometryId,
  geometryBId: SketchGeometryId,
  radius?: number,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchFillet',
    sketchId,
    geometryAId,
    geometryBId,
    ...(radius !== undefined ? { radius } : {}),
  })).ok;
}

/** Offset a line or circle by `distance` mm on the side the cursor sits. */
export function dispatchOffset(
  geometryId: SketchGeometryId,
  distance: number,
  cursor: [number, number],
  construction: boolean,
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchOffset',
    sketchId,
    geometryId,
    distance,
    cursor,
    construction,
  })).ok;
}

/** Mirror the listed geometries across the line defined by two axis points. */
export function dispatchMirror(
  geometryIds: ReadonlyArray<SketchGeometryId>,
  axisA: [number, number],
  axisB: [number, number],
): boolean {
  return dispatchInSketch((sketchId) => ({
    type: 'SketchMirror',
    sketchId,
    geometryIds,
    axisA,
    axisB,
  })).ok;
}

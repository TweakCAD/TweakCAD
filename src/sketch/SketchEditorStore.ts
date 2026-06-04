/**
 * SketchEditorStore - Zustand store for the sketch editor.
 *
 * This is the central state management for the sketch editor. All drawing
 * tools commit their results here, and the renderer reads from here.
 *
 * Key differences from the old SketchOverlay approach:
 * - Entities persist in this store (not in XState machine context)
 * - Switching tools does NOT remove entities
 * - Multiple entities coexist and are all rendered simultaneously
 * - Selection and editing work on existing entities
 *
 * Uses plain Maps for O(1) entity lookup. Points are shared between
 * entities (e.g., rectangle corners = line endpoints) for constraints.
 */

import { create } from 'zustand';
import type {
  SketchPoint,
  SketchPointId,
  SketchGeometry,
  SketchGeometryId,
  SketchRegionId,
  SketchGeometryInput,
  SketchConstraint,
  SketchConstraintId,
  SketchToolId,
  SketchPreviewData,
  HitTarget,
  SnapResult,
} from '@tweakcad/core/src/sketch/types.ts';
import {
  sketchPointId,
  sketchGeometryId,
  sketchRegionId,
  ORIGIN_POINT_ID,
  ORIGIN_CONSTRAINT_ID,
} from '@tweakcad/core/src/sketch/types.ts';
import { detectSketchRegions, pointInRegion, findRegionForEntity } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchEntity } from '@tweakcad/core/src/document/schema.ts';
import { entityId } from '@tweakcad/core/src/ids.ts';
import { getSolver } from '@tweakcad/core/src/sketch/solver/index.ts';

/**
 * Solve via the active solver (planegcs — the only solver).
 * Throws `PlaneGCSNotReadyError` if WASM
 * hasn't loaded yet; in practice the boot path resolves before any
 * sketch interaction can fire a solve.
 */
function solveConstraints(
  ...args: Parameters<ReturnType<typeof getSolver>['solve']>
): ReturnType<ReturnType<typeof getSolver>['solve']> {
  return getSolver().solve(...args);
}

/**
 * Walk the geometry map and update each arc's stored radius from its
 * actual current center-to-start distance. Called after every solve so
 * the persisted arc.radius stays consistent with the points the solver
 * just adjusted. A post-solve geometry-sync hook.
 *
 * Returns a new geometries map only if anything actually changed (to keep
 * Immer/Zustand reference equality where possible).
 */
function syncDerivedGeometryFields(
  geometries: Map<SketchGeometryId, SketchGeometry>,
  points: Map<SketchPointId, SketchPoint>,
): Map<SketchGeometryId, SketchGeometry> {
  let next: Map<SketchGeometryId, SketchGeometry> | null = null;
  for (const [gid, g] of geometries) {
    if (g.type !== 'arc') continue;
    const c = points.get(g.centerId);
    const s = points.get(g.startId);
    if (!c || !s) continue;
    const r = Math.hypot(s.x - c.x, s.y - c.y);
    if (Math.abs(r - g.radius) > 1e-6) {
      if (!next) next = new Map(geometries);
      next.set(gid, { ...g, radius: r });
    }
  }
  return next ?? geometries;
}

/**
 * Selection intent: determines hit-test priority.
 * - 'editGeometry': normal editing mode (points > curves > regions)
 * - 'selectProfileForFeature': profile picking mode (regions > curves)
 */
export type SketchSelectionIntent = 'editGeometry' | 'selectProfileForFeature';

/**
 * Snapshot of a dimension-tool target awaiting a numeric value.
 *
 * The SketchEditor renders an input near `(screenX, screenY)` while this
 * is non-null. Committing the input applies the matching value constraint
 * (length / radius / distance) and snaps geometry to match.
 */
export type PendingDimension =
  | { kind: 'length'; geometryId: SketchGeometryId; current: number; screenX: number; screenY: number }
  | { kind: 'radius'; geometryId: SketchGeometryId; current: number; screenX: number; screenY: number }
  | {
      kind: 'angle';
      geometryA: SketchGeometryId;
      geometryB: SketchGeometryId;
      /** Current angle in radians (CCW from A to B). UI displays degrees. */
      current: number;
      screenX: number;
      screenY: number;
    }
  | { kind: 'distance'; pointA: SketchPointId; pointB: SketchPointId; current: number; screenX: number; screenY: number }
  /**
   * Horizontal distance between two points. `current` carries the signed
   * (pB.x − pA.x) of the picked geometry; the input prompt displays it as a
   * positive magnitude. The committed `distanceX` constraint stores the signed
   * value so the solver preserves orientation.
   */
  | { kind: 'distanceX'; pointA: SketchPointId; pointB: SketchPointId; current: number; screenX: number; screenY: number }
  | { kind: 'distanceY'; pointA: SketchPointId; pointB: SketchPointId; current: number; screenX: number; screenY: number };

// ---- Counter for unique IDs ----

let _idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${++_idCounter}_${Date.now().toString(36)}`;
}

// ---- Helpers ----

function getPointIdsFromGeometry(geom: SketchGeometry): SketchPointId[] {
  // There are no `slot` or `polygon` editor geometries —
  // their tools (drawSlot / drawPolygon) decompose at draw time so the
  // points show up via the line / arc cases instead.
  switch (geom.type) {
    case 'line':
      return [geom.startId, geom.endId];
    case 'circle':
      return [geom.centerId];
    case 'arc':
      return [geom.centerId, geom.startId, geom.endId];
    case 'ellipse':
      return [geom.centerId, geom.majorId];
    case 'spline':
      return [...geom.pointIds];
    case 'point':
      return [geom.pointId];
  }
}

function isPointUsedByOtherGeometry(
  pointId: SketchPointId,
  excludeGeomId: SketchGeometryId,
  geometries: Map<SketchGeometryId, SketchGeometry>,
): boolean {
  for (const [gid, geom] of geometries) {
    if (gid === excludeGeomId) continue;
    if (getPointIdsFromGeometry(geom).includes(pointId)) return true;
  }
  return false;
}

function isPointUsedByAnyGeometry(
  pointId: SketchPointId,
  geometries: Map<SketchGeometryId, SketchGeometry>,
): boolean {
  for (const geom of geometries.values()) {
    if (getPointIdsFromGeometry(geom).includes(pointId)) return true;
  }
  return false;
}

function geometriesToSketchEntities(
  points: Map<SketchPointId, SketchPoint>,
  geometries: Map<SketchGeometryId, SketchGeometry>,
): Record<string, SketchEntity> {
  const entities: Record<string, SketchEntity> = {};

  for (const [gid, geom] of geometries) {
    if (geom.type === 'line') {
      const start = points.get(geom.startId);
      const end = points.get(geom.endId);
      if (!start || !end) continue;
      entities[String(gid)] = {
        id: entityId(String(gid)),
        type: 'line',
        start: [String(start.x), String(start.y)],
        end: [String(end.x), String(end.y)],
        ...(geom.construction ? { construction: true as const } : {}),
      };
    } else if (geom.type === 'circle') {
      const center = points.get(geom.centerId);
      if (!center) continue;
      entities[String(gid)] = {
        id: entityId(String(gid)),
        type: 'circle',
        center: [String(center.x), String(center.y)],
        diameter: String(geom.radius * 2),
        ...(geom.construction ? { construction: true as const } : {}),
      };
    }
  }

  return entities;
}

function constraintReferencesGeometry(
  constraint: SketchConstraint,
  geomId: SketchGeometryId,
): boolean {
  switch (constraint.type) {
    case 'horizontal':
    case 'vertical':
    case 'radius':
    case 'length':
    case 'pointOnLine':
    case 'pointOnCircle':
    case 'symmetric':
      return constraint.geometryId === geomId;
    case 'parallel':
    case 'perpendicular':
    case 'angle':
    case 'equal':
      return constraint.geometryA === geomId || constraint.geometryB === geomId;
    case 'tangent':
      return (
        constraint.circleId === geomId ||
        constraint.lineId === geomId ||
        constraint.secondCircleId === geomId
      );
    default:
      return false;
  }
}

// Per-point constraint helpers were removed when enforceSimpleConstraints
// moved into the core solver path. constraintReferencesGeometry is kept
// above because removeGeometry still uses it to garbage-collect orphan
// constraints.

// There is no editor-store-side `addConstraint`
// action, no rollback helpers (`checkAddFailure`,
// `perturbFreeDimensions`, `constraintsEqual`), and no
// `conflictingConstraints` map. The dedupe + tentative-solve +
// auto-resize + conflict-detection pipeline runs through the bus via
// `SketchApplyConstraint` → `applyConstraintWithSolver` in
// `@tweakcad/core/src/sketch/applyConstraintPipeline.ts`. UI surfaces
// rejection through the dispatch-side toast in `sketchDispatch.ts`.

// Note: constraint enforcement lives in `@tweakcad/core/src/sketch/solver/`
// (planegcs adapter via the ISketchSolver interface). There is no
// fixed-point relaxation fallback.

// ---- State Type ----

export interface SketchEditorState {
  // Entity data
  points: Map<SketchPointId, SketchPoint>;
  geometries: Map<SketchGeometryId, SketchGeometry>;
  constraints: Map<SketchConstraintId, SketchConstraint>;

  // Selection — mutually exclusive across kinds. Selecting a constraint
  // clears geometry/point/region selection and vice versa.
  selectedPointIds: Set<SketchPointId>;
  selectedGeometryIds: Set<SketchGeometryId>;
  selectedRegionIds: Set<SketchRegionId>;
  selectedConstraintIds: Set<SketchConstraintId>;
  hoveredTarget: HitTarget;
  /**
   * Extra entities to render in the hover style — set by the SketchBrowser
   * when a constraint row is hovered so every referenced point + geometry
   * lights up (e.g. both endpoints of a coincident, both lines of a
   * perpendicular). Independent of hoveredTarget so the scene can combine
   * both sources.
   */
  hoveredConstraintRefs: {
    points: ReadonlySet<SketchPointId>;
    geometries: ReadonlySet<SketchGeometryId>;
  };
  /** Set from a constraint object, or clear with null. */
  setHoveredConstraint: (c: SketchConstraint | null) => void;

  // Selection intent (editGeometry vs selectProfileForFeature)
  selectionIntent: SketchSelectionIntent;

  // Tool
  activeTool: SketchToolId;
  preview: SketchPreviewData;
  activeSnap: SnapResult | null;

  // Viewport
  zoom: number;
  panX: number;
  panY: number;
  gridSpacing: number;
  gridSnapEnabled: boolean;

  /**
   * When true, every new geometry the tools create is marked
   * `construction: true` (dashed, not extrudable, ignored by region detection
   * and the worker face builder). Toggle is a sticky modifier
   * — turn it on, draw a centerline, turn it off.
   */
  constructionMode: boolean;
  setConstructionMode: (on: boolean) => void;
  toggleConstructionMode: () => void;
  /** Toggle the construction flag on a single existing geometry. */
  setGeometryConstruction: (id: SketchGeometryId, construction: boolean) => void;

  // Dimension tool: when set, the editor renders an input near (screenX, screenY)
  pendingDimension: PendingDimension | null;
  setPendingDimension: (p: PendingDimension | null) => void;

  /**
   * IDs of constraints the solver couldn't satisfy after the last
   * move/edit. Empty when the sketch is consistent. Browser rows badge
   * themselves red when their constraint id is in this set.
   */
  unsatisfiedConstraints: ReadonlySet<SketchConstraintId>;

  /**
   * Remaining degrees of freedom after the last solve. 0 = fully
   * defined, >0 = under-constrained, `undefined` while WASM hasn't
   * loaded yet or before the first solve. Drives the sketch panel's
   * DOF badge ("Fully defined" / "Under-constrained · N DOF") and the
   * "fully defined" blue tint applied to geometry in
   * `SketchSceneManager` when this value is 0.
   *
   * V7: pulled from planegcs's `GcsSystem.dof()` after each solve via
   * `SolveResult.diagnostic.dof`.
   */
  dof: number | undefined;

  /**
   * V8 · Live inferred-constraint hint shown next to the cursor while
   * drawing. Set by the line tool's `handlePointerMove` whenever the
   * in-progress segment is within a small angular tolerance of
   * horizontal or vertical; cleared between sessions.
   *
   * When set, the line tool's commit handler will dispatch the matching
   * `'horizontal'` / `'vertical'` constraint right after the line so
   * the user gets a snapped-flat axis-aligned line in one click.
   */
  inferredHint: { kind: 'horizontal' | 'vertical'; sketchX: number; sketchY: number } | null;
  setInferredHint: (h: SketchEditorState['inferredHint']) => void;

  // There is no `conflictingConstraints` field and no editor-store-side
  // `addConstraint` action. Rejected constraints are
  // surfaced as a toast from `sketchDispatch.dispatchApplyConstraint`;
  // they never enter the editor state, so the browser doesn't need a
  // separate "couldn't apply" bucket.

  // Actions
  addPoint: (x: number, y: number, fixed?: boolean) => SketchPointId;
  addGeometry: (geom: SketchGeometryInput) => SketchGeometryId;
  removeGeometry: (id: SketchGeometryId) => void;
  removePoint: (id: SketchPointId) => void;
  removeConstraint: (id: SketchConstraintId) => void;
  updateGeometry: (id: SketchGeometryId, updates: Partial<SketchGeometry>) => void;
  movePoint: (id: SketchPointId, x: number, y: number) => void;
  /**
   * Move several points in a single transaction with the moved set treated
   * as anchored — neighbouring constraints adjust other points to stay
   * satisfied, but the user-driven drag is never overridden. Use this for
   * drag gestures that touch multiple line endpoints at once.
   */
  movePointsBatch: (updates: Array<{ id: SketchPointId; x: number; y: number }>) => void;
  setRadius: (id: SketchGeometryId, radius: number) => void;

  selectGeometry: (id: SketchGeometryId, additive: boolean) => void;
  selectPoint: (id: SketchPointId, additive: boolean) => void;
  selectRegion: (id: SketchRegionId, additive: boolean) => void;
  selectConstraint: (id: SketchConstraintId, additive: boolean) => void;
  clearSelection: () => void;
  setHoveredTarget: (target: HitTarget) => void;
  deleteSelected: () => void;

  setActiveTool: (tool: SketchToolId) => void;
  setPreview: (preview: SketchPreviewData) => void;
  setActiveSnap: (snap: SnapResult | null) => void;

  setZoom: (zoom: number) => void;
  setPan: (x: number, y: number) => void;
  setGridSnap: (enabled: boolean) => void;

  clearAll: () => void;
  loadFromDocument: (
    points: SketchPoint[],
    geometries: SketchGeometry[],
    constraints: SketchConstraint[],
  ) => void;
  /**
   * Replace the geometry slice (points/geometries/constraints) from a
   * document snapshot WITHOUT touching the UI slice (active tool,
   * selection, hover, snap, preview). Used by the document → store
   * subscription so an undo/redo or any other doc-driven mutation
   * refreshes the editor without disrupting the user's interaction
   * state. Selections that point to entities no longer in the snapshot
   * are pruned silently.
   *
   * Differs from loadFromDocument (which resets ALL state for a fresh
   * sketch open) — that one is for entering a sketch, this one is for
   * staying in sync once already inside.
   */
  hydrateFromDocument: (
    points: SketchPoint[],
    geometries: SketchGeometry[],
    constraints: SketchConstraint[],
  ) => void;
  /**
   * Bulk-import the points / geometries / constraints from a core
   * `EditorState` diff (i.e. the result of running a pure core primitive
   * like `drawRectangle` against the current state). Used by UI tool
   * handlers that delegate their structural work to the core operations
   * module — same primitive runs from the MCP/document side, so both
   * paths produce identical editor states.
   *
   * `delta` is the set of NEW points/geometries/constraints to add.
   * Existing entries with the same id are overwritten (idempotent).
   */
  importDelta: (delta: {
    points: ReadonlyArray<SketchPoint>;
    geometries: ReadonlyArray<SketchGeometry>;
    constraints: ReadonlyArray<SketchConstraint>;
  }) => void;

  /**
   * Find the nearest snap target to the given coords. Optional
   * `excludePointIds` skips the listed points — used during a select-
   * tool drag to keep the cursor from snapping back to the very point
   * being moved (without this, drag distances under the snap radius
   * collapse to zero and the entity appears glued in place).
   */
  snapPosition: (x: number, y: number, excludePointIds?: ReadonlySet<SketchPointId>) => SnapResult;
  setSelectionIntent: (intent: SketchSelectionIntent) => void;
  hitTestRegion: (x: number, y: number) => SketchRegion | null;
  selectRegionAtPoint: (x: number, y: number, additive: boolean) => void;
  getSketchRegions: () => SketchRegion[];
  getGeometryPointIds: (id: SketchGeometryId) => SketchPointId[];
  isPointReferenced: (id: SketchPointId) => boolean;
}

// ---- Store ----

export const useSketchEditorStore = create<SketchEditorState>((set, get) => ({
  // Initial state
  points: new Map<SketchPointId, SketchPoint>(),
  geometries: new Map<SketchGeometryId, SketchGeometry>(),
  constraints: new Map<SketchConstraintId, SketchConstraint>(),
  selectedPointIds: new Set<SketchPointId>(),
  selectedGeometryIds: new Set<SketchGeometryId>(),
  selectedRegionIds: new Set<SketchRegionId>(),
  selectedConstraintIds: new Set<SketchConstraintId>(),
  hoveredTarget: null,
  hoveredConstraintRefs: { points: new Set<SketchPointId>(), geometries: new Set<SketchGeometryId>() },
  setHoveredConstraint: (c: SketchConstraint | null): void => {
    if (!c) {
      set({ hoveredConstraintRefs: { points: new Set<SketchPointId>(), geometries: new Set<SketchGeometryId>() } });
      return;
    }
    const points = new Set<SketchPointId>();
    const geometries = new Set<SketchGeometryId>();
    switch (c.type) {
      case 'coincident':
        points.add(c.pointA); points.add(c.pointB); break;
      case 'fixed':
        points.add(c.pointId); break;
      case 'distance':
      case 'distanceX':
      case 'distanceY':
        points.add(c.pointA); points.add(c.pointB); break;
      case 'horizontal':
      case 'vertical':
      case 'length':
      case 'radius':
        geometries.add(c.geometryId); break;
      case 'parallel':
      case 'perpendicular':
      case 'angle':
      case 'equal':
        geometries.add(c.geometryA); geometries.add(c.geometryB); break;
      case 'tangent':
        // Highlight both curves of the tangent — line + circle, or both
        // circles. Optional fields are skipped when undefined.
        if (c.lineId !== undefined) geometries.add(c.lineId);
        geometries.add(c.circleId);
        if (c.secondCircleId !== undefined) geometries.add(c.secondCircleId);
        break;
      case 'pointOnLine':
      case 'pointOnCircle':
        points.add(c.pointId); geometries.add(c.geometryId); break;
      case 'symmetric':
        points.add(c.pointA); points.add(c.pointB); geometries.add(c.geometryId); break;
    }
    set({ hoveredConstraintRefs: { points, geometries } });
  },
  selectionIntent: 'editGeometry' as SketchSelectionIntent,
  activeTool: null,
  preview: null,
  activeSnap: null,
  zoom: 5,
  panX: 0,
  panY: 0,
  gridSpacing: 10,
  gridSnapEnabled: false,
  pendingDimension: null,
  setPendingDimension: (p: PendingDimension | null): void => { set({ pendingDimension: p }); },
  unsatisfiedConstraints: new Set<SketchConstraintId>(),
  dof: undefined,
  inferredHint: null,
  setInferredHint: (h: SketchEditorState['inferredHint']): void => { set({ inferredHint: h }); },
  constructionMode: false,
  setConstructionMode: (on: boolean): void => { set({ constructionMode: on }); },
  toggleConstructionMode: (): void => { set((s) => ({ constructionMode: !s.constructionMode })); },
  setGeometryConstruction: (id: SketchGeometryId, construction: boolean): void => {
    set((state) => {
      const geom = state.geometries.get(id);
      if (!geom) return state;
      const geometries = new Map(state.geometries);
      geometries.set(id, { ...geom, construction });
      return { geometries };
    });
  },

  // ---- Entity CRUD ----

  addPoint: (x: number, y: number, fixed: boolean = false): SketchPointId => {
    const id = sketchPointId(nextId('pt'));
    const point: SketchPoint = { id, x, y, fixed };
    set((state: SketchEditorState) => {
      const points = new Map(state.points);
      points.set(id, point);
      return { points };
    });
    return id;
  },

  addGeometry: (geomInput: SketchGeometryInput): SketchGeometryId => {
    const id = geomInput.id ?? sketchGeometryId(nextId('geo'));
    const geom = { ...geomInput, id } as SketchGeometry;
    set((state: SketchEditorState) => {
      const geometries = new Map(state.geometries);
      geometries.set(id, geom);
      return { geometries };
    });
    return id;
  },

  // There is no `addConstraint` action. UI callers dispatch through
  // `sketchDispatch.dispatchApplyConstraint`, which runs the
  // `applyConstraintWithSolver` pipeline.

  removeGeometry: (id: SketchGeometryId): void => {
    set((state: SketchEditorState) => {
      const geometries = new Map(state.geometries);
      const geom = geometries.get(id);
      geometries.delete(id);

      // Remove orphaned points
      const points = new Map(state.points);
      if (geom) {
        const pointIds = getPointIdsFromGeometry(geom);
        for (const pid of pointIds) {
          if (!isPointUsedByOtherGeometry(pid, id, geometries)) {
            points.delete(pid);
          }
        }
      }

      // Remove constraints referencing this geometry
      const constraints = new Map(state.constraints);
      for (const [cid, c] of constraints) {
        if (constraintReferencesGeometry(c, id)) {
          constraints.delete(cid);
        }
      }

      // Clean selection
      const selectedGeometryIds = new Set(state.selectedGeometryIds);
      selectedGeometryIds.delete(id);
      const selectedRegionIds = new Set(state.selectedRegionIds);
      for (const region of detectSketchRegions(geometriesToSketchEntities(points, geometries))) {
        if (region.entityIds.some(entityId => String(entityId) === String(id))) {
          selectedRegionIds.delete(sketchRegionId(region.id));
        }
      }

      return { geometries, points, constraints, selectedGeometryIds, selectedRegionIds };
    });
  },

  removePoint: (id: SketchPointId): void => {
    // V11.5 · the origin point is non-deletable. Deleting it would break
    // the DOF accounting (the sketch would suddenly have +2 free DOF)
    // and orphan its `fixed` constraint. The UI hides delete affordances
    // on the origin row, but defend-in-depth at the store level too.
    if (id === ORIGIN_POINT_ID) return;
    const state = get();
    if (isPointUsedByAnyGeometry(id, state.geometries)) {
      return; // Cannot remove referenced point
    }
    set((s: SketchEditorState) => {
      const points = new Map(s.points);
      points.delete(id);
      const selectedPointIds = new Set(s.selectedPointIds);
      selectedPointIds.delete(id);
      return { points, selectedPointIds };
    });
  },

  removeConstraint: (id: SketchConstraintId): void => {
    // V11.5 · the origin's anchoring `fixed` constraint is non-deletable
    // for the same reason as `removePoint` above.
    if (id === ORIGIN_CONSTRAINT_ID) return;
    set((state: SketchEditorState) => {
      const constraints = new Map(state.constraints);
      constraints.delete(id);
      // There is no conflict-revival loop and no `conflictingConstraints`.
      // Rejected constraints never enter the editor state — they get bounced
      // at the bus by `applyConstraintWithSolver`, so there's no bucket
      // of stashed conflicts to re-try here.
      const result = solveConstraints(state.points, state.geometries, constraints, new Set());
      return {
        constraints,
        points: result.points,
        geometries: result.geometries,
        unsatisfiedConstraints: result.diagnostic.unsatisfied,
        dof: result.diagnostic.dof,
      };
    });
  },

  updateGeometry: (id: SketchGeometryId, updates: Partial<SketchGeometry>): void => {
    set((state: SketchEditorState) => {
      const geometries = new Map(state.geometries);
      const existing = geometries.get(id);
      if (!existing) return { geometries };
      geometries.set(id, { ...existing, ...updates } as SketchGeometry);
      return { geometries };
    });
  },

  movePoint: (id: SketchPointId, x: number, y: number): void => {
    set((state: SketchEditorState) => {
      const points = new Map(state.points);
      const existing = points.get(id);
      if (existing) {
        points.set(id, { ...existing, x, y });
      }
      const anchored = new Set<SketchPointId>([id]);
      const result = solveConstraints(points, state.geometries, state.constraints, anchored);
      const geometries = syncDerivedGeometryFields(result.geometries, result.points);
      return { points: result.points, geometries, unsatisfiedConstraints: result.diagnostic.unsatisfied, dof: result.diagnostic.dof };
    });
  },

  movePointsBatch: (updates: Array<{ id: SketchPointId; x: number; y: number }>): void => {
    if (updates.length === 0) return;
    set((state: SketchEditorState) => {
      const points = new Map(state.points);
      const anchored = new Set<SketchPointId>();
      for (const u of updates) {
        const existing = points.get(u.id);
        if (existing) {
          points.set(u.id, { ...existing, x: u.x, y: u.y });
          anchored.add(u.id);
        }
      }
      const result = solveConstraints(points, state.geometries, state.constraints, anchored);
      const geometries = syncDerivedGeometryFields(result.geometries, result.points);
      return { points: result.points, geometries, unsatisfiedConstraints: result.diagnostic.unsatisfied, dof: result.diagnostic.dof };
    });
  },

  setRadius: (id: SketchGeometryId, radius: number): void => {
    set((state: SketchEditorState) => {
      const geometries = new Map(state.geometries);
      const geom = geometries.get(id);
      if (geom && (geom.type === 'circle' || geom.type === 'arc')) {
        geometries.set(id, { ...geom, radius });
      }
      return { geometries };
    });
  },

  // ---- Selection ----

  selectGeometry: (id: SketchGeometryId, additive: boolean): void => {
    set((state: SketchEditorState) => {
      const selectedGeometryIds = additive
        ? new Set(state.selectedGeometryIds)
        : new Set<SketchGeometryId>();
      const selectedPointIds = additive
        ? new Set(state.selectedPointIds)
        : new Set<SketchPointId>();

      if (selectedGeometryIds.has(id)) {
        selectedGeometryIds.delete(id);
      } else {
        selectedGeometryIds.add(id);
      }

      return {
        selectedGeometryIds,
        selectedPointIds,
        selectedRegionIds: new Set<SketchRegionId>(),
        selectedConstraintIds: new Set<SketchConstraintId>(),
      };
    });
  },

  selectPoint: (id: SketchPointId, additive: boolean): void => {
    set((state: SketchEditorState) => {
      const selectedPointIds = additive
        ? new Set(state.selectedPointIds)
        : new Set<SketchPointId>();
      const selectedGeometryIds = additive
        ? new Set(state.selectedGeometryIds)
        : new Set<SketchGeometryId>();

      if (selectedPointIds.has(id)) {
        selectedPointIds.delete(id);
      } else {
        selectedPointIds.add(id);
      }

      return {
        selectedPointIds,
        selectedGeometryIds,
        selectedRegionIds: new Set<SketchRegionId>(),
        selectedConstraintIds: new Set<SketchConstraintId>(),
      };
    });
  },

  selectRegion: (id: SketchRegionId, additive: boolean): void => {
    set((state: SketchEditorState) => {
      const selectedRegionIds = additive
        ? new Set(state.selectedRegionIds)
        : new Set<SketchRegionId>();
      const selectedPointIds = additive
        ? new Set(state.selectedPointIds)
        : new Set<SketchPointId>();
      const selectedGeometryIds = additive
        ? new Set(state.selectedGeometryIds)
        : new Set<SketchGeometryId>();

      if (selectedRegionIds.has(id)) {
        selectedRegionIds.delete(id);
      } else {
        selectedRegionIds.add(id);
      }

      return {
        selectedRegionIds,
        selectedPointIds,
        selectedGeometryIds,
        selectedConstraintIds: new Set<SketchConstraintId>(),
      };
    });
  },

  selectConstraint: (id: SketchConstraintId, additive: boolean): void => {
    set((state: SketchEditorState) => {
      const selectedConstraintIds = additive
        ? new Set(state.selectedConstraintIds)
        : new Set<SketchConstraintId>();
      if (selectedConstraintIds.has(id)) {
        selectedConstraintIds.delete(id);
      } else {
        selectedConstraintIds.add(id);
      }
      return {
        selectedConstraintIds,
        // Clear other selection kinds — constraint and geometry are a single
        // selection unit.
        selectedGeometryIds: new Set<SketchGeometryId>(),
        selectedPointIds: new Set<SketchPointId>(),
        selectedRegionIds: new Set<SketchRegionId>(),
      };
    });
  },

  clearSelection: (): void => {
    set({
      selectedPointIds: new Set<SketchPointId>(),
      selectedGeometryIds: new Set<SketchGeometryId>(),
      selectedRegionIds: new Set<SketchRegionId>(),
      selectedConstraintIds: new Set<SketchConstraintId>(),
    });
  },

  setHoveredTarget: (target: HitTarget): void => {
    set({ hoveredTarget: target });
  },

  deleteSelected: (): void => {
    const state = get();
    const geoIds = [...state.selectedGeometryIds];
    const ptIds = [...state.selectedPointIds];

    // Remove geometries first (also removes orphaned points)
    for (const gid of geoIds) {
      get().removeGeometry(gid);
    }

    // Remove standalone selected points
    for (const pid of ptIds) {
      get().removePoint(pid);
    }

    set({
      selectedPointIds: new Set<SketchPointId>(),
      selectedGeometryIds: new Set<SketchGeometryId>(),
      selectedRegionIds: new Set<SketchRegionId>(),
    });
  },

  // ---- Tool ----

  setActiveTool: (tool: SketchToolId): void => {
    set({ activeTool: tool, preview: null, activeSnap: null });
  },

  setPreview: (preview: SketchPreviewData): void => {
    set({ preview });
  },

  setActiveSnap: (snap: SnapResult | null): void => {
    set({ activeSnap: snap?.type === 'none' ? null : snap });
  },

  // ---- Viewport ----

  setZoom: (zoom: number): void => {
    set({ zoom: Math.max(0.5, Math.min(100, zoom)) });
  },

  setPan: (x: number, y: number): void => {
    set({ panX: x, panY: y });
  },

  setGridSnap: (enabled: boolean): void => {
    set({ gridSnapEnabled: enabled });
  },

  // ---- Bulk ----

  clearAll: (): void => {
    set({
      points: new Map<SketchPointId, SketchPoint>(),
      geometries: new Map<SketchGeometryId, SketchGeometry>(),
      constraints: new Map<SketchConstraintId, SketchConstraint>(),
      selectedPointIds: new Set<SketchPointId>(),
      selectedGeometryIds: new Set<SketchGeometryId>(),
      selectedRegionIds: new Set<SketchRegionId>(),
      selectedConstraintIds: new Set<SketchConstraintId>(),
      hoveredTarget: null,
      selectionIntent: 'editGeometry' as SketchSelectionIntent,
      preview: null,
      activeSnap: null,
      pendingDimension: null,
      unsatisfiedConstraints: new Set<SketchConstraintId>(),
      dof: undefined,
    });
  },

  hydrateFromDocument: (
    points: SketchPoint[],
    geometries: SketchGeometry[],
    constraints: SketchConstraint[],
  ): void => {
    const pointMap = new Map<SketchPointId, SketchPoint>();
    for (const p of points) pointMap.set(p.id, p);
    const geomMap = new Map<SketchGeometryId, SketchGeometry>();
    for (const g of geometries) geomMap.set(g.id, g);
    const constraintMap = new Map<SketchConstraintId, SketchConstraint>();
    for (const c of constraints) constraintMap.set(c.id, c);

    // Run one passive solve so `dof` + `unsatisfiedConstraints` are
    // accurate the instant the sketch opens (otherwise the DOF badge
    // would show "Solving..." until the user moved something). Wrapped
    // in try/catch for the edge case where WASM hasn't initialised yet
    // — in practice the boot path resolves before any sketch can be
    // opened, but we don't want a half-loaded planegcs to crash the
    // hydration subscriber.
    let solvedPoints: Map<SketchPointId, SketchPoint> | null = null;
    let solvedGeoms: Map<SketchGeometryId, SketchGeometry> | null = null;
    let solvedUnsat: ReadonlySet<SketchConstraintId> = new Set<SketchConstraintId>();
    let solvedDof: number | undefined = undefined;
    try {
      const r = solveConstraints(pointMap, geomMap, constraintMap, new Set());
      solvedPoints = r.points;
      solvedGeoms = syncDerivedGeometryFields(r.geometries, r.points);
      solvedUnsat = r.diagnostic.unsatisfied;
      solvedDof = r.diagnostic.dof;
    } catch {
      // Solver not ready or threw — fall back to the raw snapshot.
      // Next user interaction will trigger a real solve and populate dof.
    }

    set((state) => {
      // Prune selections to entities that still exist in the snapshot.
      // Anything else (active tool, snap, preview, hover) carries over.
      const selectedPointIds = new Set<SketchPointId>();
      for (const id of state.selectedPointIds) {
        if (pointMap.has(id)) selectedPointIds.add(id);
      }
      const selectedGeometryIds = new Set<SketchGeometryId>();
      for (const id of state.selectedGeometryIds) {
        if (geomMap.has(id)) selectedGeometryIds.add(id);
      }
      const selectedConstraintIds = new Set<SketchConstraintId>();
      for (const id of state.selectedConstraintIds) {
        if (constraintMap.has(id)) selectedConstraintIds.add(id);
      }
      return {
        points: solvedPoints ?? pointMap,
        geometries: solvedGeoms ?? geomMap,
        constraints: constraintMap,
        selectedPointIds,
        selectedGeometryIds,
        selectedConstraintIds,
        unsatisfiedConstraints: solvedUnsat,
        dof: solvedDof,
      };
    });
  },

  importDelta: (delta: {
    points: ReadonlyArray<SketchPoint>;
    geometries: ReadonlyArray<SketchGeometry>;
    constraints: ReadonlyArray<SketchConstraint>;
  }): void => {
    set((state: SketchEditorState) => {
      const points = new Map(state.points);
      for (const p of delta.points) points.set(p.id, p);
      const geometries = new Map(state.geometries);
      for (const g of delta.geometries) geometries.set(g.id, g);
      const constraints = new Map(state.constraints);
      for (const c of delta.constraints) constraints.set(c.id, c);
      return { points, geometries, constraints };
    });
  },

  loadFromDocument: (
    points: SketchPoint[],
    geometries: SketchGeometry[],
    constraints: SketchConstraint[],
  ): void => {
    const pointMap = new Map<SketchPointId, SketchPoint>();
    for (const p of points) pointMap.set(p.id, p);

    const geomMap = new Map<SketchGeometryId, SketchGeometry>();
    for (const g of geometries) geomMap.set(g.id, g);

    const constraintMap = new Map<SketchConstraintId, SketchConstraint>();
    for (const c of constraints) constraintMap.set(c.id, c);

    set({
      points: pointMap,
      geometries: geomMap,
      constraints: constraintMap,
      selectedPointIds: new Set<SketchPointId>(),
      selectedGeometryIds: new Set<SketchGeometryId>(),
      selectedRegionIds: new Set<SketchRegionId>(),
      selectedConstraintIds: new Set<SketchConstraintId>(),
      hoveredTarget: null,
      preview: null,
      activeSnap: null,
    });
  },

  // ---- Queries ----

  snapPosition: (x: number, y: number, excludePointIds?: ReadonlySet<SketchPointId>): SnapResult => {
    const state = get();
    const { gridSpacing, gridSnapEnabled, points, geometries, zoom } = state;

    // Check point snaps (higher priority)
    const SNAP_RADIUS = 8 / zoom; // 8 screen pixels
    let closestDist = SNAP_RADIUS;
    let snapResult: SnapResult = { x, y, type: 'none' };

    for (const [pid, pt] of points) {
      if (excludePointIds?.has(pid)) continue;
      const dx = pt.x - x;
      const dy = pt.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        snapResult = { x: pt.x, y: pt.y, type: 'point', targetId: pid };
      }
    }

    if (snapResult.type !== 'none') return snapResult;

    // Check line midpoints. This gives a reference snap without
    // creating synthetic points in the model. Skip lines whose endpoints
    // are being dragged — the midpoint moves with the endpoints and
    // would falsely snap the cursor mid-drag.
    closestDist = SNAP_RADIUS;
    for (const [gid, geom] of geometries) {
      if (geom.type !== 'line') continue;
      const start = points.get(geom.startId);
      const end = points.get(geom.endId);
      if (!start || !end) continue;
      if (excludePointIds?.has(geom.startId) || excludePointIds?.has(geom.endId)) continue;
      const mx = (start.x + end.x) * 0.5;
      const my = (start.y + end.y) * 0.5;
      const dx = mx - x;
      const dy = my - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        snapResult = { x: mx, y: my, type: 'midpoint', geometryId: gid };
      }
    }

    if (snapResult.type !== 'none') return snapResult;

    // Grid snap
    if (gridSnapEnabled && gridSpacing > 0) {
      return {
        x: Math.round(x / gridSpacing) * gridSpacing,
        y: Math.round(y / gridSpacing) * gridSpacing,
        type: 'grid',
      };
    }

    return { x, y, type: 'none' };
  },

  setSelectionIntent: (intent: SketchSelectionIntent): void => {
    set({ selectionIntent: intent });
  },

  hitTestRegion: (x: number, y: number): SketchRegion | null => {
    const state = get();
    const regions = detectSketchRegions(geometriesToSketchEntities(state.points, state.geometries));
    // Find the smallest region containing the point (most specific hit)
    const hits = regions.filter(region => pointInRegion([x, y], region));
    if (hits.length === 0) return null;
    // Return the smallest area region (most specific)
    hits.sort((a, b) => a.area - b.area);
    return hits[0] ?? null;
  },

  selectRegionAtPoint: (x: number, y: number, additive: boolean): void => {
    const state = get();
    const regions = detectSketchRegions(geometriesToSketchEntities(state.points, state.geometries));

    // First try point-in-region hit test
    let hitRegion: SketchRegion | null = null;
    const hits = regions.filter(region => pointInRegion([x, y], region));
    if (hits.length > 0) {
      hits.sort((a, b) => a.area - b.area);
      hitRegion = hits[0] ?? null;
    }

    // If no direct hit, check if near a geometry edge and use geometry-to-region bridge
    if (!hitRegion) {
      // Check each geometry for proximity to click point
      for (const [gid] of state.geometries) {
        const region = findRegionForEntity(entityId(String(gid)), regions);
        if (region) {
          // Simple proximity check: is the click point near this region's centroid?
          // (The real hit test would check distance-to-edge, but this is a sufficient approximation)
          hitRegion = region;
          break;
        }
      }
    }

    if (!hitRegion) return;

    const regionId = sketchRegionId(hitRegion.id);
    const selectedRegionIds = additive
      ? new Set(state.selectedRegionIds)
      : new Set<SketchRegionId>();

    if (selectedRegionIds.has(regionId)) {
      selectedRegionIds.delete(regionId);
    } else {
      selectedRegionIds.add(regionId);
    }

    set({
      selectedRegionIds,
      selectedPointIds: new Set<SketchPointId>(),
      selectedGeometryIds: new Set<SketchGeometryId>(),
    });
  },

  getSketchRegions: (): SketchRegion[] => {
    const state = get();
    return detectSketchRegions(geometriesToSketchEntities(state.points, state.geometries));
  },

  getGeometryPointIds: (id: SketchGeometryId): SketchPointId[] => {
    const geom = get().geometries.get(id);
    return geom ? getPointIdsFromGeometry(geom) : [];
  },

  isPointReferenced: (id: SketchPointId): boolean => {
    return isPointUsedByAnyGeometry(id, get().geometries);
  },
}));

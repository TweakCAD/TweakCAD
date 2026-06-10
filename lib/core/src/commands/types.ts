/**
 * Command types for all document mutations.
 * Every command field is JSON-serializable.
 * This enables: undo/redo, macro recording, command replay tests, programmatic creation.
 */

import type { PartId, FeatureId, EntityId } from '../ids.ts';
import type {
  SketchConstraintInput,
  SketchConstraintId,
  SketchPointId,
} from '../sketch/types.ts';
import type {
  PlaneRef,
  SketchEntity,
  ExtrudeFeatureInputs,
  RevolveFeatureInputs,
  LoftFeatureInputs,
  FilletFeatureInputs,
  ChamferFeatureInputs,
  HoleFeatureInputs,
  MirrorFeatureInputs,
  PatternFeatureInputs,
  ShellFeatureInputs,
  SweepFeatureInputs,
  ImportedGeometryFeatureInputs,
  ImportedComponentFeatureInputs,
  ComponentInstanceFeatureInputs,
  ComponentDefinition,
  ConstructionPlaneFeatureInputs,
  ParameterValue,
  ConfigurationRow,
  SketchEditorSnapshot,
} from '../document/schema.ts';

/** Union of all possible document mutation commands */
export type CadCommand =
  // Project-scope commands
  | RenameProjectCommand
  // Part commands
  | CreatePartCommand
  | RenamePartCommand
  // Sketch commands
  | CreateSketchCommand
  | CreateSketchFromImportCommand
  | AddSketchEntityCommand
  | RemoveSketchEntityCommand
  // Higher-level sketch drawing commands — see
  // sketch/operations.ts for the shared primitives these route into.
  | SketchDrawLineCommand
  | SketchDrawRectangleCommand
  | SketchDrawCircleCommand
  | SketchDrawSlotCommand
  | SketchDrawArcCommand
  | SketchDrawArc3PointCommand
  | SketchDrawPolygonCommand
  | SketchDrawPointCommand
  | SketchDrawEllipseCommand
  | SketchDrawSplineCommand
  | SketchMovePointCommand
  | SketchMovePointsBatchCommand
  | SketchApplyConstraintCommand
  | SketchRemoveConstraintCommand
  // Modify-tool sketch commands
  | SketchTrimCommand
  | SketchExtendCommand
  | SketchFilletCommand
  | SketchOffsetCommand
  | SketchMirrorCommand
  // Feature commands
  | CreateExtrudeCommand
  | CreateRevolveCommand
  | CreateLoftCommand
  | CreateFilletCommand
  | CreateChamferCommand
  | CreateHoleCommand
  | CreateMirrorCommand
  | CreateShellCommand
  | CreateSweepCommand
  | CreateImportedGeometryCommand
  | CreatePatternCommand
  | CreateComponentInstanceCommand
  | CreateImportedComponentCommand
  | CreateConstructionPlaneCommand
  // Edit commands
  | UpdateFeatureInputCommand
  | ReplaceFeatureInputsCommand
  | SuppressFeatureCommand
  | SetFeatureVisibilityCommand
  | DeleteFeatureCommand
  | ReorderFeatureCommand
  // Parameter commands
  | SetParameterCommand
  | DeleteParameterCommand
  // Configuration commands
  | SetConfigurationRowCommand
  | DeleteConfigurationRowCommand
  | SetActiveConfigurationCommand;

// --- Project Commands ---

/**
 * Set `project.metadata.name`. Used by the inline rename in the title
 * bar; also routable through dispatch_command from the MCP layer.
 * Validation: name must trim non-empty (consistent with RenamePart);
 * extremely long names are clamped to 200 chars (UI ellipsis kicks in
 * far before that anyway, but we don't want runaway strings).
 */
export type RenameProjectCommand = {
  type: 'RenameProject';
  name: string;
};

// --- Part Commands ---

export type CreatePartCommand = {
  type: 'CreatePart';
  name: string;
};

export type RenamePartCommand = {
  type: 'RenamePart';
  partId: PartId;
  name: string;
};

// --- Sketch Commands ---

export type CreateSketchCommand = {
  type: 'CreateSketch';
  partId: PartId;
  plane: PlaneRef;
};

/**
 * Create a new sketch on a plane, pre-populated from an imported
 * `EditorState` snapshot (e.g. a parsed DXF). Mirrors `CreateSketch` for
 * the plane / feature-creation half, but instead of seeding only the
 * origin point it stores the supplied `editorState` snapshot and derives
 * `inputs.buildGeometry` from it — the whole import lands as ONE undo entry.
 *
 * `editorState` is the array-form `SketchEditorSnapshot` produced by the
 * importer's `toSnapshot(...)`; it must be JSON/structured-clone safe so
 * the command can be replayed and undone like any other.
 */
export type CreateSketchFromImportCommand = {
  type: 'CreateSketchFromImport';
  partId: PartId;
  plane: PlaneRef;
  editorState: SketchEditorSnapshot;
  /** Optional display name; defaults to the auto-numbered "Sketch N". */
  name?: string;
};

export type AddSketchEntityCommand = {
  type: 'AddSketchEntity';
  sketchId: FeatureId;
  entity: SketchEntity;
};

// `ReplaceSketchEntitiesCommand` was retired during the sketch-commands
// unification. Its sole caller (Shell.tsx's
// `syncSketchToDocument`) is gone; every per-mutation `Sketch*` handler
// already rebuilds `inputs.buildGeometry` via `editorModelToBuildGeometry` and
// snapshots `editorModel`, so a "replace all" command had nothing to
// add. If a future flow needs to atomically swap a sketch's contents
// (e.g. paste a templated sketch), build it on the per-primitive
// handlers wrapped in `bus.beginTransaction` / `endTransaction`.

export type RemoveSketchEntityCommand = {
  type: 'RemoveSketchEntity';
  sketchId: FeatureId;
  entityId: EntityId;
};

// --- Higher-level Sketch Drawing Commands ---
//
// These wrap the pure-function operations in
// `@tweakcad/core/src/sketch/operations.ts`. Each handler:
//   1. Loads the sketch's current editorModel into a working
//      EditorState (or empty if the sketch was just created).
//   2. Calls the matching `drawLine` / `drawRectangle` / `drawCircle`
//      primitive, which allocates points (or reuses existing ones
//      within tolerance), appends geometries, and returns a new state.
//   3. Serializes the state back: writes both `editorModel` (for
//      editor round-trip) and `buildGeometry` (the canonical document model
//      the worker rebuilds from).
//
// The point-allocation + coincident-merge logic lives in operations.ts
// ONLY. These command types are pure data; handlers are thin orchestration.

/**
 * Draw a line in a sketch from `from` to `to`. Endpoints snap to
 * existing points within `tolerance` mm (default 1e-6) — the
 * mechanism that turns 4 sequential lines into a closed quad with
 * shared corners.
 */
export type SketchDrawLineCommand = {
  type: 'SketchDrawLine';
  sketchId: FeatureId;
  /** Line start in sketch-plane coordinates (mm). */
  from: [number, number];
  /** Line end. */
  to: [number, number];
  /** Construction geometry (dashed, not used in profile detection). */
  construction?: boolean;
  /** Coincident-merge tolerance in mm. Default {@link COINCIDENT_TOLERANCE_MM} (1e-6). */
  tolerance?: number;
  /**
   * Optional chain-link target. When set, the handler:
   *   1. Allocates a fresh `SketchPoint` for this line's start
   *      (instead of merging with whatever existing point sits at the
   *      `from` coords).
   *   2. Emits an explicit `coincident` constraint between the new
   *      start point and `chainFrom`.
   *
   * Used by the in-app line tool's chain mode: each
   * segment owns its endpoints, and chain adjacency is a removable
   * `coincident` constraint, visible in the sketch browser. Atomic
   * with the line creation — one undo entry per chain segment.
   */
  chainFrom?: SketchPointId;
};

/**
 * Draw an axis-aligned rectangle. The 4 edges are named per the
 * project's rectangle convention so the entity serializer collapses
 * them into a single `SketchRectangleEntity`. `corner` is the
 * bottom-left (min X, min Y) — negative width/height is allowed and
 * normalized.
 */
export type SketchDrawRectangleCommand = {
  type: 'SketchDrawRectangle';
  sketchId: FeatureId;
  /** Bottom-left corner in sketch-plane coordinates (mm). */
  corner: [number, number];
  /** Extent along +X. May be negative. */
  width: number;
  /** Extent along +Y. May be negative. */
  height: number;
  /** Construction geometry. */
  construction?: boolean;
  /** Coincident-merge tolerance in mm. */
  tolerance?: number;
};

/**
 * Draw a circle from `center` and `radius`. The center point is
 * shared with any existing point at the same coordinates.
 */
export type SketchDrawCircleCommand = {
  type: 'SketchDrawCircle';
  sketchId: FeatureId;
  /** Center in sketch-plane coordinates (mm). */
  center: [number, number];
  /** Radius in mm (must be > 0). */
  radius: number;
  /** Construction geometry. */
  construction?: boolean;
  /** Coincident-merge tolerance in mm. */
  tolerance?: number;
};

/**
 * Draw a slot (stadium shape) from two end-cap centers + width.
 * The slot is two semicircles of radius `width / 2` connected by a
 * rectangle. Both centers snap to existing points within `tolerance`.
 */
export type SketchDrawSlotCommand = {
  type: 'SketchDrawSlot';
  sketchId: FeatureId;
  /** First end-cap center (mm). */
  center1: [number, number];
  /** Second end-cap center (mm). Must differ from center1. */
  center2: [number, number];
  /** Slot width = end-cap diameter (mm, > 0). */
  width: number;
  /** Construction geometry. */
  construction?: boolean;
  /** Coincident-merge tolerance in mm. */
  tolerance?: number;
};

/**
 * Draw an arc from `center` + `radius` + start/end angles (radians, CCW).
 * The arc's start and end points snap to existing coincident points,
 * so an arc joining a line endpoint shares the same `SketchPointId` and
 * forms a closed loop with the line.
 *
 * If `endAngle < startAngle`, the operation adds 2π so the geometry
 * always sweeps CCW (the orientation OCCT expects).
 */
export type SketchDrawArcCommand = {
  type: 'SketchDrawArc';
  sketchId: FeatureId;
  /** Center (mm). */
  center: [number, number];
  /** Radius (mm, > 0). */
  radius: number;
  /** Start angle in radians (CCW from +X). */
  startAngle: number;
  /** End angle in radians (CCW). Must differ from startAngle. */
  endAngle: number;
  /** Construction geometry. */
  construction?: boolean;
  /** Coincident-merge tolerance in mm. */
  tolerance?: number;
};

/**
 * Apply (or attempt to apply) a constraint to a sketch's editor state.
 *
 * One command for every constraint kind — the discriminator is the
 * `constraint.type` field on the embedded `SketchConstraintInput`. The
 * handler delegates to the pure `applyConstraint` primitive in
 * `sketch/operations.ts`, which appends to
 * `editorModel.constraints` without running the solver. The in-browser
 * editor re-solves on the next user interaction (drag, dimension edit).
 *
 * Conflict detection (rollback of conflicting constraints into a
 * separate bucket) is deferred to the editor's reactive solver — this
 * command's job is to record the constraint as the caller asked for it.
 * The caller gets the constraint id back via the document snapshot and
 * can call `SketchRemoveConstraint` if it later wants to revert.
 *
 * Provides the same ergonomics as the UI ribbon constraint
 * buttons: one command for "make horizontal", "make tangent", "set
 * length to 50mm", etc. — discriminated by which `SketchConstraint`
 * variant is in the input.
 */
export type SketchApplyConstraintCommand = {
  type: 'SketchApplyConstraint';
  sketchId: FeatureId;
  /** The constraint to apply. `id` may be omitted; the handler allocates one. */
  constraint: SketchConstraintInput;
};

/** Remove a constraint from a sketch by id. Idempotent (no-op on missing). */
export type SketchRemoveConstraintCommand = {
  type: 'SketchRemoveConstraint';
  sketchId: FeatureId;
  constraintId: SketchConstraintId;
};

// ---- Modify-tool sketch commands -----------------------------------------
//
// Each command takes fully-resolved inputs (geometry ids + cursor coords
// in sketch space) so the programmatic path and the UI dispatch path are
// structurally identical. The UI session collects clicks then dispatches
// one command; the modify primitives in
// `@tweakcad/core/src/sketch/modifyOps.ts` do all the math.

/**
 * Trim the picked geometry at the cursor location. The handler splits
 * the curve at every intersection with another curve, identifies the
 * sub-segment containing the cursor, and replaces the original with
 * the surviving sub-pieces (standard trim semantics).
 *
 *   - line  → ≤2 surviving sub-lines
 *   - arc   → ≤2 surviving sub-arcs
 *   - circle → 0–1 intersections = whole-delete; ≥2 = arc going CCW
 *     from prevCW to nextCCW (the side NOT under the cursor)
 *   - ellipse / spline / point → whole-delete
 */
export type SketchTrimCommand = {
  type: 'SketchTrim';
  sketchId: FeatureId;
  geometryId: import('../sketch/types.ts').SketchGeometryId;
  cursor: [number, number];
};

/**
 * Extend the picked LINE to the nearest other line's infinite extension.
 * Picks the closer end to push out. Only operates on lines today (arc
 * / spline / ellipse extend is a follow-up).
 */
export type SketchExtendCommand = {
  type: 'SketchExtend';
  sketchId: FeatureId;
  geometryId: import('../sketch/types.ts').SketchGeometryId;
};

/**
 * Round the corner where two lines meet at a shared endpoint with a
 * fillet arc. The corner is auto-detected (closest endpoint pair).
 * `radius` is optional — when omitted, defaults to min(10, shorter-leg/5).
 * The two lines' shared corner endpoints get moved inward to the
 * tangent points and a new arc lands on the bisector.
 */
export type SketchFilletCommand = {
  type: 'SketchFillet';
  sketchId: FeatureId;
  geometryAId: import('../sketch/types.ts').SketchGeometryId;
  geometryBId: import('../sketch/types.ts').SketchGeometryId;
  radius?: number;
};

/**
 * Parallel copy of a line or circle at a fixed distance. The side of
 * the offset is determined by the cursor — clicking on the +normal
 * side puts the copy on that side. Arc / ellipse / spline offset is
 * not yet supported (returns no-op).
 */
export type SketchOffsetCommand = {
  type: 'SketchOffset';
  sketchId: FeatureId;
  geometryId: import('../sketch/types.ts').SketchGeometryId;
  distance: number;
  cursor: [number, number];
  construction?: boolean;
};

/**
 * Mirror the listed geometries across a line defined by two points
 * (in sketch coords). Lines / circles / arcs are mirrored; other
 * types are skipped. Mirrored geometries get fresh points; the
 * originals are not modified. Symmetric constraints between paired
 * points are NOT yet emitted (follow-up).
 */
export type SketchMirrorCommand = {
  type: 'SketchMirror';
  sketchId: FeatureId;
  geometryIds: ReadonlyArray<import('../sketch/types.ts').SketchGeometryId>;
  axisA: [number, number];
  axisB: [number, number];
};

/**
 * Draw an arc through three points (start → mid → end). The mid is a
 * construction input only; the resulting arc geometry is identical to
 * what `SketchDrawArc` produces (center + radius + start/end angles).
 * Errors if the three points are collinear.
 */
export type SketchDrawArc3PointCommand = {
  type: 'SketchDrawArc3Point';
  sketchId: FeatureId;
  start: [number, number];
  mid: [number, number];
  end: [number, number];
  construction?: boolean;
  tolerance?: number;
};

/**
 * Draw a regular N-gon (inscribed: vertex on circumscribed circle).
 * Decomposed primitive — emits N lines + a construction center +
 * N coincident + (N−1) equal-length + (N−1) angle constraints
 * (no `SketchPolygon` composite). The `vertex`
 * point fixes orientation and the circumscribed radius. `sides` must
 * be an integer in [3, 64].
 */
export type SketchDrawPolygonCommand = {
  type: 'SketchDrawPolygon';
  sketchId: FeatureId;
  /** Polygon center (mm). */
  center: [number, number];
  /** A point on vertex 0 — defines orientation and radius. Must differ from center. */
  vertex: [number, number];
  /** Number of sides. Integer in [3, 64]. */
  sides: number;
  /** Construction mode. Only 'inscribed' is implemented. */
  mode?: 'inscribed';
  /** Construction geometry. */
  construction?: boolean;
  /** Coincident-merge tolerance in mm. */
  tolerance?: number;
};

/**
 * Place a standalone reference point. Allocates a `SketchPoint` (reusing
 * an existing one within tolerance) and wraps it in a
 * `SketchStandalonePoint` geometry.
 */
export type SketchDrawPointCommand = {
  type: 'SketchDrawPoint';
  sketchId: FeatureId;
  at: [number, number];
  construction?: boolean;
  tolerance?: number;
};

/**
 * Draw an ellipse from center + major-axis endpoint + minor radius.
 * The major endpoint defines both the major-axis length and the
 * ellipse's rotation.
 */
export type SketchDrawEllipseCommand = {
  type: 'SketchDrawEllipse';
  sketchId: FeatureId;
  center: [number, number];
  /** End of the major-axis radius from the center. */
  major: [number, number];
  /** Minor-axis radius in mm (must be > 0). */
  minorRadius: number;
  construction?: boolean;
  tolerance?: number;
};

/**
 * Draw a spline as an ordered sequence of control points. Each point
 * snaps to coincident existing points within tolerance. Needs ≥ 2 points.
 */
export type SketchDrawSplineCommand = {
  type: 'SketchDrawSpline';
  sketchId: FeatureId;
  points: ReadonlyArray<[number, number]>;
  construction?: boolean;
  tolerance?: number;
};

/**
 * Move an existing sketch point to new coordinates. Dispatched at
 * drag-end so each drag becomes one undo entry. Mid-drag positions
 * stay in the editor store and are not persisted.
 */
export type SketchMovePointCommand = {
  type: 'SketchMovePoint';
  sketchId: FeatureId;
  pointId: SketchPointId;
  to: [number, number];
};

/**
 * Move several sketch points to new coordinates atomically, then re-run
 * the solver with the moved set anchored — neighbours that share
 * coincident / parallel / etc. constraints follow the drag without
 * overriding the user-driven positions. One CadCommand = one undo
 * entry, even when N points moved. Used by the in-app drag handler
 * (geometry-level drag of a rectangle, slot, polygon, ...).
 *
 * If `moves` is empty the command is a no-op (no undo entry recorded
 * — `documentStore.mutate` skips empty patches).
 */
export type SketchMovePointsBatchCommand = {
  type: 'SketchMovePointsBatch';
  sketchId: FeatureId;
  moves: ReadonlyArray<{ pointId: SketchPointId; to: [number, number] }>;
};

// --- Feature Commands ---

export type CreateExtrudeCommand = {
  type: 'CreateExtrude';
  partId: PartId;
  inputs: ExtrudeFeatureInputs;
};

export type CreateRevolveCommand = {
  type: 'CreateRevolve';
  partId: PartId;
  inputs: RevolveFeatureInputs;
};

export type CreateFilletCommand = {
  type: 'CreateFillet';
  partId: PartId;
  inputs: FilletFeatureInputs;
};

export type CreateChamferCommand = {
  type: 'CreateChamfer';
  partId: PartId;
  inputs: ChamferFeatureInputs;
};

export type CreateLoftCommand = {
  type: 'CreateLoft';
  partId: PartId;
  inputs: LoftFeatureInputs;
};

export type CreateHoleCommand = {
  type: 'CreateHole';
  partId: PartId;
  inputs: HoleFeatureInputs;
};

export type CreatePatternCommand = {
  type: 'CreatePattern';
  partId: PartId;
  inputs: PatternFeatureInputs;
};

export type CreateMirrorCommand = {
  type: 'CreateMirror';
  partId: PartId;
  inputs: MirrorFeatureInputs;
};

export type CreateShellCommand = {
  type: 'CreateShell';
  partId: PartId;
  inputs: ShellFeatureInputs;
};

export type CreateSweepCommand = {
  type: 'CreateSweep';
  partId: PartId;
  inputs: SweepFeatureInputs;
};

export type CreateImportedGeometryCommand = {
  type: 'CreateImportedGeometry';
  partId: PartId;
  inputs: ImportedGeometryFeatureInputs;
};

export type CreateComponentInstanceCommand = {
  type: 'CreateComponentInstance';
  partId: PartId;
  inputs: ComponentInstanceFeatureInputs;
};

/**
 * Insert an instance of an embedded parametric component into a host
 * part's timeline. Handler upserts `component` into
 * `project.embeddedComponents[component.hash]` (idempotent on hash —
 * inserting the same .cadcomponent twice shares one entry) and
 * appends an `importedComponent` feature whose `componentRef` points
 * at that hash. Single command keeps embed + insert in one undo step.
 */
export type CreateImportedComponentCommand = {
  type: 'CreateImportedComponent';
  partId: PartId;
  /** Full embedded payload (hash + source). Handler stores under `embeddedComponents[hash]`. */
  component: ComponentDefinition;
  /**
   * Feature-instance inputs (everything except `componentRef`, which
   * the handler derives from `component.hash` so caller can't pass a
   * mismatched ref).
   */
  inputs: Omit<ImportedComponentFeatureInputs, 'componentRef'>;
};

export type CreateConstructionPlaneCommand = {
  type: 'CreateConstructionPlane';
  partId: PartId;
  inputs: ConstructionPlaneFeatureInputs;
};

// --- Edit Commands ---

export type UpdateFeatureInputCommand = {
  type: 'UpdateFeatureInput';
  partId: PartId;
  featureId: FeatureId;
  path: string[];
  value: unknown;
};

export type SuppressFeatureCommand = {
  type: 'SuppressFeature';
  partId: PartId;
  featureId: FeatureId;
  enabled: boolean;
};

/** Replace ALL inputs of a feature in a single mutation (one undo step, one rebuild). */
export type ReplaceFeatureInputsCommand = {
  type: 'ReplaceFeatureInputs';
  partId: PartId;
  featureId: FeatureId;
  inputs: Record<string, unknown>;
};

/** Toggle viewport visibility (show/hide) without affecting rebuild. */
export type SetFeatureVisibilityCommand = {
  type: 'SetFeatureVisibility';
  partId: PartId;
  featureId: FeatureId;
  visible: boolean;
};

export type DeleteFeatureCommand = {
  type: 'DeleteFeature';
  partId: PartId;
  featureId: FeatureId;
};

/**
 * FUTURE — not yet wired. Moves a feature to a new position in
 * `part.timeline` (the "drag a feature up/down in the tree" reorder).
 * Intentionally has no registered handler and no dispatcher today: there
 * is no timeline-reorder UI yet, so nothing emits it. Dispatching it now
 * returns `UNKNOWN_COMMAND`. When the reorder UI lands, the handler must
 * (a) reject moves that would place a feature before something it
 * `dependsOn`, and (b) mark dirty from `min(oldIndex, newIndex)` so the
 * rebuild pipeline recomputes downstream geometry.
 */
export type ReorderFeatureCommand = {
  type: 'ReorderFeature';
  partId: PartId;
  featureId: FeatureId;
  newIndex: number;
};

// --- Parameter Commands ---

export type SetParameterCommand = {
  type: 'SetParameter';
  scope: 'project' | PartId;
  name: string;
  value: ParameterValue;
};

export type DeleteParameterCommand = {
  type: 'DeleteParameter';
  scope: 'project' | PartId;
  name: string;
};

// --- Configuration Commands ---

/**
 * Upsert a configuration row in a part's `configurations.rows` array.
 * Creates the `configurations` table if it doesn't exist yet.
 */
export type SetConfigurationRowCommand = {
  type: 'SetConfigurationRow';
  partId: PartId;
  row: ConfigurationRow;
};

export type DeleteConfigurationRowCommand = {
  type: 'DeleteConfigurationRow';
  partId: PartId;
  rowId: string;
};

/**
 * Set the active configuration row for a part. `rowId: null` deactivates
 * any active config (parameters revert to their defaults).
 */
export type SetActiveConfigurationCommand = {
  type: 'SetActiveConfiguration';
  partId: PartId;
  rowId: string | null;
};

/**
 * Generate a human-readable label for a command (for undo/redo UI).
 * @param command - The command to label
 * @returns A descriptive label string
 */
export function commandLabel(command: CadCommand): string {
  switch (command.type) {
    case 'RenameProject':
      return `Rename Project`;
    case 'CreatePart':
      return `Create Part "${command.name}"`;
    case 'RenamePart':
      return `Rename Part`;
    case 'CreateSketch':
      return 'Create Sketch';
    case 'CreateSketchFromImport':
      return 'Import Sketch';
    case 'AddSketchEntity':
      return `Add ${command.entity.type}`;
    case 'SketchTrim':
      return 'Trim';
    case 'SketchExtend':
      return 'Extend';
    case 'SketchFillet':
      return 'Sketch Fillet';
    case 'SketchOffset':
      return 'Offset';
    case 'SketchMirror':
      return 'Sketch Mirror';
    case 'RemoveSketchEntity':
      return 'Remove Entity';
    case 'SketchDrawLine':
      return 'Draw Line';
    case 'SketchDrawRectangle':
      return 'Draw Rectangle';
    case 'SketchDrawCircle':
      return 'Draw Circle';
    case 'SketchDrawSlot':
      return 'Draw Slot';
    case 'SketchDrawArc':
      return 'Draw Arc';
    case 'SketchDrawArc3Point':
      return 'Draw 3-Point Arc';
    case 'SketchDrawPolygon':
      return `Draw Polygon (${command.sides} sides)`;
    case 'SketchDrawPoint':
      return 'Draw Point';
    case 'SketchDrawEllipse':
      return 'Draw Ellipse';
    case 'SketchDrawSpline':
      return 'Draw Spline';
    case 'SketchMovePoint':
      return 'Move Point';
    case 'SketchMovePointsBatch':
      return `Move ${command.moves.length} point${command.moves.length === 1 ? '' : 's'}`;
    case 'SketchApplyConstraint':
      return `Apply ${command.constraint.type} constraint`;
    case 'SketchRemoveConstraint':
      return 'Remove Constraint';
    case 'CreateExtrude':
      return `Create Extrude (${command.inputs.operation})`;
    case 'CreateRevolve':
      return `Create Revolve (${command.inputs.operation})`;
    case 'CreateLoft':
      return `Create Loft (${command.inputs.profiles.length} profiles, ${command.inputs.operation})`;
    case 'CreateFillet':
      return `Create Fillet (${command.inputs.edges.length} edges, r=${command.inputs.radius})`;
    case 'CreateChamfer':
      return `Create Chamfer (${command.inputs.edges.length} edges, d=${command.inputs.distance})`;
    case 'CreateHole':
      return `Create Hole (${command.inputs.kind})`;
    case 'CreatePattern':
      return 'Create Pattern';
    case 'CreateMirror':
      return `Create Mirror (${command.inputs.operation})`;
    case 'CreateShell':
      return `Create Shell (${command.inputs.removedFaces.length} face${command.inputs.removedFaces.length === 1 ? '' : 's'}, t=${command.inputs.thickness})`;
    case 'CreateSweep':
      return `Create Sweep`;
    case 'CreateImportedGeometry':
      return `Import ${command.inputs.fileName}`;
    case 'CreateComponentInstance':
      return `Insert Component "${command.inputs.componentName}"`;
    case 'CreateImportedComponent':
      return `Insert Component "${command.component.name}"`;
    case 'CreateConstructionPlane':
      return command.inputs.kind === 'offsetFromPlane'
        ? `Create Plane (offset ${command.inputs.offset}mm from plane)`
        : `Create Plane (offset ${command.inputs.offset}mm from face)`;
    case 'UpdateFeatureInput':
      return 'Update Feature';
    case 'ReplaceFeatureInputs':
      return 'Update Feature';
    case 'SuppressFeature':
      return command.enabled ? 'Enable Feature' : 'Suppress Feature';
    case 'SetFeatureVisibility':
      return command.visible ? 'Show Feature' : 'Hide Feature';
    case 'DeleteFeature':
      return 'Delete Feature';
    case 'ReorderFeature':
      return 'Reorder Feature';
    case 'SetParameter':
      return `Set Parameter "${command.name}"`;
    case 'DeleteParameter':
      return `Delete Parameter "${command.name}"`;
    case 'SetConfigurationRow':
      return `Set Configuration "${command.row.name}"`;
    case 'DeleteConfigurationRow':
      return `Delete Configuration`;
    case 'SetActiveConfiguration':
      return command.rowId ? `Activate Configuration` : `Clear Active Configuration`;
  }
}

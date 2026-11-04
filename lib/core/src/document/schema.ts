/**
 * Document model types for the .cadjson format.
 * These are the canonical source of truth for all CAD data.
 * Plain objects only - no classes, no methods.
 */

import type { PartId, FeatureId, BodyId, FaceId, EdgeId, StableFaceId, StableEdgeId, EntityId, ReferenceId, AssemblyId, InstanceId } from '../ids.ts';
import type { Transform3D, BoundingBox3D, MassProperties, Vec3 } from '../math.ts';
import type { Expression } from '../expressions.ts';
import type { ParameterUnit } from '../units.ts';

// --- Top-Level Project ---

export type CadProject = {
  /**
   * Format version — a monotonically increasing integer, not semver. See
   * `CURRENT_SCHEMA_VERSION` in `./version.ts` for the compatibility
   * contract: older migrates forward, newer is refused outright.
   */
  schemaVersion: number;
  // No `units` field. Every length in this document is millimetres and every
  // angle is degrees — see the units invariant in `../units.ts`. The field
  // used to be `units: 'mm' | 'inch'`, but nothing read it and nothing
  // converted, so a document declaring inches would have had every length
  // silently taken as millimetres. A field whose only legal value is 'mm'
  // carries no information; an inch *readout* is a formatting concern and
  // needs no storage.
  metadata: ProjectMetadata;
  parameters: ParameterTable;
  parts: Record<PartId, CadPart>;
  references: Record<ReferenceId, ReferenceAsset>;
  assemblies: Record<AssemblyId, CadAssembly>;
  embeddedComponents?: Record<string, ComponentDefinition>;
};

export type ProjectMetadata = {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
};

// --- Part ---

export type CadPart = {
  id: PartId;
  name: string;
  // No `transform` here on purpose. Placement belongs to an
  // {@link AssemblyInstance}, not to the part definition — a part placed
  // twice in an assembly needs two placements, and a definition can only
  // hold one. A part's own geometry is always authored at its local origin.
  parameters: ParameterTable;
  timeline: FeatureNode[];
  defaultPlanes: DefaultPlaneSet;
  /**
   * Optional named presets that override the part's parameter values.
   * Picking an active row applies its overrides on top of the parameter
   * table at rebuild time.
   */
  configurations?: ConfigurationTable;
  /**
   * Display colour per body, `#rrggbb`, keyed by body id. A body with no
   * entry shows the default appearance. Body ids survive edits (a cut or
   * join keeps the host's id), so the colour follows the body through the
   * timeline; an entry whose body no longer exists is ignored. 3MF and STEP
   * exports write these colours; STL has no colour.
   */
  bodyColors?: Record<string, string>;
};

/** The colour a body without a `bodyColors` entry is shown and exported in. */
export const DEFAULT_BODY_COLOR = '#6699cc';

/** `#rrggbb`, the only colour form `CadPart.bodyColors` holds. */
export const BODY_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** A stored body colour if it is well formed, else undefined. */
export function bodyColorOf(part: Pick<CadPart, 'bodyColors'>, bodyId: string): string | undefined {
  const c = part.bodyColors?.[bodyId];
  return c !== undefined && BODY_COLOR_PATTERN.test(c) ? c : undefined;
}

// --- Configurations (parameter presets) ---

export type ConfigurationTable = {
  /** Currently active row's id; null = use parameter defaults (no overrides). */
  active: string | null;
  rows: ConfigurationRow[];
};

export type ConfigurationRow = {
  /** Stable identifier (e.g. nanoid). Survives renames. */
  id: string;
  /** Display name (e.g. "M3×10"). Free-form. */
  name: string;
  /**
   * Per-parameter overrides as expressions. Names must exist in the
   * containing part's `parameters` table (or the project scope).
   * Missing names = use the parameter's default expression.
   */
  overrides: Record<string, Expression>;
};

export type DefaultPlaneSet = {
  XY: PlaneRef;
  XZ: PlaneRef;
  YZ: PlaneRef;
};

// --- Feature Node ---

export type FeatureNode = {
  id: FeatureId;
  type: FeatureType;
  name: string;
  version: number;
  enabled: boolean;
  /** Show/hide in viewport. Does NOT affect rebuild — hidden features still participate in booleans. */
  visible: boolean;
  inputs: Record<string, unknown>;
  dependsOn: FeatureId[];
  createdAt: string;
  updatedAt: string;
};

export type FeatureType =
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'loft'
  | 'hole'
  | 'shell'
  | 'sweep'
  | 'linearPattern'
  | 'circularPattern'
  | 'fillet'
  | 'chamfer'
  | 'mirror'
  | 'component'
  | 'constructionPlane'
  | 'importedGeometry'
  | 'primitive'
  | 'move'
  | 'boolean';

// --- Feature Status (in build artifacts, not in document) ---

export type FeatureStatus =
  | { state: 'clean' }
  | { state: 'dirty' }
  | { state: 'failed'; error: FeatureError }
  | { state: 'blocked'; blockedBy: FeatureId }
  | { state: 'suppressed' };

export type FeatureError = {
  /** `document`: the feature node itself is malformed (a field it must have is missing). */
  category: 'geometry' | 'reference' | 'parameter' | 'kernel' | 'document';
  code: string;
  message: string;
  suggestion?: string;
};

// --- Parameters ---

export type ParameterTable = {
  values: Record<string, ParameterValue>;
};

export type ParameterValue = {
  name: string;
  expression: Expression;
  unit: ParameterUnit;
  /**
   * When true, this parameter is shown in the import-component dialog as a
   * consumer-facing knob. Default false (internal helper parameter).
   * Used by the parametric-components flow.
   */
  public?: boolean;
  /** One-line helper text shown next to the input in the parameters editor. */
  description?: string;
  /**
   * `'number'` (default): `expression` is a numeric expression evaluated by
   *   the expression parser. Participates in `resolveAllParameters`.
   * `'choice'`: `expression` holds the currently-selected option from
   *   `options[]`. Does NOT enter the numeric resolved-params map; numeric
   *   expressions cannot reference choice parameters.
   */
  kind?: 'number' | 'choice';
  /** Allowed values when `kind === 'choice'`. Required iff kind is 'choice'. */
  options?: string[];
};

// --- Sketch Entities ---

export type SketchFeatureInputs = {
  plane: PlaneRef;
  /**
   * No `buildGeometry` field. The flat per-curve projection the worker and
   * region detector consume is derived on demand by `sketchBuildGeometry`
   * (`sketch/derivedGeometry.ts`), memoised on `editorModel` identity.
   *
   * It used to be persisted beside `editorModel` — a pure function of the
   * field two lines below it. Double the size in every saved document and
   * every autosave, a drift class guarded only by remembering to recompute
   * at six write sites, and a pointless round-trip where the serializer
   * stringified coordinates so the worker could parse them straight back.
   *
   * Its coordinates were `Expression` rather than `number`, which was the
   * only way a parameter reached sketch geometry — that is why this took so
   * long to remove. Parameters now drive *dimension constraints*, which the
   * solver enforces, rather than coordinates it is free to move.
  // NOTE: `constraints` (top-level dict, schema-side `SketchConstraint`) was
  // removed. It was a v0.1 placeholder for "lightweight,
  // Expression-driven, document-level constraints" that never got wired —
  // no UI wrote to it and no rebuilder read from it. The solver
  // (`sketch/solver/` — planegcs via the ISketchSolver
  // interface) supersedes it: real constraints live in
  // `editorModel.constraints` with their richer 19-variant editor type
  // (`sketch/types.ts`). When parametric sketch
  // dimensions ship, they'll be a new field designed for the post-solver
  // world, not a revival of this stub.
  // No `entityOrder` either. It was written by the FCStd converter and read
  // by nothing — entity identity comes from the ids themselves, and the
  // region detector does not care about declaration order.
  /**
   * The sketch's parametric model and editing source of truth: points,
   * curves held by point-reference, and constraints with stable IDs. The
   * in-browser editor and the planegcs solver operate on this; `buildGeometry`
   * is derived from it (never the reverse), so an edit mutates `editorModel`
   * and re-projects. Round-tripped across finish/edit cycles so constraints
   * and point IDs survive intact.
   *
   * Required: every sketch — drawn or imported — must carry its editing
   * source. An empty sketch holds the fixed origin point; importers build
   * the model through the same `operations.ts` builders the editor uses, then
   * derive `buildGeometry` from it. A sketch without it would be a
   * projection-only husk that cannot be edited or re-solved.
   */
  editorModel: SketchEditorSnapshot;
};

/**
 * Serializable snapshot of the sketch editor store.
 * Types `unknown` because the editor types live in `core/src/sketch/types.ts`
 * which has structurally-cloneable plain objects but uses branded IDs the
 * document layer doesn't need to validate against.
 */
export type SketchEditorSnapshot = {
  points: unknown[];
  geometries: unknown[];
  constraints: unknown[];
};

// NOTE: `SketchRectangleEntity` (type: 'rectangle') and `SketchSlotEntity`
// (type: 'slot') were removed during the sketch-commands unification.
// Per invariant #11 ("there is no rectangle"),
// every shape is curves + constraints — never a composite document entity.
// The in-editor drawRectangle / drawSlot primitives emit 4 lines / 2 lines +
// 2 arcs decompositions directly, and the editorModelToBuildGeometry serializer
// no longer collapses them back.
//
// This used to claim that older files "would still parse (they'd land in
// `entities` as foreign types and be ignored by the region detector)". That
// was never true: `buildSketch` reads `inputs.buildGeometry`, which such a
// file does not have, so it threw on `undefined`. The claim survived because
// `inputs` was validated as `z.record(z.unknown())` — the loader said yes and
// the worker then failed. Per-type validation now rejects that shape at load,
// which is what surfaced the six unloadable fixtures in `components/`.
//
// The three remaining primitive curves — ellipse, spline, point — are
// part of the document-entities projection. The
// worker doesn't tessellate them yet (only line / circle / arc enter
// the kernel today), but the projection gives constraint references
// and downstream tooling a stable per-curve id to work with.
export type SketchEntity =
  | SketchCircleEntity
  | SketchLineEntity
  | SketchArcEntity
  | SketchEllipseEntity
  | SketchSplineEntity
  | SketchBezierEntity
  | SketchPointEntity;

export type SketchCircleEntity = {
  id: EntityId;
  type: 'circle';
  center: [Expression, Expression];
  diameter: Expression;
  construction?: boolean;
};

export type SketchLineEntity = {
  id: EntityId;
  type: 'line';
  start: [Expression, Expression];
  end: [Expression, Expression];
  construction?: boolean;
};

export type SketchArcEntity = {
  id: EntityId;
  type: 'arc';
  center: [Expression, Expression];
  radius: Expression;
  startAngle: Expression;
  endAngle: Expression;
  construction?: boolean;
};

/**
 * Ellipse defined by center, the end-point of the major axis (which
 * encodes both major-radius and rotation as a single point), and the
 * minor radius. Editor representation matches one-for-one — see
 * `SketchEllipse` in `core/src/sketch/types.ts`.
 */
export type SketchEllipseEntity = {
  id: EntityId;
  type: 'ellipse';
  center: [Expression, Expression];
  majorEnd: [Expression, Expression];
  minorRadius: Expression;
  construction?: boolean;
};

/**
 * Quadratic Bezier-ish spline as an ordered control-point sequence
 * (≥2 points). Worker tessellation is a follow-up — currently used
 * for round-tripping a hand-drawn curve through the document.
 */
export type SketchSplineEntity = {
  id: EntityId;
  type: 'spline';
  points: ReadonlyArray<[Expression, Expression]>;
  construction?: boolean;
};

/**
 * Cubic Bezier curve: `start`/`end` are on-curve endpoints, `cp1`/`cp2` the
 * off-curve control poles. The document counterpart of the editor's
 * `SketchBezier`. SVG `C`/`Q` path segments import to this 1:1.
 */
export type SketchBezierEntity = {
  id: EntityId;
  type: 'bezier';
  start: [Expression, Expression];
  cp1: [Expression, Expression];
  cp2: [Expression, Expression];
  end: [Expression, Expression];
  construction?: boolean;
};

/**
 * Standalone reference point, not attached to any other geometry.
 * Useful as a constraint anchor (point-on-line, distance-to-point)
 * without committing to a full curve.
 */
export type SketchPointEntity = {
  id: EntityId;
  type: 'point';
  at: [Expression, Expression];
  construction?: boolean;
};

// --- Sketch Constraints ---
//
// The schema-side `SketchConstraint` type (a 6-variant Expression-valued
// union) and its supporting `EntityRef` / `EntityPointRef` were removed
// along with the dead `SketchFeatureInputs.constraints` field.
// They were a v0.1 placeholder for "lightweight document-level constraints"
// that never got wired. The solver
// (`sketch/solver/` — planegcs via the ISketchSolver
// interface) uses the richer 19-variant `SketchConstraint` from
// `sketch/types.ts` instead, persisted in
// `SketchFeatureInputs.editorModel.constraints`.

// --- Extrude ---

export type ExtrudeFeatureInputs = {
  /** One or more profile references. Multi-profile extrude creates one timeline entry. */
  profiles: ProfileRef[];
  operation: 'newBody' | 'join' | 'cut';
  direction: DirectionSpec;
  extent: ExtentSpec;
  /**
   * Shift of the profile along the extrude direction before extruding.
   * With `startFrom` set it is measured from that plane instead of from
   * the sketch plane.
   */
  startOffset?: Expression;
  /**
   * Start the extrude from this plane instead of the sketch plane: a body
   * face (`stableTopology`, must be planar) or a construction / default
   * plane. The profile is moved along the sketch
   * normal onto it, and the face is re-resolved on every rebuild, so the
   * extrude follows it when upstream dimensions change. Absent = start at
   * the sketch plane.
   */
  startFrom?: PlaneRef;
  targetBodies?: BodyRef[];
};

/**
 * How far an extrude goes. `toPlane` extrudes up to a plane: a default or
 * construction plane, or a planar body face (`stableTopology`),
 * re-resolved on every rebuild.
 */
export type ExtentSpec =
  | { type: 'distance'; value: Expression }
  | { type: 'throughAll' }
  | { type: 'toPlane'; plane: PlaneRef }
  | { type: 'symmetric'; value: Expression };

/**
 * Profile reference stored in the extrude feature.
 * References a sketch + the entity IDs forming the wire boundary
 * (a sketch plus a subset of named sub-edges).
 */
export type ProfileRef = {
  /** The sketch that contains the profile geometry. */
  sketchId: FeatureId;

  /**
   * Entity IDs forming the wire boundary of this profile.
   * For a circle: ["circle_E"]
   * For a rectangle: ["rect_base"]
   * For a line loop: ["line_A", "line_B", "line_C", "line_D"]
   */
  wireEntityIds: EntityId[];

  /**
   * A 2D point known to be inside this region, in sketch-local coordinates.
   * Used for disambiguation when the same entity IDs participate in multiple
   * detected regions (overlapping/intersecting geometry).
   * Not needed for simple non-intersecting cases.
   */
  interiorPoint?: [number, number];
};

// --- Revolve ---

/**
 * Revolve a sketch profile around an axis to create a solid body.
 * Built with OCCT's BRepPrimAPI_MakeRevol; a 360° revolve of a closed
 * profile with an axis offset produces a torus-section solid.
 */
export type RevolveFeatureInputs = {
  /** The closed profile to revolve. Single profile per revolve feature. */
  profile: ProfileRef;
  /** Axis of revolution. Default planes work; custom needs origin + direction. */
  axis: AxisSpec;
  /** Sweep angle in degrees. 360 = full revolve. */
  angle: Expression;
  operation: 'newBody' | 'join' | 'cut';
  /** Optional offset along the profile normal before revolving. */
  startOffset?: Expression;
  targetBodies?: BodyRef[];
};

// --- Fillet ---

/**
 * Round one or more edges of an existing body with a constant-radius
 * fillet. First feature in the codebase that consumes EdgeRef.stableTopology
 * — its edge refs survive upstream rebuilds via the topology-naming layer.
 */
export type FilletFeatureInputs = {
  /**
   * Edges to fillet. Ordered for human-readability in the timeline; the
   * kernel doesn't care about order. All edges must belong to the same
   * body (the schema doesn't enforce this — the builder rejects mixed
   * bodies with a clear diagnostic).
   */
  edges: EdgeRef[];
  /** Fillet radius (Expression so parameters can drive it). */
  radius: Expression;
  /** Optional body override; otherwise inferred from the first edge's bodyRef. */
  targetBody?: BodyRef;
};

// --- Chamfer ---

/**
 * Bevel one or more edges of an existing body with a constant-distance
 * symmetric chamfer. Mirrors {@link FilletFeatureInputs} field-for-field
 * — same EdgeRef.stableTopology input, same all-edges-same-body
 * constraint enforced in the builder — but produces a flat cut surface
 * instead of a rounded one. Kernel-side: BRepFilletAPI_MakeChamfer.
 *
 * v1 ships symmetric (equal setback on both adjacent faces).
 * Asymmetric (`d1, d2`) and angle (`distance + angle`) variants are
 * deferred until a real workflow demands them; the schema can grow a
 * discriminated `mode` field without breaking existing chamfer features
 * (the current shape is implicitly `mode: 'symmetric'`).
 */
export type ChamferFeatureInputs = {
  /**
   * Edges to chamfer. Same ordering + same-body rules as Fillet.
   */
  edges: EdgeRef[];
  /** Setback distance on each adjacent face (Expression). */
  distance: Expression;
  /** Optional body override; otherwise inferred from the first edge's bodyRef. */
  targetBody?: BodyRef;
};

// --- Loft ---

/**
 * Loft a solid through 2+ closed profile sections.
 * Built with OCCT's BRepOffsetAPI_ThruSections; two parallel circles of
 * different diameters produce a cone frustum, three coaxial profiles a
 * lens, etc.
 *
 * Profile order is significant — the resulting surface interpolates
 * between consecutive entries in the order given.
 */
export type LoftFeatureInputs = {
  /**
   * Ordered profile sections, 2..16 entries. May come from different
   * sketches. All profiles must resolve to closed wires; mixed open/closed
   * causes the build to fail with a clear diagnostic.
   */
  profiles: ProfileRef[];
  operation: 'newBody' | 'join' | 'cut';
  /**
   * If true, OCCT uses straight (ruled) segments between profiles instead
   * of fitting a smooth surface. Faster and produces simpler topology.
   */
  ruled?: boolean;
  /**
   * If true, the loft closes back from the last profile to the first,
   * producing a closed loop (think: torus from circles around an axis).
   */
  closed?: boolean;
  targetBodies?: BodyRef[];
};

// --- Operation Effect (consumed/created body tracking) ---

export type OperationEffect = {
  consumed: BodyId[];
  created: BodyId[];
};

// --- Construction Plane ---

/**
 * A datum plane — pure reference geometry, not a body. Downstream features
 * (sketch base, Hole face) consume it via a `PlaneRef.constructionPlane`
 * or `FaceRef.constructionPlane`. Grown incrementally as the
 * supporting pickers ship — deferred plane modes include angle-through-
 * edge, midplane, two-edges, three-points, and tangent-at-point.
 */
export type ConstructionPlaneFeatureInputs =
  /**
   * Parallel to an existing plane (default XY/XZ/YZ or another
   * construction plane) with a signed offset along that plane's
   * normal. The base is captured as a {@link PlaneRef} so the UI's
   * click-pick overlay can hand back either variant uniformly.
   */
  | {
      kind: 'offsetFromPlane';
      basePlane: PlaneRef;
      /** Signed offset along the base plane's normal, in mm. */
      offset: Expression;
    }
  /**
   * Parallel to a picked face's tangent plane with a signed offset
   * along the face's outward normal. The face is resolved via the
   * topology-tracker layer just like a Fillet edge — survives upstream
   * rebuilds. Offset 0 produces a plane coincident with the face
   * (useful as a named reference to that face's plane).
   */
  | {
      kind: 'offsetFromFace';
      face: FaceRef;
      offset: Expression;
    };

// --- Sweep ---

/**
 * Sweep a closed profile along a path (spine) to produce a solid.
 * Wraps OCCT's `BRepOffsetAPI_MakePipe` via occt-wasm `pipe(profile,
 * spine)`.
 *
 * V1 scope:
 *  - Profile = a closed sketch region (rectangle / circle / wire-loop).
 *    Resolves through the same profile-region picker the Extrude /
 *    Loft / Revolve features already use.
 *  - Path = a closed sketch region too. The builder extracts the
 *    boundary wire from the resolved path face and feeds it to
 *    occt-wasm's `pipe` as the spine. Closed-path sweeps include the
 *    canonical "circle profile + circle path = torus" workflow.
 *  - `operation: 'newBody'` only. Boolean composition with existing
 *    bodies (`join` / `cut`) is a v2 follow-up — the schema reserves
 *    the field so it can grow without migration.
 *
 * V2 deferred work (tracked separately, not blocking v1):
 *  - **Open-wire paths.** Needs an open-chain detector + a kernel
 *    method that returns a wire (not a face) from a chain of sketch
 *    entities. Depends on tangent-edge chain selection landing first.
 *  - **Body-edge paths** — pick edges on an existing body as the
 *    spine. Same dependency as above.
 *  - **Boolean composition** (`join` / `cut`).
 *  - **Guide rail**, transition mode, twist/scale-along-path.
 */
export type SweepFeatureInputs = {
  /** Closed sketch profile that gets swept. */
  profile: ProfileRef;
  /**
   * Closed sketch region whose boundary wire is the sweep path. The
   * sweep follows the outer boundary of this region (inner holes are
   * ignored). v1 closes-only restriction; open-wire paths land in v2.
   */
  path: ProfileRef;
  /**
   * Boolean composition with existing bodies. v1 only accepts
   * `'newBody'`; the field is here to forward-compat without a schema
   * migration when join/cut land.
   */
  operation: 'newBody';
  /** Reserved for `join` / `cut` operation modes. v1 ignores. */
  targetBodies?: BodyRef[];
};

// --- Shell ---

/**
 * Hollow a solid body to a uniform wall thickness, optionally removing
 * one or more faces so the cavity opens through them.
 *
 * Kernel-side (`occt-wasm.shellWithHistory`):
 *  - `solid`           = the source body's shape handle.
 *  - `facesToRemove[]` = ShapeHandles of faces left open (0 or more).
 *                        v1 requires at least one — a zero-removed-face
 *                        shell produces a closed hollow body, which has
 *                        legitimate uses (interior cavity) but is rarely
 *                        the user's intent and easy to add later.
 *  - `thickness`       = wall thickness in mm. Stored positive in the
 *                        schema; the builder negates before calling OCCT
 *                        so the wall grows *inward* from the original
 *                        surface (the common default). Outward shell
 *                        is a deferred toggle.
 *  - `tolerance`       = numerical tolerance for the offset surface fit.
 *                        Default 1e-3 (occt-wasm's loose preset);
 *                        precise shells can pass 1e-6.
 *
 * Topology naming: occt-wasm's `shellWithHistory` reports per-face
 * evolution, so faces on the resulting shell trace back to the source
 * body's stable IDs via the same path used by fillet/chamfer.
 * Edges fall back to hash-match (history is face-only on the facade).
 */
export type ShellFeatureInputs = {
  /** Body to hollow. Single-body v1. */
  sourceBody: BodyRef;
  /**
   * Faces left open after shelling — the cavity opens through these
   * faces. Each must lie on `sourceBody`; the builder rejects mixed-
   * body input with a clear diagnostic (same all-edges-same-body rule
   * as Fillet). 1..N faces.
   */
  removedFaces: FaceRef[];
  /**
   * Wall thickness in mm, positive. Always grows inward in v1
   * (builder negates before passing to OCCT). An `outward` toggle can
   * land in a follow-up without a schema migration if a workflow needs
   * it.
   */
  thickness: Expression;
  /**
   * Numerical tolerance for OCCT's offset-surface fit. Optional;
   * defaults to 1e-3 (the loose preset most CAD UX uses).
   * Pass 1e-6 for precise shells.
   */
  tolerance?: number;
};

// --- Imported Geometry (STEP / STL) ---

/**
 * Import geometry from a STEP (.step / .stp) or STL (.stl) file as a
 * timeline feature. The feature stores the file's raw bytes (base64-
 * encoded) so the .cadjson is self-contained — projects can be
 * opened anywhere without the original file. Cost: ~33% size bloat
 * from base64, fine for v1.
 *
 * One feature = one file = N bodies. STEP files commonly arrive as a
 * compound containing multiple solids; the kernel decomposes via
 * `getSubShapes(shape, 'solid')` so each solid becomes its own
 * `KernelBody` with its own stable face/edge IDs. Single-solid
 * files return a one-body result.
 *
 * V1 limitations (clearly flagged):
 *  - Plain `importStep` only — no XCAF. Names, colors, and assembly
 *    hierarchy aren't preserved. Will switch to `xcafImportSTEP`
 *    when our document model grows multi-body assemblies (today
 *    `CadProject.assemblies` is a stub `{}`).
 *  - No re-import on file change. The bytes are captured at import
 *    time; user must delete + re-import to refresh from disk.
 *  - STL produces a faceted shell with no analytical curves —
 *    boolean ops still work but the topology is purely triangular.
 *
 * One feature per file maps to a multi-body result.
 */
/**
 * Payload of an imported file: embedded, or referenced out of the document.
 *
 * Both carry `sizeBytes` so a reader can report or budget without decoding
 * base64 or fetching a blob — a project tree showing "bracket.step · 18 MB"
 * should not have to materialise 18 MB to draw that label.
 */
export type ImportedGeometryData =
  | { kind: 'inline'; base64: string; sizeBytes: number }
  | { kind: 'ref'; referenceId: ReferenceId; sizeBytes: number };

/**
 * Above this, an import should become a `ref` rather than being embedded.
 *
 * 256 KB covers the overwhelming majority of real parts — a bracket, a
 * fastener, a printed enclosure — so the common case stays self-contained and
 * portable. What it excludes is the scanned assembly or vendor STEP that
 * would otherwise make the document unopenable in a text editor and slow to
 * autosave.
 *
 * Enforced at import: `makeImportedData` returns `ref` above this and the
 * import pipeline registers the asset alongside the feature.
 */
export const IMPORT_INLINE_MAX_BYTES = 256 * 1024;

export type ImportedGeometryFeatureInputs = {
  /** Original filename — shown as the timeline label and tooltip. */
  fileName: string;
  /** File format. `step` covers both .step and .stp; `stl` is its own format; `brep` covers .brep / .brp. */
  format: 'step' | 'stl' | 'brep';
  /**
   * Where the file bytes live.
   *
   * `inline` keeps the document self-contained — ship one file and it opens
   * anywhere. `ref` points at an entry in `CadProject.references`, which the
   * SaaS layer can store as its own blob instead of inside the document.
   *
   * The discriminator exists from the start because adding one to a bare
   * string later is the breaking part; the threshold that decides between
   * them, and the resolver behind `ref`, are both additive. Imports are the
   * only unbounded thing a `.cadjson` carries: base64 inflates bytes by a
   * third, and until autosave stopped minting a revision per keystroke
   * burst, a 20 MB STEP was re-uploaded whole every two seconds.
   *
   * Which one you get is decided by `IMPORT_INLINE_MAX_BYTES`, in
   * `makeImportedData`. A `ref`'s asset is registered in the same mutation
   * that appends the feature, so a document never references bytes it did
   * not store.
   */
  data: ImportedGeometryData;
  /**
   * Optional rigid placement applied to ALL imported bodies as a group
   * (the whole import moves together). Absent/identity = "as imported".
   * Reserved for a future "Move all"; per-body Move uses `bodyTransforms`.
   */
  transform?: Transform3D;
  /**
   * Per-body rigid placement, keyed by the body's index in the imported
   * set ("0", "1", …) — a STEP compound decomposes into N solids and each
   * can be moved independently. The Move gizmo (right-click one body →
   * Move) edits this entry's `position` (v1 is translate-only; rotation is
   * carried forward). `buildImportedGeometry` applies the per-body
   * transform, then the group `transform` on top, via `kernel.transform`.
   */
  bodyTransforms?: Record<string, Transform3D>;
};

// --- Mirror Body ---

/**
 * Mirror an existing body across a plane to produce its reflection.
 *
 * v1 semantics:
 *  - One source body (`sourceBody`). Multi-body mirror is a follow-up.
 *  - One mirror plane (`PlaneRef`) — default planes XY/XZ/YZ, a named
 *    construction plane, or (future) a planar face. Kernel-side OCCT only
 *    needs origin + outward normal; basis u/v don't matter for the mirror
 *    transform.
 *  - `operation`:
 *      `newBody`  → keep the mirrored copy as a separate body alongside
 *                   the source (default; matches "Mirror as new body").
 *      `join`     → fuse the mirrored copy back with the source — gives
 *                   a single symmetric body, the most common workflow
 *                   when modelling a left/right-symmetric part from one
 *                   half. Kernel pipeline: mirror → booleanFuse.
 *
 * Topology naming: the kernel's `mirror` op uses occt-wasm's
 * `mirrorWithHistory`, so stable face/edge IDs on the mirrored copy
 * derive from the source body's IDs via the per-input-face evolution
 * mapping. Downstream features that picked a face on the mirrored copy
 * survive subsequent rebuilds.
 */
export type MirrorFeatureInputs = {
  /**
   * Body to mirror. v1 is single-body; the `targetBodies` field is
   * reserved for forward compatibility with multi-body mirror without a
   * schema migration.
   */
  sourceBody: BodyRef;
  /**
   * Plane to mirror across. `defaultPlane` (XY/XZ/YZ) is the v1 happy
   * path; `constructionPlane` works once the user has a named CP in
   * scope. `featureOutput` and `stableTopology` (face-as-plane) are
   * accepted by the schema but resolved by the existing
   * `resolvePlaneRef` helper, which currently rejects them — they'll
   * light up when that helper grows the corresponding kinds.
   */
  plane: PlaneRef;
  /**
   * Boolean composition with the source body.
   *  - `newBody`: emit the mirror as a separate body alongside the
   *    source (default; "mirror to new body").
   *  - `join`: fuse the mirror back into the source so the result is a
   *    single symmetric body. Most common when modelling a symmetric
   *    half.
   */
  operation: 'newBody' | 'join';
  /**
   * Optional forward-compatibility slot for multi-body mirror. Ignored
   * in v1; reserved so the field can be populated later without a
   * schema migration.
   */
  targetBodies?: BodyRef[];
};

// --- Hole ---

/**
 * Drill a hole through the picked face into a body.
 *
 * Geometry pipeline (see `packages/worker/src/featureBuilders/buildHole.ts`):
 *   1. Resolve `face` → face plane (origin + outward normal).
 *   2. Build a primary cylinder anchored at the face surface, axis = the
 *      *inward* direction (face normal flipped), height = blind depth or
 *      a through-all distance derived from the target body's AABB.
 *   3. For `counterbore`, fuse a wider, shallower cylinder on top.
 *   4. For `countersink`, fuse a cone (r1 = csink-rim radius, r2 = 0) on
 *      top — height derived from the user-supplied included angle.
 *   5. Boolean-cut the assembled tool body from the face's parent body.
 *
 * `center` is the in-plane (u, v) offset of the hole axis from the face's
 * surface centroid. v1 always emits [0, 0] (auto-center); the field is
 * reserved for the eventual click-to-position UX (drag-on-face
 * placement).
 *
 * `counterbore*` / `countersink*` fields are consulted only when `kind`
 * matches. Kept at the top level (rather than a discriminated union per
 * kind) so the dialog can preserve user-entered values when toggling the
 * Hole kind dropdown.
 */
export type HoleFeatureInputs = {
  face: FaceRef;
  center: [Expression, Expression];
  direction: DirectionSpec;
  diameter: Expression;
  extent: ExtentSpec;
  kind: 'simple' | 'counterbore' | 'countersink';
  /** Counterbore (cylindrical recess) head diameter. Required when kind = 'counterbore'. */
  counterboreDiameter?: Expression;
  /** Counterbore depth into the body, measured from the face surface. */
  counterboreDepth?: Expression;
  /** Countersink (conical recess) rim diameter at the face surface. Required when kind = 'countersink'. */
  countersinkDiameter?: Expression;
  /** Countersink full included angle in degrees (90° is the ISO 7046 default; 82° matches Imperial flatheads). */
  countersinkAngle?: Expression;
  targetBodies?: BodyRef[];
};

// --- Boolean ---

/**
 * Combine existing bodies with a boolean operation.
 *
 * Extrude, revolve and the rest each carry their own `operation` field, which
 * covers the common case of "make this shape and subtract it as you go". What
 * they cannot express is combining two bodies that already exist — two
 * imports, two primitives, an extrude and a component — because neither one
 * is being created at the moment the combination is wanted.
 *
 * Like {@link MoveFeatureInputs} this is a **modifier**: the result carries
 * the primary target's id (see `bodyIdentity.ts`), so a `FaceRef` captured
 * before the boolean still resolves after it. Tool bodies are consumed and
 * their ids retire — they are now part of the target.
 */
export type BooleanFeatureInputs = {
  /**
   * `union` fuses everything into one body. `subtract` removes the tools from
   * the target. `intersect` keeps only the overlap.
   */
  operation: 'union' | 'subtract' | 'intersect';
  /**
   * The body that survives, and whose id the result carries. For `union` and
   * `intersect` the distinction is only about identity, not geometry.
   */
  targetBody: BodyRef;
  /** Bodies combined into the target and consumed. At least one. */
  toolBodies: BodyRef[];
};

// --- Move ---

/**
 * Reposition bodies that have nowhere else to store a placement.
 *
 * Imported geometry and components carry a `transform` on their own inputs,
 * because the thing being placed arrived whole and the feature that produced
 * it *is* the placement. A body that came out of an extrude, revolve or
 * boolean has no such home: its position is a consequence of a sketch on a
 * plane and a distance, so there is no field to put a translation in without
 * inventing one on every builder.
 *
 * A timeline feature is the parametric answer. "Move" cannot be a free drag
 * of the mesh — the mesh is regenerated on every rebuild, so the gesture has
 * to become a **stored, replayable value**. This is that value.
 *
 * It is a **modifier**: the moved bodies keep their ids (see `bodyIdentity.ts`)
 * so a `BodyRef` or a captured `FaceRef` taken before the move still resolves
 * after it. Bodies not listed in `targetBodies` pass through untouched.
 */
export type MoveFeatureInputs = {
  /**
   * Bodies to reposition. Refs that no longer resolve are skipped rather than
   * failing the feature — deleting the extrude upstream of a move should not
   * also break the move, it should leave it with nothing to do.
   */
  targetBodies: BodyRef[];
  /** Rigid placement applied in world space, on top of where the body already is. */
  transform: Transform3D;
};

// --- Primitive ---

/**
 * A solid created from numbers alone — no sketch, no profile, no face pick.
 *
 * Every other solid-producing feature starts from a sketch, which makes the
 * cheapest possible body (a 10 mm cube to test a boolean, a cylinder to cut a
 * shaft clearance) cost a plane choice, a rectangle and an extrude. The kernel
 * has had `makeBox`/`makeCylinder`/`makeCone` all along; `makeSphere` and
 * `makeTorus` were added alongside this feature so all five are reachable.
 *
 * **Placement is one `Transform3D`, not a per-shape axis field.** Each shape
 * is built in its own canonical local frame — centred on the local origin,
 * axis of revolution along +Y to match the app's Y-up convention and the
 * default XZ sketch plane — and the transform places it. So orientation works
 * the same way for all five, a box can be rotated off-axis (an `axis` field
 * could not express that), and the UI can grow a full placement gizmo without
 * a schema change. `transform` matches `ComponentFeatureInputs`, which
 * already places geometry this way.
 *
 * Centred rather than corner- or base-anchored, uniformly: one rule instead of
 * five, a primitive dropped at the origin is symmetric about it (so mirrors and
 * symmetric cuts line up), and it matches how `symmetric` extrude straddles its
 * sketch plane.
 */
export type PrimitiveFeatureInputs = {
  shape: PrimitiveShape;
  /**
   * Placement in part space. The primitive is built centred on its local
   * origin, so `position` is where its centre lands and `rotation` orients
   * its local +Y (the axis of revolution, for the shapes that have one).
   */
  transform: Transform3D;
  operation: 'newBody' | 'join' | 'cut';
  /**
   * Bodies `join`/`cut` act against. Empty/absent means every body in the
   * part, matching Extrude.
   */
  targetBodies?: BodyRef[];
};

/**
 * Dimensions, discriminated by shape. A union rather than Hole's flat
 * top-level fields: switching Hole kind keeps most values meaningful
 * (diameter, depth, position), switching primitive shape shares nothing but
 * the placement, so there is nothing for a flat shape to preserve.
 *
 * Box dimensions are named for the axes they span in the primitive's local
 * frame (`width` = X, `height` = Y, `depth` = Z), matching `BoxSpec`.
 */
export type PrimitiveShape =
  | { kind: 'box'; width: Expression; height: Expression; depth: Expression }
  | { kind: 'cylinder'; radius: Expression; height: Expression }
  | { kind: 'sphere'; radius: Expression }
  /**
   * Truncated cone. `topRadius: 0` is a pointed cone; `topRadius` equal to
   * `bottomRadius` is a cylinder (allowed — the kernel copes, and rejecting
   * it would fight a user dragging a slider).
   */
  | { kind: 'cone'; bottomRadius: Expression; topRadius: Expression; height: Expression }
  /**
   * `majorRadius` is centre-to-tube-centre, `minorRadius` the tube itself.
   * The builder rejects `minorRadius >= majorRadius`, which would be a
   * self-intersecting solid that only fails later inside a boolean.
   */
  | { kind: 'torus'; majorRadius: Expression; minorRadius: Expression };

/** Every shape a `primitive` feature can take. */
export const PRIMITIVE_KINDS = ['box', 'cylinder', 'sphere', 'cone', 'torus'] as const;

export type PrimitiveKind = typeof PRIMITIVE_KINDS[number];

// --- Pattern ---

/**
 * Replicate a body in a regular pattern. v1 ships **body-level**
 * patterns (replicating whole bodies)
 * because that's what the kernel exposes natively
 * (`linearPattern(body, dir, spacing, count)`,
 * `circularPattern(body, center, axis, angle, count)`).
 *
 * Feature-level patterning (replicating the source feature, keeping the
 * originals) requires re-running the source feature builder once per
 * transformed instance and merging *WithHistory across instances —
 * that's a v2 task. The schema reserves `sourceBody` instead of
 * `sourceFeature` to keep the door open for both modes; a future
 * `mode: 'body' | 'feature'` discriminator can pick.
 */
export type PatternFeatureInputs =
  | LinearPatternInputs
  | CircularPatternInputs;

/**
 * Linear (rectangular) body pattern. Produces `count` copies spaced
 * `spacing` mm apart along `direction` (the original is instance #0;
 * `count = 1` is a no-op). v1 only exposes X/Y/Z directions in the
 * dialog; the schema accepts any AxisSpec so custom directions
 * (e.g. along a picked edge) light up later without a schema change.
 */
export type LinearPatternInputs = {
  patternType: 'linear';
  /** Body to replicate. Single-body v1. */
  sourceBody: BodyRef;
  /**
   * Direction of replication. v1 dialog emits `{ type: 'x' | 'y' | 'z' }`;
   * `custom` is parsed by the kernel via the picked-edge → direction
   * follow-up. Origin (when AxisSpec is `custom`) is ignored — only the
   * direction component drives linear pattern.
   */
  direction: AxisSpec;
  /** Total instance count including the source. Evaluates to a positive integer. */
  count: Expression;
  /** Center-to-center spacing in mm between consecutive instances. */
  spacing: Expression;
};

/**
 * Circular (polar) body pattern. Produces `count` copies evenly
 * distributed around `axis` over `fullAngle` (defaults to 360°).
 * The source counts as instance #0; `count = 1` is a no-op.
 */
export type CircularPatternInputs = {
  patternType: 'circular';
  /** Body to replicate. Single-body v1. */
  sourceBody: BodyRef;
  /** Axis of rotation. Origin matters — defines the rotation center. */
  axis: AxisSpec;
  /** Total instance count including the source. Evaluates to a positive integer. */
  count: Expression;
  /**
   * Total sweep angle in degrees (default 360 = full revolution). v1
   * dialog defaults to 360; partial sweeps land as an inputs follow-up
   * without a schema change.
   */
  fullAngle?: Expression;
};

// --- Imported Component (parametric components) ---

/**
 * Inputs for the `component` feature type — a single instance of
 * an embedded parametric component placed into the host part's timeline.
 *
 * v1 = feature-mode: the component's sub-timeline is
 * rebuilt by the worker and its bodies are added to (or boolean-composed
 * with) the host part. The component itself lives in
 * `project.embeddedComponents[componentRef]` — same .cadjson shape as a
 * full project, but with exactly one part inside.
 *
 * Behaviour:
 *  - `transform` places every body the component produces, applied before
 *    any boolean so a `cut` instance subtracts where the user put it.
 *  - `parameterOverrides` + `configurationId` are applied at rebuild
 *    time on top of the component's own parameter table (merge
 *    order: defaults → config row → per-instance overrides).
 *  - `boolean` mirrors `ExtrudeFeatureInputs.operation` — `cut` lets a
 *    screw component punch its own hole into the host body, `join`
 *    fuses a mounting boss into a chassis, `newBody` keeps them
 *    separate (most common; default).
 */
export type ComponentFeatureInputs = {
  /** Lookup key into `CadProject.embeddedComponents`. The component's content hash. */
  componentRef: string;
  /**
   * Position + orientation in host-part local space. Defaults written by
   * the handler are origin + identity quaternion; the placement panel in
   * the component dialog edits it as millimetres and Euler degrees.
   */
  transform: Transform3D;
  /**
   * Per-instance parameter overrides keyed by parameter name. Applied
   * on top of the active configuration row's overrides at rebuild
   * time. Empty record = no per-instance customisation.
   */
  parameterOverrides: Record<string, Expression>;
  /**
   * Which row of the component's configurations table is active for
   * THIS instance:
   *  - a row id: that row, whatever the component's own active row is;
   *  - `null`: no row — the component's parameter defaults (the dialog's
   *    "(use defaults)");
   *  - missing: inherit the component's own `configurations.active`
   *    (which may itself be `null`, meaning defaults).
   * Per-instance config wins over the component-internal active row so
   * two screws can be different sizes from the same embedded component.
   */
  configurationId?: string | null;
  /**
   * Boolean op against existing host bodies in the part.
   *  - `newBody` (default): keep the component as separate bodies.
   *  - `cut`:    subtract the component bodies from every host body.
   *  - `join`:   fuse the component bodies with every host body.
   * Mirrors `ExtrudeFeatureInputs.operation`.
   */
  boolean: 'newBody' | 'cut' | 'join';
};

// --- References ---

/**
 * A plane a feature anchors to. `stableTopology` names a planar body face:
 * a sketch on it uses the frame from `sketchFrameOnPlane`
 * (`sketch/facePlane.ts`), and extrude start / extent planes use its plane.
 * The face is resolved asynchronously through the kernel on every rebuild
 * (`resolvePlaneRefAsync` in the worker), so the anchor follows the face.
 */
export type PlaneRef =
  | { type: 'defaultPlane'; name: 'XY' | 'YZ' | 'XZ' }
  | { type: 'constructionPlane'; planeId: string }
  | { type: 'featureOutput'; featureId: FeatureId; output: string }
  | { type: 'stableTopology'; bodyRef: BodyRef; stableFaceId: StableFaceId; repairHint?: RepairHint };

export type FaceRef =
  | { type: 'defaultPlane'; name: 'XY' | 'YZ' | 'XZ' }
  | { type: 'constructionPlane'; planeId: string }
  | { type: 'featureOutput'; featureId: FeatureId; output: string }
  | { type: 'stableTopology'; bodyRef: BodyRef; stableFaceId: StableFaceId; repairHint?: RepairHint };

/**
 * Reference to an edge on a body. Mirrors {@link FaceRef} but for edges.
 * The only kind that lives across rebuilds is `stableTopology`; the others
 * are reserved for future symmetry with construction-edge constructs.
 */
export type EdgeRef =
  | { type: 'featureOutput'; featureId: FeatureId; output: string }
  | { type: 'stableTopology'; bodyRef: BodyRef; stableEdgeId: StableEdgeId; repairHint?: RepairHint };

export type BodyRef = {
  partId: PartId;
  bodyId: BodyId;
};

export type DirectionSpec =
  | { type: 'normal' }
  | { type: 'reversed' }
  | { type: 'custom'; vector: Vec3 };

export type AxisSpec =
  | { type: 'x' }
  | { type: 'y' }
  | { type: 'z' }
  | { type: 'custom'; origin: Vec3; direction: Vec3 };

/**
 * What a picked face or edge looked like when it was picked, stored next to
 * its stable id. On rebuild the kernel checks the entity the id resolves to
 * against it: when that entity has changed but another one is still exactly
 * the hinted geometry, the id has come to name something else and the ref
 * follows the untouched one; when the id is not found at all, the closest
 * match stands in for it (`chooseByHint` in `lib/kernel/src/repairHint.ts`).
 * Taken from the topology map at pick time, which computes it in the kernel
 * with the same measures the check uses.
 *
 * Faces: `center` and `size` of the face's bounding box, and `normal`
 * for planar faces only. Edges: `center` (linear centre of mass),
 * `length`, and `direction` for straight edges only. A field present in
 * the hint must be present on the candidate, so a planar face does not match
 * a curved one and a line does not match an arc.
 */
export type RepairHint = {
  geometrySignature?: string;
  /** Where it is: a face's bounding-box centre, an edge's centre of mass. */
  center?: Vec3;
  /** Unit normal of a planar face. */
  normal?: Vec3;
  /** Diagonal of a face's bounding box. */
  size?: number;
  /** Unit direction of a straight edge (sign ignored when matching). */
  direction?: Vec3;
  /** Edge length. */
  length?: number;
};

// --- Selection ---

export type Selection =
  | { type: 'part'; partId: PartId }
  | { type: 'body'; partId: PartId; bodyId: BodyId }
  | { type: 'face'; partId: PartId; bodyId: BodyId; faceId: FaceId }
  | { type: 'edge'; partId: PartId; bodyId: BodyId; edgeId: EdgeId }
  | { type: 'feature'; partId: PartId; featureId: FeatureId }
  | { type: 'sketchEntity'; sketchId: FeatureId; entityId: EntityId }
  | { type: 'plane'; plane: PlaneRef };

// --- Build Artifacts (separate from document, disposable) ---

export type ProjectBuildArtifact = {
  documentRevision: string;
  builtAt: string;
  parts: Record<PartId, PartBuildArtifact>;
  diagnostics: Diagnostic[];
};

export type PartBuildArtifact = {
  partId: PartId;
  status: 'success' | 'partial' | 'failed';
  bodies: BuiltBody[];
  featureResults: Record<FeatureId, FeatureBuildResult>;
  topologyIndex?: TopologyIndex;
};

export type BuiltBody = {
  bodyId: BodyId;
  sourceFeatureId: FeatureId;
  role: string;
  displayMesh: DisplayMesh;
  boundingBox: BoundingBox3D;
  massProperties?: MassProperties;
};

export type DisplayMesh = {
  bodyId: BodyId;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edgePositions?: Float32Array;
};

/**
 * Worker→main-thread shape for a construction plane's viewport display.
 *
 * The plane itself is pure math (origin + 3-vector basis), so unlike a
 * solid body we don't ship a tessellated mesh. The viewport's
 * `ConstructionPlaneLayer` constructs the translucent rectangle locally
 * sized to the scene bounding box. We do ship `name` + `visible` so the
 * viewport can label the plane and honor the timeline's eye toggle
 * without re-reading the document.
 */
export type ConstructionPlaneDisplay = {
  featureId: FeatureId;
  /** User-facing name shown as a label next to the plane. */
  name: string;
  /** Whether to render it. Mirrors `FeatureNode.visible`. */
  visible: boolean;
  origin: Vec3;
  uAxis: Vec3;
  vAxis: Vec3;
  normal: Vec3;
};

/**
 * Worker→main-thread world frame of a sketch placed on a body face
 * (`PlaneRef.stableTopology`). Published on every rebuild so the editor
 * draws and edits the sketch where the worker resolved it — the face moves
 * when upstream dimensions change, and only the worker can resolve it.
 */
export type SketchPlaneDisplay = {
  featureId: FeatureId;
  origin: Vec3;
  uAxis: Vec3;
  vAxis: Vec3;
  normal: Vec3;
};

export type FeatureBuildResult =
  /**
   * `warnings`: the feature built, but not quite as authored (see
   * `BuildResult.warnings`). Absent when there are none.
   */
  | { featureId: FeatureId; status: 'success'; bodies: BuiltBody[]; warnings?: string[] }
  | { featureId: FeatureId; status: 'suppressed' }
  | { featureId: FeatureId; status: 'blocked'; blockedBy: FeatureId }
  | { featureId: FeatureId; status: 'failed'; error: FeatureError };

export type TopologyIndex = {
  bodyTopologies: Record<BodyId, TopologyMap>;
};

export type TopologyMap = {
  bodyId: BodyId;
  faces: {
    faceId: FaceId;
    triStart: number;
    triEnd: number;
    semanticRef?: string;
    /**
     * Stable identifier that survives rebuilds. Optional during the
     * topology-naming layer rollout; will be required once feature
     * builders consume it via FaceRef.stableTopology.
     */
    stableFaceId?: StableFaceId;
    /** The face's {@link RepairHint}, copied into a FaceRef when it is picked. */
    repairHint?: RepairHint;
  }[];
  edges: {
    edgeId: EdgeId;
    lineSegments: Float32Array;
    adjacentFaces: [FaceId, FaceId];
    /** Stable edge identifier — see {@link StableEdgeId}. Optional during topology-naming rollout. */
    stableEdgeId?: StableEdgeId;
    /** The edge's {@link RepairHint}, copied into an EdgeRef when it is picked. */
    repairHint?: RepairHint;
  }[];
};

// --- Diagnostics ---

export type Diagnostic = {
  id: string;
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  featureId?: FeatureId;
  entityId?: string;
  recoverable: boolean;
  suggestedFixes?: SuggestedFix[];
};

export type SuggestedFix = {
  label: string;
  command: unknown;
};

// --- Stubs for future features ---

/**
 * A file the document refers to rather than embeds.
 *
 * `CadProject.references` has been declared and empty since the schema was
 * written. It is the destination for an `ImportedGeometryData` of kind
 * `'ref'`: the document keeps the metadata and the bytes live elsewhere —
 * inside the archive for a future `.cadpack`, or as a separate blob for a
 * cloud project.
 *
 * `bytes` is optional precisely because the point is to not carry them. A
 * loader that has the archive populates it; one that only has the `.cadjson`
 * leaves it absent, and a builder that needs the geometry reports a missing
 * reference rather than silently producing an empty body.
 */
export type ReferenceAsset = {
  id: ReferenceId;
  /** Original filename, for display and for re-linking from disk. */
  name: string;
  type: 'step' | 'stl' | 'brep';
  sizeBytes: number;
  /** SHA-256 (hex) of the bytes — pins which version this document built against. */
  hash: string;
  /** Base64 bytes, when this reader has them. Absent means "resolve elsewhere". */
  bytes?: string;
};

/**
 * An assembly: a tree of placed instances.
 *
 * **Not built yet** — `CadProject.assemblies` is `{}` in every document the
 * app writes today, and no builder or viewport code reads this. It is
 * defined now, pre-launch, because one field in {@link AssemblyInstance}
 * cannot be added later without migrating every saved file: `instanceId`.
 *
 * Everything an assembly eventually needs — joints, per-instance visibility,
 * suppression, appearance overrides, exploded-view offsets, BOM quantities —
 * is an optional field or a separate table keyed by `instanceId`, so all of
 * it is additive once instance identity exists. Nothing else is reserved
 * here; adding an optional field to an object is free, and a field nothing
 * reads is a field that lies.
 */
export type CadAssembly = {
  id: AssemblyId;
  name: string;
  /**
   * True for the assembly the document opens as. Exactly one assembly in
   * `CadProject.assemblies` should carry it. Structural rather than
   * behavioural: a tree needs a designated entry point, and inferring one
   * after the fact ("the first key", "the one nothing references") is
   * ambiguous the moment a document has two top-level assemblies.
   */
  root: boolean;
  instances: AssemblyInstance[];
};

/**
 * One placement of a part or a sub-assembly.
 *
 * `instanceId` is the whole reason this type exists now. Without it, two
 * placements of the same part are indistinguishable — there is no way to say
 * "the left bracket" rather than "a bracket". Every downstream assembly
 * feature needs that distinction: a joint connects two *instances*, never two
 * part definitions; per-instance visibility, suppression and appearance are
 * keyed by it; BOM quantities count it.
 */
export type AssemblyInstance = {
  instanceId: InstanceId;
  /** What is placed. The union is what makes sub-assemblies possible. */
  of:
    | { kind: 'part'; partId: PartId }
    | { kind: 'assembly'; assemblyId: AssemblyId };
  /** Placement relative to the parent assembly's frame. */
  transform: Transform3D;
};

/**
 * An embedded parametric component.
 *
 * Stored in `CadProject.embeddedComponents`, keyed by `hash` (so the
 * dict key matches the field — easy lookup-and-verify). The full
 * sub-document `source` is embedded so .cadjson is self-contained
 * (ship one file → consumer can open it offline, no broken links).
 *
 * Multiple `component` features that reference the same hash
 * share this one entry — 20 screws of the same size cost one copy of
 * the source, not 20.
 */
export type ComponentDefinition = {
  /**
   * SHA-256 of canonical-JSON serialization of `source`. Also the
   * dict key in `CadProject.embeddedComponents`. Pins the exact
   * version the host was built against; "re-link from disk" can
   * detect drift by re-hashing the on-disk file.
   */
  hash: string;
  /** Human-readable name from the source file. Cached for tree display. */
  name: string;
  /** Author-provided semver string from source metadata. Optional. */
  version?: string;
  /** Original filename / path the user picked. Cached for "re-link" UX. */
  origin?: string;
  /** ISO timestamp of when this was embedded into the host project. */
  embeddedAt: string;
  /**
   * The full sub-document. Same CadProject shape as the host; we just
   * nest. The rebuilder runs `source.parts[firstPartId].timeline`
   * through the same builder dispatch the host part uses.
   */
  source: CadProject;
};

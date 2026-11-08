/**
 * What the version-2 worker service hands the app. Everything here is plain
 * data that structured cloning carries across a worker boundary; meshes are
 * typed arrays, so they can be transferred instead of copied.
 *
 * A **key** is a small integer naming one entity of the kept evaluation: a
 * face, edge, vertex or body, a sketch curve, point or region, or a
 * construction output. Keys are valid until the next `evaluate`; the
 * `generation` of the display they came with says which evaluation that is.
 */
import type { EntityKind, EntityRecord, Loop, NameTableJson } from '@tweakcad/format';
import type { CurveShape, JsonSet } from '@tweakcad/format';

export type Key = number;
export type Vec3 = [number, number, number];
/** A unit quaternion `[x, y, z, w]` (2.7). */
export type Quat = [number, number, number, number];

/** A frame: origin and unit axes, `normal` = x × y. */
export interface FrameDisplay {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  normal: Vec3;
}

/** A rigid placement `p ↦ R·p + T` (2.7). */
export interface Placement {
  position: Vec3;
  rotation: Quat;
}

/** Where an entity lies: one build of a part (a definition), or an assembly. */
export type Scope = { definition: number } | { assembly: string };

/** What a key names. */
export interface EntityInfo {
  key: Key;
  kind: EntityKind;
  scope: Scope;
  /** The key of the body it lies on; a body's is its own; null for sketch entities and construction outputs. */
  body: Key | null;
  /** The feature that created it; for a sketch entity, its sketch. */
  feature: string;
  /** False for an entity of a state before a feature that the display does not show. */
  shown: boolean;
}

/**
 * One body shape's display mesh and pick tables, in its part's frame.
 * Triangles of one face are contiguous; segments of one edge are contiguous.
 */
export interface BodyMesh {
  /** XYZ per vertex. */
  positions: Float32Array;
  /** XYZ unit normal per vertex. */
  normals: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** Per face: first triangle, triangle count, face key. */
  faces: Uint32Array;
  /** Edge polylines as line segments: two XYZ points per segment. */
  segments: Float32Array;
  /** Per drawn edge: first segment, segment count, edge key. Seams and degenerate edges are not drawn. */
  edges: Uint32Array;
  /** XYZ per vertex entity. */
  points: Float32Array;
  /** The key of each point. */
  vertices: Uint32Array;
}

/** How a face or body shows (16.1). `color` is `#rrggbb`. */
export interface Style {
  color: string;
  opacity: number;
  visible: boolean;
}

/**
 * One live body of a part: one solid, meshed on its own even where a feature
 * left several solids in one shape. A part's bodies come in creation order
 * (7.3's creation key), which numbers their default names.
 */
export interface BodyDisplay extends Style {
  /** The body entity. */
  key: Key;
  /** Its identity, the same in every evaluation that holds the body: a preview's display and the committed one share it. */
  id: string;
  /** The feature that created it. */
  feature: string;
  /** Its `name` attribute, or "Body n" by its place in creation order. */
  name: string;
  /** Faces that show otherwise than the body. */
  faceStyles: (Style & { key: Key })[];
  mesh: BodyMesh;
  /**
   * The id of the mesh's geometry (its positions, normals, triangles,
   * segments and points), the same in every display of the same body
   * shape; absent for an unmeshed body.
   */
  geometry?: number;
  /** A hidden body no display has meshed yet: its mesh is empty until it shows. */
  unmeshed?: true;
  /**
   * As the worker sends it: the geometry is the one the client holds under
   * `geometry` (empty arrays are sent), and only the pick tables (`faces`,
   * `edges`, `vertices`) are. The client fills it in, so a display the app
   * sees never has it.
   */
  kept?: true;
}

export interface SketchCurveDisplay {
  key: Key;
  /** The curve root (8.1), or the text row of a glyph contour. */
  root: string;
  /** Construction curves and external curves that bound no region draw as such. */
  construction: boolean;
  /** A polyline in the part frame: XYZ per point. */
  points: Float32Array;
}

export interface SketchRegionDisplay {
  key: Key;
  /** Its region row, or null for a detected region no row holds yet. */
  row: string | null;
  /** Closed polylines in the part frame, XYZ per point: the outer loop, then each hole. */
  loops: Float32Array[];
}

export interface SketchDisplay {
  feature: string;
  frame: FrameDisplay;
  visible: boolean;
  curves: SketchCurveDisplay[];
  /** The external curves as built, in the sketch frame, for a sketch editor's solve. */
  externals: { id: string; shape: CurveShape; bounds: boolean }[];
  points: { key: Key; id: string; at: Vec3 }[];
  regions: SketchRegionDisplay[];
  /** Degrees of freedom the solve left (0: fully defined); absent when evaluated without a solver. */
  dof?: number;
}

export interface ConstructionDisplay {
  key: Key;
  feature: string;
  kind: 'plane' | 'axis' | 'point' | 'frame';
  /** A plane is its xy plane, an axis its z axis through its origin, a point its origin. */
  frame: FrameDisplay;
  visible: boolean;
}

/**
 * A cosmetic thread (a `core.thread` or a tapped `core.hole` that is not
 * modelled): data on cylindrical faces that the geometry does not show, so
 * the viewport draws it over them. Lengths in mm, in the part's frame.
 */
export interface ThreadDisplay {
  /** The feature that made it. */
  feature: string;
  /** The threaded faces the display shows, by key; a face a later feature split shows as its pieces. */
  faces: Key[];
  designation: string;
  class: string;
  /** In a hole, or on a shaft. */
  internal: boolean;
  pitch: number;
  /** The radius of the threaded cylinder. */
  radius: number;
  /** Where the thread starts on the faces' axis, the unit direction it runs in from there, and how far. */
  start: Vec3;
  direction: Vec3;
  length: number;
  /** Present on a left-handed thread only. */
  hand?: 'left';
}

/** One build of a part: a part of the document, or a variant an insertion made (12.1, 11.1). */
export interface DefinitionDisplay {
  index: number;
  /** The part's id in the document it comes from. */
  part: string;
  /** Empty for a part of this document as it stands; otherwise the build's variant key. */
  variant: string;
  /** The feature the part is shown just before (its rollback, 7.1), or null for the end of the timeline. */
  rollback: string | null;
  bodies: BodyDisplay[];
  sketches: SketchDisplay[];
  construction: ConstructionDisplay[];
  /** The cosmetic threads on its bodies' faces. */
  threads: ThreadDisplay[];
}

/** A placed part in an assembly, nested instances flattened: one per placed copy of a definition. */
export interface InstanceDisplay {
  /** Its instance path (9.1), outermost first. */
  path: unknown;
  definition: number;
  /** Where the pose solve put it, in the assembly frame. */
  placement: Placement;
  /** What an attribute on an instance along its path sets over everything inside it (16.1). */
  override: Partial<Style>;
  visible: boolean;
}

export interface AssemblyDisplay {
  id: string;
  instances: InstanceDisplay[];
  /** Each solved joint's values by degree of freedom (mm, deg). */
  joints: Record<string, Record<string, number>>;
  /** Each solved joint's end frames in the assembly: `b` is `a` moved by the joint's values (12.1). */
  jointFrames: Record<string, { a: Placement; b: Placement }>;
  activePosition: string | null;
  /** Each exploded view (12.1): every instance's placement in it, by its index in `instances`. */
  exploded: Record<string, Placement[]>;
}

export interface Pause {
  feature: string;
  message: string;
  through?: string[];
}

/** A shape's volume and box, in the part's frame. */
export interface ShapeMeasures {
  volume: number;
  /** Centre of mass. */
  center: Vec3;
  min: Vec3;
  max: Vec3;
}

/** The display output of one evaluation. */
export interface Display {
  generation: number;
  /**
   * The generation of the display before, when this one only shows it
   * otherwise (display-only changes: appearance, visibility, names): no
   * evaluation ran, and every key of that display names the same entity.
   */
  restyled?: number;
  definitions: DefinitionDisplay[];
  /** The definition index of each part of the document. */
  parts: Record<string, number>;
  assemblies: AssemblyDisplay[];
  /** Every key handed out so far, by key. */
  entities: EntityInfo[];
  pauses: Pause[];
  stale: Pause[];
  outOfDate: { part: string; context: string; reason: string }[];
  /**
   * Milliseconds spent evaluating and building the display, how many
   * features a cache let it skip, and why it took over no more: the first
   * feature each part rebuilt from and what changed there, or why the
   * evaluation started afresh.
   */
  /** Times in ms; features taken over from the evaluation before (`resumed`), placings of instances taken over (`placed`), and why the cache missed. */
  timing: { evaluate: number; display: number; resumed: number; placed?: number; misses?: string[] };
}

/** A picked entity, as a feature input stores it. */
export interface PickedEntity {
  /** The reference to write: `{"entity": record}`. */
  reference: { entity: EntityRecord };
  /** The name-table entries the record uses that the document lacks. */
  names: NameTableJson;
}

/** A detected region that no region row holds yet: the command writes the row, then references it. */
export interface PickedRegion {
  region: { sketch: string; loop: Loop; holes: JsonSet<Loop> };
}

export type Picked = PickedEntity | PickedRegion;

/** What to pick: a key, and for an instance in an assembly, the assembly and the instance's index in its display. */
export interface PickTarget {
  key: Key;
  instance?: { assembly: string; index: number };
}

/** How a pick is written. */
export interface PickOptions {
  /** Against the part just before this feature, for a feature being edited. */
  before?: string;
  /**
   * For a pick through an instance: the instance path (9.1), in the same
   * assembly, of the part that holds the reference. Its snapshot is then
   * written in that part's frame, as an in-context reference's is (9.7).
   */
  frameOf?: unknown;
}

export type Resolved = { outcome: 'same'; keys: Key[] } | { outcome: 'ask'; suggestions: Key[] } | { outcome: 'gone' };

/** Where a reference is read: a part of the document, before one of its features or as displayed; or an assembly. */
export type ResolveScope = { part: string; before?: string } | { assembly: string };

/**
 * A part as it stands just before one of its features: the state a panel
 * on that feature picks in. A feature the part does not hold (a new one,
 * not yet in the evaluated document) stands at the part's rollback.
 */
export interface BeforeScope {
  part: string;
  feature: string;
}

/**
 * Where a stored reference lies in a part's state before a feature, drawn
 * in the part's frame: a face or a body as triangles (`positions` xyz,
 * `indices` three per triangle), an edge as line segments (`segments`, two
 * xyz points each).
 */
export type PickOutline =
  { kind: 'face' | 'body'; positions: Float32Array; indices: Uint32Array } | { kind: 'edge'; segments: Float32Array };

/** One body of a part's state before a feature, as the browser and a panel list it. */
export interface ListedBody extends Style {
  /** The body entity, in the evaluation the listing came from; it may be one the display does not show. */
  key: Key;
  /** Its identity, as `BodyDisplay.id`. */
  id: string;
  /** The feature that created it. */
  feature: string;
  /** Its `name` attribute, or "Body n" by its place in creation order, as the display names it. */
  name: string;
  /** Its reference written against that state, when asked for. */
  picked?: PickedEntity;
}

/** Where a stored reference lands in a part's state before a feature. */
export interface PlacedReference {
  /** False when it resolves to nothing there. */
  found: boolean;
  /** What it names, when known. */
  kind: EntityKind | null;
  /** The identity (`ListedBody.id`) of the body it lies on; null for sketch entities, construction outputs and references not found. */
  body: string | null;
}

/** The bodies of a part's state before a feature, and where stored references land there. */
export interface BodiesBefore {
  /** The evaluation the keys belong to: the `generation` of the display it made. */
  generation: number;
  bodies: ListedBody[];
  /** One per record asked about, in order. */
  references: PlacedReference[];
}

export type MeasureKind = 'distance' | 'length' | 'area' | 'volume' | 'angle' | 'radius';

export type Measured = { value: number; quantity: string } | { pause: string };

/** A body's mass properties in its part's frame and base units: volume, surface area, centre of mass, and its bounding box (min and max corners). */
export interface BodyMeasures {
  volume: number;
  area: number;
  centroid: Vec3;
  bbox: [Vec3, Vec3];
}

/** The curves an external sketch row would take from a model entity (8.1), in the order its index counts them. */
export type ExternalCandidates = { shapes: CurveShape[] } | { pause: string };

export type ExportFormat = 'stl' | '3mf' | 'step' | 'brep';

export interface ExportOptions {
  /** The bodies to export, by key; all shown bodies by default. */
  bodies?: Key[];
  /** The file's object name (3MF), or its header and solid name (STL). */
  name?: string;
  /** Chord deviation in mm for meshed formats. */
  linearDeflection?: number;
  angularDeflection?: number;
  /** STL as text rather than binary. */
  ascii?: boolean;
}

export interface EvaluateServiceOptions {
  /** Display mesh chord deviation in mm, and angle in radians. */
  linearDeflection?: number;
  angularDeflection?: number;
  /**
   * False leaves the bodies out of the display and meshes nothing: for a
   * caller after the pauses and the evaluated state, not a picture (an
   * import's finishing). Picks and locators work on the evaluation as ever.
   */
  meshes?: boolean;
  /**
   * The generation of the display whose document this one differs from only
   * in what is shown: the attributes of parts and assemblies, a part's
   * rollback, and name-table entries no feature holds. When the kept evaluation is that display's,
   * nothing is evaluated: the display is made again from it with the new
   * attributes, and a body the client holds the mesh of is not meshed again.
   * The service checks it: anything else of the document that differs from
   * the kept one (a feature row), another evaluation kept, a name
   * a feature holds come or gone, or a value a feature read that reads
   * otherwise, and the document is evaluated as usual.
   */
  restyle?: number;
  /**
   * The geometries the client holds (`BodyDisplay.geometry`): a body whose
   * geometry is among them is sent as kept. None by default.
   */
  held?: number[];
  /**
   * A panel's preview, shown at the parts' rollbacks: each part is built only
   * up to its rollback, since the features after it do not show. The
   * evaluation is kept beside the last one that was not a preview, so a
   * cancelled preview resumes from that one, and nothing is shown from it
   * but its rollbacks (a later `restyle` evaluates).
   */
  preview?: boolean;
}

/**
 * Where a running evaluation stands, as the worker reports it while it
 * works: reading the document, building feature `done + 1` of `total`
 * (`kept` of them taken over from the evaluation before), placing the
 * assemblies' parts, meshing body `done + 1` of `total`.
 */
export type Progress =
  | { phase: 'reading' }
  | {
      phase: 'building';
      done: number;
      total: number;
      kept: number;
      part: string;
      feature: string;
      name: string;
      type: string;
    }
  | { phase: 'placing' }
  | { phase: 'meshing'; done: number; total: number };

/** A context to re-capture (12.4), and instance paths it should hold besides those its part references. */
export interface ContextRequest {
  part: string;
  context: string;
  include?: Record<string, unknown>[];
}

/** A feature frozen (7.2): its `frozen` field, with the asset rows and name-table entries the document lacks; or why it cannot be. */
export type FrozenResult =
  | { ok: true; frozen: Record<string, unknown>; assets: Record<string, unknown>; names: NameTableJson }
  | { ok: false; message: string };

/** Re-captured contexts: each context's new row, with the asset rows and name-table entries the document lacks. */
export interface ContextsUpdate {
  /** False when automatic passes did not settle; nothing is returned then. */
  settled: boolean;
  passes: number;
  contexts: { part: string; context: string; row: Record<string, unknown> }[];
  assets: Record<string, unknown>;
  names: NameTableJson;
}

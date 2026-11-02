/**
 * CadKernel - abstract interface for geometry operations.
 * The kernel exposes geometry operations, not product features.
 * A HoleFeature is implemented by the feature builder as makeCylinder + booleanCut.
 */

import type { Result } from '@tweakcad/core/src/result.ts';
import type { Vec3, Transform3D, BoundingBox3D, MassProperties } from '@tweakcad/core/src/math.ts';
import type { DisplayMesh, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import type { StableFaceId, StableEdgeId } from '@tweakcad/core/src/ids.ts';
import type { RepairHint } from '@tweakcad/core/src/document/schema.ts';
import type {
  KernelBody,
  KernelFace,
  KernelEdge,
  ResolvedProfile,
  ResolvedPlane,
  ResolvedAxis,
  CylinderSpec,
  ConeSpec,
  BoxSpec,
  SphereSpec,
  TorusSpec,
  TessellationOptions,
  StlExportOptions,
  StepExportOptions,
  ThreeMfExportOptions,
  KernelError,
} from './types.ts';

export interface CadKernel {
  /** Initialize the kernel (load WASM, etc.) */
  init(): Promise<void>;

  // --- Sketch to face ---

  /** Create a face from a resolved sketch profile */
  createSketchFace(profile: ResolvedProfile): Promise<Result<KernelFace, KernelError>>;

  // --- Solid creation ---

  /**
   * Extrude a face along a direction vector.
   *
   * `origin` is forwarded to the topology tracker so stable face/edge
   * IDs derive deterministically from (origin, walk-index). Passing the
   * source feature's id (`node.id`) ensures the same extrude rebuilding
   * the same profile produces the same stable IDs every time — so a
   * user-captured FaceRef survives subsequent rebuilds.
   */
  extrudeFace(face: KernelFace, vector: Vec3, origin?: string): Promise<Result<KernelBody, KernelError>>;

  /**
   * Revolve a face around an axis. Uses OCCT's BRepPrimAPI_MakeRevol.
   * The axis is in world coordinates; the face must not be coincident with it.
   * @param angleRad Sweep angle in radians (2π for a full revolve).
   * @param copy Whether OCCT should copy the input face (defaults false).
   * @param origin Source tag for deterministic stable IDs (see extrudeFace).
   */
  revolve(
    face: KernelFace,
    axis: ResolvedAxis,
    angleRad: number,
    copy?: boolean,
    origin?: string,
  ): Promise<Result<KernelBody, KernelError>>;

  /**
   * Loft a solid through 2+ closed profile faces. Uses OCCT's
   * BRepOffsetAPI_ThruSections. Profile order is significant — the
   * resulting surface interpolates between consecutive faces.
   * @param faces 2..16 closed-profile faces.
   * @param options.ruled  Use straight (ruled) segments instead of smooth fit.
   * @param options.closed Close back from last face to first (loop).
   * @param origin Source tag for deterministic stable IDs.
   */
  loft(
    faces: KernelFace[],
    options?: { ruled?: boolean; closed?: boolean },
    origin?: string,
  ): Promise<Result<KernelBody, KernelError>>;

  /** Create a cylinder primitive. `origin` tags the body for stable IDs. */
  makeCylinder(spec: CylinderSpec, origin?: string): Promise<Result<KernelBody, KernelError>>;

  /**
   * Create a (possibly truncated) cone primitive. Used by the Hole
   * builder's countersink mode. `radius2 = 0` produces a pointed cone.
   * `origin` tags the body for stable IDs.
   */
  makeCone(spec: ConeSpec, origin?: string): Promise<Result<KernelBody, KernelError>>;

  /** Create a box primitive. `origin` tags the body for stable IDs. */
  makeBox(spec: BoxSpec, origin?: string): Promise<Result<KernelBody, KernelError>>;

  /** Create a sphere. `origin` tags the body for stable IDs. */
  makeSphere(spec: SphereSpec, origin?: string): Promise<Result<KernelBody, KernelError>>;

  /**
   * Create a torus about `spec.axis`. Rejects `minorRadius >= majorRadius`,
   * which OCCT would build as a self-intersecting solid that only fails
   * later inside a boolean. `origin` tags the body for stable IDs.
   */
  makeTorus(spec: TorusSpec, origin?: string): Promise<Result<KernelBody, KernelError>>;

  // --- Boolean operations ---

  /** Fuse (union) multiple bodies */
  booleanFuse(targets: KernelBody[]): Promise<Result<KernelBody, KernelError>>;

  /** Cut tool bodies from a target body */
  booleanCut(target: KernelBody, tools: KernelBody[]): Promise<Result<KernelBody, KernelError>>;

  /** Intersect multiple bodies */
  booleanIntersect(targets: KernelBody[]): Promise<Result<KernelBody, KernelError>>;

  /**
   * Split a body into one independent body per connected solid. A solid
   * input returns a single-element array; a compound returned by a fuse
   * of disjoint inputs returns one body per disjoint solid. Used by the
   * Extrude builder to fuse touching profiles while keeping disjoint
   * ones separate for newBody operations.
   *
   * The input body's handle is unaffected; the returned bodies own
   * fresh stable-id ranges keyed off `origin`.
   */
  decomposeBody(body: KernelBody, origin: string): Promise<KernelBody[]>;

  // --- Modify ---

  /** Apply fillet to edges */
  fillet(
    body: KernelBody,
    edges: KernelEdge[],
    radius: number,
  ): Promise<Result<KernelBody, KernelError>>;

  /** Apply chamfer to edges */
  chamfer(
    body: KernelBody,
    edges: KernelEdge[],
    distance: number,
  ): Promise<Result<KernelBody, KernelError>>;

  /** Mirror a body across a plane */
  mirror(body: KernelBody, plane: ResolvedPlane): Promise<Result<KernelBody, KernelError>>;

  /**
   * Apply a rigid transform (translation + rotation) to a body, returning
   * the transformed body. OCCT's transform preserves TShapes, so stable
   * face/edge IDs carry over via hash-match. Used for body Move.
   */
  transform(body: KernelBody, transform: Transform3D): Promise<Result<KernelBody, KernelError>>;

  /**
   * Sweep a closed profile face along the boundary wire of a closed
   * path face. Wraps OCCT's `BRepOffsetAPI_MakePipe` via occt-wasm's
   * `pipe(profileShape, spineWireShape)`.
   *
   * V1 only accepts closed paths (the kernel extracts the path face's
   * outer wire as the spine). Open-path sweeps land in v2 once a
   * wire-from-sketch-chain builder is in place.
   *
   * Stable face IDs on the swept body are assigned fresh from `origin`
   * — pipe creates entirely new geometry, so there's nothing to
   * propagate from the input shapes.
   *
   * @param profileFace Closed sketch face that gets swept.
   * @param pathFace    Closed sketch face whose outer wire is the spine.
   * @param origin      Topology-tracker tag for deterministic IDs.
   */
  sweep(
    profileFace: KernelFace,
    pathFace: KernelFace,
    origin?: string,
  ): Promise<Result<KernelBody, KernelError>>;

  /**
   * Hollow a solid body to uniform wall thickness, removing the listed
   * faces so the cavity opens through them. Wraps OCCT's
   * `BRepOffsetAPI_MakeThickSolid` via occt-wasm `shellWithHistory`.
   *
   * @param body          The solid to hollow.
   * @param facesToRemove Faces left open after shelling. Must reference
   *                      faces on `body` (caller's responsibility); the
   *                      kernel doesn't cross-check.
   * @param thickness     Wall thickness in mm. Positive values shell
   *                      inward (the outer surface stays put); negative
   *                      values shell outward.
   * @param tolerance     Numerical tolerance for the offset fit. 1e-3
   *                      is occt-wasm's loose preset; 1e-6 is precise.
   */
  shell(
    body: KernelBody,
    facesToRemove: KernelFace[],
    thickness: number,
    tolerance?: number,
  ): Promise<Result<KernelBody, KernelError>>;

  /**
   * Linear pattern of a body. `count` includes the source; returns the
   * `count - 1` copies (instance i translated `i * spacing` along `dir`),
   * each a separate body. The source body is not part of the result.
   */
  linearPattern(
    body: KernelBody,
    dir: Vec3,
    count: number,
    spacing: number,
  ): Promise<Result<KernelBody[], KernelError>>;

  /**
   * Circular pattern of a body over a full turn. `count` includes the
   * source; returns the `count - 1` copies (instance i rotated
   * `i * 360° / count` about `axis`), each a separate body. The source
   * body is not part of the result.
   */
  circularPattern(
    body: KernelBody,
    axis: ResolvedAxis,
    count: number,
  ): Promise<Result<KernelBody[], KernelError>>;

  // --- Query ---

  /** Get the topology map for a body */
  getTopology(body: KernelBody): Promise<TopologyMap>;

  /**
   * Extract a planar reference frame from a face. Used by features that
   * anchor to a face — Construction Plane (offset-from-face mode),
   * Hole (face + center in 2D coords), sketches on a face and extrude
   * start / extent faces.
   *
   * Returns the face's surface centroid as `origin`, the outward surface
   * normal at the UV midpoint as `normal`, and a right-handed u/v basis
   * lying *in* the face's tangent plane (constructed via Gram-Schmidt
   * from the normal — the choice of u/v rotation around the normal is
   * arbitrary but stable for a given face geometry).
   *
   * For non-planar faces (cylinder, sphere, cone) this returns the
   * tangent plane at the surface centroid — useful for "tangent to face"
   * placement. `planar` is true only when the face's underlying surface
   * is a plane; callers that need a real plane (sketch on face, extrude
   * from / to a face) reject the face otherwise.
   */
  getFacePlane(face: KernelFace): Promise<{
    origin: Vec3;
    uAxis: Vec3;
    vAxis: Vec3;
    normal: Vec3;
    planar: boolean;
  }>;

  /** Get the bounding box of a body */
  getBoundingBox(body: KernelBody): Promise<BoundingBox3D>;

  /**
   * Minimum distance between two bodies, in mm. 0 when they touch, overlap,
   * or one lies inside the other. Join and cut use it to find the bodies a
   * new solid actually meets.
   */
  distanceBetween(a: KernelBody, b: KernelBody): Promise<number>;

  /** Get mass properties of a body (optional capability) */
  getMassProperties?(body: KernelBody): Promise<MassProperties>;

  /**
   * Length of one edge, in mm.
   *
   * Measured on the BREP curve, not on the tessellation — a tessellated arc
   * is a chain of chords and always reads short, by an amount that depends on
   * the deflection setting rather than on the model. A measurement that moves
   * when you change display quality is not a measurement.
   */
  getEdgeLength?(edge: KernelEdge): Promise<number>;

  /** Area of one face, in mm². Measured on the surface, not the mesh. */
  getFaceArea?(face: KernelFace): Promise<number>;

  /**
   * Resolve a stable face reference back to a runtime `KernelFace` handle
   * on the given body.
   *
   * Strategy:
   *  1. Direct lookup via the topology tracker (constant time).
   *  2. If 1 misses and a `repairHint` is provided, fall back to scoring
   *     every face on the body by centroid distance / normal angle / area
   *     similarity. The best match within all thresholds wins; otherwise
   *     return `null`.
   *
   * Returns `null` if neither path finds a match.
   */
  resolveFaceRef(
    body: KernelBody,
    stableFaceId: StableFaceId,
    repairHint?: RepairHint,
  ): Promise<KernelFace | null>;

  /**
   * Resolve a stable edge reference back to a runtime `KernelEdge` handle.
   * Mirrors {@link resolveFaceRef} for edges. The hint's `centroid` is
   * interpreted as the edge midpoint when used for fallback.
   */
  resolveEdgeRef(
    body: KernelBody,
    stableEdgeId: StableEdgeId,
    repairHint?: RepairHint,
  ): Promise<KernelEdge | null>;

  // --- Output ---

  /** Tessellate a body into a display mesh */
  tessellate(body: KernelBody, options: TessellationOptions): Promise<DisplayMesh>;

  /** Export bodies to STEP format */
  exportStep(bodies: KernelBody[], options?: StepExportOptions): Promise<Blob>;

  /** Export bodies to STL format */
  exportStl(bodies: KernelBody[], options?: StlExportOptions): Promise<Blob>;

  /**
   * Import a STEP file (.step / .stp) as one or more bodies.
   *
   * occt-wasm's `importStep` returns a single `ShapeHandle`; the
   * implementation decomposes it into per-solid bodies via
   * `getSubShapes(shape, 'solid')`, so a STEP file with 8 parts
   * becomes 8 `KernelBody` entries under one feature. Single-solid
   * STEP files return a one-element array.
   *
   * V1 uses the plain `importStep` path (no XCAF). Names, colors,
   * and assembly hierarchy are not preserved — `xcafImportSTEP`
   * lands when our document model grows multi-body assemblies.
   *
   * @param data    Raw STEP bytes (the importer accepts the file as text).
   * @param origin  Topology-tracker tag; feature id makes IDs deterministic.
   */
  importStep(data: ArrayBuffer, origin?: string): Promise<Result<KernelBody[], KernelError>>;

  /**
   * Import an STL file (.stl) as a single body.
   *
   * STL is mesh-only — the result is a faceted shell with no
   * analytical curves/surfaces. Boolean ops still work on it but
   * the topology is purely triangular. Returned as a single-element
   * body array so the API matches `importStep`.
   */
  importStl(data: ArrayBuffer, origin?: string): Promise<Result<KernelBody[], KernelError>>;

  /**
   * Import a binary BREP file (.brep / .brp) as one or more bodies.
   *
   * BREP is OCCT's native serialization — `fromBREPBinary` returns a
   * single `ShapeHandle` which the implementation decomposes into
   * per-solid bodies via the same `decomposeToBodies` path as STEP, so
   * a compound with 8 solids becomes 8 `KernelBody` entries under one
   * feature. Single-solid files return a one-element array.
   *
   * @param data    Raw BREP bytes (binary — read as ArrayBuffer).
   * @param origin  Topology-tracker tag; feature id makes IDs deterministic.
   */
  importBrep(data: ArrayBuffer, origin?: string): Promise<Result<KernelBody[], KernelError>>;

  /** Export bodies to 3MF format (mesh-based, ZIP-packaged). */
  export3MF(bodies: KernelBody[], options?: ThreeMfExportOptions): Promise<Blob>;

  /**
   * Export bodies to binary BREP (OpenCASCADE's native BRep format).
   *
   * BREP preserves the full analytical B-Rep (curves, surfaces,
   * topology) like STEP, but is OCCT's own serialization — written and
   * read as raw bytes via occt-wasm's `toBREPBinary`/`fromBREPBinary`,
   * not text. Multi-body exports wrap the bodies in a transient
   * compound, same as `exportStep`.
   */
  exportBrep(bodies: KernelBody[]): Promise<Blob>;

  // --- Lifecycle ---

  /** Release a kernel handle (free memory) */
  dispose(handle: KernelBody | KernelFace | KernelEdge): void;
}

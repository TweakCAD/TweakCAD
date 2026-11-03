/**
 * OcctKernel — occt-wasm@5.x implementation of {@link CadKernel}.
 *
 * Wraps the upstream `OcctKernel` from `occt-wasm` behind our internal
 * `CadKernel` interface so feature builders, the rebuilder, and the worker
 * see a stable API. Handle bookkeeping is string-keyed (matching
 * `KernelBody.handle: string`) — internally we map those strings to the
 * upstream's branded arena `ShapeHandle` numbers.
 */

import type { Result } from '@tweakcad/core/src/result.ts';
import { ok, err } from '@tweakcad/core/src/result.ts';
import type { Vec3, Transform3D, BoundingBox3D, MassProperties } from '@tweakcad/core/src/math.ts';
import type { DisplayMesh, TopologyMap, RepairHint } from '@tweakcad/core/src/document/schema.ts';
import { bodyId as makeBodyId, faceId as makeFaceId, edgeId as makeEdgeId } from '@tweakcad/core/src/ids.ts';
import type { FaceId, StableFaceId, StableEdgeId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from './interface.ts';
import { build3MF, EXPORT_MIME } from './occtExports.ts';
import { dedupePointsForInterpolation } from './splineDedup.ts';
import { chooseByHint } from './repairHint.ts';
import { FINE_TESSELLATION } from './types.ts';
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
import { OcctKernel as UpstreamKernel, type ShapeHandle, type EvolutionData } from 'occt-wasm';
import { ShapeEvolutionTracker, type EvolutionRecord } from './topologyTracker.ts';

/**
 * Upper bound for `kernel.hashCode(shape, upperBound)` — used as the modulo
 * for OCCT's internal `MapOfShape` hash. Used by `ShapeEvolutionTracker` to
 * key stable IDs and by the `*WithHistory` calls to hash their payloads.
 * The tracker maps every face and edge of a body by hash, and a boolean's
 * history payload also carries section-edge hashes, so a collision silently
 * renames a face. Hashes follow heap addresses, so with a small modulus a
 * face can be named differently from one rebuild to the next; the largest
 * int32 prime keeps collisions out of practical reach.
 */
const HASH_UPPER_BOUND = 2_147_483_647;

/**
 * Modulus the mesher uses for `faceGroups[3*i + 2]` and the wireframe pass
 * uses for `edgeGroups[3*i + 2]`, hard-coded in the C++ facade as
 * `TopTools_ShapeMapHasher{}(shape) % 2147483647`. To pair faces returned
 * by `getSubShapes('face')` to their cached triangle ranges, we must call
 * `k.hashCode(face, MESH_HASH_BOUND)` so the JS-side and C++-side hashes
 * land in the same numeric space. Currently the same value as
 * `HASH_UPPER_BOUND`, but the two are kept as separate names: this one is
 * fixed by the C++ facade, the tracker's is ours to choose.
 *
 * Reference: the OCCT mesher and wireframe passes in the occt-wasm facade.
 */
const MESH_HASH_BOUND = 2_147_483_647;

function kernelError(
  category: KernelError['category'],
  code: string,
  message: string,
  suggestion?: string,
): KernelError {
  const result: KernelError = { category, code, message };
  if (suggestion !== undefined) {
    result.suggestion = suggestion;
  }
  return result;
}

let handleCounter = 0;
function nextHandle(prefix: string): string {
  return `${prefix}_${handleCounter++}`;
}

/**
 * Below this, a swept solid encloses nothing and is treated as a failed
 * sweep. Generous compared to the float noise actually observed (a degenerate
 * pipe measured ~9e-13) but far below any volume a user would model in mm.
 */
const SWEEP_MIN_VOLUME = 1e-9;

/**
 * Compose a topology-tracker origin string from a builtin op name and an
 * optional caller-supplied tag. Builders pass `node.id` as the tag so the
 * stable ids derived from this origin are deterministic per feature: same
 * feature rebuilding the same geometry yields the same stable IDs across
 * rebuilds, which is what makes user-captured FaceRef/EdgeRef survive.
 *
 * Feature ids already encode the op as their prefix (`extrude_<uid>`,
 * `revolve_<uid>`, etc.), so naively concatenating produces
 * `extrude_extrude_<uid>` → `sf_extrude_extrude_<uid>_0`. We de-duplicate
 * here when the tag already starts with `<op>_` so stable face/edge ids
 * stay readable. Single source of truth: every caller goes through this
 * function.
 *
 * If the caller doesn't pass a tag we fall back to just the op name —
 * legacy behavior, used by tests and one-off kernel callers (export,
 * tessellate, etc.). Those bodies won't have stable IDs across kernel
 * sessions but that's fine: they're not referenced by feature inputs.
 */
function originTag(op: string, callerTag: string | undefined): string {
  if (callerTag === undefined || callerTag.length === 0) return op;
  // Already prefixed (`extrude_<uid>` passed in for op='extrude') → don't double up.
  if (callerTag === op || callerTag.startsWith(`${op}_`)) return callerTag;
  return `${op}_${callerTag}`;
}

function computeLocalAxes(nx: number, ny: number, nz: number): { uDir: Vec3; vDir: Vec3 } {
  let refX = 1, refY = 0, refZ = 0;
  if (Math.abs(nx) > 0.9) {
    refX = 0;
    refY = 1;
    refZ = 0;
  }
  const ux = refY * nz - refZ * ny;
  const uy = refZ * nx - refX * nz;
  const uz = refX * ny - refY * nx;
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const uDir: Vec3 = [ux / uLen, uy / uLen, uz / uLen];
  const vx = ny * uDir[2] - nz * uDir[1];
  const vy = nz * uDir[0] - nx * uDir[2];
  const vz = nx * uDir[1] - ny * uDir[0];
  return { uDir, vDir: [vx, vy, vz] };
}

/**
 * Convert a {@link Transform3D} (position + quaternion `[x,y,z,w]`) into the
 * 3x4 row-major matrix occt-wasm's `transform()` expects: three rotated-basis
 * columns (U V W) plus a translation column. Standard quaternion → rotation
 * matrix; columns are the rotated unit axes.
 */
function transform3x4(t: Transform3D): number[] {
  const [x, y, z, w] = t.rotation;
  const [tx, ty, tz] = t.position;
  // Rotation matrix from a unit quaternion (R[row][col]).
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  const r00 = 1 - 2 * (yy + zz), r01 = 2 * (xy - wz),     r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz),     r11 = 1 - 2 * (xx + zz), r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy),     r21 = 2 * (yz + wx),     r22 = 1 - 2 * (xx + yy);
  // Row-major 3x4: [ R | T ].
  return [
    r00, r01, r02, tx,
    r10, r11, r12, ty,
    r20, r21, r22, tz,
  ];
}

export class OcctKernel implements CadKernel {
  private kernel: UpstreamKernel | null = null;
  /** External string handle → upstream arena ShapeHandle (bodies/solids). */
  private bodies = new Map<string, ShapeHandle>();
  /** External string handle → upstream arena ShapeHandle (faces). */
  private faces = new Map<string, ShapeHandle>();
  /** External string handle → upstream arena ShapeHandle (edges). */
  private edges = new Map<string, ShapeHandle>();
  /**
   * Body handle → the face / edge handles resolved on it. They are views of
   * that body's topology and useless once it is gone, so `dispose(body)`
   * releases them too. Nothing else did: every fillet, chamfer, shell,
   * sketch-on-face plane and measurement left its resolved sub-shapes in the
   * arena for the worker's lifetime.
   */
  private subShapesOf = new Map<string, Set<string>>();
  /**
   * Per-body cache of the last tessellation, keyed by sub-shape hashCode.
   * Cleared on dispose.
   *
   * **Why hash-keyed and not index-keyed:** the mesher (`meshShape`) and
   * the topology walker (`getSubShapes('face')`) do not guarantee the same
   * iteration order over a shape's faces. occt-wasm@5 already ships the
   * face hash inside `faceGroups[3*i + 2]` and the edge hash inside
   * `edgeGroups[3*i + 2]`, so we can bridge by hash instead of trusting
   * positional alignment. The previous index-keyed cache caused
   * `TopologyMap.faces[i]` to receive a triangle range belonging to a
   * different face when orders diverged — visible to users as wrong-region
   * highlights, mis-picks, and mis-colored faces on extruded bodies.
   *
   * Maps stay empty (rather than missing) for bodies that haven't been
   * tessellated; `getTopology()` falls back to zero-length ranges and the
   * downstream raycaster still works (it just won't find geometry).
   */
  private topologyCache = new Map<string, {
    /** faceHash → triangle range in the body's display mesh. */
    faceRanges: Map<number, { triStart: number; triCount: number }>;
    /**
     * edgeHash → per-edge LineSegments-format buffer. Each entry is a
     * Float32Array with 6 floats per segment (start xyz + end xyz). Built
     * from k.wireframe() polylines in tessellate() and consumed by
     * getTopology() + MeshRegistry's body-edges raycaster + SelectionHighlight.
     */
    edgeSegments: Map<number, Float32Array>;
  }>();
  /**
   * Stable face-ID tracker. Assigns IDs on body creation and
   * propagates them through history-aware modify ops.
   */
  private tracker = new ShapeEvolutionTracker();

  async init(): Promise<void> {
    if (this.kernel) return;
    this.kernel = await UpstreamKernel.init();
  }

  private getKernel(): UpstreamKernel {
    if (!this.kernel) throw new Error('OcctKernel not initialized. Call init() first.');
    return this.kernel;
  }

  /**
   * Allocate a body handle and store the upstream shape, but do NOT
   * register any face identity. Callers must immediately call either
   * {@link assignFreshFaceIds} (for primitive/sketch creation) or
   * {@link propagateFaceIdsFromInputs} (for modify ops with input bodies).
   */
  private storeBody(shape: ShapeHandle, source: string): KernelBody {
    const handle = nextHandle('body');
    this.bodies.set(handle, shape);
    return { handle, source };
  }

  /**
   * For body-creating ops with no input parents (makeBox, makeCylinder,
   * extrudeFace, revolve, loft, etc.). Walks the new body's faces and
   * edges, hashes each, and registers fresh stable IDs with the tracker.
   */
  private assignFreshIds(body: KernelBody, origin: string): void {
    const k = this.getKernel();
    const shape = this.getBodyShape(body);
    const faces = k.getSubShapes(shape, 'face');
    const edges = k.getSubShapes(shape, 'edge');
    try {
      const faceHashes = faces.map(f => k.hashCode(f, HASH_UPPER_BOUND));
      const edgeHashes = edges.map(e => k.hashCode(e, HASH_UPPER_BOUND));
      this.tracker.registerFreshBody(body.handle, faceHashes, edgeHashes, origin);
    } finally {
      for (const f of faces) k.release(f);
      for (const e of edges) k.release(e);
    }
  }

  /**
   * For modify ops (booleans, fillet, chamfer, mirror, transforms,
   * patterns). Walks the result body's faces+edges and copies stable IDs
   * from input bodies where hashes match; assigns fresh IDs where no match
   * exists (those resolve via {@link RepairHint} fallback in resolveFaceRef
   * or resolveEdgeRef).
   */
  private propagateIdsFromInputs(
    resultBody: KernelBody,
    inputBodies: KernelBody[],
    origin: string,
  ): void {
    const k = this.getKernel();
    const resultShape = this.getBodyShape(resultBody);
    const resultFaces = k.getSubShapes(resultShape, 'face');
    const resultEdges = k.getSubShapes(resultShape, 'edge');
    try {
      const faceHashes = resultFaces.map(f => k.hashCode(f, HASH_UPPER_BOUND));
      const edgeHashes = resultEdges.map(e => k.hashCode(e, HASH_UPPER_BOUND));
      this.tracker.propagateIds(
        resultBody.handle,
        inputBodies.map(b => b.handle),
        faceHashes,
        edgeHashes,
        origin,
      );
    } finally {
      for (const f of resultFaces) k.release(f);
      for (const e of resultEdges) k.release(e);
    }
  }

  /**
   * Helper: store a freshly-built body and assign fresh stable IDs in one
   * call. Used by all primitive/sketch ops.
   */
  private storeFreshBody(shape: ShapeHandle, source: string): KernelBody {
    const body = this.storeBody(shape, source);
    this.assignFreshIds(body, source);
    return body;
  }

  /**
   * Helper: store a freshly-built body and propagate stable IDs from
   * input bodies in one call. Used by every modify op.
   *
   * Note: hash-match propagation only — silently fails when a boolean or
   * fillet recreates a TShape. Prefer {@link storeBodyWithHistory} for
   * ops that have a `*WithHistory` sibling in the kernel.
   */
  private storeModifiedBody(
    shape: ShapeHandle,
    inputBodies: KernelBody[],
    origin: string,
  ): KernelBody {
    const body = this.storeBody(shape, origin);
    this.propagateIdsFromInputs(body, inputBodies, origin);
    return body;
  }

  /**
   * Store a result body whose history is known via an occt-wasm
   * `*WithHistory` call. Uses the per-input-face → per-result-face
   * mapping in the {@link EvolutionData} payload to transfer stable
   * IDs precisely, then falls back to hash-match for any result face
   * OCCT didn't report on. Edges propagate via the legacy hash-match
   * path (history is face-only on the facade).
   */
  private storeBodyWithHistory(
    shape: ShapeHandle,
    inputBodies: KernelBody[],
    evolution: EvolutionData,
    origin: string,
  ): KernelBody {
    const body = this.storeBody(shape, origin);
    const k = this.getKernel();
    const resultFaces = k.getSubShapes(shape, 'face');
    const resultEdges = k.getSubShapes(shape, 'edge');
    try {
      const faceHashes = resultFaces.map(f => k.hashCode(f, HASH_UPPER_BOUND));
      const edgeHashes = resultEdges.map(e => k.hashCode(e, HASH_UPPER_BOUND));
      const record: EvolutionRecord = {
        modified: evolution.modified,
        generated: evolution.generated,
        deleted: evolution.deleted,
      };
      // Faces that end up sharing an ID (a split face's pieces) are ranked
      // largest-area first, then by centroid, so the bare ID stays on the
      // main piece and the ranking doesn't depend on OCCT's walk order.
      // Only called for faces in such a group.
      const round = (v: number) => Math.round(v * 1e6) / 1e6;
      const faceOrder = (i: number): number[] => {
        const f = resultFaces[i]!;
        const c = k.getSurfaceCenterOfMass(f);
        return [-round(Math.abs(k.getSurfaceArea(f))), round(c.x), round(c.y), round(c.z)];
      };
      this.tracker.recordEvolution(
        body.handle,
        inputBodies.map(b => b.handle),
        faceHashes,
        record,
        origin,
        faceOrder,
      );
      this.tracker.recordEdgeEvolution(
        body.handle,
        inputBodies.map(b => b.handle),
        edgeHashes,
        origin,
      );
    } finally {
      for (const f of resultFaces) k.release(f);
      for (const e of resultEdges) k.release(e);
    }
    return body;
  }

  /**
   * Gather all input face hashes from a list of input bodies. Used to
   * scope the `inputFaceHashes` parameter of `*WithHistory` calls — OCCT
   * only reports history for hashes we ask about, so passing the full
   * set ensures we don't miss propagation.
   */
  private collectInputFaceHashes(inputBodies: KernelBody[]): number[] {
    const k = this.getKernel();
    const all: number[] = [];
    for (const body of inputBodies) {
      const shape = this.getBodyShape(body);
      const faces = k.getSubShapes(shape, 'face');
      try {
        for (const f of faces) all.push(k.hashCode(f, HASH_UPPER_BOUND));
      } finally {
        for (const f of faces) k.release(f);
      }
    }
    return all;
  }

  /**
   * Fold a binary `*WithHistory` boolean over `first` and `rest`: each
   * step's result is the next step's first operand, so every call gives
   * per-input → per-result face mappings. Input hashes are collected per
   * step: OCCT only reports history for the hashes it is given, and the
   * accumulated body's faces are new after every step.
   *
   * Each intermediate result is disposed as soon as the next step has
   * stored its own result. The tracker copies stable IDs into the new
   * body's entry when it is recorded, so nothing reads the intermediate's
   * entry afterwards. The caller's bodies are never disposed.
   */
  private foldWithHistory(
    first: KernelBody,
    rest: KernelBody[],
    op: (a: ShapeHandle, b: ShapeHandle, inputFaceHashes: number[], bound: number) => EvolutionData,
    origin: string,
  ): KernelBody {
    let acc = first;
    try {
      for (const tool of rest) {
        const evo = op(
          this.getBodyShape(acc),
          this.getBodyShape(tool),
          this.collectInputFaceHashes([acc, tool]),
          HASH_UPPER_BOUND,
        );
        const next = this.storeBodyWithHistory(evo.result, [acc, tool], evo, origin);
        if (acc !== first) this.dispose(acc);
        acc = next;
      }
    } catch (e) {
      if (acc !== first) this.dispose(acc);
      throw e;
    }
    return acc;
  }

  private storeFace(shape: ShapeHandle, bodyHandle: string): KernelFace {
    const handle = nextHandle('face');
    this.faces.set(handle, shape);
    this.trackSubShape(bodyHandle, handle);
    return { handle, bodyHandle };
  }

  private storeEdge(shape: ShapeHandle, bodyHandle: string): KernelEdge {
    const handle = nextHandle('edge');
    this.edges.set(handle, shape);
    this.trackSubShape(bodyHandle, handle);
    return { handle, bodyHandle };
  }

  /**
   * Record that `handle` was resolved on `bodyHandle`. A face with no body —
   * a sketch face from `createSketchFace` — is owned by the caller, which
   * disposes it once the solid it was made into exists.
   */
  private trackSubShape(bodyHandle: string, handle: string): void {
    if (!bodyHandle) return;
    let owned = this.subShapesOf.get(bodyHandle);
    if (!owned) {
      owned = new Set();
      this.subShapesOf.set(bodyHandle, owned);
    }
    owned.add(handle);
  }

  private getFaceShape(face: KernelFace): ShapeHandle {
    const shape = this.faces.get(face.handle);
    if (shape === undefined) throw new Error(`Unknown kernel face handle: ${face.handle}`);
    return shape;
  }

  private getBodyShape(body: KernelBody): ShapeHandle {
    const shape = this.bodies.get(body.handle);
    if (shape === undefined) throw new Error(`Unknown kernel body handle: ${body.handle}`);
    return shape;
  }

  // --- Sketch to face ---

  async createSketchFace(profile: ResolvedProfile): Promise<Result<KernelFace, KernelError>> {
    try {
      const k = this.getKernel();

      const outerWire = this.buildProfileWire(k, profile);
      let faceShape = k.makeFace(outerWire);
      k.release(outerWire);

      // Even-odd holes: punch each inner profile's boundary wire through
      // the face (a washer = square/circle outer + circle hole, in one
      // operation). The worker decides which selected profiles are holes —
      // see `profileNesting.ts`.
      const holes = profile.holes ?? [];
      if (holes.length > 0) {
        const holeWires = holes.map(h => this.buildProfileWire(k, h));
        const holed = k.addHolesInFace(faceShape, holeWires);
        k.release(faceShape);
        for (const w of holeWires) k.release(w);
        faceShape = holed;
      }

      return ok(this.storeFace(faceShape, ''));
    } catch (e) {
      console.error('[OcctKernel] createSketchFace failed:', e);
      return err(
        kernelError('kernel', 'SKETCH_FACE_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /**
   * Build the closed boundary wire for a profile, dispatching on type.
   * Shared by the outer face and by every hole — a hole is just another
   * profile whose wire gets punched into the face via `addHolesInFace`.
   *
   * `makeRectangleFace` was retired in task F (invariant #11 — no composite
   * entities); rectangles arrive as 4 lines and build via the polygon path.
   */
  private buildProfileWire(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
    switch (profile.type) {
      case 'circle':       return this.makeCircleWire(k, profile);
      case 'polygon':      return this.makePolygonWire(k, profile);
      case 'wire':         return this.makeSegmentWire(k, profile);
      case 'closedSpline': return this.makeClosedSplineWire(k, profile);
      default:
        throw new Error(`Unsupported profile type for wire: ${(profile as ResolvedProfile).type}`);
    }
  }

  private makeCircleWire(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
    const radius = profile.radius ?? (profile.diameter !== undefined ? profile.diameter / 2 : 25);
    if (radius <= 0) {
      throw new Error(`Circle profile radius must be positive, got ${radius}`);
    }
    const cx = profile.center?.[0] ?? profile.origin[0];
    const cy = profile.center?.[1] ?? profile.origin[1];
    const cz = profile.center?.[2] ?? profile.origin[2];
    const [nx, ny, nz] = profile.normal;

    const edge = k.makeCircleEdge({ x: cx, y: cy, z: cz }, { x: nx, y: ny, z: nz }, radius);
    const wire = k.makeWire([edge]);
    k.release(edge);
    return wire;
  }

  /**
   * Build the closed boundary wire for a `'closedSpline'` profile — a
   * standalone closed loop supplied pre-sampled (in world space) on
   * `profile.vertices`. OCCT fits a single closed periodic B-spline through
   * the ring via `interpolatePoints(…, true)`.
   *
   * Backs both standalone ellipses and standalone closed splines. For
   * ellipses we sample-and-interpolate rather than call `makeEllipseEdge`
   * because occt-wasm's ellipse edge builder takes only (center, normal,
   * major, minor) with no in-plane major-axis direction — it can't
   * represent a rotated ellipse, which our sketches allow.
   */
  private makeClosedSplineWire(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
    const ring = dedupePointsForInterpolation(profile.vertices ?? [], true);
    if (ring.length < 3) {
      throw new Error(`closedSpline profile requires at least 3 distinct perimeter points (got ${ring.length})`);
    }
    const edge = k.interpolatePoints(ring.map(p => ({ x: p[0], y: p[1], z: p[2] })), true);
    const wire = k.makeWire([edge]);
    k.release(edge);
    return wire;
  }

  private makePolygonWire(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
    const vertices = profile.vertices ?? [];
    if (vertices.length < 3) {
      throw new Error('Polygon profile requires at least three vertices');
    }
    const edgeHandles: ShapeHandle[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!;
      const b = vertices[(i + 1) % vertices.length]!;
      edgeHandles.push(
        k.makeLineEdge({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }),
      );
    }
    const wire = k.makeWire(edgeHandles);
    for (const e of edgeHandles) k.release(e);
    return wire;
  }

  /**
   * Build the closed boundary wire for a `'wire'` profile whose segments
   * preserve their native curve type (line / 3-point arc / cubic Bézier /
   * spline).
   *
   * Uses polymorphic dispatch — each segment knows how to become a kernel
   * edge. Arc segments use `makeArcEdge` (OCCT's `GC_MakeArcOfCircle_4`);
   * Bézier segments use `makeBezierEdge` (`Geom_BezierCurve`); spline
   * segments interpolate a B-spline. All stay analytic, so an extruded
   * prism produces one lateral face per curve, not one per sampled facet.
   */
  private makeSegmentWire(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
    const segments = profile.segments ?? [];
    if (segments.length < 2) {
      throw new Error(`Wire profile requires at least 2 segments (got ${segments.length})`);
    }
    const edgeHandles: ShapeHandle[] = [];
    for (const seg of segments) {
      switch (seg.kind) {
        case 'line':
          edgeHandles.push(
            k.makeLineEdge(
              { x: seg.start[0], y: seg.start[1], z: seg.start[2] },
              { x: seg.end[0], y: seg.end[1], z: seg.end[2] },
            ),
          );
          break;
        case 'arc3pt':
          edgeHandles.push(
            k.makeArcEdge(
              { x: seg.start[0], y: seg.start[1], z: seg.start[2] },
              { x: seg.mid[0], y: seg.mid[1], z: seg.mid[2] },
              { x: seg.end[0], y: seg.end[1], z: seg.end[2] },
            ),
          );
          break;
        case 'bezier':
          edgeHandles.push(
            k.makeBezierEdge([
              { x: seg.start[0], y: seg.start[1], z: seg.start[2] },
              { x: seg.cp1[0], y: seg.cp1[1], z: seg.cp1[2] },
              { x: seg.cp2[0], y: seg.cp2[1], z: seg.cp2[2] },
              { x: seg.end[0], y: seg.end[1], z: seg.end[2] },
            ]),
          );
          break;
        case 'spline': {
          const pts = dedupePointsForInterpolation(seg.points, false);
          if (pts.length < 2) {
            throw new Error('Spline wire segment collapsed to <2 distinct points');
          }
          edgeHandles.push(
            k.interpolatePoints(pts.map(p => ({ x: p[0], y: p[1], z: p[2] })), false),
          );
          break;
        }
      }
    }
    const wire = k.makeWire(edgeHandles);
    for (const e of edgeHandles) k.release(e);
    return wire;
  }

  // --- Solid creation ---

  async extrudeFace(face: KernelFace, vector: Vec3, origin?: string): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      const faceShape = this.getFaceShape(face);
      const body = k.extrude(faceShape, vector[0], vector[1], vector[2]);
      return ok(this.storeFreshBody(body, originTag('extrude', origin)));
    } catch (e) {
      console.error('[OcctKernel] extrudeFace failed:', e);
      return err(
        kernelError('kernel', 'EXTRUDE_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async revolve(
    face: KernelFace,
    axis: ResolvedAxis,
    angleRad: number,
    _copy?: boolean,
    origin?: string,
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      const faceShape = this.getFaceShape(face);
      const [dx, dy, dz] = axis.direction;
      const dirLen = Math.hypot(dx, dy, dz);
      if (dirLen === 0) {
        return err(kernelError('parameter', 'ZERO_AXIS', 'Revolve axis direction cannot be zero'));
      }
      if (!Number.isFinite(angleRad) || angleRad === 0) {
        return err(kernelError('parameter', 'ZERO_ANGLE', 'Revolve angle must be non-zero'));
      }
      const [ox, oy, oz] = axis.origin;
      // occt-wasm normalizes the direction internally; we still send a unit
      // vector to match v1 behavior exactly.
      const body = k.revolve(
        faceShape,
        {
          point: { x: ox, y: oy, z: oz },
          direction: { x: dx / dirLen, y: dy / dirLen, z: dz / dirLen },
        },
        angleRad,
      );
      return ok(this.storeFreshBody(body, originTag('revolve', origin)));
    } catch (e) {
      console.error('[OcctKernel] revolve failed:', e);
      return err(
        kernelError('kernel', 'REVOLVE_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async loft(
    faces: KernelFace[],
    options?: { ruled?: boolean; closed?: boolean },
    origin?: string,
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      if (faces.length < 2) {
        return err(kernelError('parameter', 'LOFT_NEEDS_2', 'Loft requires at least 2 profiles'));
      }
      if (faces.length > 16) {
        return err(kernelError('parameter', 'LOFT_TOO_MANY', 'Loft supports at most 16 profiles'));
      }
      const k = this.getKernel();
      const ruled = options?.ruled ?? false;
      // occt-wasm's loft takes wire handles, not faces. Extract the outer
      // wire of each face via getSubShapes(face, 'wire')[0]. The first wire
      // returned is the outer boundary (inner holes — not used here — come
      // after, and loft doesn't support them anyway).
      const wires: ShapeHandle[] = [];
      try {
        for (const face of faces) {
          const faceShape = this.getFaceShape(face);
          const wireSubs = k.getSubShapes(faceShape, 'wire');
          if (wireSubs.length === 0) {
            return err(kernelError('geometry', 'LOFT_PROFILE_NO_WIRE', 'Loft profile face has no wire boundary'));
          }
          wires.push(wireSubs[0]!);
          // Release any extra wires we won't use.
          for (let i = 1; i < wireSubs.length; i++) k.release(wireSubs[i]!);
        }
        // isSolid=true caps the loft to produce a closed solid.
        const lofted = k.loft(wires, true, ruled);
        // `closed` (loop back from last to first) isn't supported by the
        // single-call loft signature — same v1 limitation, deferred.
        void options?.closed;
        // ThruSections naturally produces one face per B-spline patch (66+
        // faces for a typical 2-profile loft). `unifySameDomain` merges
        // adjacent faces that share a tangent-continuous underlying surface
        // into a single OCCT face, which is what users expect when they
        // click a "side" of a loft. The OLD lofted handle is released since
        // unifySameDomain returns a fresh shape.
        let body: ShapeHandle;
        try {
          body = k.unifySameDomain(lofted);
        } catch {
          // Fall back to the raw loft if unification fails (e.g., for
          // degenerate inputs); face count will be high but geometry is
          // still valid.
          body = lofted;
        }
        if (body !== lofted) k.release(lofted);
        return ok(this.storeFreshBody(body, originTag('loft', origin)));
      } finally {
        for (const w of wires) k.release(w);
      }
    } catch (e) {
      console.error('[OcctKernel] loft failed:', e);
      return err(
        kernelError('kernel', 'LOFT_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async makeCylinder(spec: CylinderSpec, origin?: string): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      // occt-wasm's makeCylinder creates a Z-axis-aligned cylinder at the
      // origin. To honor an arbitrary center+axis we build the canonical
      // shape, then transform it into the requested frame.
      const cyl = k.makeCylinder(spec.radius, spec.height);
      try {
        const [ax, ay, az] = spec.axis;
        const len = Math.hypot(ax, ay, az);
        if (len === 0) {
          return err(kernelError('parameter', 'ZERO_AXIS', 'Cylinder axis cannot be zero'));
        }
        const dir: Vec3 = [ax / len, ay / len, az / len];
        // Build a rotation that maps +Z to `dir`, using a right-handed local
        // basis. computeLocalAxes returns u,v such that {u, v, dir} is a
        // right-handed orthonormal triad — we use it to assemble the 3x4
        // row-major matrix occt-wasm's transform() expects.
        const { uDir, vDir } = computeLocalAxes(dir[0], dir[1], dir[2]);
        const [cx, cy, cz] = spec.center;
        // Columns: U V W, with translation = spec.center.
        const matrix = [
          uDir[0], vDir[0], dir[0], cx,
          uDir[1], vDir[1], dir[1], cy,
          uDir[2], vDir[2], dir[2], cz,
        ];
        const oriented = k.transform(cyl, matrix);
        k.release(cyl);
        return ok(this.storeFreshBody(oriented, originTag('cylinder', origin)));
      } catch (e) {
        try { k.release(cyl); } catch { /* already released */ }
        throw e;
      }
    } catch (e) {
      console.error('[OcctKernel] makeCylinder failed:', e);
      return err(
        kernelError('kernel', 'CYLINDER_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async makeCone(spec: ConeSpec, origin?: string): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      // occt-wasm's `makeCone(r1, r2, height)` produces a Z-aligned cone
      // (BRepPrimAPI_MakeCone) with `r1` at z=0 and `r2` at z=height.
      // Identical orientation strategy to makeCylinder: build canonical,
      // then transform into the requested frame via a 3x4 row-major
      // matrix whose columns are {u, v, dir, center}.
      const cone = k.makeCone(spec.radius1, spec.radius2, spec.height);
      try {
        const [ax, ay, az] = spec.axis;
        const len = Math.hypot(ax, ay, az);
        if (len === 0) {
          return err(kernelError('parameter', 'ZERO_AXIS', 'Cone axis cannot be zero'));
        }
        const dir: Vec3 = [ax / len, ay / len, az / len];
        const { uDir, vDir } = computeLocalAxes(dir[0], dir[1], dir[2]);
        const [cx, cy, cz] = spec.center;
        const matrix = [
          uDir[0], vDir[0], dir[0], cx,
          uDir[1], vDir[1], dir[1], cy,
          uDir[2], vDir[2], dir[2], cz,
        ];
        const oriented = k.transform(cone, matrix);
        k.release(cone);
        return ok(this.storeFreshBody(oriented, originTag('cone', origin)));
      } catch (e) {
        try { k.release(cone); } catch { /* already released */ }
        throw e;
      }
    } catch (e) {
      console.error('[OcctKernel] makeCone failed:', e);
      return err(
        kernelError('kernel', 'CONE_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async makeBox(spec: BoxSpec, origin?: string): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      // occt-wasm's makeBox places the box at the origin; v1 places it at
      // spec.origin. Translate to match.
      const box = k.makeBox(spec.width, spec.height, spec.depth);
      try {
        if (spec.origin[0] === 0 && spec.origin[1] === 0 && spec.origin[2] === 0) {
          return ok(this.storeFreshBody(box, originTag('box', origin)));
        }
        const placed = k.translate(box, spec.origin[0], spec.origin[1], spec.origin[2]);
        k.release(box);
        return ok(this.storeFreshBody(placed, originTag('box', origin)));
      } catch (e) {
        try { k.release(box); } catch { /* already released */ }
        throw e;
      }
    } catch (e) {
      console.error('[OcctKernel] makeBox failed:', e);
      return err(kernelError('kernel', 'BOX_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async makeSphere(spec: SphereSpec, origin?: string): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      if (!(spec.radius > 0)) {
        return err(kernelError('parameter', 'INVALID_RADIUS', 'Sphere radius must be positive'));
      }
      // A sphere needs no orientation — only a translation. Skipping the
      // transform when it is at the origin avoids building an identity
      // matrix and a second shape for the common case.
      const sphere = k.makeSphere(spec.radius);
      try {
        const [cx, cy, cz] = spec.center;
        if (cx === 0 && cy === 0 && cz === 0) {
          return ok(this.storeFreshBody(sphere, originTag('sphere', origin)));
        }
        const placed = k.translate(sphere, cx, cy, cz);
        k.release(sphere);
        return ok(this.storeFreshBody(placed, originTag('sphere', origin)));
      } catch (e) {
        try { k.release(sphere); } catch { /* already released */ }
        throw e;
      }
    } catch (e) {
      console.error('[OcctKernel] makeSphere failed:', e);
      return err(kernelError('kernel', 'SPHERE_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async makeTorus(spec: TorusSpec, origin?: string): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      if (!(spec.majorRadius > 0) || !(spec.minorRadius > 0)) {
        return err(kernelError('parameter', 'INVALID_RADIUS', 'Torus radii must be positive'));
      }
      if (spec.minorRadius >= spec.majorRadius) {
        // OCCT builds this happily and produces a self-intersecting solid
        // that fails later, inside a boolean, with an error naming neither
        // the torus nor the reason. Reject it where the cause is obvious.
        return err(kernelError(
          'parameter',
          'TORUS_SELF_INTERSECTS',
          `Torus minor radius (${spec.minorRadius}) must be smaller than its major ` +
            `radius (${spec.majorRadius}); otherwise the tube passes through itself.`,
        ));
      }
      // Canonical torus lies in XY about +Z, same as the cylinder's canonical
      // form — so it takes the identical orientation path.
      const torus = k.makeTorus(spec.majorRadius, spec.minorRadius);
      try {
        const [ax, ay, az] = spec.axis;
        const len = Math.hypot(ax, ay, az);
        if (len === 0) {
          return err(kernelError('parameter', 'ZERO_AXIS', 'Torus axis cannot be zero'));
        }
        const dir: Vec3 = [ax / len, ay / len, az / len];
        const { uDir, vDir } = computeLocalAxes(dir[0], dir[1], dir[2]);
        const [cx, cy, cz] = spec.center;
        const matrix = [
          uDir[0], vDir[0], dir[0], cx,
          uDir[1], vDir[1], dir[1], cy,
          uDir[2], vDir[2], dir[2], cz,
        ];
        const oriented = k.transform(torus, matrix);
        k.release(torus);
        return ok(this.storeFreshBody(oriented, originTag('torus', origin)));
      } catch (e) {
        try { k.release(torus); } catch { /* already released */ }
        throw e;
      }
    } catch (e) {
      console.error('[OcctKernel] makeTorus failed:', e);
      return err(kernelError('kernel', 'TORUS_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  // --- Boolean operations ---

  async booleanFuse(targets: KernelBody[]): Promise<Result<KernelBody, KernelError>> {
    try {
      if (targets.length < 2) {
        return err(kernelError('parameter', 'FUSE_NEEDS_2', 'Boolean fuse requires at least 2 bodies'));
      }
      const k = this.getKernel();
      return ok(this.foldWithHistory(
        targets[0]!,
        targets.slice(1),
        (a, b, hashes, bound) => k.fuseWithHistory(a, b, hashes, bound),
        'fuse',
      ));
    } catch (e) {
      console.error('[OcctKernel] booleanFuse failed:', e);
      return err(kernelError('kernel', 'FUSE_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async decomposeBody(body: KernelBody, origin: string): Promise<KernelBody[]> {
    return this.decomposeToBodies(this.getBodyShape(body), origin);
  }

  async splitSolids(body: KernelBody, origin: string): Promise<KernelBody[] | null> {
    const k = this.getKernel();
    const solids = k.getSubShapes(this.getBodyShape(body), 'solid');
    if (solids.length < 2) {
      for (const s of solids) k.release(s);
      return null;
    }
    // Each solid shares its faces and edges with the compound it came from,
    // so hash-match carries the compound's stable ids onto the piece that
    // holds them (`storeModifiedBody`) — a pick made before the split still
    // resolves on the piece it is on.
    return solids.map((solid, i) => this.storeModifiedBody(solid, [body], `${origin}_${i}`));
  }

  async booleanCut(
    target: KernelBody,
    tools: KernelBody[],
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      if (tools.length === 0) return ok(target);
      const k = this.getKernel();
      return ok(this.foldWithHistory(
        target,
        tools,
        (a, b, hashes, bound) => k.cutWithHistory(a, b, hashes, bound),
        'cut',
      ));
    } catch (e) {
      console.error('[OcctKernel] booleanCut failed:', e);
      return err(kernelError('kernel', 'CUT_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async booleanIntersect(targets: KernelBody[]): Promise<Result<KernelBody, KernelError>> {
    try {
      if (targets.length < 2) {
        return err(kernelError('parameter', 'INTERSECT_NEEDS_2', 'Boolean intersect requires at least 2 bodies'));
      }
      const k = this.getKernel();
      return ok(this.foldWithHistory(
        targets[0]!,
        targets.slice(1),
        (a, b, hashes, bound) => k.intersectWithHistory(a, b, hashes, bound),
        'intersect',
      ));
    } catch (e) {
      console.error('[OcctKernel] booleanIntersect failed:', e);
      return err(kernelError('kernel', 'INTERSECT_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  // --- Modify ---

  async fillet(
    body: KernelBody,
    edges: KernelEdge[],
    radius: number,
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      const selected = this.selectEdgesByIndex(shape, edges);
      try {
        // *WithHistory returns per-input-face → result-face mapping so
        // the tracker can transfer stable IDs precisely instead of
        // falling back to hash-match (which silently misses any face
        // whose TShape was recreated by the operation).
        const inputFaceHashes = this.collectInputFaceHashes([body]);
        const evo = k.filletWithHistory(
          shape,
          selected.list,
          radius,
          inputFaceHashes,
          HASH_UPPER_BOUND,
        );
        return ok(this.storeBodyWithHistory(evo.result, [body], evo, 'fillet'));
      } finally {
        for (const e of selected.toRelease) k.release(e);
      }
    } catch (e) {
      console.error('[OcctKernel] fillet failed:', e);
      return err(kernelError('kernel', 'FILLET_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async chamfer(
    body: KernelBody,
    edges: KernelEdge[],
    distance: number,
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      const selected = this.selectEdgesByIndex(shape, edges);
      try {
        const inputFaceHashes = this.collectInputFaceHashes([body]);
        const evo = k.chamferWithHistory(
          shape,
          selected.list,
          distance,
          inputFaceHashes,
          HASH_UPPER_BOUND,
        );
        return ok(this.storeBodyWithHistory(evo.result, [body], evo, 'chamfer'));
      } finally {
        for (const e of selected.toRelease) k.release(e);
      }
    } catch (e) {
      console.error('[OcctKernel] chamfer failed:', e);
      return err(kernelError('kernel', 'CHAMFER_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async mirror(body: KernelBody, plane: ResolvedPlane): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      // mirrorWithHistory hands back per-face evolution so
      // every face on the reflected copy traces back to its source face's
      // stable ID. Hash-match would mostly work for a rigid transform
      // (TShapes are preserved by OCCT for transforms) but the history
      // path is exact and zero-cost — the WASM call already runs the
      // history machinery internally; we just opt in to receive it.
      const inputFaceHashes = this.collectInputFaceHashes([body]);
      const evo = k.mirrorWithHistory(
        shape,
        { x: plane.origin[0], y: plane.origin[1], z: plane.origin[2] },
        { x: plane.normal[0], y: plane.normal[1], z: plane.normal[2] },
        inputFaceHashes,
        HASH_UPPER_BOUND,
      );
      return ok(this.storeBodyWithHistory(evo.result, [body], evo, 'mirror'));
    } catch (e) {
      console.error('[OcctKernel] mirror failed:', e);
      return err(kernelError('kernel', 'MIRROR_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async transform(body: KernelBody, t: Transform3D): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      // occt-wasm's transform() takes a 3x4 row-major matrix whose first
      // three columns are the rotated basis (U V W) and the fourth is the
      // translation. A rigid transform preserves TShapes, so the stable
      // face/edge IDs carry over from the input body via hash-match.
      const matrix = transform3x4(t);
      const out = k.transform(shape, matrix);
      return ok(this.storeModifiedBody(out, [body], 'transform'));
    } catch (e) {
      console.error('[OcctKernel] transform failed:', e);
      return err(kernelError('kernel', 'TRANSFORM_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async sweep(
    profileFace: KernelFace,
    pathFace: KernelFace,
    origin?: string,
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      const k = this.getKernel();
      const profileShape = this.getFaceShape(profileFace);
      const pathShape = this.getFaceShape(pathFace);

      // Extract the outer wire from the path face. A simple sketch
      // face (rectangle/circle/wire-loop) has exactly one wire; for
      // faces with holes (e.g. an annulus from two concentric
      // circles), the outer wire is conventionally the first. We
      // grab [0] and release the rest.
      const pathWires = k.getSubShapes(pathShape, 'wire');
      if (pathWires.length === 0) {
        return err(
          kernelError('geometry', 'SWEEP_NO_PATH_WIRE', 'Path face has no wire — cannot sweep'),
        );
      }
      const pathWire = pathWires[0]!;
      try {
        // `pipe` over `simplePipe` because the former handles the
        // general case where the profile normal isn't aligned with
        // the path tangent at the start point. simplePipe assumes
        // good alignment and produces weird results when it's wrong.
        const result = k.pipe(profileShape, pathWire);

        // `pipe` succeeds even when the profile plane is degenerate with
        // respect to the spine — a profile whose normal is perpendicular to
        // the path tangent sweeps out a self-intersecting sheet that OCCT
        // still reports as a solid, just one enclosing no volume. Left
        // unchecked that reaches the timeline as a feature that built "fine"
        // and renders nothing, which is far harder to diagnose than an error.
        //
        // Concretely, with a circle profile at (30,0,0) swept along a circle
        // path of R=30 in the XY plane (tangent +Y at that point): a +Y
        // profile normal gives the expected torus, volume 5329.6 against an
        // analytic 5329.0, while a +X or +Z normal gives volume 0 with a
        // plausible-looking surface area.
        if (Math.abs(k.getVolume(result)) <= SWEEP_MIN_VOLUME) {
          k.release(result);
          return err(
            kernelError(
              'geometry',
              'SWEEP_DEGENERATE',
              'Sweep produced a solid with no volume — the profile is most ' +
                'likely not perpendicular to the path at its start point.',
            ),
          );
        }

        // No input bodies to propagate IDs from — sweep creates a
        // brand new solid whose faces come from the swept profile +
        // the path geometry. Assign fresh IDs from the feature's
        // origin tag so they stay deterministic across rebuilds.
        return ok(this.storeFreshBody(result, origin ?? 'sweep'));
      } finally {
        for (const w of pathWires) k.release(w);
      }
    } catch (e) {
      console.error('[OcctKernel] sweep failed:', e);
      return err(kernelError('kernel', 'SWEEP_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async shell(
    body: KernelBody,
    facesToRemove: KernelFace[],
    thickness: number,
    tolerance: number = 1e-3,
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      if (facesToRemove.length === 0) {
        return err(
          kernelError('parameter', 'SHELL_NO_FACES', 'Shell requires at least one face to remove'),
        );
      }
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      // Look each KernelFace up in the live shape map. resolveFaceRef
      // already populated `this.faces` for picked faces; we just hand
      // the stored ShapeHandles to OCCT directly — no walk-by-index,
      // no release after (the stored shapes are owned by this instance).
      const faceShapes = facesToRemove.map(f => this.getFaceShape(f));
      const inputFaceHashes = this.collectInputFaceHashes([body]);
      // shellWithHistory mirrors fillet/chamfer's history path: the
      // evolution payload maps each input face to its result face, so
      // stable IDs on the hollowed body trace back exactly.
      const evo = k.shellWithHistory(
        shape,
        faceShapes,
        thickness,
        tolerance,
        inputFaceHashes,
        HASH_UPPER_BOUND,
      );
      return ok(this.storeBodyWithHistory(evo.result, [body], evo, 'shell'));
    } catch (e) {
      console.error('[OcctKernel] shell failed:', e);
      return err(kernelError('kernel', 'SHELL_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async linearPattern(
    body: KernelBody,
    dir: Vec3,
    count: number,
    spacing: number,
  ): Promise<Result<KernelBody[], KernelError>> {
    try {
      if (count < 1) {
        return err(kernelError('parameter', 'PATTERN_COUNT', 'Pattern count must be at least 1'));
      }
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      if (len === 0) {
        return err(kernelError('parameter', 'PATTERN_DIRECTION', 'Pattern direction has zero length'));
      }
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      const inputFaceHashes = this.collectInputFaceHashes([body]);
      // One translated copy per instance after the source, each its own
      // body. occt-wasm's `linearPattern` returns one compound whose first
      // solid coincides with the source, which would double the source.
      const copies: KernelBody[] = [];
      for (let i = 1; i < count; i++) {
        const d = (spacing * i) / len;
        const evo = k.translateWithHistory(
          shape,
          dir[0] * d,
          dir[1] * d,
          dir[2] * d,
          inputFaceHashes,
          HASH_UPPER_BOUND,
        );
        copies.push(this.storeBodyWithHistory(evo.result, [body], evo, 'linearPattern'));
      }
      return ok(copies);
    } catch (e) {
      console.error('[OcctKernel] linearPattern failed:', e);
      return err(
        kernelError('kernel', 'LINEAR_PATTERN_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async circularPattern(
    body: KernelBody,
    axis: ResolvedAxis,
    count: number,
  ): Promise<Result<KernelBody[], KernelError>> {
    try {
      if (count < 1) {
        return err(kernelError('parameter', 'PATTERN_COUNT', 'Pattern count must be at least 1'));
      }
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      const inputFaceHashes = this.collectInputFaceHashes([body]);
      const rotationAxis = {
        point: { x: axis.origin[0], y: axis.origin[1], z: axis.origin[2] },
        direction: { x: axis.direction[0], y: axis.direction[1], z: axis.direction[2] },
      };
      // One rotated copy per instance after the source, evenly spaced over
      // a full turn, each its own body. (occt-wasm's `circularPattern`
      // takes the total sweep, not the step, and its compound also
      // repeats the source as instance 0.)
      const step = (2 * Math.PI) / count;
      const copies: KernelBody[] = [];
      for (let i = 1; i < count; i++) {
        const evo = k.rotateWithHistory(
          shape,
          rotationAxis,
          step * i,
          inputFaceHashes,
          HASH_UPPER_BOUND,
        );
        copies.push(this.storeBodyWithHistory(evo.result, [body], evo, 'circularPattern'));
      }
      return ok(copies);
    } catch (e) {
      console.error('[OcctKernel] circularPattern failed:', e);
      return err(
        kernelError('kernel', 'CIRCULAR_PATTERN_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /**
   * Resolve KernelEdge handles to the live `ShapeHandle`s the kernel
   * stored for them (in `this.edges`). Used by fillet/chamfer to feed
   * the user-picked edges into OCCT's edge maker.
   *
   * Earlier this function tried to parse a positional index out of the
   * KernelEdge.handle (regex `/^e_(\d+)$/`) and look that index up in
   * `getSubShapes('edge')`. That was wrong twice over:
   *   1. `storeEdge` produces handles like `'edge_42'` via the arena
   *      counter — the regex never matched, so `list` was always empty.
   *      Then `k.fillet(shape, [], radius)` ran with zero edges and
   *      OCCT's `BRepFilletAPI_MakeFillet.Build()` threw an opaque
   *      `WebAssembly.Exception` (the user-visible symptom for the
   *      whole feature lifetime).
   *   2. Even with the regex fixed, `'edge_42'`'s `42` is a global
   *      monotonic counter — NOT an index into `getSubShapes('edge')`
   *      for this body — so the lookup would still pick the wrong
   *      edge.
   *
   * The right answer: the stored handles in `this.edges` are already
   * the live OCCT `ShapeHandle`s for the picked edges (kept alive by
   * `resolveEdgeRef`'s `storeEdge` call). Just hand them straight to
   * the kernel op. No re-walk needed, nothing to release after — the
   * stored shapes are owned by the `OcctKernel` instance and live
   * until the body is disposed.
   */
  private selectEdgesByIndex(
    shape: ShapeHandle,
    edges: KernelEdge[],
  ): { list: ShapeHandle[]; toRelease: ShapeHandle[] } {
    // Empty edges = "operate on every edge of the body" (used by some
    // kernel tests and the v1 "fillet everything" shortcut). These are
    // fresh ShapeHandles from getSubShapes — caller must release them
    // via `toRelease` after the op completes.
    if (edges.length === 0) {
      const k = this.getKernel();
      const allEdges = k.getSubShapes(shape, 'edge');
      return { list: allEdges, toRelease: allEdges };
    }
    // User-picked edges: look up the live ShapeHandles already stored
    // in `this.edges` (kept alive by resolveEdgeRef → storeEdge).
    // Nothing to release — those shapes are owned by the kernel.
    const list: ShapeHandle[] = [];
    for (const e of edges) {
      const stored = this.edges.get(e.handle);
      if (stored !== undefined) list.push(stored);
    }
    return { list, toRelease: [] };
  }

  // --- Query ---

  async getTopology(body: KernelBody): Promise<TopologyMap> {
    const k = this.getKernel();
    const shape = this.getBodyShape(body);
    const bid = makeBodyId(body.handle);

    // Face list = getSubShapes('face'). Each face is paired to its triangle
    // range via `hashCode(face)` against the tessellator's cached
    // `faceGroups[3*i+2]` table — see the topologyCache docstring for why
    // this replaces the previous parallel-index pairing. When the cache is
    // missing (getTopology called before tessellate) or the face's hash
    // isn't present (degenerate face skipped by the mesher), the range
    // stays empty — downstream picking degrades for that face only.
    const cached = this.topologyCache.get(body.handle);
    const faceShapes = k.getSubShapes(shape, 'face');
    const faces: TopologyMap['faces'] = [];
    // Edge hash (MESH_HASH_BOUND space) → ids of the faces bounded by that
    // edge, in face order. An edge shared by two faces hashes identically
    // from both sides (hashCode ignores orientation).
    const edgeFaces = new Map<number, FaceId[]>();
    try {
      for (let i = 0; i < faceShapes.length; i++) {
        const fh = faceShapes[i]!;
        const fid = makeFaceId(`f_${i}`);
        const faceEdges = k.getSubShapes(fh, 'edge');
        try {
          for (const feh of faceEdges) {
            const h = k.hashCode(feh, MESH_HASH_BOUND);
            const list = edgeFaces.get(h);
            if (!list) edgeFaces.set(h, [fid]);
            else if (!list.includes(fid)) list.push(fid);
          }
        } finally {
          for (const feh of faceEdges) k.release(feh);
        }
        // Two hashes per face: one in the mesh-bridge space (matches what
        // the C++ mesher wrote into faceGroups[*+2]), one in the tracker
        // namespace. The moduli happen to be equal today; each lookup uses
        // its own so either can change independently.
        const meshHash = k.hashCode(fh, MESH_HASH_BOUND);
        const trackerHash = k.hashCode(fh, HASH_UPPER_BOUND);
        const stable = this.tracker.getStableFaceId(body.handle, trackerHash);
        const range = cached?.faceRanges.get(meshHash);
        const triStart = range?.triStart ?? 0;
        const triCount = range?.triCount ?? 0;
        faces.push({
          faceId: fid,
          triStart,
          triEnd: triStart + triCount,
          semanticRef: `face_${i}`,
          ...(stable !== undefined ? { stableFaceId: stable, ...this.hintField(() => this.describeFace(fh)) } : {}),
        });
      }
    } finally {
      for (const fh of faceShapes) k.release(fh);
    }


    // Edges: same hash-keyed pairing against the wireframe pass's per-edge
    // buffers, using the mesher's hash space (MESH_HASH_BOUND). The
    // wireframe pass dedups edges shared between faces via
    // NCollection_IndexedMap, so cached.edgeSegments may have fewer
    // entries than getSubShapes('edge'); the lookup degrades to an empty
    // segment buffer for any edge the wireframe pass merged or skipped.
    const edgeShapes = k.getSubShapes(shape, 'edge');
    const edges: TopologyMap['edges'] = [];
    const firstFace = faces[0]?.faceId ?? makeFaceId('f_0');
    for (let i = 0; i < edgeShapes.length; i++) {
      const eh = edgeShapes[i]!;
      const meshHash = k.hashCode(eh, MESH_HASH_BOUND);
      const trackerHash = k.hashCode(eh, HASH_UPPER_BOUND);
      const stable = this.tracker.getStableEdgeId(body.handle, trackerHash);
      const lineSegments = cached?.edgeSegments.get(meshHash) ?? new Float32Array(0);
      // Seam edges and free (open-shell) edges border a single face; report
      // it twice so the tuple shape holds.
      const adj = edgeFaces.get(meshHash);
      const faceA = adj?.[0] ?? firstFace;
      const faceB = adj?.[1] ?? faceA;
      edges.push({
        edgeId: makeEdgeId(`e_${i}`),
        lineSegments,
        adjacentFaces: [faceA, faceB],
        ...(stable !== undefined ? { stableEdgeId: stable, ...this.hintField(() => this.describeEdge(eh)) } : {}),
      });
    }
    for (const eh of edgeShapes) k.release(eh);

    return { bodyId: bid, faces, edges };
  }

  async resolveFaceRef(
    body: KernelBody,
    stableFaceId: StableFaceId,
    repairHint?: RepairHint,
  ): Promise<KernelFace | null> {
    const k = this.getKernel();
    const targetHash = this.tracker.resolveStableFaceId(body.handle, stableFaceId);
    const faceShapes = k.getSubShapes(this.getBodyShape(body), 'face');
    const matched = this.chooseSubShape(faceShapes, targetHash, repairHint, (fh) => this.describeFace(fh));
    return matched === undefined ? null : this.storeFace(matched, body.handle);
  }

  /**
   * Pick the sub-shape a stable ref resolves to: the one whose hash the
   * tracker maps the id to, checked against the ref's hint
   * ({@link chooseByHint}). Releases every handle in `candidates` except the
   * one returned, which the caller owns.
   */
  private chooseSubShape(
    candidates: ShapeHandle[],
    targetHash: number | undefined,
    hint: RepairHint | undefined,
    describe: (handle: ShapeHandle) => RepairHint,
  ): ShapeHandle | undefined {
    const k = this.getKernel();
    let chosen = -1;
    try {
      const found = targetHash === undefined
        ? -1
        : candidates.findIndex((h) => k.hashCode(h, HASH_UPPER_BOUND) === targetHash);
      const described = new Map<number, RepairHint>();
      chosen = chooseByHint(candidates.length, found, hint, (i) => {
        let d = described.get(i);
        if (d === undefined) {
          d = this.safeDescribe(() => describe(candidates[i]!));
          described.set(i, d);
        }
        return d;
      });
      return chosen >= 0 ? candidates[chosen] : undefined;
    } finally {
      candidates.forEach((h, i) => { if (i !== chosen) k.release(h); });
    }
  }

  /** A measure that fails (degenerate geometry) describes nothing, which matches no hint field. */
  private safeDescribe(describe: () => RepairHint): RepairHint {
    try {
      return describe();
    } catch {
      return {};
    }
  }

  /** `{ repairHint }` for a topology-map entry, or nothing when it cannot be measured. */
  private hintField(describe: () => RepairHint): { repairHint?: RepairHint } {
    const hint = this.safeDescribe(describe);
    return Object.keys(hint).length > 0 ? { repairHint: hint } : {};
  }

  /**
   * The {@link RepairHint} measures of a face: centre and diagonal of its
   * bounding box, and the normal when the face is planar. The loose box
   * (analytic extents, control hulls) is deterministic and costs microseconds,
   * where a surface centre of mass and area cost an integration each: tens
   * of milliseconds per rebuild on a plate with a hundred holes. A curved
   * face's normal at its parameter midpoint depends on where OCCT put the
   * seam, so it is not recorded.
   */
  private describeFace(fh: ShapeHandle): RepairHint {
    const k = this.getKernel();
    const bb = k.getBoundingBox(fh, { precise: false });
    const hint: RepairHint = {
      center: [(bb.xmin + bb.xmax) / 2, (bb.ymin + bb.ymax) / 2, (bb.zmin + bb.zmax) / 2],
      size: Math.hypot(bb.xmax - bb.xmin, bb.ymax - bb.ymin, bb.zmax - bb.zmin),
    };
    if (k.surfaceType(fh) === 'plane') {
      const uv = k.uvBounds(fh);
      const n = k.surfaceNormal(fh, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2);
      hint.normal = [n.x, n.y, n.z];
    }
    return hint;
  }

  /**
   * The {@link RepairHint} measures of an edge: linear centre of mass and
   * length, and the direction when the edge is a straight line.
   */
  private describeEdge(eh: ShapeHandle): RepairHint {
    const k = this.getKernel();
    const com = k.getLinearCenterOfMass(eh);
    const hint: RepairHint = { center: [com.x, com.y, com.z], length: Math.abs(k.getLength(eh)) };
    if (k.curveType(eh) === 'line') {
      const { first, last } = k.curveParameters(eh);
      const t = k.curveTangent(eh, (first + last) / 2);
      const len = Math.hypot(t.x, t.y, t.z);
      if (len > 0) hint.direction = [t.x / len, t.y / len, t.z / len];
    }
    return hint;
  }

  async getFacePlane(face: KernelFace): Promise<{
    origin: Vec3;
    uAxis: Vec3;
    vAxis: Vec3;
    normal: Vec3;
    planar: boolean;
  }> {
    const k = this.getKernel();
    const fh = this.getFaceShape(face);

    // Origin: surface centroid.
    const com = k.getSurfaceCenterOfMass(fh);
    // Normal: surface normal sampled at the UV midpoint. For a planar
    // face the normal is constant over the UV domain so the midpoint
    // sample is exact; for curved faces we get the tangent-plane normal
    // at the centroid which is the standard reference for "tangent at
    // face centroid" placement.
    const uv = k.uvBounds(fh);
    const uMid = (uv.uMin + uv.uMax) / 2;
    const vMid = (uv.vMin + uv.vMax) / 2;
    const n = k.surfaceNormal(fh, uMid, vMid);

    // Build a right-handed u/v basis in the tangent plane via the same
    // Gram-Schmidt helper used by makeCylinder's orientation matrix.
    const nLen = Math.hypot(n.x, n.y, n.z);
    if (nLen === 0) {
      throw new Error('Face has zero-length surface normal — cannot extract plane');
    }
    const normal: Vec3 = [n.x / nLen, n.y / nLen, n.z / nLen];
    const { uDir, vDir } = computeLocalAxes(normal[0], normal[1], normal[2]);

    return {
      origin: [com.x, com.y, com.z],
      uAxis: uDir,
      vAxis: vDir,
      normal,
      planar: k.surfaceType(fh) === 'plane',
    };
  }

  async resolveEdgeRef(
    body: KernelBody,
    stableEdgeId: StableEdgeId,
    repairHint?: RepairHint,
  ): Promise<KernelEdge | null> {
    const k = this.getKernel();
    const targetHash = this.tracker.resolveStableEdgeId(body.handle, stableEdgeId);
    const edgeShapes = k.getSubShapes(this.getBodyShape(body), 'edge');
    const matched = this.chooseSubShape(edgeShapes, targetHash, repairHint, (eh) => this.describeEdge(eh));
    return matched === undefined ? null : this.storeEdge(matched, body.handle);
  }

  async getBoundingBox(body: KernelBody): Promise<BoundingBox3D> {
    const k = this.getKernel();
    const shape = this.getBodyShape(body);
    // useTriangulation=true matches v1 (BRepBndLib.Add(shape, box, true)).
    const bb = k.getBoundingBox(shape, true);
    return { min: [bb.xmin, bb.ymin, bb.zmin], max: [bb.xmax, bb.ymax, bb.zmax] };
  }

  async distanceBetween(a: KernelBody, b: KernelBody): Promise<number> {
    const k = this.getKernel();
    return k.distanceBetween(this.getBodyShape(a), this.getBodyShape(b));
  }

  async getMassProperties(body: KernelBody): Promise<MassProperties> {
    const k = this.getKernel();
    const shape = this.getBodyShape(body);
    const volume = Math.abs(k.getVolume(shape));
    const surfaceArea = Math.abs(k.getSurfaceArea(shape));
    const com = k.getCenterOfMass(shape);
    return {
      volume,
      surfaceArea,
      centerOfMass: [com.x, com.y, com.z],
    };
  }

  async getEdgeLength(edge: KernelEdge): Promise<number> {
    const k = this.getKernel();
    const shape = this.edges.get(edge.handle);
    if (shape === undefined) throw new Error(`Unknown kernel edge handle: ${edge.handle}`);
    return Math.abs(k.getLength(shape));
  }

  async getFaceArea(face: KernelFace): Promise<number> {
    const k = this.getKernel();
    return Math.abs(k.getSurfaceArea(this.getFaceShape(face)));
  }

  // --- Output ---

  async tessellate(body: KernelBody, options: TessellationOptions): Promise<DisplayMesh> {
    const k = this.getKernel();
    const shape = this.getBodyShape(body);
    // meshShape returns per-face triangle groups; we cache them so getTopology
    // can recover face triangle ranges without re-meshing.
    const mesh = k.meshShape(shape, {
      linearDeflection: options.linearDeflection,
      angularDeflection: options.angularDeflection,
    });

    // Wireframe pass: get per-edge polylines for picking + visual edges.
    // Use the same linearDeflection so edge sampling matches surface density.
    // The result format is [pointStart, pointCount, edgeHash] triples in
    // `edgeGroups`, with sample points interleaved XYZ in `points`.
    const edgeData = k.wireframe(shape, options.linearDeflection);
    const edgeSegmentsArr = polylinesToLineSegments(edgeData);
    const edgePositions = concatLineSegments(edgeSegmentsArr);

    // Build hash-keyed lookup maps so getTopology() can pair faces and
    // edges to triangle ranges / line buffers by content identity, not by
    // assumed parallel-iteration order. See the topologyCache docstring.
    //
    // Unit conversion: the C++ mesher stores `faceTriStart` and
    // `nbTri * 3` in **index units** (3 indices per triangle). Every
    // consumer of `TopologyMap.faces[i].triStart / triEnd` expects
    // **triangle units** — see `selectionHighlight.ts:164` which
    // multiplies by 3 to recover indices. Divide by 3 here so the schema
    // contract is honored at the source.
    const faceRanges = new Map<number, { triStart: number; triCount: number }>();
    if (mesh.faceGroups && mesh.faceCount !== undefined) {
      const groups = mesh.faceGroups;
      for (let i = 0; i < mesh.faceCount; i++) {
        const triStartIdx = groups[3 * i] ?? 0;
        const triCountIdx = groups[3 * i + 1] ?? 0;
        const faceHash = groups[3 * i + 2] ?? 0;
        const triStart = triStartIdx / 3; // indices → triangle number
        const triCount = triCountIdx / 3; // indices → triangle count
        // Last-write-wins on hash collision; collisions are astronomically
        // rare for `MESH_HASH_BOUND` over a single body's faces.
        faceRanges.set(faceHash, { triStart, triCount });
      }
    }

    const edgeSegments = new Map<number, Float32Array>();
    {
      const groups = edgeData.edgeGroups;
      for (let i = 0; i < edgeData.edgeCount; i++) {
        const edgeHash = groups[3 * i + 2] ?? 0;
        const buf = edgeSegmentsArr[i] ?? new Float32Array(0);
        edgeSegments.set(edgeHash, buf);
      }
    }

    this.topologyCache.set(body.handle, { faceRanges, edgeSegments });

    return {
      bodyId: makeBodyId(body.handle),
      // meshShape returns owned copies (per its docstring), so we can return
      // them directly across the worker boundary.
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      edgePositions,
    };
  }

  async importStep(data: ArrayBuffer, origin?: string): Promise<Result<KernelBody[], KernelError>> {
    try {
      const k = this.getKernel();
      // occt-wasm's importStep takes the raw STEP text. STEP files
      // are ASCII, but we accept ArrayBuffer for symmetry with
      // file-upload paths; the wrapper decodes to string internally.
      const root = k.importStep(data);
      try {
        return ok(this.decomposeToBodies(root, origin ?? 'step-import'));
      } finally {
        k.release(root);
      }
    } catch (e) {
      console.error('[OcctKernel] importStep failed:', e);
      return err(kernelError('kernel', 'STEP_IMPORT_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async importStl(data: ArrayBuffer, origin?: string): Promise<Result<KernelBody[], KernelError>> {
    try {
      const k = this.getKernel();
      // STL produces a faceted shell. Same decomposition path as STEP
      // — single-shape files come back as a 1-element body array; if
      // the STL contains multiple solids OCCT will report them as
      // distinct sub-shapes.
      //
      // Passed as a Uint8Array: occt-wasm >= 5.0.0 hands bytes straight to
      // the kernel. Earlier versions ran the buffer through a UTF-8
      // `TextDecoder`, which silently destroyed every byte >= 0x80 and made
      // binary STL unimportable from any source.
      const root = k.importStl(new Uint8Array(data));
      try {
        return ok(this.decomposeToBodies(root, origin ?? 'stl-import'));
      } finally {
        k.release(root);
      }
    } catch (e) {
      console.error('[OcctKernel] importStl failed:', e);
      return err(kernelError('kernel', 'STL_IMPORT_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async importBrep(data: ArrayBuffer, origin?: string): Promise<Result<KernelBody[], KernelError>> {
    try {
      const k = this.getKernel();
      // occt-wasm's fromBREPBinary takes the raw BREP bytes. Same
      // decomposition path as STEP — single-solid files come back as a
      // 1-element body array; a compound is split per solid.
      const root = k.fromBREPBinary(new Uint8Array(data));
      try {
        return ok(this.decomposeToBodies(root, origin ?? 'brep-import'));
      } finally {
        k.release(root);
      }
    } catch (e) {
      console.error('[OcctKernel] importBrep failed:', e);
      return err(kernelError('kernel', 'BREP_IMPORT_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * Decompose an imported root shape into one or more KernelBody
   * entries. STEP files often arrive as a compound containing
   * multiple solids; we extract each solid as its own body so the
   * timeline / picker treats them independently. A STEP file with a
   * single solid (no wrapping compound) returns a one-element array.
   *
   * Each body gets fresh stable face/edge IDs derived from `origin`
   * + a per-body index — same pattern Extrude uses for multi-profile
   * outputs. The root shape is the caller's to release.
   */
  private decomposeToBodies(root: ShapeHandle, origin: string): KernelBody[] {
    const k = this.getKernel();
    const rootType = k.getShapeType(root);
    if (rootType === 'solid') {
      // Single-solid file — copy the shape into a fresh arena handle
      // so the body owns its own ID and the caller can release the
      // root without invalidating us.
      return [this.storeFreshBody(k.copy(root), origin)];
    }
    // Compound, shell, or anything else: pull out every solid inside.
    // getSubShapes returns fresh arena handles per child, so we own
    // them independently of the root once the root is released.
    const solids = k.getSubShapes(root, 'solid');
    if (solids.length === 0) {
      // Mesh-only STL or BREP shell with no solid sub-shapes — store
      // the whole root as one body so the user still gets pickable
      // geometry. Copy for the same lifetime reason as above.
      return [this.storeFreshBody(k.copy(root), origin)];
    }
    const bodies: KernelBody[] = [];
    for (let i = 0; i < solids.length; i++) {
      bodies.push(this.storeFreshBody(solids[i]!, `${origin}_${i}`));
    }
    return bodies;
  }

  async exportStep(bodies: KernelBody[], _options?: StepExportOptions): Promise<Blob> {
    if (bodies.length === 0) throw new Error('exportStep: no bodies provided');
    const k = this.getKernel();
    // occt-wasm's exportStep takes a single shape; wrap multi-body exports in
    // a transient compound. Schema is still not user-selectable as of
    // occt-wasm 4.4.0 — `exportStep(shape)` takes no options and picks AP214
    // internally.
    const shapes = bodies.map(b => this.getBodyShape(b));
    let target: ShapeHandle;
    let release = false;
    if (shapes.length === 1) {
      target = shapes[0]!;
    } else {
      target = k.makeCompound(shapes);
      release = true;
    }
    try {
      const text = k.exportStep(target);
      return new Blob([text], { type: EXPORT_MIME.step });
    } finally {
      if (release) k.release(target);
    }
  }

  async exportBrep(bodies: KernelBody[]): Promise<Blob> {
    if (bodies.length === 0) throw new Error('exportBrep: no bodies provided');
    const k = this.getKernel();
    // occt-wasm's toBREPBinary takes a single shape; wrap multi-body exports
    // in a transient compound, same as exportStep.
    const shapes = bodies.map(b => this.getBodyShape(b));
    let target: ShapeHandle;
    let release = false;
    if (shapes.length === 1) {
      target = shapes[0]!;
    } else {
      target = k.makeCompound(shapes);
      release = true;
    }
    try {
      const bytes = k.toBREPBinary(target);
      // Copy through an ArrayBuffer so Blob accepts it regardless of whether
      // the source view is backed by a SharedArrayBuffer.
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return new Blob([ab], { type: EXPORT_MIME.brep });
    } finally {
      if (release) k.release(target);
    }
  }

  async exportStl(bodies: KernelBody[], options?: StlExportOptions): Promise<Blob> {
    if (bodies.length === 0) throw new Error('exportStl: no bodies provided');
    const k = this.getKernel();
    const binary = options?.binary ?? true;
    const linear = options?.linearDeflection ?? FINE_TESSELLATION.linearDeflection;
    const shapes = bodies.map(b => this.getBodyShape(b));
    let target: ShapeHandle;
    let release = false;
    if (shapes.length === 1) {
      target = shapes[0]!;
    } else {
      target = k.makeCompound(shapes);
      release = true;
    }
    try {
      // occt-wasm >= 5.0.0 returns binary STL as a Uint8Array and ASCII as a
      // string. Before that, both came back as a string across an Embind
      // boundary that is UTF-8 in each direction, so every byte >= 0x80 in a
      // binary payload arrived as U+FFFD — structurally intact files with a
      // destroyed float payload. We transcoded through ASCII to work around
      // it; upstream now moves the bytes natively, so that code is gone.
      const bytes = binary
        ? k.exportStl(target, linear)
        : new TextEncoder().encode(k.exportStl(target, linear, true));
      // Copy through an ArrayBuffer so Blob accepts it regardless of whether
      // the source view is backed by a SharedArrayBuffer.
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return new Blob([ab], { type: EXPORT_MIME.stl });
    } finally {
      if (release) k.release(target);
    }
  }

  async export3MF(bodies: KernelBody[], options?: ThreeMfExportOptions): Promise<Blob> {
    if (bodies.length === 0) throw new Error('export3MF: no bodies provided');
    const tessOpts: TessellationOptions = {
      linearDeflection: options?.linearDeflection ?? FINE_TESSELLATION.linearDeflection,
      angularDeflection: options?.angularDeflection ?? FINE_TESSELLATION.angularDeflection,
    };
    const meshes = await Promise.all(bodies.map(b => this.tessellate(b, tessOpts)));
    const buf = build3MF(meshes, {
      name: options?.name ?? 'model',
      unit: options?.unit ?? 'millimeter',
    });
    return new Blob([buf], { type: EXPORT_MIME.threemf });
  }

  // --- Lifecycle ---

  dispose(handle: KernelBody | KernelFace | KernelEdge): void {
    if (!this.kernel) return;
    const id = handle.handle;
    // Discriminate by handle prefix; KernelFace and KernelEdge are
    // structurally identical so we can't rely on the `in` operator.
    const map = id.startsWith('body_')
      ? this.bodies
      : id.startsWith('face_')
        ? this.faces
        : id.startsWith('edge_')
          ? this.edges
          : null;
    if (!map) return;
    const shape = map.get(id);
    if (shape !== undefined) {
      try {
        this.kernel.release(shape);
      } catch (e) {
        console.warn('[OcctKernel] release failed for', id, e);
      }
      map.delete(id);
      if (map === this.bodies) {
        this.topologyCache.delete(id);
        this.tracker.forgetBody(id);
      }
    }
    if (id.startsWith('body_')) {
      // The faces and edges resolved on this body go with it. One already
      // disposed on its own is simply no longer in its map.
      const owned = this.subShapesOf.get(id);
      this.subShapesOf.delete(id);
      for (const sub of owned ?? []) this.dispose({ handle: sub, bodyHandle: id });
    }
  }
}

// ---- Wireframe / edge helpers ----

/** EdgeData from occt-wasm. Stays inline-typed because we only construct it via k.wireframe(). */
type EdgeDataInput = {
  points: Float32Array;
  edgeGroups: Int32Array;
  edgeCount: number;
};

/**
 * Convert per-edge polylines (from `k.wireframe`) into per-edge
 * LineSegments buffers. A polyline with N points has N-1 segments; each
 * segment is two points = 6 floats. The output is one Float32Array per
 * edge, in the same order as `edgeData.edgeGroups`.
 *
 * Why convert at all: Three.js `LineSegments` raycaster expects every
 * non-overlapping pair (v0,v1), (v2,v3), ... to be one segment. A
 * polyline-style buffer (v0,v1,v1,v2,v2,v3,...) would either need
 * `THREE.Line` (no per-segment hit index) or this conversion.
 *
 * **Unit contract (verified against the C++ producer in the occt-wasm
 * facade):**
 *   `edgeGroups[3i]`     = FLOAT offset into `points` (NOT point index)
 *   `edgeGroups[3i + 1]` = FLOAT count (= 3 × number of points)
 *   `edgeGroups[3i + 2]` = edge hash (% 2_147_483_647)
 *
 * The previous version of this function treated those values as POINT
 * units and then multiplied by 3 again, producing ~3× too many segments
 * per edge. The extra segments read past the edge's own data into the
 * next edge's points, drawing stray lines that crossed face interiors
 * (visible as X-shaped diagonals on rectangular faces and apparent
 * "extra strips" on cylindrical surfaces).
 */
function polylinesToLineSegments(edgeData: EdgeDataInput): Float32Array[] {
  const result: Float32Array[] = [];
  const points = edgeData.points;
  const groups = edgeData.edgeGroups;
  for (let i = 0; i < edgeData.edgeCount; i++) {
    const floatStart = groups[3 * i] ?? 0;       // float offset into `points`
    const floatCount = groups[3 * i + 1] ?? 0;   // float count (3 per point)
    const pointCount = floatCount / 3;
    if (pointCount < 2) {
      result.push(new Float32Array(0));
      continue;
    }
    const segCount = pointCount - 1;
    const buf = new Float32Array(segCount * 6);
    let dst = 0;
    for (let s = 0; s < segCount; s++) {
      const a = floatStart + s * 3;       // float offset of point s
      const b = floatStart + (s + 1) * 3; // float offset of point s+1
      buf[dst++] = points[a] ?? 0;
      buf[dst++] = points[a + 1] ?? 0;
      buf[dst++] = points[a + 2] ?? 0;
      buf[dst++] = points[b] ?? 0;
      buf[dst++] = points[b + 1] ?? 0;
      buf[dst++] = points[b + 2] ?? 0;
    }
    result.push(buf);
  }
  return result;
}

/** Concatenate per-edge LineSegments buffers into a single flat Float32Array. */
function concatLineSegments(perEdge: Float32Array[]): Float32Array {
  let total = 0;
  for (const e of perEdge) total += e.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const e of perEdge) {
    out.set(e, offset);
    offset += e.length;
  }
  return out;
}

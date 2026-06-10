/**
 * OcctKernel — occt-wasm@3.x implementation of {@link CadKernel}.
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
import type { StableFaceId, StableEdgeId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from './interface.ts';
import { build3MF, EXPORT_MIME } from './occtExports.ts';
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
 * for OCCT's internal `MapOfShape` hash. A large prime gives a near-zero
 * collision rate across typical CAD models. Used by `ShapeEvolutionTracker`
 * to key stable IDs.
 */
const HASH_UPPER_BOUND = 1_000_003;

/**
 * Modulus the mesher uses for `faceGroups[3*i + 2]` and the wireframe pass
 * uses for `edgeGroups[3*i + 2]`, hard-coded in the C++ facade as
 * `TopTools_ShapeMapHasher{}(shape) % 2147483647`. To pair faces returned
 * by `getSubShapes('face')` to their cached triangle ranges, we must call
 * `k.hashCode(face, MESH_HASH_BOUND)` so the JS-side and C++-side hashes
 * land in the same numeric space. Distinct from `HASH_UPPER_BOUND`
 * (1_000_003) which is the tracker's separate namespace.
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
 * Compute local U and V axis directions from a normal vector
 * (right-handed). Mirrors the v1 helper in occtKernel.ts.
 */
/**
 * Decode a string whose code units each carry one byte of binary data.
 * Used for binary STL export: occt-wasm returns the STL bytes through a
 * `string` return type, with each char taking a single byte (latin-1).
 */
function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

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
   * Per-body cache of the last tessellation, keyed by sub-shape hashCode.
   * Cleared on dispose.
   *
   * **Why hash-keyed and not index-keyed:** the mesher (`meshShape`) and
   * the topology walker (`getSubShapes('face')`) do not guarantee the same
   * iteration order over a shape's faces. occt-wasm@3 already ships the
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
      this.tracker.recordEvolution(
        body.handle,
        inputBodies.map(b => b.handle),
        faceHashes,
        record,
        origin,
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

  private storeFace(shape: ShapeHandle, bodyHandle: string): KernelFace {
    const handle = nextHandle('face');
    this.faces.set(handle, shape);
    return { handle, bodyHandle };
  }

  private storeEdge(shape: ShapeHandle, bodyHandle: string): KernelEdge {
    const handle = nextHandle('edge');
    this.edges.set(handle, shape);
    return { handle, bodyHandle };
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
      let faceShape: ShapeHandle;

      switch (profile.type) {
        case 'circle':
          faceShape = this.makeCircleFace(k, profile);
          break;
        case 'polygon':
          faceShape = this.makePolygonFace(k, profile);
          break;
        case 'wire':
          faceShape = this.makeWireFace(k, profile);
          break;
      }

      return ok(this.storeFace(faceShape, ''));
    } catch (e) {
      console.error('[OcctKernel] createSketchFace failed:', e);
      return err(
        kernelError('kernel', 'SKETCH_FACE_FAILED', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // `makeRectangleFace` was retired in task F together with the
  // worker's `ResolvedRectangle` and the schema's `SketchRectangleEntity`
  // (invariant #11 — no composite entities). Rectangles arrive as 4 lines
  // and build via the general polygon / wire face paths.

  private makeCircleFace(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
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
    const face = k.makeFace(wire);
    k.release(wire);
    k.release(edge);
    return face;
  }

  private makePolygonFace(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
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
    const face = k.makeFace(wire);
    k.release(wire);
    for (const e of edgeHandles) k.release(e);
    return face;
  }

  /**
   * Build a closed-loop face from a `'wire'` profile whose segments
   * preserve their native curve type (line / 3-point arc / circle).
   *
   * Uses polymorphic dispatch — each segment knows how to become a
   * kernel edge. For arc segments we use `makeArcEdge` (backed
   * by OCCT's `GC_MakeArcOfCircle_4`) so the resulting prism produces
   * one cylindrical lateral face per arc, not one strip face per sampled
   * facet.
   */
  private makeWireFace(k: UpstreamKernel, profile: ResolvedProfile): ShapeHandle {
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
      }
    }
    const wire = k.makeWire(edgeHandles);
    const face = k.makeFace(wire);
    k.release(wire);
    for (const e of edgeHandles) k.release(e);
    return face;
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

  // --- Boolean operations ---

  async booleanFuse(targets: KernelBody[]): Promise<Result<KernelBody, KernelError>> {
    try {
      if (targets.length < 2) {
        return err(kernelError('parameter', 'FUSE_NEEDS_2', 'Boolean fuse requires at least 2 bodies'));
      }
      const k = this.getKernel();
      // *WithHistory is binary-only; fold pairwise so each call gives us
      // per-input → per-result face mappings. After each step the
      // accumulated body becomes the next input — its tracker entry
      // (just populated by storeBodyWithHistory) feeds the next merge.
      const inputFaceHashes = this.collectInputFaceHashes(targets);
      let accBody = targets[0]!;
      for (let i = 1; i < targets.length; i++) {
        const evo = k.fuseWithHistory(
          this.getBodyShape(accBody),
          this.getBodyShape(targets[i]!),
          inputFaceHashes,
          HASH_UPPER_BOUND,
        );
        accBody = this.storeBodyWithHistory(
          evo.result,
          [accBody, targets[i]!],
          evo,
          'fuse',
        );
      }
      return ok(accBody);
    } catch (e) {
      console.error('[OcctKernel] booleanFuse failed:', e);
      return err(kernelError('kernel', 'FUSE_FAILED', e instanceof Error ? e.message : String(e)));
    }
  }

  async decomposeBody(body: KernelBody, origin: string): Promise<KernelBody[]> {
    return this.decomposeToBodies(this.getBodyShape(body), origin);
  }

  async booleanCut(
    target: KernelBody,
    tools: KernelBody[],
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      if (tools.length === 0) return ok(target);
      const k = this.getKernel();
      // Same pairwise fold as booleanFuse — cutWithHistory is binary,
      // so peel tools off one at a time. The result becomes the new
      // target for the next iteration.
      const inputFaceHashes = this.collectInputFaceHashes([target, ...tools]);
      let accBody = target;
      for (const tool of tools) {
        const evo = k.cutWithHistory(
          this.getBodyShape(accBody),
          this.getBodyShape(tool),
          inputFaceHashes,
          HASH_UPPER_BOUND,
        );
        accBody = this.storeBodyWithHistory(evo.result, [accBody, tool], evo, 'cut');
      }
      return ok(accBody);
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
      // Pairwise fold via intersectWithHistory — same shape as fuse/cut.
      const inputFaceHashes = this.collectInputFaceHashes(targets);
      let accBody = targets[0]!;
      for (let i = 1; i < targets.length; i++) {
        const evo = k.intersectWithHistory(
          this.getBodyShape(accBody),
          this.getBodyShape(targets[i]!),
          inputFaceHashes,
          HASH_UPPER_BOUND,
        );
        accBody = this.storeBodyWithHistory(
          evo.result,
          [accBody, targets[i]!],
          evo,
          'intersect',
        );
      }
      return ok(accBody);
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
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      if (count < 1) {
        return err(kernelError('parameter', 'PATTERN_COUNT', 'Pattern count must be at least 1'));
      }
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      const result = k.linearPattern(
        shape,
        { x: dir[0], y: dir[1], z: dir[2] },
        spacing,
        count,
      );
      return ok(this.storeModifiedBody(result, [body], 'linearPattern'));
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
  ): Promise<Result<KernelBody, KernelError>> {
    try {
      if (count < 1) {
        return err(kernelError('parameter', 'PATTERN_COUNT', 'Pattern count must be at least 1'));
      }
      const k = this.getKernel();
      const shape = this.getBodyShape(body);
      const result = k.circularPattern(
        shape,
        { x: axis.origin[0], y: axis.origin[1], z: axis.origin[2] },
        { x: axis.direction[0], y: axis.direction[1], z: axis.direction[2] },
        (2 * Math.PI) / count,
        count,
      );
      return ok(this.storeModifiedBody(result, [body], 'circularPattern'));
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
    try {
      for (let i = 0; i < faceShapes.length; i++) {
        const fh = faceShapes[i]!;
        // Two hashes per face: one in the mesh-bridge space (matches what
        // the C++ mesher wrote into faceGroups[*+2]), one in the tracker
        // namespace (smaller modulus). They are NOT interchangeable.
        const meshHash = k.hashCode(fh, MESH_HASH_BOUND);
        const trackerHash = k.hashCode(fh, HASH_UPPER_BOUND);
        const stable = this.tracker.getStableFaceId(body.handle, trackerHash);
        const range = cached?.faceRanges.get(meshHash);
        const triStart = range?.triStart ?? 0;
        const triCount = range?.triCount ?? 0;
        faces.push({
          faceId: makeFaceId(`f_${i}`),
          triStart,
          triEnd: triStart + triCount,
          semanticRef: `face_${i}`,
          ...(stable !== undefined ? { stableFaceId: stable } : {}),
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
      edges.push({
        edgeId: makeEdgeId(`e_${i}`),
        lineSegments,
        // adjacentFaces wiring deferred to a follow-up. The picker + highlight
        // don't need it; only consumers like Mirror-about-edge would.
        adjacentFaces: [firstFace, firstFace],
        ...(stable !== undefined ? { stableEdgeId: stable } : {}),
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
    const shape = this.getBodyShape(body);
    const targetHash = this.tracker.resolveStableFaceId(body.handle, stableFaceId);
    const faceShapes = k.getSubShapes(shape, 'face');
    let matched: ShapeHandle | undefined;

    if (targetHash !== undefined) {
      for (let i = 0; i < faceShapes.length; i++) {
        const fh = faceShapes[i]!;
        if (matched === undefined && k.hashCode(fh, HASH_UPPER_BOUND) === targetHash) {
          matched = fh;
        } else {
          k.release(fh);
        }
      }
    } else if (repairHint) {
      matched = this.pickFaceByHint(faceShapes, repairHint);
      // pickFaceByHint releases all non-matched handles itself.
    } else {
      for (const fh of faceShapes) k.release(fh);
    }

    if (matched === undefined) return null;
    return this.storeFace(matched, body.handle);
  }

  /**
   * Score-and-pick a face by {@link RepairHint}. Releases every handle in
   * `candidates` that isn't selected. Returns the winning handle (caller
   * owns it) or undefined if no candidate clears the thresholds.
   *
   * Thresholds are intentionally conservative — false positives are worse
   * than false negatives (a wrong attachment is a silent bug; a null lets
   * the UI prompt the user to re-pick).
   */
  private pickFaceByHint(candidates: ShapeHandle[], hint: RepairHint): ShapeHandle | undefined {
    const k = this.getKernel();
    const CENTROID_MAX_MM = 10;
    const NORMAL_MAX_RAD = 0.5;
    const AREA_RATIO_MIN = 0.5;
    const AREA_RATIO_MAX = 2.0;

    let bestIdx = -1;
    let bestScore = Infinity;
    const scored: { idx: number; centroidDist: number }[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const fh = candidates[i]!;
      let pass = true;
      let centroidDist = 0;

      if (hint.centroid) {
        const com = k.getSurfaceCenterOfMass(fh);
        const dx = com.x - hint.centroid[0];
        const dy = com.y - hint.centroid[1];
        const dz = com.z - hint.centroid[2];
        centroidDist = Math.hypot(dx, dy, dz);
        if (centroidDist > CENTROID_MAX_MM) pass = false;
      }

      if (pass && hint.normal) {
        const uv = k.uvBounds(fh);
        const uMid = (uv.uMin + uv.uMax) / 2;
        const vMid = (uv.vMin + uv.vMax) / 2;
        const n = k.surfaceNormal(fh, uMid, vMid);
        // Cosine of the angle between hint.normal and the face normal.
        const dot = n.x * hint.normal[0] + n.y * hint.normal[1] + n.z * hint.normal[2];
        // Both vectors are unit-length; clamp for numerical safety.
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (angle > NORMAL_MAX_RAD) pass = false;
      }

      if (pass && hint.area !== undefined) {
        const area = k.getSurfaceArea(fh);
        if (hint.area > 0) {
          const ratio = area / hint.area;
          if (ratio < AREA_RATIO_MIN || ratio > AREA_RATIO_MAX) pass = false;
        }
      }

      if (pass) {
        scored.push({ idx: i, centroidDist });
        if (centroidDist < bestScore) {
          bestScore = centroidDist;
          bestIdx = i;
        }
      }
    }

    let winner: ShapeHandle | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const fh = candidates[i]!;
      if (i === bestIdx) {
        winner = fh;
      } else {
        k.release(fh);
      }
    }
    void scored; // reserved for richer scoring in a future refinement
    return winner;
  }

  async getFacePlane(face: KernelFace): Promise<{
    origin: Vec3;
    uAxis: Vec3;
    vAxis: Vec3;
    normal: Vec3;
  }> {
    const k = this.getKernel();
    const fh = this.getFaceShape(face);

    // Origin: surface centroid (already used by pickFaceByHint:938).
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
    };
  }

  async resolveEdgeRef(
    body: KernelBody,
    stableEdgeId: StableEdgeId,
    repairHint?: RepairHint,
  ): Promise<KernelEdge | null> {
    const k = this.getKernel();
    const shape = this.getBodyShape(body);
    const targetHash = this.tracker.resolveStableEdgeId(body.handle, stableEdgeId);
    const edgeShapes = k.getSubShapes(shape, 'edge');
    let matched: ShapeHandle | undefined;

    if (targetHash !== undefined) {
      for (let i = 0; i < edgeShapes.length; i++) {
        const eh = edgeShapes[i]!;
        if (matched === undefined && k.hashCode(eh, HASH_UPPER_BOUND) === targetHash) {
          matched = eh;
        } else {
          k.release(eh);
        }
      }
    } else if (repairHint) {
      matched = this.pickEdgeByHint(edgeShapes, repairHint);
    } else {
      for (const eh of edgeShapes) k.release(eh);
    }

    if (matched === undefined) return null;
    return this.storeEdge(matched, body.handle);
  }

  /**
   * Score-and-pick an edge by {@link RepairHint}. Currently uses only the
   * `centroid` field — interpreted as the edge midpoint via OCCT's linear
   * center-of-mass. `normal` and `area` are face-scoped concepts; edge
   * tangent/length matching can be added when needed.
   */
  private pickEdgeByHint(candidates: ShapeHandle[], hint: RepairHint): ShapeHandle | undefined {
    const k = this.getKernel();
    const MIDPOINT_MAX_MM = 10;
    let bestIdx = -1;
    let bestDist = MIDPOINT_MAX_MM;

    if (hint.centroid) {
      for (let i = 0; i < candidates.length; i++) {
        const eh = candidates[i]!;
        const com = k.getLinearCenterOfMass(eh);
        const dx = com.x - hint.centroid[0];
        const dy = com.y - hint.centroid[1];
        const dz = com.z - hint.centroid[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }

    let winner: ShapeHandle | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const eh = candidates[i]!;
      if (i === bestIdx) {
        winner = eh;
      } else {
        k.release(eh);
      }
    }
    return winner;
  }

  async getBoundingBox(body: KernelBody): Promise<BoundingBox3D> {
    const k = this.getKernel();
    const shape = this.getBodyShape(body);
    // useTriangulation=true matches v1 (BRepBndLib.Add(shape, box, true)).
    const bb = k.getBoundingBox(shape, true);
    return { min: [bb.xmin, bb.ymin, bb.zmin], max: [bb.xmax, bb.ymax, bb.zmax] };
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
      const root = k.importStl(data);
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
    // a transient compound. Schema is not user-selectable in occt-wasm@3.1.0
    // (it picks AP214 internally — same default as v1).
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
      // occt-wasm's exportStl returns a string. For binary STL the upstream
      // builds the binary payload and decodes it as latin-1 so every byte
      // survives in a JS string — we re-encode with a 1:1 byte mapping.
      const text = k.exportStl(target, linear, !binary);
      const bytes = binary ? latin1ToBytes(text) : new TextEncoder().encode(text);
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

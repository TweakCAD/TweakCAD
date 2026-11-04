/**
 * CAD Worker entry point.
 *
 * Runs in a dedicated Web Worker thread. Owns the OcctKernel WASM instance
 * and exposes a typed API via Comlink. The main thread never touches kernel
 * handles directly - only serializable data crosses the boundary.
 *
 * Architecture invariant: workers own kernel handles. The main thread
 * receives only serializable data: meshes, IDs, diagnostics, blobs.
 */

import * as Comlink from 'comlink';
import type { CadPart, CadProject, DisplayMesh, TopologyMap, FeatureBuildResult, ConstructionPlaneDisplay, SketchPlaneDisplay } from '@tweakcad/core/src/document/schema.ts';
import { bodyColorOf } from '@tweakcad/core/src/document/schema.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { incrementalRebuild, sweepPreviousRebuild, sweepRemovedParts, releaseRebuildBodies } from './rebuilder.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { MeasureTarget, MeasureResult } from './protocol.ts';

// ---- Types (serializable across worker boundary) ----

/** Serializable rebuild result - no kernel handles, only cloneable data */
export type WorkerRebuildResult = {
  partId: PartId;
  status: 'success' | 'partial' | 'failed';
  featureResults: FeatureBuildResult[];
  meshes: DisplayMesh[];
  topologyMaps: TopologyMap[];
  /**
   * Construction planes for the viewport to render as translucent
   * rectangles. Always present; may be empty when no plane features exist.
   */
  constructionPlanes: ConstructionPlaneDisplay[];
  /** World frames of the sketches placed on body faces. */
  sketchPlanes: SketchPlaneDisplay[];
  /** Mapping from bodyId to the featureId that created it */
  bodyToFeatureMap: Record<string, string>;
  diagnostics: string[];
};

// ---- Kernel State ----

let kernel: CadKernel | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the OcctKernel WASM module. One load per worker lifetime —
 * concurrent callers await the same promise. Init errors propagate to the
 * caller (WorkerPool surfaces them via its `init failed` log) and clear
 * the cached promise: re-awaiting a rejected one would rethrow the
 * original failure for the rest of the worker's life, so a retry would
 * never reach the kernel even if the cause was transient.
 */
async function ensureKernel(): Promise<CadKernel> {
  if (kernel && ready) return kernel;

  if (initPromise) {
    await initPromise;
    return kernel!;
  }

  const loading = (async () => {
    const startTime = performance.now();
    kernel = new OcctKernel();
    await kernel.init();
    const elapsed = (performance.now() - startTime).toFixed(0);
    console.log(`[CadWorker] OcctKernel (occt-wasm@5) loaded in ${elapsed}ms`);
    ready = true;
  })();
  initPromise = loading;

  try {
    await loading;
  } catch (error) {
    if (initPromise === loading) {
      initPromise = null;
      kernel = null;
    }
    throw error;
  }
  return kernel!;
}

/**
 * Each part's bodies from its last rebuild, by part id then body id.
 *
 * The rebuilder keeps these handles until the next `buildPart` of the same
 * part sweeps them; this adds the id → handle mapping that measurement needs,
 * since the main thread only ever knows body ids. A part's entry is replaced
 * whenever that part rebuilds, and dropped when it leaves the document, so it
 * never names a handle a sweep has freed. Per part because the viewport shows
 * every part at once: one map, replaced per rebuild, made every part but the
 * last one built unmeasurable.
 */
const lastRebuildBodies = new Map<string, Map<string, KernelBody>>();

/** The handle of a body from any part's last rebuild, if it still exists. */
function liveBody(bodyId: string): KernelBody | undefined {
  for (const bodies of lastRebuildBodies.values()) {
    const handle = bodies.get(bodyId);
    if (handle) return handle;
  }
  return undefined;
}

// ---- Worker API ----

const api = {
  /**
   * Initialize the kernel eagerly (called once on worker spawn).
   * Subsequent calls are no-ops.
   */
  async init(): Promise<{ kernelType: string; loadTimeMs: number }> {
    const startTime = performance.now();
    await ensureKernel();
    const loadTimeMs = Math.round(performance.now() - startTime);
    return { kernelType: 'occt', loadTimeMs };
  },

  /**
   * Run an incremental rebuild for a part.
   * Returns only serializable data - kernel handles stay in the worker.
   */
  async buildPart(
    part: CadPart,
    project: CadProject,
    fromIndex?: number,
  ): Promise<WorkerRebuildResult> {
    const k = await ensureKernel();
    // Free the bodies THIS PART's last rebuild left behind before building new
    // ones, and those of parts that have left the document. Other parts'
    // bodies stay: they are still on screen and can still be measured.
    // Done here rather than inside `incrementalRebuild` because the export
    // paths call that too, and an export must not free bodies belonging to an
    // export still assembling its blob. This worker only ever serves rebuilds,
    // so by the time a part rebuilds its previous result is finished with.
    const livePartIds = Object.keys(project.parts);
    sweepPreviousRebuild(k, String(part.id));
    sweepRemovedParts(k, livePartIds);
    for (const partId of lastRebuildBodies.keys()) {
      if (!livePartIds.includes(partId)) lastRebuildBodies.delete(partId);
    }
    const result = await incrementalRebuild(part, project, k, fromIndex);

    lastRebuildBodies.set(
      String(part.id),
      new Map(result.bodies.map((b) => [String(b.bodyId), b.handle])),
    );

    // Strip non-serializable kernel handles from the result.
    // The worker retains ownership of the WASM shape handles.
    return {
      partId: result.partId,
      status: result.status,
      featureResults: result.featureResults,
      meshes: result.meshes,
      topologyMaps: result.topologyMaps,
      constructionPlanes: result.constructionPlanes,
      sketchPlanes: result.sketchPlanes,
      bodyToFeatureMap: result.bodyToFeatureMap,
      diagnostics: result.diagnostics,
    };
  },

  /**
   * Export a part as STL.
   * Returns the raw ArrayBuffer (transferable for zero-copy).
   */
  async exportStl(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const k = await ensureKernel();
    const result = await incrementalRebuild(part, project, k, 0);

    // Collect all kernel body handles
    const bodyHandles = result.bodies.map(b => b.handle);
    if (bodyHandles.length === 0) {
      return new ArrayBuffer(0);
    }

    // Export via kernel (uses OCCT's StlAPI_Writer)
    try {
      const blob = await k.exportStl(bodyHandles);
      return await blob.arrayBuffer();
    } finally {
      releaseRebuildBodies(k, result.bodies);
    }
  },

  /**
   * Export a part as STEP.
   * Returns the raw ArrayBuffer (transferable for zero-copy).
   */
  async exportStep(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const k = await ensureKernel();
    const result = await incrementalRebuild(part, project, k, 0);

    const bodyHandles = result.bodies.map(b => b.handle);
    if (bodyHandles.length === 0) {
      return new ArrayBuffer(0);
    }

    try {
      const blob = await k.exportStep(bodyHandles, { colors: result.bodies.map(b => bodyColorOf(part, b.bodyId)) });
      return await blob.arrayBuffer();
    } finally {
      releaseRebuildBodies(k, result.bodies);
    }
  },

  /**
   * Export a part as binary BREP (OCCT's native B-Rep format).
   * Returns the raw ArrayBuffer (transferable for zero-copy).
   */
  async exportBrep(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const k = await ensureKernel();
    const result = await incrementalRebuild(part, project, k, 0);

    const bodyHandles = result.bodies.map(b => b.handle);
    if (bodyHandles.length === 0) {
      return new ArrayBuffer(0);
    }

    try {
      const blob = await k.exportBrep(bodyHandles);
      return await blob.arrayBuffer();
    } finally {
      releaseRebuildBodies(k, result.bodies);
    }
  },

  /**
   * Export a part as 3MF (mesh-based, ZIP archive).
   * Returns the raw ArrayBuffer (transferable for zero-copy).
   */
  async export3MF(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const k = await ensureKernel();
    const result = await incrementalRebuild(part, project, k, 0);

    const bodyHandles = result.bodies.map(b => b.handle);
    if (bodyHandles.length === 0) {
      return new ArrayBuffer(0);
    }

    try {
      const blob = await k.export3MF(bodyHandles, {
        name: part.name,
        colors: result.bodies.map(b => bodyColorOf(part, b.bodyId)),
      });
      return await blob.arrayBuffer();
    } finally {
      releaseRebuildBodies(k, result.bodies);
    }
  },

  /**
   * Measure something in the current geometry of any part.
   *
   * Reads the bodies each part's last rebuild left alive — the ones
   * `buildPart` sweeps when that part next rebuilds — so measuring costs a kernel query
   * rather than a rebuild. A target whose body is no longer there returns
   * null rather than throwing: selection can outlive the geometry it points
   * at, and "nothing to measure" is a normal state for a panel to be in.
   *
   * Lengths and areas come off the BREP, not the display mesh. A tessellated
   * arc is a chain of chords and reads short by an amount that depends on the
   * deflection setting — a measurement that changes when you change display
   * quality is not a measurement.
   */
  async measure(target: MeasureTarget): Promise<MeasureResult | null> {
    const k = await ensureKernel();
    const body = liveBody(target.bodyId);
    if (!body) return null;

    if (target.kind === 'body') {
      if (!k.getMassProperties) return null;
      const [mass, bbox] = await Promise.all([
        k.getMassProperties(body),
        k.getBoundingBox(body),
      ]);
      return {
        kind: 'body',
        volume: mass.volume,
        surfaceArea: mass.surfaceArea,
        centerOfMass: mass.centerOfMass,
        boundingBox: { min: bbox.min, max: bbox.max },
      };
    }

    if (target.kind === 'face') {
      if (!k.getFaceArea) return null;
      const face = await k.resolveFaceRef(body, target.stableFaceId as never);
      if (!face) return null;
      return { kind: 'face', area: await k.getFaceArea(face) };
    }

    if (!k.getEdgeLength) return null;
    const edge = await k.resolveEdgeRef(body, target.stableEdgeId as never);
    if (!edge) return null;
    return { kind: 'edge', length: await k.getEdgeLength(edge) };
  },

  /**
   * Reset worker state. Kernel WASM memory is freed when the worker is
   * terminated by the browser (Worker.terminate()). Individual shape handles
   * are released during the rebuild cycle: the rebuilder frees shapes a
   * feature orphans, `buildPart` sweeps the previous rebuild's survivors, and
   * each export releases the bodies its own rebuild produced.
   */
  async reset(): Promise<void> {
    lastRebuildBodies.clear();
    kernel = null;
    ready = false;
    initPromise = null;
  },
};

/** Type exported for the main thread to use with Comlink.wrap */
export type CadWorkerApi = typeof api;

// Expose the API to the main thread via Comlink
Comlink.expose(api);

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
import type { CadPart, CadProject, DisplayMesh, TopologyMap, FeatureBuildResult } from '@tweakcad/core/src/document/schema.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { incrementalRebuild } from './rebuilder.ts';

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
  constructionPlanes: import('@tweakcad/core/src/document/schema.ts').ConstructionPlaneDisplay[];
  /** Mapping from bodyId to the featureId that created it */
  bodyToFeatureMap: Record<string, string>;
  diagnostics: string[];
};

// ---- Kernel State ----

let kernel: CadKernel | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the OcctKernel WASM module. Singleton — only runs once per
 * worker lifetime. Init errors propagate to the caller (WorkerPool surfaces
 * them via its `init failed` log).
 */
async function ensureKernel(): Promise<CadKernel> {
  if (kernel && ready) return kernel;

  if (initPromise) {
    await initPromise;
    return kernel!;
  }

  initPromise = (async () => {
    const startTime = performance.now();
    kernel = new OcctKernel();
    await kernel.init();
    const elapsed = (performance.now() - startTime).toFixed(0);
    console.log(`[CadWorker] OcctKernel (occt-wasm@3) loaded in ${elapsed}ms`);
    ready = true;
  })();

  await initPromise;
  return kernel!;
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
    const result = await incrementalRebuild(part, project, k, fromIndex);

    // Strip non-serializable kernel handles from the result.
    // The worker retains ownership of the WASM shape handles.
    return {
      partId: result.partId,
      status: result.status,
      featureResults: result.featureResults,
      meshes: result.meshes,
      topologyMaps: result.topologyMaps,
      constructionPlanes: result.constructionPlanes,
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
    const blob = await k.exportStl(bodyHandles);
    return blob.arrayBuffer();
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

    const blob = await k.exportStep(bodyHandles);
    return blob.arrayBuffer();
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

    const blob = await k.exportBrep(bodyHandles);
    return blob.arrayBuffer();
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

    const blob = await k.export3MF(bodyHandles, { name: part.name });
    return blob.arrayBuffer();
  },

  /**
   * Reset worker state. Kernel WASM memory is freed when the worker
   * is terminated by the browser (Worker.terminate()). Individual
   * shape handles should be freed via kernel.dispose(handle) during
   * rebuilds, but that's managed within the rebuild cycle.
   */
  async reset(): Promise<void> {
    kernel = null;
    ready = false;
    initPromise = null;
  },
};

/** Type exported for the main thread to use with Comlink.wrap */
export type CadWorkerApi = typeof api;

// Expose the API to the main thread via Comlink
Comlink.expose(api);

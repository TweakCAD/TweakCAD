/**
 * WorkerPool - manages dedicated Web Workers for CAD operations.
 *
 * Multi-lane architecture (section 11):
 *   - Rebuild lane: Full incremental timeline rebuild (cancellable)
 *   - Export lane: STL/STEP export (background, non-blocking)
 *
 * Each lane is a separate Worker thread with its own OcctKernel WASM instance.
 * The main thread only receives serializable data (DisplayMesh, diagnostics, blobs).
 *
 * Note: Preview lane (fast partial rebuild during drag) is deferred to a
 * future phase when the sketch interaction model is implemented.
 */

import * as Comlink from 'comlink';
import type { CadPart, CadProject } from '@tweakcad/core/src/document/schema.ts';
import type { CadWorkerApi, WorkerRebuildResult } from './cadWorker.ts';
import type { MeasureTarget, MeasureResult } from './protocol.ts';

// ---- Types ----

export type WorkerStatus = 'idle' | 'initializing' | 'busy' | 'error';

export type PoolStatus = {
  rebuild: WorkerStatus;
  export: WorkerStatus;
};

// ---- WorkerPool ----

export class WorkerPool {
  private rebuildWorker: Comlink.Remote<CadWorkerApi> | null = null;
  private exportWorker: Comlink.Remote<CadWorkerApi> | null = null;
  private rebuildRaw: Worker | null = null;
  private exportRaw: Worker | null = null;

  private rebuildStatus: WorkerStatus = 'idle';
  private exportStatus: WorkerStatus = 'idle';

  /** In-flight `init()` per lane, so concurrent callers share one spawn. */
  private rebuildInit: Promise<Comlink.Remote<CadWorkerApi>> | null = null;
  private exportInit: Promise<Comlink.Remote<CadWorkerApi>> | null = null;

  /** Current pending rebuild - used for cancellation */
  private currentRebuildId = 0;

  /**
   * Spawn a new worker and wrap it with Comlink.
   * The worker URL uses Vite's `new URL('./cadWorker.ts', import.meta.url)` pattern
   * which Vite transforms into a proper worker bundle during build.
   *
   * `protected` so tests can substitute a worker whose `init()` they
   * control — the lane lifecycle (what happens to a worker whose kernel
   * failed to load) is the part worth pinning, and it can't be reached
   * through a real WASM boot.
   */
  protected spawn(): { raw: Worker; wrapped: Comlink.Remote<CadWorkerApi> } {
    const raw = new Worker(
      new URL('./cadWorker.ts', import.meta.url),
      { type: 'module' },
    );
    const wrapped = Comlink.wrap<CadWorkerApi>(raw);
    return { raw, wrapped };
  }

  /**
   * Spawn and initialize one lane's worker, or hand back the one that is
   * already running. Lazy — the export lane costs a second WASM instance,
   * so it waits for the first export request.
   *
   * A failed `init()` must leave nothing behind. Inside the worker,
   * `ensureKernel` caches its init promise and re-awaits it, so a cached
   * handle to a worker whose kernel never loaded rejects every later call
   * for the lifetime of the page: the rebuild lane survives that on the
   * scheduler's main-thread fallback, but export has no fallback, so one
   * failed boot used to kill every export for the session. On rejection
   * the raw worker is terminated (not just dropped — otherwise the dead
   * thread and its half-loaded WASM instance stay resident) and the next
   * request starts clean.
   */
  private ensureWorker(lane: 'rebuild' | 'export'): Promise<Comlink.Remote<CadWorkerApi>> {
    const ready = lane === 'rebuild' ? this.rebuildWorker : this.exportWorker;
    if (ready) return Promise.resolve(ready);
    // Two exports racing on first use would otherwise spawn two workers
    // and leak whichever lost.
    const pending = lane === 'rebuild' ? this.rebuildInit : this.exportInit;
    if (pending) return pending;

    const { raw, wrapped } = this.spawn();
    this.setStatus(lane, 'initializing');
    // Tracked before the await so `dispose()` can terminate a worker
    // that is still booting.
    if (lane === 'rebuild') this.rebuildRaw = raw; else this.exportRaw = raw;

    const booting = (async (): Promise<Comlink.Remote<CadWorkerApi>> => {
      try {
        const info = await wrapped.init();
        const stillOurs = lane === 'rebuild' ? this.rebuildRaw === raw : this.exportRaw === raw;
        if (!stillOurs) {
          // Disposed mid-boot. The pool is being torn down, so don't
          // publish a handle to a worker nobody is tracking.
          raw.terminate();
          throw new Error(`[WorkerPool] ${lane} worker disposed during init`);
        }
        console.log(`[WorkerPool] ${lane} worker ready: kernel=${info.kernelType}, load=${info.loadTimeMs}ms`);
        if (lane === 'rebuild') this.rebuildWorker = wrapped; else this.exportWorker = wrapped;
        this.setStatus(lane, 'idle');
        return wrapped;
      } catch (error) {
        this.setStatus(lane, 'error');
        console.error(`[WorkerPool] ${lane} worker init failed:`, error);
        raw.terminate();
        if (lane === 'rebuild') {
          if (this.rebuildRaw === raw) this.rebuildRaw = null;
          this.rebuildWorker = null;
        } else {
          if (this.exportRaw === raw) this.exportRaw = null;
          this.exportWorker = null;
        }
        throw error;
      } finally {
        if (lane === 'rebuild') this.rebuildInit = null; else this.exportInit = null;
      }
    })();

    if (lane === 'rebuild') this.rebuildInit = booting; else this.exportInit = booting;
    return booting;
  }

  private setStatus(lane: 'rebuild' | 'export', status: WorkerStatus): void {
    if (lane === 'rebuild') this.rebuildStatus = status;
    else this.exportStatus = status;
  }

  private ensureRebuildWorker(): Promise<Comlink.Remote<CadWorkerApi>> {
    return this.ensureWorker('rebuild');
  }

  private ensureExportWorker(): Promise<Comlink.Remote<CadWorkerApi>> {
    return this.ensureWorker('export');
  }

  /**
   * Request a rebuild for a part.
   *
   * If a rebuild is already in progress, this increments the rebuildId.
   * The caller should check document revision to discard stale results.
   * Actual WASM cancellation is not possible (no AbortSignal in WASM),
   * but the stale-result guard in rebuildScheduler handles this.
   *
   * @param part - The part to rebuild
   * @param project - The full project (for parameters)
   * @param fromIndex - Start from this timeline index (0 = full)
   * @returns Serializable rebuild result
   */
  async requestRebuild(
    part: CadPart,
    project: CadProject,
    fromIndex?: number,
  ): Promise<WorkerRebuildResult> {
    const worker = await this.ensureRebuildWorker();
    const rebuildId = ++this.currentRebuildId;
    this.rebuildStatus = 'busy';

    try {
      const result = await worker.buildPart(part, project, fromIndex);

      // If a newer rebuild was requested while we were running,
      // mark this result as potentially stale (caller checks revision)
      if (rebuildId !== this.currentRebuildId) {
        console.log('[WorkerPool] Rebuild completed but newer request exists, returning anyway');
      }

      return result;
    } finally {
      if (rebuildId === this.currentRebuildId) {
        this.rebuildStatus = 'idle';
      }
    }
  }

  /**
   * Export a part to STL format.
   * Runs on the export worker (does not block rebuilds).
   */
  async requestExportStl(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const worker = await this.ensureExportWorker();
    this.exportStatus = 'busy';
    try {
      return await worker.exportStl(part, project);
    } finally {
      this.exportStatus = 'idle';
    }
  }

  /**
   * Export a part to STEP format.
   * Runs on the export worker (does not block rebuilds).
   */
  async requestExportStep(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const worker = await this.ensureExportWorker();
    this.exportStatus = 'busy';
    try {
      return await worker.exportStep(part, project);
    } finally {
      this.exportStatus = 'idle';
    }
  }

  /**
   * Export a part to binary BREP format.
   * Runs on the export worker (does not block rebuilds).
   */
  async requestExportBrep(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const worker = await this.ensureExportWorker();
    this.exportStatus = 'busy';
    try {
      return await worker.exportBrep(part, project);
    } finally {
      this.exportStatus = 'idle';
    }
  }

  /**
   * Export a part to 3MF format.
   * Runs on the export worker (does not block rebuilds).
   */
  async requestExport3MF(
    part: CadPart,
    project: CadProject,
  ): Promise<ArrayBuffer> {
    const worker = await this.ensureExportWorker();
    this.exportStatus = 'busy';
    try {
      return await worker.export3MF(part, project);
    } finally {
      this.exportStatus = 'idle';
    }
  }

  /**
   * Get the current status of both lanes.
   */
  /**
   * Measure something in the rebuild worker's current geometry.
   *
   * Goes to the **rebuild** worker specifically: it is the one holding the
   * bodies the last rebuild produced. The export worker runs its own kernel
   * and its own throwaway rebuild, so it knows nothing about what is on
   * screen.
   *
   * Returns null when the target no longer exists — selection outlives
   * geometry routinely, and a panel showing nothing is the correct response.
   */
  async requestMeasure(target: MeasureTarget): Promise<MeasureResult | null> {
    const worker = await this.ensureRebuildWorker();
    return worker.measure(target);
  }

  getStatus(): PoolStatus {
    return {
      rebuild: this.rebuildStatus,
      export: this.exportStatus,
    };
  }

  /**
   * Terminate all workers and free resources.
   */
  dispose(): void {
    if (this.rebuildRaw) {
      this.rebuildRaw.terminate();
      this.rebuildRaw = null;
      this.rebuildWorker = null;
    }
    if (this.exportRaw) {
      this.exportRaw.terminate();
      this.exportRaw = null;
      this.exportWorker = null;
    }
    this.rebuildStatus = 'idle';
    this.exportStatus = 'idle';
  }
}

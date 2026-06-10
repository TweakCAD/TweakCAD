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

  /** Current pending rebuild - used for cancellation */
  private currentRebuildId = 0;

  /**
   * Spawn a new worker and wrap it with Comlink.
   * The worker URL uses Vite's `new URL('./cadWorker.ts', import.meta.url)` pattern
   * which Vite transforms into a proper worker bundle during build.
   */
  private spawn(): { raw: Worker; wrapped: Comlink.Remote<CadWorkerApi> } {
    const raw = new Worker(
      new URL('./cadWorker.ts', import.meta.url),
      { type: 'module' },
    );
    const wrapped = Comlink.wrap<CadWorkerApi>(raw);
    return { raw, wrapped };
  }

  /**
   * Ensure the rebuild worker is spawned and initialized.
   */
  private async ensureRebuildWorker(): Promise<Comlink.Remote<CadWorkerApi>> {
    if (this.rebuildWorker) return this.rebuildWorker;

    this.rebuildStatus = 'initializing';
    const { raw, wrapped } = this.spawn();
    this.rebuildRaw = raw;
    this.rebuildWorker = wrapped;

    try {
      const info = await wrapped.init();
      console.log(`[WorkerPool] Rebuild worker ready: kernel=${info.kernelType}, load=${info.loadTimeMs}ms`);
      this.rebuildStatus = 'idle';
    } catch (error) {
      this.rebuildStatus = 'error';
      console.error('[WorkerPool] Rebuild worker init failed:', error);
      throw error;
    }

    return this.rebuildWorker;
  }

  /**
   * Ensure the export worker is spawned and initialized.
   * Only spawned on first export request (lazy).
   */
  private async ensureExportWorker(): Promise<Comlink.Remote<CadWorkerApi>> {
    if (this.exportWorker) return this.exportWorker;

    this.exportStatus = 'initializing';
    const { raw, wrapped } = this.spawn();
    this.exportRaw = raw;
    this.exportWorker = wrapped;

    try {
      const info = await wrapped.init();
      console.log(`[WorkerPool] Export worker ready: kernel=${info.kernelType}, load=${info.loadTimeMs}ms`);
      this.exportStatus = 'idle';
    } catch (error) {
      this.exportStatus = 'error';
      console.error('[WorkerPool] Export worker init failed:', error);
      throw error;
    }

    return this.exportWorker;
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

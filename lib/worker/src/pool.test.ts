/**
 * Lane lifecycle tests for `WorkerPool`.
 *
 * What matters here is what the pool does with a worker whose kernel
 * never loaded. A cached handle to one is poison: inside the worker,
 * `ensureKernel` re-awaits its stored init promise, so every later call
 * rejects with the original failure. The rebuild lane rides that out on
 * the scheduler's main-thread fallback; the export lane has no fallback,
 * so a single failed boot took every export for the rest of the session.
 *
 * The real `spawn()` needs a browser `Worker` and a WASM load, so these
 * drive the pool through a stand-in whose `init()` the test controls.
 */

import { describe, it, expect } from 'vitest';
import type * as Comlink from 'comlink';
import { WorkerPool } from './pool.ts';
import type { CadWorkerApi } from './cadWorker.ts';
import type { CadPart, CadProject } from '@tweakcad/core/src/document/schema.ts';

const PART = {} as CadPart;
const PROJECT = {} as CadProject;

class TestPool extends WorkerPool {
  spawnCount = 0;
  terminateCount = 0;
  /** One entry per expected spawn: resolve or reject that worker's init. */
  initOutcomes: Array<'ok' | 'fail'> = [];
  /** Resolvers for the pending init of each spawned worker, in order. */
  private gates: Array<() => void> = [];

  protected override spawn(): { raw: Worker; wrapped: Comlink.Remote<CadWorkerApi> } {
    const index = this.spawnCount++;
    const raw = {
      terminate: () => { this.terminateCount++; },
    } as unknown as Worker;

    const init = (): Promise<{ kernelType: string; loadTimeMs: number }> =>
      new Promise((resolve, reject) => {
        this.gates[index] = () => {
          if (this.initOutcomes[index] === 'fail') reject(new Error('kernel load failed'));
          else resolve({ kernelType: 'occt', loadTimeMs: 1 });
        };
      });

    const wrapped = {
      init,
      exportStl: async () => new ArrayBuffer(8),
      exportStep: async () => new ArrayBuffer(8),
    } as unknown as Comlink.Remote<CadWorkerApi>;

    return { raw, wrapped };
  }

  /** Settle the Nth spawned worker's `init()`. */
  async settle(index: number): Promise<void> {
    // Give the pool a turn to register its gate before we trip it.
    for (let i = 0; i < 20 && !this.gates[index]; i++) await Promise.resolve();
    this.gates[index]!();
  }
}

describe('WorkerPool — lane boot', () => {
  it('does not cache an export worker whose init failed', async () => {
    const pool = new TestPool();
    pool.initOutcomes = ['fail', 'ok'];

    const first = pool.requestExportStl(PART, PROJECT);
    await pool.settle(0);
    await expect(first).rejects.toThrow('kernel load failed');
    expect(pool.getStatus().export).toBe('error');
    // Dropping the reference isn't enough — the dead thread and its
    // half-loaded WASM instance have to go.
    expect(pool.terminateCount).toBe(1);

    // The next export gets a fresh worker instead of the poisoned one.
    const second = pool.requestExportStl(PART, PROJECT);
    await pool.settle(1);
    await expect(second).resolves.toBeInstanceOf(ArrayBuffer);
    expect(pool.spawnCount).toBe(2);
    expect(pool.getStatus().export).toBe('idle');
  });

  it('does not cache a rebuild worker whose init failed', async () => {
    const pool = new TestPool();
    pool.initOutcomes = ['fail'];

    const first = pool.requestRebuild(PART, PROJECT);
    await pool.settle(0);
    await expect(first).rejects.toThrow('kernel load failed');
    expect(pool.getStatus().rebuild).toBe('error');
    expect(pool.terminateCount).toBe(1);
  });

  it('shares one spawn between callers racing on first use', async () => {
    const pool = new TestPool();
    pool.initOutcomes = ['ok'];

    const stl = pool.requestExportStl(PART, PROJECT);
    const step = pool.requestExportStep(PART, PROJECT);
    await pool.settle(0);
    await expect(Promise.all([stl, step])).resolves.toHaveLength(2);
    // Two concurrent first-use requests used to spawn two workers and
    // leak whichever one lost the assignment race.
    expect(pool.spawnCount).toBe(1);
    expect(pool.terminateCount).toBe(0);
  });

  it('reuses the worker once it is up', async () => {
    const pool = new TestPool();
    pool.initOutcomes = ['ok'];

    const first = pool.requestExportStl(PART, PROJECT);
    await pool.settle(0);
    await first;
    await pool.requestExportStep(PART, PROJECT);
    expect(pool.spawnCount).toBe(1);
  });

  it('terminates a worker that is still booting when disposed', async () => {
    const pool = new TestPool();
    pool.initOutcomes = ['ok'];

    const pending = pool.requestExportStl(PART, PROJECT);
    pool.dispose();
    await pool.settle(0);
    await expect(pending).rejects.toThrow(/disposed during init/);
    // Once by dispose, once by the boot discovering it was disposed.
    expect(pool.terminateCount).toBeGreaterThanOrEqual(1);
  });
});

/**
 * `waitForRebuildIdle` — shared settle-the-worker primitive.
 *
 * Used by both the in-app chat ToolHost (browserToolHost.ts) and the
 * MCP bridge client (mcpBridgeClient.ts) so they observe the same
 * settling behavior. The dispatch path is racy:
 *
 *   bus.dispatch(cmd)                  // sync: notifies dirtyListeners
 *     → requestRebuild(partId)         // rebuild queue in rebuildScheduler.ts
 *       → viewportStore.setRebuilding(true)   // sync, unless one is running
 *       → await pool.requestRebuild(...)      // first suspension point
 *
 * By the time dispatchCommand returns to the caller, `rebuilding === true`
 * has already been set. We then subscribe and resolve on the first
 * transition to `false`. A one-tick settling delay catches the case where
 * a second rebuild is queued back-to-back and would briefly flip the flag
 * back to true.
 *
 * Throws on timeout — the caller should bound its wait so a hung worker
 * doesn't deadlock the loop.
 */

import type { StoreApi } from 'zustand/vanilla';
import type { ViewportState } from '@tweakcad/core/src/store/viewportStore.ts';

/** Default timeout when the caller doesn't pass one. */
const DEFAULT_TIMEOUT_MS = 10_000;

export async function waitForRebuildIdle(
  store: StoreApi<ViewportState>,
  timeoutMs?: number,
): Promise<{ waitedMs: number }> {
  const limit = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  // Already idle now? Re-check after one macrotask: dispatchCommand has
  // returned but the dirty-listener microtask may not have run yet, so a
  // "settled now" reading can be a false positive.
  if (!store.getState().rebuilding) {
    await new Promise<void>((r) => setTimeout(r, 0));
    if (!store.getState().rebuilding) return { waitedMs: Date.now() - start };
  }

  return new Promise<{ waitedMs: number }>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      reject(new Error(`wait_for_rebuild timed out after ${limit} ms`));
    }, limit);
    const unsubscribe = store.subscribe((state) => {
      if (done) return;
      if (state.rebuilding) return;
      // Hit "idle" — wait one tick to swallow back-to-back rebuild
      // transitions, then resolve if still idle. If a new rebuild kicked
      // in during that tick, we just go back to waiting (within the same
      // timeout budget).
      setTimeout(() => {
        if (done) return;
        if (store.getState().rebuilding) return; // still in flight; keep waiting
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({ waitedMs: Date.now() - start });
      }, 0);
    });
  });
}

/**
 * Rebuild scheduler lifecycle tests.
 *
 * The `rebuilding` flag is what the toolbar indicator shows and what
 * `waitForRebuildIdle` (the AI tool path's post-dispatch barrier) polls,
 * so every exit path from a rebuild has to clear it. The two paths that
 * publish nothing — a result discarded as stale, and a rebuild that
 * threw — are the ones that used to leave it set.
 *
 * The scheduler is driven through an injected pool whose `buildPart` the
 * test controls; a real pool needs a browser `Worker` and a WASM load.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Comlink from 'comlink';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { createViewportStore } from '@tweakcad/core/src/store/viewportStore.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { WorkerPool } from '@tweakcad/worker/src/pool.ts';
import type { CadWorkerApi, WorkerRebuildResult } from '@tweakcad/worker/src/cadWorker.ts';
import type { CadPart, CadProject } from '@tweakcad/core/src/document/schema.ts';
import { initRebuildScheduler } from './rebuildScheduler.ts';
import type { AppState } from './appInit.ts';

function emptyResult(partId: string): WorkerRebuildResult {
  return {
    partId,
    status: 'success',
    // One entry, so "nothing was published" is distinguishable from
    // "published an empty result".
    featureResults: [{ featureId: 'f_marker', status: 'success' }],
    meshes: [],
    topologyMaps: [],
    constructionPlanes: [],
    bodyToFeatureMap: {},
    diagnostics: [],
  } as unknown as WorkerRebuildResult;
}

/** A pool that answers `requestRebuild` from a callback, no worker involved. */
class StubPool extends WorkerPool {
  constructor(private readonly onBuild: (part: CadPart) => Promise<WorkerRebuildResult>) {
    super();
  }

  protected override spawn(): { raw: Worker; wrapped: Comlink.Remote<CadWorkerApi> } {
    throw new Error('StubPool must not spawn a worker');
  }

  override async requestRebuild(part: CadPart, _project: CadProject): Promise<WorkerRebuildResult> {
    return this.onBuild(part);
  }
}

function makeAppState(): { appState: AppState; documentStore: DocumentStore } {
  const documentStore = new DocumentStore(newProjectWithPart());
  const viewportStore = createViewportStore();
  const appState = { documentStore, viewportStore } as unknown as AppState;
  return { appState, documentStore };
}

describe('rebuild scheduler — rebuilding flag', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the flag when the result is discarded as stale', async () => {
    const { appState, documentStore } = makeAppState();
    const pool = new StubPool(async (part) => {
      // Something mutated the document while the rebuild was in flight.
      // A rename bumps the revision without dirtying a feature, so no
      // follow-up rebuild is coming to clear the flag.
      documentStore.mutate('Rename', (draft) => {
        draft.metadata.name = 'renamed mid-rebuild';
      });
      return emptyResult(part.id);
    });

    await initRebuildScheduler(appState, { pool });

    expect(documentStore.getRevision()).toBeGreaterThan(0);
    expect(appState.viewportStore.getState().rebuilding).toBe(false);
    // The stale result must not reach the viewport.
    expect(appState.viewportStore.getState().featureResults).toEqual({});
  });

  it('clears the flag when the rebuild throws', async () => {
    const { appState } = makeAppState();
    const pool = new StubPool(async () => {
      throw new Error('kernel exploded');
    });

    await initRebuildScheduler(appState, { pool });

    expect(appState.viewportStore.getState().rebuilding).toBe(false);
  });

  it('clears the flag on a normal rebuild, and publishes the result', async () => {
    const { appState } = makeAppState();
    const pool = new StubPool(async (part) => emptyResult(part.id));

    await initRebuildScheduler(appState, { pool });

    expect(appState.viewportStore.getState().rebuilding).toBe(false);
    expect(appState.viewportStore.getState().featureResults).toHaveProperty('f_marker');
  });
});

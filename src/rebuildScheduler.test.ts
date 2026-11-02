/**
 * Rebuild scheduler lifecycle tests.
 *
 * The `rebuilding` flag is what the toolbar indicator shows and what
 * `waitForRebuildIdle` (the AI tool path's post-dispatch barrier) polls,
 * so every exit path from a rebuild has to clear it. The path that used
 * to leave it set is the one that publishes nothing: a result discarded
 * as stale.
 *
 * The scheduler is driven through an injected pool whose `buildPart` the
 * test controls; a real pool needs a browser `Worker` and a WASM load.
 *
 * Not covered here: a rebuild that throws. `setRebuildError` clears the
 * flag on that path, and the handler around it flips the scheduler to
 * main-thread mode and retries — which loads the real OCCT kernel, so
 * it belongs in an integration test, not this file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as Comlink from 'comlink';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { createViewportStore } from '@tweakcad/core/src/store/viewportStore.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { WorkerPool } from '@tweakcad/worker/src/pool.ts';
import type { CadWorkerApi, WorkerRebuildResult } from '@tweakcad/worker/src/cadWorker.ts';
import type { CadPart, CadProject } from '@tweakcad/core/src/document/schema.ts';
import { initRebuildScheduler, disposeRebuildScheduler } from './rebuildScheduler.ts';
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
    disposeRebuildScheduler();
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

  it('clears the flag on a normal rebuild, and publishes the result', async () => {
    const { appState } = makeAppState();
    const pool = new StubPool(async (part) => emptyResult(part.id));

    await initRebuildScheduler(appState, { pool });

    expect(appState.viewportStore.getState().rebuilding).toBe(false);
    expect(appState.viewportStore.getState().featureResults).toHaveProperty('f_marker');
  });
});

/** Append a feature to the part's timeline: a mutation that dirties the part. */
function addFeature(documentStore: DocumentStore, n: number): void {
  documentStore.mutate(`Add ${n}`, (draft) => {
    const part = Object.values(draft.parts)[0]!;
    part.timeline.push({ id: `f_${n}`, type: 'sketch', name: `F${n}`, inputs: {}, dependsOn: [] } as never);
  });
}

describe('rebuild scheduler — coalescing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    disposeRebuildScheduler();
    vi.restoreAllMocks();
  });

  it('collapses edits made during a rebuild into one follow-up that builds the latest document', async () => {
    const { appState, documentStore } = makeAppState();
    const builds: { timelineLength: number; finish: () => void }[] = [];
    const pool = new StubPool((part) => new Promise((resolve) => {
      builds.push({ timelineLength: part.timeline.length, finish: () => resolve(emptyResult(part.id)) });
    }));

    const init = initRebuildScheduler(appState, { pool });
    await vi.waitFor(() => expect(builds).toHaveLength(1));
    builds[0]!.finish();
    await init;

    // A burst of edits, the way a sketch or an AI tool sequence makes them.
    for (let n = 1; n <= 8; n++) addFeature(documentStore, n);
    await vi.waitFor(() => expect(builds).toHaveLength(2));

    // More edits while that rebuild runs: it is now stale, and they must
    // queue one follow-up rather than one rebuild each.
    for (let n = 9; n <= 12; n++) addFeature(documentStore, n);
    builds[1]!.finish();
    await vi.waitFor(() => expect(builds).toHaveLength(3));
    expect(builds[2]!.timelineLength).toBe(12);
    expect(appState.viewportStore.getState().rebuilding).toBe(true);
    // The stale result was not published.
    expect(appState.viewportStore.getState().featureResults).toEqual({ f_marker: expect.anything() });

    builds[2]!.finish();
    await vi.waitFor(() => expect(appState.viewportStore.getState().rebuilding).toBe(false));
    expect(builds).toHaveLength(3);
  });

  it('keeps the flag set from the first request until the follow-up finishes', async () => {
    const { appState, documentStore } = makeAppState();
    const finishers: (() => void)[] = [];
    const pool = new StubPool((part) => new Promise((resolve) => {
      finishers.push(() => resolve(emptyResult(part.id)));
    }));
    const init = initRebuildScheduler(appState, { pool });
    await vi.waitFor(() => expect(finishers).toHaveLength(1));
    finishers[0]!();
    await init;
    const flags: boolean[] = [];
    appState.viewportStore.subscribe((s) => flags.push(s.rebuilding));

    addFeature(documentStore, 1);
    expect(appState.viewportStore.getState().rebuilding).toBe(true);
    await vi.waitFor(() => expect(finishers).toHaveLength(2));
    addFeature(documentStore, 2);
    finishers[1]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(finishers).toHaveLength(3);
    expect(appState.viewportStore.getState().rebuilding).toBe(true);
    finishers[2]!();
    await vi.waitFor(() => expect(appState.viewportStore.getState().rebuilding).toBe(false));

    // Set once, cleared once: `wait_for_rebuild` never sees an idle gap
    // between the stale rebuild and its follow-up.
    expect(flags.filter((f, i) => f !== (flags[i - 1] ?? false))).toEqual([true, false]);
  });

  it('a disposed scheduler stops rebuilding, so a remount does not double every rebuild', async () => {
    // React StrictMode mounts, unmounts and remounts the app in development.
    const { appState, documentStore } = makeAppState();
    let first = 0;
    let second = 0;
    await initRebuildScheduler(appState, { pool: new StubPool(async (part) => { first++; return emptyResult(part.id); }) });
    disposeRebuildScheduler();
    await initRebuildScheduler(appState, { pool: new StubPool(async (part) => { second++; return emptyResult(part.id); }) });

    addFeature(documentStore, 1);
    await vi.waitFor(() => expect(appState.viewportStore.getState().rebuilding).toBe(false));
    expect(first).toBe(1);
    expect(second).toBe(2);
  });
});

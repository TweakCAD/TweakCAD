/**
 * Rebuild scheduler lifecycle tests.
 *
 * The `rebuilding` flag is what the toolbar indicator shows and what
 * `waitForRebuildIdle` (the AI tool path's post-dispatch barrier) polls,
 * so every exit path from a rebuild has to clear it, and nothing may clear
 * it while any part is still building.
 *
 * A result is published only if the document still holds what the rebuild
 * read; one whose inputs changed mid-flight is dropped and the part rebuilt.
 * A change the part does not depend on must not cost it its result.
 *
 * The scheduler is driven through an injected pool whose `buildPart` the
 * test controls; a real pool needs a browser `Worker` and a WASM load.
 *
 * Not covered here: a rebuild that throws. The handler around it flips the
 * scheduler to main-thread mode and retries — which loads the real OCCT
 * kernel, so it belongs in an integration test, not this file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as Comlink from 'comlink';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { createViewportStore } from '@tweakcad/core/src/store/viewportStore.ts';
import { createPart, newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { WorkerPool } from '@tweakcad/worker/src/pool.ts';
import type { CadWorkerApi, WorkerRebuildResult } from '@tweakcad/worker/src/cadWorker.ts';
import type { CadPart, CadProject } from '@tweakcad/core/src/document/schema.ts';
import { initRebuildScheduler, disposeRebuildScheduler } from './rebuildScheduler.ts';
import type { AppState } from './appInit.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import { waitForRebuildIdle } from './ai/viewportSync.ts';

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
  constructor(private readonly onBuild: (part: CadPart, project: CadProject) => Promise<WorkerRebuildResult>) {
    super();
  }

  protected override spawn(): { raw: Worker; wrapped: Comlink.Remote<CadWorkerApi> } {
    throw new Error('StubPool must not spawn a worker');
  }

  override async requestRebuild(part: CadPart, project: CadProject): Promise<WorkerRebuildResult> {
    return this.onBuild(part, project);
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

  it('publishes a result when only something the part does not read changed mid-rebuild', async () => {
    const { appState, documentStore } = makeAppState();
    let builds = 0;
    const pool = new StubPool(async (part) => {
      builds++;
      // A project rename lands while the first load's rebuild is in flight.
      // It bumps the revision, but the part's rebuild never read the name.
      documentStore.mutate('Rename', (draft) => {
        draft.metadata.name = 'renamed mid-rebuild';
      });
      return emptyResult(part.id);
    });

    await initRebuildScheduler(appState, { pool });

    expect(builds).toBe(1);
    expect(appState.viewportStore.getState().rebuilding).toBe(false);
    // Used to be discarded with no follow-up: an empty viewport on load.
    expect(appState.viewportStore.getState().featureResults).toHaveProperty('f_marker');
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

/** A result that records which build produced it, so tests can tell them apart. */
function resultFor(part: CadPart, tag: string): WorkerRebuildResult {
  return {
    ...emptyResult(part.id),
    featureResults: [{ featureId: `${part.name}_${tag}`, status: 'success' }],
  } as unknown as WorkerRebuildResult;
}

function twoPartAppState(): { appState: AppState; documentStore: DocumentStore; b: PartId } {
  const project = newProjectWithPart('P', 'A');
  const partB = createPart('B');
  project.parts[partB.id] = partB;
  const documentStore = new DocumentStore(project);
  const viewportStore = createViewportStore();
  return { appState: { documentStore, viewportStore } as unknown as AppState, documentStore, b: partB.id };
}

type Pending = { name: string; timeline: number; finish: () => void };

/** A pool that holds every build until the test finishes it. */
function holdingPool(pending: Pending[], tag: (part: CadPart, project: CadProject) => string = (p) => `len${p.timeline.length}`): StubPool {
  return new StubPool((part, project) => new Promise((resolve) => {
    pending.push({ name: part.name, timeline: part.timeline.length, finish: () => resolve(resultFor(part, tag(part, project))) });
  }));
}

/** A project parameter change: dirties every part. */
function setProjectParameter(documentStore: DocumentStore): void {
  documentStore.mutate('Param', (draft) => {
    draft.parameters.values['w'] = { name: 'w', expression: '5', unit: 'mm' } as never;
  });
}

describe('rebuild scheduler — results whose inputs changed mid-rebuild', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    disposeRebuildScheduler();
    vi.restoreAllMocks();
  });

  it('rebuilds again after a part change that dirties nothing, such as a visibility toggle', async () => {
    const { appState, documentStore } = makeAppState();
    const pending: Pending[] = [];
    const pool = holdingPool(pending, (p) => (p.timeline[0]?.visible === false ? 'hidden' : 'shown'));
    const init = initRebuildScheduler(appState, { pool });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.finish();
    await init;

    addFeature(documentStore, 1);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // Hide the feature while that rebuild runs. `visible` is display-only,
    // so it dirties nothing, but the result in flight described the part
    // before the change.
    documentStore.mutate('Hide', (draft) => {
      Object.values(draft.parts)[0]!.timeline[0]!.visible = false;
    });
    pending[1]!.finish();

    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2]!.finish();
    await vi.waitFor(() => expect(appState.viewportStore.getState().rebuilding).toBe(false));
    const published = appState.viewportStore.getState().featureResults;
    expect(published).toHaveProperty('Part 1_hidden');
    expect(published).not.toHaveProperty('Part 1_shown');
  });

  it("keeps a part's result when another part is edited during its rebuild", async () => {
    const { appState, documentStore, b } = twoPartAppState();
    const pending: Pending[] = [];
    const init = initRebuildScheduler(appState, { pool: holdingPool(pending, (p, proj) => `${'w' in proj.parameters.values ? 'param' : 'base'}_len${p.timeline.length}`) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.finish();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.finish();
    await init;

    setProjectParameter(documentStore);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    // An edit to B while both rebuild: A's inputs are untouched.
    documentStore.mutate('Edit B', (draft) => {
      draft.parts[b]!.timeline.push({ id: 'f_b', type: 'sketch', name: 'SB', inputs: {}, dependsOn: [], enabled: true, visible: true } as never);
    });
    pending[2]!.finish(); // A, after the parameter change
    pending[3]!.finish(); // B, built before its new feature: stale
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    pending[4]!.finish(); // B again
    await vi.waitFor(() => expect(appState.viewportStore.getState().rebuilding).toBe(false));

    // A is not rebuilt a third time, and its post-parameter result is the one
    // on screen. It used to be discarded with nothing rebuilding it, leaving
    // A on its pre-parameter geometry.
    expect(pending.map((p) => p.name)).toEqual(['A', 'B', 'A', 'B', 'B']);
    expect(pending[4]!.timeline).toBe(1);
    const published = appState.viewportStore.getState().featureResults;
    expect(published).toHaveProperty('A_param_len0');
    expect(published).not.toHaveProperty('A_base_len0');
    expect(published).toHaveProperty('B_param_len1');
  });

  it('does not rebuild a part that left the document mid-rebuild', async () => {
    const { appState, documentStore, b } = twoPartAppState();
    const pending: Pending[] = [];
    const init = initRebuildScheduler(appState, { pool: holdingPool(pending) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.finish();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    documentStore.mutate('Remove B', (draft) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- id-keyed record
      delete draft.parts[b];
    });
    pending[1]!.finish();
    await init;
    await vi.waitFor(() => expect(appState.viewportStore.getState().rebuilding).toBe(false));

    expect(pending).toHaveLength(2);
    expect(appState.viewportStore.getState().featureResults).not.toHaveProperty('B_len0');
  });
});

describe('rebuild scheduler — rebuilding flag across parts', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    disposeRebuildScheduler();
    vi.restoreAllMocks();
  });

  it('stays set until the last part finishes, so wait_for_rebuild does not return early', async () => {
    const { appState, documentStore } = twoPartAppState();
    const pending: Pending[] = [];
    const init = initRebuildScheduler(appState, { pool: holdingPool(pending) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.finish();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.finish();
    await init;

    setProjectParameter(documentStore);
    await vi.waitFor(() => expect(pending).toHaveLength(4));

    let idle = false;
    const waited = waitForRebuildIdle(appState.viewportStore, 2_000).then(() => { idle = true; });

    pending[2]!.finish(); // A publishes; B is still building
    await vi.waitFor(() => expect(appState.viewportStore.getState().resultsByPart).toHaveProperty(Object.keys(documentStore.getState().parts)[0]!));
    await new Promise((r) => setTimeout(r, 20));
    expect(appState.viewportStore.getState().rebuilding).toBe(true);
    expect(idle).toBe(false);

    pending[3]!.finish();
    await waited;
    expect(appState.viewportStore.getState().rebuilding).toBe(false);
  });
});

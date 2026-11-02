/**
 * Rebuild scheduler.
 *
 * Listens for dirty features from the DocumentStore and triggers rebuilds
 * via the WorkerPool. The kernel runs entirely in a Web Worker thread -
 * the main thread only receives serializable meshes and diagnostics.
 *
 * One rebuild per part at a time: requests that arrive while one runs
 * collapse into a single follow-up (see `createRebuildQueue`).
 *
 * Stale result guard: if anything a rebuild read changes while it is in
 * flight, the result is discarded and that part is rebuilt again.
 *
 * Falls back to main-thread execution if workers fail to initialize
 * (e.g., SharedArrayBuffer unavailable, WASM loading issue).
 */

import type { PartId, BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import type { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import type { createViewportStore } from '@tweakcad/core/src/store/viewportStore.ts';
import type { CadPart, CadProject, FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { consoleLog } from '@tweakcad/core/src/store/consoleStore.ts';
import { WorkerPool } from '@tweakcad/worker/src/pool.ts';
import { resolveActivePartId } from '@tweakcad/core/src/document/featureLookup.ts';
import type { MeasureTarget, MeasureResult } from '@tweakcad/worker/src/protocol.ts';
import type { WorkerRebuildResult } from '@tweakcad/worker/src/cadWorker.ts';
import type { AppState } from './appInit.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { incrementalRebuild } from '@tweakcad/worker/src/rebuilder.ts';

// ---- State ----

let pool: WorkerPool | null = null;
let useWorker = true;
/** Unsubscribes the dirty-feature listener `initRebuildScheduler` registered. */
let stopListening: (() => void) | null = null;

// Fallback: main-thread kernel + rebuilder (lazy loaded only if worker fails)
let mainThreadFallback: {
  kernel: CadKernel;
  rebuild: typeof incrementalRebuild;
} | null = null;

/**
 * Initialize main-thread fallback if worker mode fails.
 * Lazy imports to avoid loading WASM on the main thread when workers work fine.
 */
async function ensureMainThreadFallback(): Promise<typeof mainThreadFallback & object> {
  if (mainThreadFallback) return mainThreadFallback;

  console.warn('[RebuildScheduler] Initializing main-thread fallback...');
  const [{ OcctKernel }, { MockKernel }, { incrementalRebuild }] = await Promise.all([
    import('@tweakcad/kernel/src/occtKernel.ts'),
    import('@tweakcad/kernel/src/mockKernel.ts'),
    import('@tweakcad/worker/src/rebuilder.ts'),
  ]);

  let kernel: CadKernel;
  try {
    kernel = new OcctKernel();
    await kernel.init();
  } catch {
    console.warn('[RebuildScheduler] OcctKernel fallback failed, using MockKernel');
    kernel = new MockKernel();
    await kernel.init();
  }

  mainThreadFallback = { kernel, rebuild: incrementalRebuild };
  return mainThreadFallback;
}

// ---- Public API ----

/**
 * Initialize the rebuild scheduler.
 * Spawns the WorkerPool, connects document store dirty detection,
 * and triggers initial builds for all parts.
 */
export async function initRebuildScheduler(
  appState: AppState,
  // Tests substitute a pool whose worker they control. Spawning a real
  // one needs a browser `Worker` plus a WASM load, and the paths worth
  // pinning here (stale results, a rebuild that throws) are about what
  // the scheduler does with the answer, not how it got one.
  opts: { pool?: WorkerPool } = {},
): Promise<void> {
  const { documentStore, viewportStore } = appState;

  // Try to create the worker pool
  try {
    pool = opts.pool ?? new WorkerPool();
    useWorker = true;
  } catch (error) {
    console.warn('[RebuildScheduler] Worker creation failed, using main thread:', error);
    useWorker = false;
  }

  const requestRebuild = createRebuildQueue(documentStore, viewportStore);

  // Listen for dirty features - always rebuild from 0 to ensure
  // all bodies are accumulated in the build context correctly.
  // TODO: implement context caching for true incremental rebuilds.
  stopListening = documentStore.onDirtyFeature(async (_fromIndex, partId) => {
    // A part can also *leave* the document (undo of `CreatePart`), and
    // nothing schedules a rebuild for a part that no longer exists — so
    // sweep the published results before building.
    viewportStore.getState().retainParts(
      Object.keys(documentStore.getState().parts) as PartId[],
    );
    await requestRebuild(partId);
  });

  // Trigger initial build for all parts
  const project = documentStore.getState();
  for (const partId of Object.keys(project.parts) as PartId[]) {
    await requestRebuild(partId);
  }
}

type ViewportStoreApi = ReturnType<typeof createViewportStore>;

/**
 * Coalesce rebuild requests: at most one rebuild per part runs at a time,
 * and requests that arrive while it runs collapse into one follow-up that
 * builds the latest document.
 *
 * Every rebuild is a full one, and every edit dirties the part — a sketch
 * line, a constraint, each point of a drag. Running one rebuild per request
 * queued them all on the single rebuild worker, and each re-ran and
 * re-tessellated every body in the part only to be discarded as stale. With
 * a body that is slow to mesh (a revolved or shelled spline surface takes
 * seconds), a handful of edits kept the worker busy for minutes.
 *
 * The returned promise settles when the part has no rebuild running or
 * requested.
 *
 * A rebuild whose inputs changed while it ran is not published (see
 * {@link sameBuildInputs}), and the part goes back on the queue. Edits that
 * dirty the part already request a follow-up, but plenty of changes to a
 * part's inputs dirty nothing — a visibility toggle edits the timeline and is
 * deliberately not a rebuild trigger — and without the re-request the part
 * kept the result from before the change until some later edit came along.
 *
 * The `rebuilding` flag is set synchronously on the first request and
 * cleared here, in a `finally`, once no part is rebuilding — and only here.
 * Publishing one part's result does not clear it: with two parts building,
 * the first to finish would otherwise report idle while the second still ran,
 * and `waitForRebuildIdle` (the `wait_for_rebuild` tool) returned early.
 */
function createRebuildQueue(
  documentStore: DocumentStore,
  viewportStore: ViewportStoreApi,
): (partId: PartId) => Promise<void> {
  const running = new Map<PartId, Promise<void>>();
  const requested = new Set<PartId>();

  return (partId) => {
    requested.add(partId);
    const inFlight = running.get(partId);
    if (inFlight) return inFlight;

    viewportStore.getState().setRebuilding(true);
    const loop = (async () => {
      try {
        while (requested.delete(partId)) {
          const outcome = await rebuildPart(documentStore, viewportStore, partId, 0);
          if (outcome === 'stale') requested.add(partId);
        }
      } finally {
        running.delete(partId);
        if (running.size === 0) viewportStore.getState().setRebuilding(false);
      }
    })();
    running.set(partId, loop);
    return loop;
  };
}

/**
 * Whether the document still holds everything a rebuild of `partId` read.
 *
 * A part's rebuild reads the part itself, the project parameter table, the
 * imported-geometry references and the embedded components, and nothing
 * else. Immer keeps each of those the same object unless it changed, so
 * reference equality is exact for "this result describes the current
 * document". Comparing the document revision instead threw away results for
 * changes they don't depend on — a rename, metadata, another part's edit —
 * and nothing rebuilt afterwards, so the part kept its old geometry (or, on
 * first load, showed none).
 */
function sameBuildInputs(built: CadProject, now: Readonly<CadProject>, partId: PartId): boolean {
  return now.parts[partId] === built.parts[partId]
    && now.parameters === built.parameters
    && now.references === built.references
    && now.embeddedComponents === built.embeddedComponents;
}

/**
 * What became of one rebuild: published, discarded because its inputs
 * changed while it ran (the caller rebuilds again), or neither (the part is
 * gone, or the rebuild failed and the error was published).
 */
type RebuildOutcome = 'published' | 'stale' | 'none';

/**
 * Rebuild one part now. Routes to WorkerPool or main-thread fallback.
 * Discards the result if the part's inputs changed during the rebuild.
 */
async function rebuildPart(
  documentStore: DocumentStore,
  viewportStore: ViewportStoreApi,
  partId: PartId,
  fromIndex: number,
): Promise<RebuildOutcome> {
  const workerPool = useWorker ? pool : null;

  try {
    const project = documentStore.getState();
    const part = project.parts[partId];
    if (!part) return 'none';

    let result: WorkerRebuildResult;

    if (workerPool) {
      // Worker path: kernel runs off main thread
      result = await workerPool.requestRebuild(part, project, fromIndex);

      if (result.diagnostics.length > 0) {
        console.warn('[RebuildScheduler] Diagnostics:', result.diagnostics);
      }
    } else {
      // Main-thread fallback
      const fallback = await ensureMainThreadFallback();
      const fallbackResult = await fallback.rebuild(part, project, fallback.kernel, fromIndex);
      result = {
        partId: fallbackResult.partId,
        status: fallbackResult.status,
        featureResults: fallbackResult.featureResults,
        meshes: fallbackResult.meshes,
        topologyMaps: fallbackResult.topologyMaps,
        constructionPlanes: fallbackResult.constructionPlanes,
        sketchPlanes: fallbackResult.sketchPlanes,
        bodyToFeatureMap: fallbackResult.bodyToFeatureMap,
        diagnostics: fallbackResult.diagnostics,
      };
    }

    logRebuildResult(part, result);

    // Stale result guard: discard if anything this rebuild read changed while
    // it ran. A part that left the document is not rebuilt again.
    const now = documentStore.getState();
    if (!sameBuildInputs(project, now, partId)) {
      return now.parts[partId] ? 'stale' : 'none';
    }

    // Use the bodyToFeatureMap from the rebuild result
    const bodyToFeature = (result.bodyToFeatureMap ?? {}) as Record<BodyId, FeatureId>;
    console.log('[RebuildScheduler] bodyToFeature map:', JSON.stringify(bodyToFeature));

    // Push meshes + construction planes + per-feature results to viewport
    // store, under this part's key: parts rebuild independently, and the
    // store merges them so republishing one doesn't blank the others.
    // The CP layer in ViewportController re-renders translucent
    // rectangles when constructionPlanes changes; the ProjectTree uses
    // featureResults to surface failed/blocked badges on each feature
    // so build errors are visible without reading the console.
    viewportStore.getState().setRebuildResult(
      partId,
      result.meshes,
      result.topologyMaps,
      result.constructionPlanes,
      result.featureResults,
      bodyToFeature,
      result.sketchPlanes,
    );
    return 'published';
  } catch (error) {
    console.error('[RebuildScheduler] Rebuild failed:', error);
    consoleLog('error', `Rebuild failed: ${error instanceof Error ? error.message : String(error)}`, 'rebuild');

    // If worker fails, switch to main-thread mode for future rebuilds —
    // unless the pool was disposed while this rebuild ran; then the
    // scheduler that owned it is gone and its replacement is unaffected.
    if (workerPool) {
      if (workerPool !== pool) return 'none';
      console.warn('[RebuildScheduler] Switching to main-thread mode after worker failure');
      useWorker = false;
      pool?.dispose();
      pool = null;

      // Retry on main thread
      return rebuildPart(documentStore, viewportStore, partId, fromIndex);
    }

    viewportStore.getState().setRebuildError(
      error instanceof Error ? error.message : String(error),
    );
    return 'none';
  }
}

function logRebuildResult(part: CadPart, result: WorkerRebuildResult): void {
  // Build a featureId → name+status map so per-feature log lines can
  // attribute a 'blocked' cascade to the correct upstream feature
  // *and* its actual status ("blocked by Sketch 1 (suppressed)" vs
  // "(failed)" vs "(blocked)"). Without this the log lied — it always
  // said "failed" even when the upstream was suppressed.
  const featureByIdName = new Map<string, string>();
  const featureByIdStatus = new Map<string, 'success' | 'failed' | 'blocked' | 'suppressed'>();
  for (const r of result.featureResults) {
    const f = part.timeline.find(item => item.id === r.featureId);
    if (f) featureByIdName.set(String(r.featureId), f.name);
    featureByIdStatus.set(String(r.featureId), r.status);
  }

  // Count statuses to drive the summary line's severity. A 'partial'
  // rebuild contains at least one failure by the rebuilder's
  // definition (rebuilder.ts:318), so any failed count means the
  // summary headline is an error, not a warning. Suppressed-only or
  // blocked-only timelines aren't failures and stay informational.
  let succeededCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  let suppressedCount = 0;

  for (const featureResult of result.featureResults) {
    const feature = part.timeline.find(item => item.id === featureResult.featureId);
    if (!feature) continue;
    const name = feature.name;

    if (featureResult.status === 'success') {
      succeededCount += 1;
      // Per-feature success line is noisy for non-extrude features
      // (every sketch/plane/etc would flood the console). Keep the
      // existing extrude-only "Built ..." line as the user-visible
      // signal of new geometry.
      if (feature.type === 'extrude') {
        consoleLog('success', `Built ${name}: ${describeExtrude(feature)}`, 'rebuild');
      }
    } else if (featureResult.status === 'failed') {
      failedCount += 1;
      // Now logs for ALL feature types, not just extrude — previously
      // a failed Fillet / Construction Plane / Hole emitted nothing,
      // so the user only saw the umbrella warning with no per-feature
      // detail.
      consoleLog('error', `Failed ${name} (${feature.type}): ${featureResult.error.message}`, 'rebuild');
    } else if (featureResult.status === 'blocked') {
      blockedCount += 1;
      const upstreamName = featureByIdName.get(String(featureResult.blockedBy)) ?? String(featureResult.blockedBy);
      const upstreamStatus = featureByIdStatus.get(String(featureResult.blockedBy)) ?? 'failed';
      consoleLog('warn', `Blocked ${name} (${feature.type}): upstream ${upstreamName} is ${upstreamStatus}`, 'rebuild');
    } else if (featureResult.status === 'suppressed') {
      suppressedCount += 1;
      // Suppressed is intentional and noisy in bulk; only log when
      // it's the only non-success status so the user knows we didn't
      // crash, but skip when there's a failure / block that overshadows.
    }
  }

  // Summary line: severity matches the worst status in the result.
  // Counts give the user a one-line picture without scrolling per-feature.
  if (failedCount > 0) {
    consoleLog(
      'error',
      `${part.name}: ${failedCount} failed${blockedCount > 0 ? `, ${blockedCount} blocked` : ''}${suppressedCount > 0 ? `, ${suppressedCount} suppressed` : ''}, ${succeededCount} ok`,
      'rebuild',
    );
  } else if (blockedCount > 0) {
    consoleLog(
      'warn',
      `${part.name}: ${blockedCount} blocked${suppressedCount > 0 ? `, ${suppressedCount} suppressed` : ''}, ${succeededCount} ok`,
      'rebuild',
    );
  } else if (result.status === 'success') {
    consoleLog('info', `Part rebuild complete: ${part.name} (${result.meshes.length} bodies)`, 'rebuild');
  }
}

function describeExtrude(feature: FeatureNode): string {
  const inputs = feature.inputs as Record<string, unknown>;
  const profile = inputs.profile as { type?: string; regionId?: string; entityId?: string } | undefined;
  const extent = inputs.extent as { type?: string; value?: string } | undefined;
  const offset = inputs.startOffset;
  const profileText = profile?.regionId ?? profile?.entityId ?? profile?.type ?? 'profile';
  const extentText = extent?.value !== undefined ? `${extent.type ?? 'extent'} ${extent.value}` : (extent?.type ?? 'extent');
  return `${profileText}, ${extentText}, offset ${String(offset ?? 0)}`;
}

/**
 * Stop rebuilding: unsubscribe from the document and terminate the worker
 * pool. The app calls it on unmount; under React StrictMode the mount effect
 * runs twice in development, and without it every edit would rebuild on two
 * schedulers and two workers.
 */
export function disposeRebuildScheduler(): void {
  stopListening?.();
  stopListening = null;
  pool?.dispose();
  pool = null;
}

// ---- Export helpers ----

/**
 * Export one part of the document to the requested format.
 *
 * Runs on the dedicated export worker (does not block rebuilds). Falls
 * back to the main-thread kernel if workers are unavailable. Returns the
 * raw bytes as an ArrayBuffer so the caller can produce a Blob with the
 * right MIME type or PUT it directly to the SaaS attachment endpoint.
 *
 * `partId` is the user's active part; omitting it exports the first part,
 * which is what the load-time cloud auto-export wants (it runs before
 * the user has activated anything). Exporting *all* parts as one
 * compound, with per-part SubObject metadata, is still a future
 * enhancement — this exports exactly one.
 */
export async function exportActivePart(
  documentStore: DocumentStore,
  format: 'stl' | 'step' | 'brep' | '3mf',
  activePartId?: PartId | null,
): Promise<ArrayBuffer> {
  const project = documentStore.getState();
  const partId = resolveActivePartId(project, activePartId);
  if (!partId) throw new Error('No part to export.');
  const part = project.parts[partId];
  if (!part) throw new Error('No part to export.');

  if (useWorker && pool) {
    if (format === 'stl') return pool.requestExportStl(part, project);
    if (format === 'step') return pool.requestExportStep(part, project);
    if (format === 'brep') return pool.requestExportBrep(part, project);
    return pool.requestExport3MF(part, project);
  }

  // Main-thread fallback. We need to rebuild on the fallback kernel so
  // the body handles match what the kernel's export call expects.
  const fallback = await ensureMainThreadFallback();
  const result = await fallback.rebuild(part, project, fallback.kernel, 0);
  const bodyHandles = result.bodies.map((b) => b.handle);
  if (bodyHandles.length === 0) return new ArrayBuffer(0);
  let blob: Blob;
  if (format === 'stl') blob = await fallback.kernel.exportStl(bodyHandles);
  else if (format === 'step') blob = await fallback.kernel.exportStep(bodyHandles);
  else if (format === 'brep') blob = await fallback.kernel.exportBrep(bodyHandles);
  else blob = await fallback.kernel.export3MF(bodyHandles, { name: part.name });
  return blob.arrayBuffer();
}

/**
 * Measure a body, face or edge in the current geometry.
 *
 * Goes through the scheduler because the pool is private to it, and routes to
 * the rebuild worker — the one that still holds the bodies on screen. Returns
 * null before the first rebuild, or when the target has gone.
 */
export async function measureInWorker(
  target: MeasureTarget,
): Promise<MeasureResult | null> {
  if (!pool) return null;
  return pool.requestMeasure(target);
}

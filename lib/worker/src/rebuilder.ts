/**
 * Incremental rebuild algorithm.
 * Walks the feature timeline, resolves parameters, builds features,
 * tessellates results, and returns display meshes.
 *
 * Optimizations for fast rebuilds:
 * - Additive change detection: if only new features appended, skip earlier ones
 * - Consumed/created body tracking per feature
 */

import type { CadPart, CadProject, DisplayMesh, TopologyMap, FeatureBuildResult, FeatureNode, OperationEffect, ConstructionPlaneDisplay } from '@tweakcad/core/src/document/schema.ts';
import type { FeatureId, BodyId } from '@tweakcad/core/src/ids.ts';
import { resolveAllParameters } from '@tweakcad/core/src/parameters/evaluator.ts';
import { applyActiveConfiguration } from '@tweakcad/core/src/commands/handlers/configurationCommands.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { FINE_TESSELLATION } from '@tweakcad/kernel/src/types.ts';
import type { RebuildResult } from './protocol.ts';
import { dispatchFeatureBuilder } from './subTimelineRunner.ts';

// --- Incremental rebuild state (cached between rebuilds) ---

type CachedRebuildState = {
  timeline: FeatureNode[];
  pointer: number;
  context: BuildContext;
  featureResults: FeatureBuildResult[];
  effects: Map<FeatureId, OperationEffect>;
  /**
   * Append-only across rebuilds: every body that any feature has ever
   * successfully produced, mapped to its producing featureId. Drives
   * the transitive cascade-block synthesis — when a feature is
   * suppressed/blocked and doesn't run this pass, its previously-
   * recorded body→producer entries stay in the map so downstream
   * features that reference those bodies still get correctly
   * cascade-blocked. Stale entries (for deleted features) are safe:
   * walker finds them but they're not in any blocker set, so no
   * spurious cascade.
   */
  bodyProducer: Map<string, FeatureId>;
};

let cachedState: CachedRebuildState | null = null;

/**
 * Bodies that survived to the end of the previous rebuild, per kernel.
 *
 * A rebuild's final bodies stay alive after it returns — the caller
 * tessellates and exports from them. They only become garbage when the NEXT
 * rebuild supersedes them, which is why they're swept at the start of one
 * rather than the end of this one: nothing in flight can be freed.
 *
 * Safe because a rebuild is always from scratch. `findIncrementalStartIndex`
 * is stubbed to 0, so cached bodies are never reused; no worker API accepts a
 * `KernelBody` from outside; and the main thread only ever receives body IDs.
 * The one place a handle outlives its rebuild is the export path, which runs
 * its OWN rebuild and consumes the handles immediately — and exports run on a
 * separate worker with a separate kernel, so they can't sweep each other.
 *
 * Keyed weakly so a discarded kernel doesn't pin its handle list.
 */
const previousFinalBodies = new WeakMap<CadKernel, KernelBody[]>();

/**
 * Release the previous rebuild's surviving bodies on this kernel.
 *
 * Call immediately before starting a fresh rebuild. Deliberately NOT called
 * from inside `incrementalRebuild`: the export paths call that too, and an
 * export must not free the bodies of an export still assembling its blob.
 */
export function sweepPreviousRebuild(kernel: CadKernel): void {
  const stale = previousFinalBodies.get(kernel);
  if (!stale) return;
  previousFinalBodies.delete(kernel);
  for (const handle of stale) {
    try {
      kernel.dispose(handle);
    } catch (e) {
      console.warn('[Rebuilder] Failed to release a retired body:', e);
    }
  }
}

/** Release the bodies a one-shot rebuild produced, once they've been used. */
export function releaseRebuildBodies(kernel: CadKernel, bodies: { handle: KernelBody }[]): void {
  for (const b of bodies) {
    try {
      kernel.dispose(b.handle);
    } catch (e) {
      console.warn('[Rebuilder] Failed to release an export body:', e);
    }
  }
}

/**
 * Incremental rebuild is DISABLED until the caching logic is stable.
 * Always returns 0 (full rebuild from scratch).
 *
 * TODO: Re-enable incremental builds once body caching/invalidation is reliable.
 * The previous implementation had bugs where cached bodies from suppressed or
 * deleted features leaked into subsequent rebuilds.
 */
function findIncrementalStartIndex(
  _oldTimeline: FeatureNode[],
  _oldPointer: number,
  _newTimeline: FeatureNode[],
  _newPointer: number,
): number {
  return 0; // Always full rebuild
}

/**
 * Run a full or incremental rebuild of a part's feature timeline.
 * Continues past failures - failed features don't block independent downstream features.
 *
 * @param part - The part to rebuild
 * @param project - The full project (for global parameters)
 * @param kernel - The geometry kernel
 * @param fromIndex - Start rebuilding from this timeline index (0 = full rebuild)
 * @returns Build result with meshes and status
 */
export async function incrementalRebuild(
  part: CadPart,
  project: CadProject,
  kernel: CadKernel,
  fromIndex = 0,
): Promise<RebuildResult> {
  // Resolve all parameters. If the part has an active configuration row,
  // overlay its overrides onto the part's parameter table first — the
  // overrides REPLACE the parameter's expression with the override
  // expression for that build only; the on-disk parameter table is
  // untouched.
  const effectivePartParams = applyActiveConfiguration(part);
  const paramResult = resolveAllParameters(project.parameters, effectivePartParams);
  if (!paramResult.ok) {
    return {
      partId: part.id,
      status: 'failed',
      featureResults: [],
      meshes: [],
      topologyMaps: [],
      bodies: [],
      constructionPlanes: [],
      bodyToFeatureMap: {},
      diagnostics: [`Parameter resolution failed: ${paramResult.error}`],
    };
  }

  const params = paramResult.value;
  const newPointer = part.timeline.length - 1;

  // Try incremental rebuild: check if we can skip already-built features
  let startIndex = fromIndex;
  let context: BuildContext;
  let featureResults: FeatureBuildResult[];
  // Three *blocker sets*: a downstream feature whose dependsOn (or
  // synthesized body-deps) hit any of them gets `status: 'blocked'`
  // instead of running. Kept separate so the UI can attribute the
  // blocker accurately ("Blocked by Sketch 1 [suppressed]" vs "Blocked
  // by Pad 2 [failed]" vs "Blocked by Extrude 1 [blocked]"). The
  // `blockedIds` member matters for transitive cascade: when feature A
  // is suppressed, B blocks-by-A, and C consumes B's body, C must see
  // B in the blocker set so it gets `'blocked'` too (not `'failed'`
  // with a useless "Target body not in build context" message).
  let failedIds: Set<FeatureId>;
  let suppressedIds: Set<FeatureId>;
  let blockedIds: Set<FeatureId>;
  // bodyId → featureId map built incrementally so we can synthesize
  // body-dependencies for body-modifying features (Fillet, Chamfer,
  // Mirror, Hole, Shell, Pattern, Sweep) whose `dependsOn: []` is
  // currently empty by handler design (see featureCommands.ts:282).
  // When such a feature references a body produced by an upstream
  // feature that's in failedIds or suppressedIds, we emit 'blocked'
  // pre-emptively instead of letting the build die with a generic
  // "Target body X not in build context" runtime error.
  const bodyProducer = new Map<string, FeatureId>();
  const effects = new Map<FeatureId, OperationEffect>();

  if (cachedState && fromIndex === 0 && cachedState.timeline.length > 0) {
    // Check if this is an additive change (new features appended)
    const incrementalStart = findIncrementalStartIndex(
      cachedState.timeline,
      cachedState.pointer,
      part.timeline,
      newPointer,
    );

    if (incrementalStart > 0) {
      // Reuse cached context and results up to incrementalStart
      startIndex = incrementalStart;
      context = { ...cachedState.context };
      context.bodies = new Map(cachedState.context.bodies);
      context.featureOutputs = new Map(cachedState.context.featureOutputs);
      context.topologyMaps = new Map(cachedState.context.topologyMaps);
      featureResults = [...cachedState.featureResults.slice(0, startIndex)];
      failedIds = new Set(
        featureResults
          .filter(r => r.status === 'failed')
          .map(r => r.featureId),
      );
      suppressedIds = new Set(
        featureResults
          .filter(r => r.status === 'suppressed')
          .map(r => r.featureId),
      );
      blockedIds = new Set(
        featureResults
          .filter(r => r.status === 'blocked')
          .map(r => r.featureId),
      );
      // Copy effects + seed bodyProducer from the cached append-only
      // history (which already includes prior passes' entries).
      for (const [fid, effect] of cachedState.effects) {
        effects.set(fid, effect);
      }
      for (const [bid, fid] of cachedState.bodyProducer) {
        bodyProducer.set(bid, fid);
      }
    } else {
      context = emptyBuildContext(params);
      context.references = project.references;
      featureResults = [];
      failedIds = new Set();
      suppressedIds = new Set();
      blockedIds = new Set();
    }
  } else {
    context = emptyBuildContext(params);
    context.references = project.references;
    featureResults = [];
    failedIds = new Set();
    suppressedIds = new Set();
    blockedIds = new Set();
  }

  // Even in full-rebuild mode, seed bodyProducer from any cached
  // effects so transitive cascades work. Concrete case: user
  // suppresses Sketch_1; downstream Extrude_base cascade-blocks (its
  // dependsOn picks up Sketch_1). Extrude doesn't run, so body_extrude_base
  // never enters bodyProducer this pass. Without this seed, a Fillet
  // that references body_extrude_base falls through to a runtime
  // `'failed'` ("Target body not in build context") instead of the
  // correct `'blocked'` cascade. Cache seeding is safe: every feature
  // that runs successfully this pass overwrites its own entry; stale
  // entries for deleted features map to featureIds not in the new
  // timeline → walker finds them but they're not in any blocker set
  // → no spurious cascade.
  if (cachedState && bodyProducer.size === 0) {
    for (const [bid, fid] of cachedState.bodyProducer) {
      bodyProducer.set(bid, fid);
    }
  }

  const diagnostics: string[] = [];

  if (startIndex > 0) {
    diagnostics.push(`Incremental rebuild: starting from feature index ${startIndex} (skipped ${startIndex} cached features)`);
  }

  // Walk the timeline from startIndex
  for (let i = startIndex; i < part.timeline.length; i++) {
    const feature = part.timeline[i];
    if (!feature) continue;

    // Suppressed features. Tracked in suppressedIds so downstream
    // features that reference them (via dependsOn OR via a BodyRef in
    // their inputs) cascade to 'blocked' below.
    if (!feature.enabled) {
      suppressedIds.add(feature.id);
      featureResults.push({ featureId: feature.id, status: 'suppressed' });
      continue;
    }

    // Blocker check: declared dependsOn first, then synthesized
    // body-deps (extracted from any BodyRef shapes in this feature's
    // inputs). Any of the three blocker sets makes this feature
    // 'blocked' instead of attempting to build. blockedIds matters
    // for transitive cascade — a 2-hop chain (suppressed sketch →
    // blocked extrude → CP/fillet) needs the middle hop to count as
    // a blocker for the third.
    const isBlocker = (d: FeatureId): boolean =>
      failedIds.has(d) || suppressedIds.has(d) || blockedIds.has(d);
    const declaredBlocker = feature.dependsOn.find(isBlocker);
    let blocker: FeatureId | undefined = declaredBlocker;
    if (!blocker) {
      const synthDeps = extractBodyProducerDeps(feature.inputs, bodyProducer);
      for (const d of synthDeps) {
        if (isBlocker(d)) {
          blocker = d;
          break;
        }
      }
    }
    if (blocker) {
      blockedIds.add(feature.id);
      featureResults.push({ featureId: feature.id, status: 'blocked', blockedBy: blocker });
      continue;
    }

    try {
      let result;

      // Track bodies before the build for consumed/created tracking.
      // Snapshotted as id -> HANDLE (not just ids) so the orphan sweep below
      // can free shapes the builder replaced or consumed.
      const handlesBefore = new Map(context.bodies);
      const bodiesBefore = new Set(context.bodies.keys());

      // Dispatch through the shared switch in subTimelineRunner.ts so
      // top-level and recursive (importedComponent) builds use the
      // same code path. `visited` starts empty here; an importedComponent
      // builder adds its componentRef and threads through to nested
      // sub-builds for cycle defense.
      result = await dispatchFeatureBuilder(feature, params, context, kernel, project, new Set());

      // Consumed/created body tracking
      const consumed: BodyId[] = [];
      const created: BodyId[] = [];

      // Update context with build results
      for (const body of result.bodies) {
        context.bodies.set(body.bodyId, body.handle);
        if (!bodiesBefore.has(body.bodyId)) {
          created.push(body.bodyId);
        }
      }
      if (result.outputs) {
        context.featureOutputs.set(feature.id, result.outputs);
      }

      // Detect consumed bodies (bodies that were in context before but replaced)
      // For join/cut operations, the original body is consumed and a new one created
      for (const bid of bodiesBefore) {
        if (!context.bodies.has(bid)) {
          consumed.push(bid);
        }
      }

      effects.set(feature.id, { consumed, created });

      // Free the shapes this feature orphaned. A builder that consumes a body
      // (fillet, chamfer, a join/cut extrude) deletes it from `context.bodies`
      // — or rebinds the same id to a new handle — but never releases the old
      // shape, so it stays in the WASM heap for the worker's lifetime. On a
      // large mesh that is tens of MB per rebuild.
      //
      // A handle is orphaned when its id is gone from the context, or still
      // present but now pointing at a different handle. Either way nothing can
      // reach it: downstream features resolve bodies by id, and the builder has
      // already consumed it to produce its replacement (including any stable-id
      // propagation, which happens inside the kernel call).
      for (const [bid, before] of handlesBefore) {
        const after = context.bodies.get(bid);
        if (after === before) continue;
        try {
          // `BuildContext.bodies` stores handles opaquely; every producer puts
          // a KernelBody in, the same cast the tessellation loop below makes.
          kernel.dispose(before as KernelBody);
        } catch (e) {
          // Never let cleanup fail a rebuild — a missed free is a leak, a
          // thrown one loses the user's geometry.
          console.warn(`[Rebuilder] Failed to release orphaned body ${String(bid)}:`, e);
        }
      }
      // Stamp each newly-created body with its producing feature so
      // downstream features that reference it can be cascade-blocked
      // if this feature later fails or is suppressed.
      for (const bid of created) bodyProducer.set(String(bid), feature.id);

      featureResults.push({
        featureId: feature.id,
        status: 'success',
        bodies: [],
      });
      if (feature.type === 'extrude') {
        diagnostics.push(`Extrude built: ${feature.name} (${feature.id})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedIds.add(feature.id);
      featureResults.push({
        featureId: feature.id,
        status: 'failed',
        error: {
          category: 'geometry',
          code: 'BUILD_FAILED',
          message,
        },
      });
      diagnostics.push(`Feature failed: ${feature.name} (${feature.id}) - ${message}`);
      // DO NOT break - continue building subsequent features
    }
  }

  // Cache state for next incremental rebuild. bodyProducer is
  // already accumulated (cache seed + this pass's additions); we
  // snapshot it so subsequent rebuilds inherit the same append-only
  // history.
  cachedState = {
    timeline: part.timeline,
    pointer: newPointer,
    context,
    featureResults: [...featureResults],
    effects: new Map(effects),
    bodyProducer: new Map(bodyProducer),
  };

  // Tessellate all resulting bodies
  const meshes: DisplayMesh[] = [];
  const topologyMaps: TopologyMap[] = [];
  const bodyEntries: { bodyId: BodyId; handle: KernelBody }[] = [];

  for (const [bid, handle] of context.bodies.entries()) {
    try {
      const kernelHandle = handle as KernelBody;
      const mesh = await kernel.tessellate(kernelHandle, FINE_TESSELLATION);
      mesh.bodyId = bid;
      meshes.push(mesh);

      const topo = await kernel.getTopology(kernelHandle);
      topo.bodyId = bid;
      topologyMaps.push(topo);

      bodyEntries.push({ bodyId: bid, handle: kernelHandle });
    } catch (tessError) {
      // Non-fatal for the rebuild — the body exists and every downstream
      // feature can still consume it — but it IS fatal for the user, because
      // a body with no mesh renders as nothing at all.
      //
      // This used to only `console.error`, so the symptom was a feature that
      // appeared in the timeline, produced a body, and drew nothing, with no
      // indication anywhere in the app that something had gone wrong. Push it
      // into `diagnostics` so it reaches the in-app console like any other
      // build failure.
      const message = tessError instanceof Error ? tessError.message : String(tessError);
      console.error(`[Rebuilder] Tessellation failed for body ${bid}:`, tessError);
      diagnostics.push(
        `Tessellation failed for body ${bid} — the body exists but cannot be ` +
          `displayed: ${message}`,
      );
    }
  }

  // Build bodyId → featureId mapping from the effects (consumed/created) tracking
  const bodyToFeatureMap: Record<string, string> = {};
  for (const [featureId, effect] of effects) {
    for (const createdBodyId of effect.created) {
      bodyToFeatureMap[createdBodyId as string] = featureId as string;
    }
  }

  // Collect construction planes for the viewport. Walk the timeline (not
  // the build context) so we can label each entry with its feature name
  // and honor the timeline's `visible` flag — the build context only
  // keeps the resolved plane math.
  const constructionPlanes: ConstructionPlaneDisplay[] = [];
  for (const feature of part.timeline) {
    if (feature.type !== 'constructionPlane') continue;
    const outputs = context.featureOutputs.get(feature.id);
    const planeData = outputs?.data?.['plane'] as
      | { origin: [number, number, number]; uAxis: [number, number, number]; vAxis: [number, number, number]; normal: [number, number, number] }
      | undefined;
    if (!planeData) continue; // build failed or suppressed
    constructionPlanes.push({
      featureId: feature.id,
      name: feature.name,
      visible: feature.visible,
      origin: planeData.origin,
      uAxis: planeData.uAxis,
      vAxis: planeData.vAxis,
      normal: planeData.normal,
    });
  }

  const hasFailures = featureResults.some(r => r.status === 'failed');

  // Hand these to the next rebuild on this kernel to free — see
  // `previousFinalBodies`. Recorded unconditionally, but only ever acted on by
  // a caller that opts in via `sweepPreviousRebuild`.
  previousFinalBodies.set(kernel, bodyEntries.map(e => e.handle));

  return {
    partId: part.id,
    status: hasFailures ? 'partial' : 'success',
    featureResults,
    meshes,
    topologyMaps,
    bodies: bodyEntries,
    constructionPlanes,
    bodyToFeatureMap,
    diagnostics,
  };
}

/**
 * Clear the cached rebuild state. Call when the document changes
 * in a way that invalidates the cache (e.g., feature reorder, deletion).
 */
export function clearRebuildCache(): void {
  cachedState = null;
}

/**
 * Walk a feature's inputs and return the set of upstream featureIds
 * that produced any body referenced inside. The walk recognizes the
 * canonical BodyRef shape (`{ partId, bodyId }`) anywhere in the
 * inputs tree — top-level, nested in arrays, or inside another
 * object (e.g. `targetBody`, `sourceBody`, `edges[i].bodyRef`).
 *
 * Why synthesize this here instead of in the command handlers? Two
 * reasons:
 *   1. Handlers don't have access to `bodyProducer` at dispatch time;
 *      this map is built incrementally inside the rebuild loop.
 *   2. Centralizing the extraction keeps every body-modifying feature
 *      (Fillet, Chamfer, Mirror, Hole, Shell, Pattern, Sweep) in
 *      sync without per-handler duplication. A handler that grows a
 *      new BodyRef field gets cascade-blocking for free.
 *
 * Identified by structural duck-typing on `{ partId, bodyId }` so we
 * don't have to maintain a list of which input fields hold body refs.
 * A false positive (some unrelated object that happens to have those
 * two string fields) would just add a no-op dep — bodyProducer won't
 * have an entry for it, so the blocker check skips it.
 */
export function extractBodyProducerDeps(
  inputs: unknown,
  bodyProducer: Map<string, FeatureId>,
): Set<FeatureId> {
  const out = new Set<FeatureId>();
  const seen = new WeakSet<object>();
  const stack: unknown[] = [inputs];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);

    // Canonical BodyRef shape.
    const maybeRef = node as { partId?: unknown; bodyId?: unknown };
    if (typeof maybeRef.partId === 'string' && typeof maybeRef.bodyId === 'string') {
      const producer = bodyProducer.get(maybeRef.bodyId);
      if (producer !== undefined) out.add(producer);
      // Don't `continue` — a BodyRef nested under a wrapping object
      // (e.g. EdgeRef.bodyRef) is reachable via the parent walk; the
      // BodyRef itself has no children worth descending into.
    }

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else {
      for (const key of Object.keys(node)) {
        stack.push((node as Record<string, unknown>)[key]);
      }
    }
  }
  return out;
}

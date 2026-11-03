/**
 * Recursive sub-timeline runner for embedded parametric components.
 *
 * Walks an embedded component's timeline with the same builder dispatch
 * the main rebuilder uses, but in a FRESH BuildContext so its bodies
 * don't collide with the host part's body-id space. Used by
 * `buildComponent` as part of the rebuild flow.
 *
 * Why a separate module from rebuilder.ts: avoids a circular import
 * with `buildComponent`. Both rebuilder.ts and
 * buildComponent.ts import from this file; this file imports
 * the individual builders directly (which themselves don't import
 * rebuilder.ts), so no cycle.
 *
 * Differences from `incrementalRebuild`:
 *  - No caching (sub-builds are always full).
 *  - No construction-plane collection (host's CP list is canonical).
 *  - No tessellation (caller chooses what to do with the raw bodies).
 *  - Aborts on first failure instead of continuing; returns the
 *    diagnostic so the caller can turn it into a feature-level failure.
 */

import type {
  CadPart,
  CadProject,
  FeatureNode,
} from '@tweakcad/core/src/document/schema.ts';
import { resolveAllParameters } from '@tweakcad/core/src/parameters/evaluator.ts';
import { applyActiveConfiguration } from '@tweakcad/core/src/commands/handlers/configurationCommands.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { releaseShapes } from './featureBuilders/releaseShapes.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { buildSketch } from './featureBuilders/buildSketch.ts';
import { buildExtrude } from './featureBuilders/buildExtrude.ts';
import { buildRevolve } from './featureBuilders/buildRevolve.ts';
import { buildLoft } from './featureBuilders/buildLoft.ts';
import { buildFillet } from './featureBuilders/buildFillet.ts';
import { buildChamfer } from './featureBuilders/buildChamfer.ts';
import { buildHole } from './featureBuilders/buildHole.ts';
import { buildMirror } from './featureBuilders/buildMirror.ts';
import { buildShell } from './featureBuilders/buildShell.ts';
import { buildLinearPattern } from './featureBuilders/buildLinearPattern.ts';
import { buildCircularPattern } from './featureBuilders/buildCircularPattern.ts';
import { buildSweep } from './featureBuilders/buildSweep.ts';
import { buildImportedGeometry } from './featureBuilders/buildImportedGeometry.ts';
import { buildConstructionPlane } from './featureBuilders/buildConstructionPlane.ts';
import { buildPrimitive } from './featureBuilders/buildPrimitive.ts';
import { buildMove } from './featureBuilders/buildMove.ts';
import { buildBoolean } from './featureBuilders/buildBoolean.ts';
import { buildComponent } from './featureBuilders/buildComponent.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';

export type SubTimelineResult = {
  bodies: KernelBody[];
  /** If set, the sub-build failed at the named feature. `bodies` will be empty. */
  error?: string;
};

/**
 * Build the timeline of an embedded component part and return all
 * bodies that survive in the final context.
 *
 * Param resolution: the caller is responsible for handing in a part
 * whose `parameters` already reflects all instance overrides — this
 * function just resolves it. (See `buildComponent.applyInstanceOverrides`
 * for how the merge is computed.)
 *
 * @param part      The embedded component's part (with effective params)
 * @param project   The embedded source CadProject (for `embeddedComponents`
 *                  lookups if the component itself instances sub-components)
 * @param kernel    The shared geometry kernel
 * @param visited   componentRef cycle-defense set; passed through to
 *                  any nested component builds so an A→B→A
 *                  cycle is detected at the right depth.
 */
export async function runSubTimeline(
  part: CadPart,
  project: CadProject,
  kernel: CadKernel,
  visited: Set<string>,
): Promise<SubTimelineResult> {
  const effectivePartParams = applyActiveConfiguration(part);
  const paramResult = resolveAllParameters(project.parameters, effectivePartParams);
  if (!paramResult.ok) {
    return { bodies: [], error: `Parameter resolution failed: ${paramResult.error}` };
  }
  const params = paramResult.value;
  const context = emptyBuildContext(params);
  // A component can contain a large import of its own, and its assets live in
  // its own project's references — not the host's. Without this a ref'd import
  // inside a component resolves to "not loaded" and the body silently vanishes.
  context.references = project.references;

  for (const feature of part.timeline) {
    if (!feature.enabled) continue;
    try {
      const handlesBefore = new Map(context.bodies);
      const result = await dispatchFeatureBuilder(feature, params, context, kernel, project, visited);
      for (const body of result.bodies) {
        context.bodies.set(body.bodyId, body.handle);
      }
      if (result.outputs) {
        context.featureOutputs.set(feature.id, result.outputs);
      }
      // Same sweep as the top-level rebuild: a body a later feature in the
      // component consumed is not one of the component's bodies.
      releaseOrphanedBodies(kernel, handlesBefore, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The component fails as a whole, so none of what it built so far is
      // published.
      releaseShapes(kernel, context.bodies.values() as Iterable<KernelBody>);
      return {
        bodies: [],
        error: `feature "${feature.name}" (${feature.type}) failed: ${message}`,
      };
    }
  }

  return { bodies: Array.from(context.bodies.values()) as KernelBody[] };
}

/**
 * Free the bodies a feature orphaned, given the build context's id → handle
 * map from before it ran.
 *
 * A builder that consumes a body (fillet, chamfer, a join/cut extrude)
 * deletes it from `context.bodies` — or rebinds the same id to a new handle —
 * but never releases the old shape, so it stays in the WASM heap for the
 * worker's lifetime. On a large mesh that is tens of MB per rebuild.
 *
 * A handle is orphaned when its id is gone from the context, or still present
 * but now pointing at a different handle. Either way nothing can reach it:
 * downstream features resolve bodies by id, and the builder has already
 * consumed it to produce its replacement (including any stable-id
 * propagation, which happens inside the kernel call). Used by both the
 * top-level rebuild and component sub-builds.
 */
export function releaseOrphanedBodies(
  kernel: CadKernel,
  before: ReadonlyMap<unknown, unknown>,
  context: BuildContext,
): void {
  const orphaned: KernelBody[] = [];
  for (const [bid, handle] of before) {
    // `BuildContext.bodies` stores handles opaquely; every producer puts a
    // KernelBody in.
    if (context.bodies.get(bid as never) !== handle) orphaned.push(handle as KernelBody);
  }
  releaseShapes(kernel, orphaned);
}

/**
 * Shared dispatch — kept here so the main `incrementalRebuild` and the
 * recursive `runSubTimeline` both go through ONE switch. A new feature
 * type added to the schema needs only one update in this file.
 *
 * Signature matches the existing builder calling convention; the
 * `project` + `visited` extras are only consumed by
 * `buildComponent` — every other builder ignores them.
 */
export async function dispatchFeatureBuilder(
  feature: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
  project: CadProject,
  visited: Set<string>,
): Promise<BuildResult> {
  switch (feature.type) {
    case 'sketch':            return buildSketch(feature, params, context, kernel);
    case 'extrude':           return buildExtrude(feature, params, context, kernel);
    case 'revolve':           return buildRevolve(feature, params, context, kernel);
    case 'loft':              return buildLoft(feature, params, context, kernel);
    case 'fillet':            return buildFillet(feature, params, context, kernel);
    case 'chamfer':           return buildChamfer(feature, params, context, kernel);
    case 'hole':              return buildHole(feature, params, context, kernel);
    case 'mirror':            return buildMirror(feature, params, context, kernel);
    case 'shell':             return buildShell(feature, params, context, kernel);
    case 'linearPattern':     return buildLinearPattern(feature, params, context, kernel);
    case 'circularPattern':   return buildCircularPattern(feature, params, context, kernel);
    case 'sweep':             return buildSweep(feature, params, context, kernel);
    case 'importedGeometry':  return buildImportedGeometry(feature, params, context, kernel);
    case 'component': return buildComponent(feature, params, context, kernel, project, visited);
    case 'constructionPlane': return buildConstructionPlane(feature, params, context, kernel);
    case 'primitive':         return buildPrimitive(feature, params, context, kernel);
    case 'move':              return buildMove(feature, params, context, kernel);
    case 'boolean':           return buildBoolean(feature, params, context, kernel);
    default:                  throw new Error(`No builder for feature type: ${feature.type}`);
  }
}

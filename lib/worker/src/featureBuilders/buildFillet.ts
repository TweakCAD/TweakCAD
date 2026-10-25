/**
 * Fillet feature builder.
 *
 * First feature in the codebase to consume EdgeRef.stableTopology — its
 * edge refs survive upstream rebuilds via the topology-naming layer.
 *
 * Pipeline per rebuild:
 *   1. All edges in inputs.edges must belong to the same body. Reject
 *      mixed-body input with a clear diagnostic.
 *   2. Look the target body up in context.bodies by its bodyId.
 *   3. For each stable EdgeRef, call kernel.resolveEdgeRef to translate
 *      the stable id back into a current-rebuild KernelEdge handle. If
 *      any edge fails to resolve, the build fails (topology naming gave
 *      us our best shot; a downstream RepairHint pass would handle the
 *      "user moved geometry" case, but it's not wired yet).
 *   4. Evaluate the radius expression.
 *   5. Call kernel.fillet(body, edges, radius). The result replaces the
 *      original body (boolean-op semantics are not relevant — fillet is
 *      always an in-place modification).
 */

import type {
  FeatureNode,
  FilletFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { carryBodyId } from './bodyIdentity.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, KernelEdge } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';

export async function buildFillet(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as FilletFeatureInputs;

  const edgeRefs = Array.isArray(inputs.edges) ? inputs.edges : [];
  if (edgeRefs.length === 0) {
    throw new Error('Fillet requires at least one edge');
  }

  // All edges must reference the same body. Mixed-body would require
  // either multiple fillet ops (one per body) or a kernel-level multi-body
  // fillet, neither of which we want to silently fake.
  const targetBodyId = resolveTargetBodyId(inputs, edgeRefs);
  if (!targetBodyId) {
    throw new Error('Fillet edges have no bodyRef; cannot determine target body');
  }
  for (const ref of edgeRefs) {
    if (ref.type !== 'stableTopology') {
      throw new Error(`Fillet only supports stableTopology edge refs (got ${ref.type})`);
    }
    if (String(ref.bodyRef.bodyId) !== String(targetBodyId)) {
      throw new Error(
        `Fillet edges must all belong to the same body. Saw ${ref.bodyRef.bodyId} but target is ${targetBodyId}.`,
      );
    }
  }

  const bodyHandle = context.bodies.get(targetBodyId as BodyId);
  if (!bodyHandle) {
    throw new Error(`Target body ${targetBodyId} not present in build context`);
  }
  const body = bodyHandle as KernelBody;

  // Resolve each stable edge id to a current-rebuild KernelEdge handle.
  const edges: KernelEdge[] = [];
  for (let i = 0; i < edgeRefs.length; i++) {
    const ref = edgeRefs[i]!;
    if (ref.type !== 'stableTopology') continue; // already validated above
    const repairHint = ref.repairHint;
    const resolved = repairHint !== undefined
      ? await kernel.resolveEdgeRef(body, ref.stableEdgeId, repairHint)
      : await kernel.resolveEdgeRef(body, ref.stableEdgeId);
    if (!resolved) {
      throw new Error(
        `Fillet edge #${i + 1}: could not resolve stable edge id ${ref.stableEdgeId} on body ${targetBodyId}`,
      );
    }
    edges.push(resolved);
  }

  const radiusResult = evaluateExpression(inputs.radius, params);
  if (!radiusResult.ok) {
    throw new Error(`Failed to resolve fillet radius: ${radiusResult.error}`);
  }
  if (radiusResult.value <= 0) {
    throw new Error(`Fillet radius must be positive (got ${radiusResult.value})`);
  }

  const bodyResult = await kernel.fillet(body, edges, radiusResult.value);
  if (!bodyResult.ok) {
    throw new Error(`Fillet failed: ${bodyResult.error.message}`);
  }

  // Fillet replaces the input body. Delete the old entry so the rebuilder's
  // "consumed bodies" detector picks it up (it diffs the post-build context
  // against the pre-build snapshot).
  context.bodies.delete(targetBodyId as BodyId);

  // Fillet is a modifier: the body keeps its identity. This used to mint
  // `body_${node.id}_0` on the reasoning that "the bodyId is just a registry
  // handle and is allowed to change" — but body ids are persisted inside
  // every stored BodyRef, so re-keying here silently invalidated the stored
  // references of every downstream feature. Inserting a fillet above a shell
  // broke the shell; inserting a hole in the same slot did not, because hole
  // carried the id. See ./bodyIdentity.ts.
  const resultBodyId = carryBodyId(targetBodyId);
  return {
    bodies: [{ bodyId: resultBodyId, handle: bodyResult.value }],
    outputs: {
      bodies: { main: resultBodyId },
    },
  };
}

/**
 * Determine the body this fillet is applied to. Explicit `targetBody`
 * input wins; otherwise infer from the first edge's bodyRef.
 */
function resolveTargetBodyId(
  inputs: FilletFeatureInputs,
  edgeRefs: FilletFeatureInputs['edges'],
): BodyId | null {
  if (inputs.targetBody?.bodyId) return inputs.targetBody.bodyId;
  for (const ref of edgeRefs) {
    if (ref.type === 'stableTopology' && ref.bodyRef?.bodyId) {
      return ref.bodyRef.bodyId;
    }
  }
  return null;
}

/**
 * Chamfer feature builder.
 *
 * Mechanically identical to {@link buildFillet}: resolves stable
 * EdgeRefs back into runtime KernelEdge handles via the topology-naming
 * layer, validates that all edges live on one body, and calls
 * `kernel.chamfer(body, edges, distance)` to produce a beveled body.
 * The only meaningful differences from Fillet are the scalar input
 * name (`distance` vs `radius`) and the kernel call routed at the end.
 *
 * Phase A ships symmetric chamfers (equal setback on both adjacent
 * faces). Asymmetric (`d1, d2`) and angle modes are deferred until a
 * concrete workflow asks for them — see schema.ts:ChamferFeatureInputs
 * for the forward-compat note.
 */

import type {
  FeatureNode,
  ChamferFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { carryBodyId } from './bodyIdentity.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, KernelEdge } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';

export async function buildChamfer(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as ChamferFeatureInputs;

  const edgeRefs = Array.isArray(inputs.edges) ? inputs.edges : [];
  if (edgeRefs.length === 0) {
    throw new Error('Chamfer requires at least one edge');
  }

  // All edges must reference the same body — mirrors Fillet's guard.
  const targetBodyId = resolveTargetBodyId(inputs, edgeRefs);
  if (!targetBodyId) {
    throw new Error('Chamfer edges have no bodyRef; cannot determine target body');
  }
  for (const ref of edgeRefs) {
    if (ref.type !== 'stableTopology') {
      throw new Error(`Chamfer only supports stableTopology edge refs (got ${ref.type})`);
    }
    if (String(ref.bodyRef.bodyId) !== String(targetBodyId)) {
      throw new Error(
        `Chamfer edges must all belong to the same body. Saw ${ref.bodyRef.bodyId} but target is ${targetBodyId}.`,
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
    if (ref.type !== 'stableTopology') continue; // already validated
    const repairHint = ref.repairHint;
    const resolved = repairHint !== undefined
      ? await kernel.resolveEdgeRef(body, ref.stableEdgeId, repairHint)
      : await kernel.resolveEdgeRef(body, ref.stableEdgeId);
    if (!resolved) {
      throw new Error(
        `Chamfer edge #${i + 1}: could not resolve stable edge id ${ref.stableEdgeId} on body ${targetBodyId}`,
      );
    }
    edges.push(resolved);
  }

  const distanceResult = evaluateExpression(inputs.distance, params);
  if (!distanceResult.ok) {
    throw new Error(`Failed to resolve chamfer distance: ${distanceResult.error}`);
  }
  if (distanceResult.value <= 0) {
    throw new Error(`Chamfer distance must be positive (got ${distanceResult.value})`);
  }

  const bodyResult = await kernel.chamfer(body, edges, distanceResult.value);
  if (!bodyResult.ok) {
    throw new Error(`Chamfer failed: ${bodyResult.error.message}`);
  }

  // Same body-replacement convention as Fillet: drop the old entry so the
  // rebuilder's diff sees it as consumed, then re-emit the SAME id — chamfer
  // is a modifier and the body keeps its identity. See ./bodyIdentity.ts.
  context.bodies.delete(targetBodyId as BodyId);

  const resultBodyId = carryBodyId(targetBodyId);
  return {
    bodies: [{ bodyId: resultBodyId, handle: bodyResult.value }],
    outputs: {
      bodies: { main: resultBodyId },
    },
  };
}

/**
 * Determine the body this chamfer is applied to. Explicit `targetBody`
 * input wins; otherwise infer from the first edge's bodyRef.
 */
function resolveTargetBodyId(
  inputs: ChamferFeatureInputs,
  edgeRefs: ChamferFeatureInputs['edges'],
): BodyId | null {
  if (inputs.targetBody?.bodyId) return inputs.targetBody.bodyId;
  for (const ref of edgeRefs) {
    if (ref.type === 'stableTopology' && ref.bodyRef?.bodyId) {
      return ref.bodyRef.bodyId;
    }
  }
  return null;
}

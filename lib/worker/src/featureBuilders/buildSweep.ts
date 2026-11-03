/**
 * Sweep feature builder.
 *
 * V1 = closed-path sweep: both `profile` and `path` are closed sketch
 * regions (the path's outer wire is used as the spine). Canonical
 * example: circle profile + circle path = torus. Open-wire paths are
 * a deferred follow-up; the dialog enforces v1 by requiring both
 * inputs to be closed regions.
 *
 * Pipeline:
 *   1. Resolve the profile ProfileRef from its sketch's detected
 *      regions, then materialize a face via `kernel.createSketchFace`.
 *      Reuses extrude's `regionToKernelProfile` helper.
 *   2. Same for the path ProfileRef. The path's face is consumed by
 *      `kernel.sweep`, which extracts the outer wire as the spine.
 *   3. Call `kernel.sweep(profileFace, pathFace, origin)` → swept body.
 *   4. Publish under a fresh deterministic id derived from the feature.
 *      `operation: 'newBody'` is the only mode in v1; join/cut land
 *      with the schema's existing operation field once the kernel
 *      adds a partial-history sweep path.
 *
 * The deterministic origin (`node.id`) makes the topology tracker
 * mint the same stable face/edge IDs every rebuild for the same sweep
 * — matches Extrude's pattern, so a downstream Fillet that picks a
 * face on the swept body survives subsequent edits.
 */

import type {
  FeatureNode,
  SweepFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import type { FeatureId, BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelFace } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { resolveProfile } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { regionToKernelProfile } from './buildExtrude.ts';
import { releaseShapes } from './releaseShapes.ts';

export async function buildSweep(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  void params; // sweep v1 has no Expression inputs to evaluate
  const inputs = node.inputs as unknown as SweepFeatureInputs;

  if (!inputs.profile?.sketchId) {
    throw new Error('Sweep requires a profile reference');
  }
  if (!inputs.path?.sketchId) {
    throw new Error('Sweep requires a path reference');
  }

  // 1. Resolve profile face.
  const profileFace = await resolveProfileRefToFace(
    inputs.profile,
    context,
    kernel,
    'profile',
  );

  // 2. Resolve path face (its outer wire becomes the sweep spine).
  let pathFace: KernelFace;
  try {
    pathFace = await resolveProfileRefToFace(inputs.path, context, kernel, 'path');
  } catch (error) {
    releaseShapes(kernel, [profileFace]);
    throw error;
  }

  // 3. Kernel call. `node.id` is forwarded as the topology-tracker
  // origin so the swept body's stable IDs stay deterministic across
  // rebuilds.
  const sweepResult = await kernel.sweep(profileFace, pathFace, `sweep_${node.id}`);
  releaseShapes(kernel, [profileFace, pathFace]); // the sketch faces are spent
  if (!sweepResult.ok) {
    throw new Error(`Sweep failed: ${sweepResult.error.message}`);
  }

  // 4. Publish — newBody only in v1.
  const newBodyId = bodyIdBrand(`body_${node.id}_0`);
  return {
    bodies: [{ bodyId: newBodyId, handle: sweepResult.value }],
    outputs: {
      bodies: { main: newBodyId } as Record<string, BodyId>,
    },
  };
}

/**
 * Resolve a ProfileRef into a kernel face via the same region-
 * detection + wire-profile pipeline that extrude uses. `which` is just
 * the label used in error messages ("profile" / "path") so failures
 * point at the right input.
 */
async function resolveProfileRefToFace(
  ref: SweepFeatureInputs['profile'],
  context: BuildContext,
  kernel: CadKernel,
  which: 'profile' | 'path',
): Promise<KernelFace> {
  const sketchId = ref.sketchId as FeatureId;
  const sketchOutputs = context.featureOutputs.get(sketchId);
  if (!sketchOutputs?.data) {
    throw new Error(`Sweep ${which}: sketch output not found for ${sketchId}`);
  }
  const resolvedRegions = sketchOutputs.data['resolvedRegions'] as
    | Record<string, SketchRegion>
    | undefined;
  const detectedRegions = resolvedRegions ? Object.values(resolvedRegions) : [];

  const resolved = resolveProfile(ref, detectedRegions);
  if (resolved.status !== 'resolved' || !resolved.region) {
    throw new Error(
      `Sweep ${which}: profile did not match a closed region in sketch ${sketchId} ` +
      `(error: ${resolved.error ?? 'unknown'}). v1 requires both profile and path to ` +
      `be closed sketch regions — open paths are a deferred follow-up.`,
    );
  }

  const kernelProfile = regionToKernelProfile(resolved.region, sketchId, context);
  const faceResult = await kernel.createSketchFace(kernelProfile);
  if (!faceResult.ok) {
    throw new Error(`Sweep ${which}: createSketchFace failed: ${faceResult.error.message}`);
  }
  return faceResult.value;
}

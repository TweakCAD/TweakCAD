/**
 * Loft feature builder.
 *
 * Takes 2..16 closed profile references (potentially from different
 * sketches) and lofts them through OCCT's BRepOffsetAPI_ThruSections.
 * The profile order in `inputs.profiles` is the interpolation order.
 */

import type {
  FeatureNode,
  LoftFeatureInputs,
  ProfileRef,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { mintBodyId } from './bodyIdentity.ts';
import { selectTargetCandidates, joinTouchingBodies, cutTouchingBodies } from './bodyOperation.ts';
import type { EmittedBody } from './bodyOperation.ts';
import type { FeatureId, BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelFace, ResolvedProfile } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { resolveProfile } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type {
  ResolvedSketchEntityData,
  ResolvedSketchPlaneData,
} from './buildSketch.ts';
import {
  regionHasCurveSegments,
  regionSegmentsToWire,
  sketchToWorld,
} from './wireProfile.ts';
import { DEFAULT_PLANES } from './resolvePlane.ts';
import { releaseShapes } from './releaseShapes.ts';

const MIN_PROFILES = 2;
const MAX_PROFILES = 16;

export async function buildLoft(
  node: FeatureNode,
  _params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as LoftFeatureInputs;

  const profiles = Array.isArray(inputs.profiles) ? inputs.profiles : [];
  if (profiles.length < MIN_PROFILES) {
    throw new Error(`Loft requires at least ${MIN_PROFILES} profiles (got ${profiles.length})`);
  }
  if (profiles.length > MAX_PROFILES) {
    throw new Error(`Loft supports at most ${MAX_PROFILES} profiles (got ${profiles.length})`);
  }

  // Resolve every profile up-front; bail with a clear diagnostic if any one
  // can't be turned into a closed region.
  const faces: KernelFace[] = [];
  let bodyResult: Awaited<ReturnType<CadKernel['loft']>>;
  try {
    for (let i = 0; i < profiles.length; i++) {
      const ref = profiles[i]!;
      const resolved = resolveOneProfile(ref, context);
      if (resolved.status !== 'resolved' || !resolved.region) {
        throw new Error(
          `Loft profile #${i + 1} (sketch ${ref.sketchId}) failed to resolve: ${resolved.error ?? 'unknown'}`,
        );
      }
      const kernelProfile = regionToKernelProfile(resolved.region, ref.sketchId, context);
      const faceResult = await kernel.createSketchFace(kernelProfile);
      if (!faceResult.ok) {
        throw new Error(`Loft profile #${i + 1}: face creation failed: ${faceResult.error.message}`);
      }
      faces.push(faceResult.value);
    }

    const opts: { ruled?: boolean; closed?: boolean } = {};
    if (inputs.ruled !== undefined) opts.ruled = inputs.ruled;
    if (inputs.closed !== undefined) opts.closed = inputs.closed;

    // Pass node.id as origin so stable face/edge IDs are deterministic
    // per feature — user-captured FaceRef/EdgeRef survive rebuilds.
    bodyResult = await kernel.loft(faces, opts, node.id);
  } finally {
    // The section faces are spent whether the loft worked or a later
    // profile failed to resolve.
    releaseShapes(kernel, faces);
  }
  if (!bodyResult.ok) {
    throw new Error(`Loft failed: ${bodyResult.error.message}`);
  }

  const operands = {
    tools: [bodyResult.value],
    candidates: selectTargetCandidates(inputs.targetBodies, context),
    context,
    kernel,
    explicitTargets: (inputs.targetBodies?.length ?? 0) > 0,
  };
  // Same contract as Extrude's (see `bodyOperation.ts`). Deterministic ids
  // derived from the feature keep user-captured FaceRef/EdgeRef on a new
  // body valid across rebuilds.
  let bodies: EmittedBody[];
  if (inputs.operation === 'join') {
    bodies = await joinTouchingBodies({
      ...operands,
      newBodies: async ([tool]) => [{ bodyId: mintBodyId(node.id), handle: tool! }],
    });
  } else if (inputs.operation === 'cut') {
    bodies = await cutTouchingBodies({ ...operands, featureId: node.id });
  } else {
    bodies = [{ bodyId: mintBodyId(node.id), handle: bodyResult.value }];
  }

  return {
    bodies,
    outputs: {
      bodies: Object.fromEntries(bodies.map((b, i) => [i === 0 ? 'main' : `body_${i}`, b.bodyId])) as Record<string, BodyId>,
    },
  };
}

// ---- Helpers (mirror buildRevolve.ts; extract into a shared file when Sweep lands) ----

function resolveOneProfile(
  ref: ProfileRef,
  context: BuildContext,
): ReturnType<typeof resolveProfile> {
  const sketchId = ref.sketchId as FeatureId;
  const sketchOutputs = context.featureOutputs.get(sketchId);
  if (!sketchOutputs?.data) {
    return {
      profileRef: ref,
      status: 'missing' as const,
      error: `Sketch output not found for ${sketchId}`,
    };
  }
  const resolvedRegions = sketchOutputs.data.resolvedRegions as Record<string, SketchRegion> | undefined;
  const detected = resolvedRegions ? Object.values(resolvedRegions) : [];
  return resolveProfile(ref, detected);
}

function regionToKernelProfile(
  region: SketchRegion,
  sketchId: FeatureId,
  context: BuildContext,
): ResolvedProfile {
  const sketchOutputs = context.featureOutputs.get(sketchId);
  const plane = sketchOutputs?.data?.plane as ResolvedSketchPlaneData | undefined;
  const resolvedEntities = sketchOutputs?.data?.resolvedEntities as
    | Record<string, ResolvedSketchEntityData>
    | undefined;
  const { normal, uAxis, vAxis } = plane ?? DEFAULT_PLANES.XZ;

  if (region.type === 'circle') {
    const entityId = region.entityIds[0];
    const entity = entityId ? resolvedEntities?.[String(entityId)] : undefined;
    if (entity?.type === 'circle') {
      const center = sketchToWorld(region.center, plane);
      return {
        type: 'circle',
        center,
        diameter: entity.diameter,
        normal,
        origin: center,
        uAxis,
        vAxis,
      };
    }
  }

  if (region.type === 'polygon') {
    // (Rectangle fast path retired in task F — invariant #11 dropped
    // the `SketchRectangleEntity` composite, so this branch is now
    // unreachable. Rectangles arrive as 4 lines and fall through to the
    // wire / general-polygon paths below.)

    // Curve-bearing regions (arc / Bézier): emit a wire profile so the
    // loft endpoint sections preserve real curve edges. Same shared
    // helper used by buildExtrude / buildRevolve.
    if (regionHasCurveSegments(region)) {
      const wireSegments = regionSegmentsToWire(region, plane);
      const center = sketchToWorld(region.center, plane);
      return {
        type: 'wire',
        segments: wireSegments,
        center,
        normal,
        origin: center,
        uAxis,
        vAxis,
      };
    }

    const vertices = region.vertices.map(v => sketchToWorld(v, plane));
    if (vertices.length < 3) {
      throw new Error('Loft profile has fewer than three vertices');
    }
    const center = sketchToWorld(region.center, plane);
    return {
      type: 'polygon',
      vertices,
      center,
      normal,
      origin: center,
      uAxis,
      vAxis,
    };
  }

  throw new Error(`Unable to convert region to loft profile: ${region.type}`);
}

/**
 * Revolve feature builder.
 *
 * Takes a single closed sketch profile and revolves it around an axis,
 * producing a solid body via OCCT's BRepPrimAPI_MakeRevol. A 360° revolve
 * of an offset rectangle yields a torus-section solid; a 180° revolve
 * of a half-disc yields a hemisphere.
 */

import { releaseShapes } from './releaseShapes.ts';
import type {
  FeatureNode,
  RevolveFeatureInputs,
  ProfileRef,
  AxisSpec,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { mintBodyId } from './bodyIdentity.ts';
import { selectTargetCandidates, joinTouchingBodies, cutTouchingBodies } from './bodyOperation.ts';
import type { EmittedBody } from './bodyOperation.ts';
import type { FeatureId, BodyId } from '@tweakcad/core/src/ids.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { ResolvedProfile, ResolvedAxis } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { resolveProfile } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import {
  regionHasCurveSegments,
  regionSegmentsToWire,
  sketchToWorld,
} from './wireProfile.ts';
import { DEFAULT_PLANES } from './resolvePlane.ts';
import type {
  ResolvedSketchEntityData,
  ResolvedSketchPlaneData,
} from './buildSketch.ts';

/**
 * Build a revolve feature.
 * Creates a solid body by revolving a sketch profile around an axis.
 */
export async function buildRevolve(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as RevolveFeatureInputs;

  if (!inputs.profile) {
    throw new Error('Revolve feature has no profile reference');
  }

  const resolved = resolveOneProfile(inputs.profile, context);
  if (resolved.status !== 'resolved' || !resolved.region) {
    throw new Error(`Could not resolve revolve profile: ${resolved.error ?? 'unknown'}`);
  }

  const profile = regionToKernelProfile(resolved.region, inputs.profile.sketchId, context);

  const startOffset = resolveStartOffset(inputs, params);
  const profileWithOffset = startOffset !== 0
    ? offsetProfile(profile, startOffset)
    : profile;

  const angleDegResult = evaluateExpression(inputs.angle, params);
  if (!angleDegResult.ok) {
    throw new Error(`Failed to resolve revolve angle: ${angleDegResult.error}`);
  }
  const angleRad = (angleDegResult.value * Math.PI) / 180;

  const axis = resolveAxis(inputs.axis);

  const faceResult = await kernel.createSketchFace(profileWithOffset);
  if (!faceResult.ok) {
    throw new Error(`Failed to create revolve face: ${faceResult.error.message}`);
  }

  // Pass node.id as origin so stable face/edge IDs are deterministic
  // per feature — user-captured FaceRef/EdgeRef survive rebuilds.
  const bodyResult = await kernel.revolve(faceResult.value, axis, angleRad, false, node.id);
  releaseShapes(kernel, [faceResult.value]); // the sketch face is spent
  if (!bodyResult.ok) {
    throw new Error(`Failed to revolve face: ${bodyResult.error.message}`);
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
    bodies = await cutTouchingBodies(operands);
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

// ---- Helpers ----

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
  const detectedRegions = resolvedRegions ? Object.values(resolvedRegions) : [];
  return resolveProfile(ref, detectedRegions);
}

function resolveStartOffset(inputs: RevolveFeatureInputs, params: ResolvedParams): number {
  if (inputs.startOffset === undefined) return 0;
  const result = evaluateExpression(inputs.startOffset, params);
  if (!result.ok) throw new Error(`Failed to resolve revolve start offset: ${result.error}`);
  return result.value;
}

function resolveAxis(spec: AxisSpec): ResolvedAxis {
  switch (spec.type) {
    case 'x':
      return { origin: [0, 0, 0], direction: [1, 0, 0] };
    case 'y':
      return { origin: [0, 0, 0], direction: [0, 1, 0] };
    case 'z':
      return { origin: [0, 0, 0], direction: [0, 0, 1] };
    case 'custom':
      return { origin: spec.origin, direction: spec.direction };
  }
}

// The helpers below mirror buildExtrude.ts. Kept local while the kernel-profile
// conversion is the only shared path; will get extracted when Loft + Sweep land.

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

    // Curve-bearing regions (arc / Bézier): emit a wire profile so
    // revolve sweeps real curve edges (not polygonalized facets) around
    // the axis. Same shared helper used by buildExtrude / buildLoft —
    // see wireProfile.ts.
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
      throw new Error('Revolve profile has fewer than three vertices');
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

  throw new Error(`Unable to convert region to revolve profile: ${region.type}`);
}

function offsetProfile(profile: ResolvedProfile, distance: number): ResolvedProfile {
  const n = profile.normal;
  const off: Vec3 = [n[0] * distance, n[1] * distance, n[2] * distance];
  const offsetVec = (v: Vec3 | undefined): Vec3 | undefined => v
    ? [v[0] + off[0], v[1] + off[1], v[2] + off[2]]
    : undefined;

  const result: ResolvedProfile = {
    ...profile,
    origin: offsetVec(profile.origin) ?? profile.origin,
  };
  const c = offsetVec(profile.center);
  if (c) result.center = c;
  if (profile.vertices) {
    result.vertices = profile.vertices.map(v => [
      v[0] + off[0],
      v[1] + off[1],
      v[2] + off[2],
    ] as Vec3);
  }
  return result;
}

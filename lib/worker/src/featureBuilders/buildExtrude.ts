/**
 * Extrude feature builder.
 * Takes sketch profile references and extrudes them into solid bodies.
 *
 * Profile resolution:
 * 1. Detect regions from the sketch output at extrude execution time
 * 2. Resolve each ProfileRef by entity-ID set matching
 * 3. If any profile fails to resolve, the entire feature fails
 */

import type { FeatureNode, ExtrudeFeatureInputs, ProfileRef, PlaneRef, BodyRef } from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { bodyId } from '@tweakcad/core/src/ids.ts';
import { carryBodyId } from './bodyIdentity.ts';
import type { FeatureId, BodyId } from '@tweakcad/core/src/ids.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, ResolvedProfile } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { resolveProfile } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { SketchRegion, ResolvedProfileResult } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { sampleEllipse, catmullRomClosed } from '@tweakcad/core/src/sketch/curveSampling.ts';
import { ringSelfIntersects } from '@tweakcad/core/src/sketch/selfIntersection.ts';
import type {
  ResolvedSketchEntityData,
  ResolvedSketchPlaneData,
} from './buildSketch.ts';
import { resolvePlaneRef } from './resolvePlane.ts';
import {
  regionHasCurveSegments,
  regionSegmentsToWire,
  sketchToWorld as sharedSketchToWorld,
} from './wireProfile.ts';

/**
 * Slop added to throughAll distances so OCCT booleans have clean exit
 * faces — without this the cut tool ends exactly at the body surface
 * and the resulting topology has degenerate edges.
 */
const THROUGH_ALL_SLOP_MM = 5;

/** Perimeter samples handed to the kernel for a standalone ellipse — a
 *  periodic B-spline is fit through them. 48 is smooth past eye accuracy. */
const ELLIPSE_KERNEL_SAMPLES = 48;

/** Catmull-Rom samples per control-point span for a standalone closed
 *  spline. Dense enough that the periodic B-spline fit follows the curve. */
const CLOSED_SPLINE_SUBDIVISIONS = 8;

/**
 * Build an extrude feature.
 * Creates solid bodies by extruding sketch profile(s).
 */
export async function buildExtrude(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const rawInputs = node.inputs as Record<string, unknown>;

  // Normalize inputs: support both new (profiles array) and legacy (single profile) format
  const inputs = normalizeExtrudeInputs(rawInputs);

  if (inputs.profiles.length === 0) {
    throw new Error('Extrude feature has no profile references');
  }

  // Resolve all profiles from referenced sketches
  const resolvedProfiles = resolveAllProfiles(inputs.profiles, context);

  // Check for failures -- if any profile is missing, the entire feature fails
  const missing = resolvedProfiles.filter(r => r.status === 'missing');
  if (missing.length > 0) {
    const errors = missing.map(m => m.error ?? 'unknown').join('; ');
    throw new Error(`Missing profiles: ${errors}`);
  }

  const startOffset = resolveStartOffset(inputs, params);

  // Select the bodies join/cut/throughAll operate against. When
  // `targetBodies` is set, only those participate. Empty / undefined
  // falls back to the whole context — preserves behavior for
  // documents saved before the picker shipped.
  const targetEntries = selectTargetEntries(inputs, context);

  const isSymmetric = inputs.extent.type === 'symmetric';
  // Offset is applied along the extrusion direction, not raw +normal.
  // Without this, a reversed-direction extrude with offset shifts the
  // face the wrong way along the sketch normal and the body straddles
  // the sketch plane instead of starting offset along the extrude axis.
  // Symmetric is direction-agnostic — keep raw sign.
  const dirSign = inputs.direction.type === 'reversed' ? -1 : 1;
  const signedOffset = isSymmetric ? startOffset : startOffset * dirSign;

  // Resolve the extent → numeric distance along the extrude axis.
  // `throughAll` and `toPlane` need the sketch plane + extrude
  // direction unit vector to project against, so we compute the
  // direction-axis first.
  const firstResolved = resolvedProfiles.find(r => r.status === 'resolved' && r.region);
  const firstProfile = firstResolved && firstResolved.region
    ? regionToKernelProfile(firstResolved.region, firstResolved.profileRef.sketchId, context)
    : undefined;
  const sketchPlane = firstResolved
    ? (context.featureOutputs.get(firstResolved.profileRef.sketchId as FeatureId)?.data?.plane as ResolvedSketchPlaneData | undefined)
    : undefined;
  const extrudeAxis = resolveExtrudeAxis(inputs, firstProfile);

  const distance = await resolveExtentDistance(
    inputs,
    params,
    context,
    kernel,
    extrudeAxis,
    sketchPlane,
    startOffset,
    targetEntries.map(([, h]) => h),
  );

  // Each selected region already carries its nested holes (assigned at
  // detection time — a circle inside a square makes that square's region
  // an annulus). So a profile is just its region's outer boundary plus its
  // holes; selecting the annulus extrudes a washer with no extra step.
  const holedProfiles: ResolvedProfile[] = [];
  for (const resolved of resolvedProfiles) {
    if (resolved.status !== 'resolved' || !resolved.region) continue;
    const sid = resolved.profileRef.sketchId as FeatureId;
    const profile = regionToKernelProfile(resolved.region, sid, context);
    const holes = resolved.region.holes ?? [];
    if (holes.length > 0) {
      profile.holes = holes.map(h => regionToKernelProfile(h, sid, context));
    }
    holedProfiles.push(profile);
  }

  // Step 1: build every profile-body. No boolean ops in this loop —
  // applying join/cut per profile against `context.bodies` (the
  // pre-extrude state) is what produced the "monster body" duplicates
  // where each profile emitted its own copy of "previous-state ∪ profile".
  const profileBodies: KernelBody[] = [];
  let profileIndex = 0;
  for (const profile of holedProfiles) {
    // Apply offset, then back-shift by half-distance for symmetric so
    // the body straddles the sketch plane.
    let shifted = profile;
    if (signedOffset !== 0) shifted = offsetProfile(shifted, signedOffset);
    if (isSymmetric) shifted = offsetProfile(shifted, -distance / 2);

    const faceResult = await kernel.createSketchFace(shifted);
    if (!faceResult.ok) {
      throw new Error(`Failed to create sketch face: ${faceResult.error.message}`);
    }

    // Extrusion vector = shared extrudeAxis × magnitude. extrudeAxis
    // already encodes direction (normal / reversed / custom / symmetric).
    const vector: Vec3 = [
      extrudeAxis[0] * distance,
      extrudeAxis[1] * distance,
      extrudeAxis[2] * distance,
    ];

    // `node.id` is forwarded as the topology-tracker origin so stable
    // face/edge IDs are deterministic per feature. Multi-face extrudes
    // use a per-face suffix so each face gets a unique tag.
    const extrudeOrigin = holedProfiles.length > 1
      ? `${node.id}_${profileIndex}`
      : node.id;
    const bodyResult = await kernel.extrudeFace(faceResult.value, vector, extrudeOrigin);
    if (!bodyResult.ok) {
      throw new Error(`Failed to extrude face: ${bodyResult.error.message}`);
    }
    profileBodies.push(bodyResult.value);
    profileIndex++;
  }

  if (profileBodies.length === 0) {
    throw new Error('Extrude produced no bodies (all profiles failed to resolve)');
  }

  // Step 2: apply the feature operation once.
  //  - newBody (or no resolved targets) → fuse profile-bodies, split
  //    into one body per connected solid.
  //  - join → fuse selected target bodies + profile-bodies; targets
  //    consumed; emit one body.
  //  - cut → cut the first selected target with the union of
  //    profile-bodies; target consumed.
  // `targetEntries` is the set of bodies actually in scope for
  // join/cut — filtered by `inputs.targetBodies` if set, else the
  // whole context (back-compat). Empty selection drops back to
  // newBody so the feature still produces geometry instead of failing.
  const allBodies: { bodyId: BodyId; handle: unknown }[] = [];

  if (inputs.operation === 'newBody' || targetEntries.length === 0) {
    let combined = profileBodies[0]!;
    if (profileBodies.length > 1) {
      const fuseResult = await kernel.booleanFuse(profileBodies);
      if (!fuseResult.ok) {
        throw new Error(`Failed to merge profile bodies: ${fuseResult.error.message}`);
      }
      combined = fuseResult.value;
    }
    const split = await kernel.decomposeBody(combined, node.id);
    split.forEach((handle, i) => {
      allBodies.push({ bodyId: bodyId(`body_${node.id}_${i}`), handle });
    });
  } else if (inputs.operation === 'join') {
    const fuseResult = await kernel.booleanFuse([
      ...targetEntries.map(([, h]) => h),
      ...profileBodies,
    ]);
    if (!fuseResult.ok) {
      throw new Error(`Join failed: ${fuseResult.error.message}`);
    }
    // Merge: the result carries the PRIMARY target's id; the other inputs
    // are consumed and their ids retire. Minting a fresh id here would
    // invalidate every stored BodyRef pointing at the target the user joined
    // onto, which is the body they still think of as theirs.
    //
    // `targetEntries` is non-empty in this branch — the guard above routes
    // the empty case to newBody — but read it without an assertion so the
    // invariant is enforced rather than asserted.
    const [primaryTarget] = targetEntries;
    if (!primaryTarget) throw new Error('Join reached with no target bodies.');
    for (const [tid] of targetEntries) context.bodies.delete(tid);
    allBodies.push({ bodyId: carryBodyId(primaryTarget[0]), handle: fuseResult.value });
  } else {
    // cut — targetEntries[0] is the user-picked target (or the
    // insertion-order first body in the back-compat all-context path).
    const [tid, th] = targetEntries[0]!;
    const cutResult = await kernel.booleanCut(th, profileBodies);
    if (!cutResult.ok) {
      throw new Error(`Cut failed: ${cutResult.error.message}`);
    }
    // Cut modifies the target in place — same body, material removed — so it
    // carries the target's id rather than minting one.
    context.bodies.delete(tid);
    allBodies.push({ bodyId: carryBodyId(tid), handle: cutResult.value });
  }

  return {
    bodies: allBodies,
    outputs: {
      bodies: Object.fromEntries(allBodies.map((b, i) => [i === 0 ? 'main' : `body_${i}`, b.bodyId])) as Record<string, BodyId>,
      faces: {
        startFace: `${node.id}:startFace`,
        endFace: `${node.id}:endFace`,
      },
    },
  };
}

/**
 * Normalize extrude inputs to the canonical `profiles[]` format.
 */
function normalizeExtrudeInputs(raw: Record<string, unknown>): ExtrudeFeatureInputs {
  if (Array.isArray(raw.profiles)) {
    return raw as unknown as ExtrudeFeatureInputs;
  }
  return { ...raw, profiles: [] } as unknown as ExtrudeFeatureInputs;
}

/**
 * Resolve all ProfileRefs against detected sketch regions.
 */
function resolveAllProfiles(
  profiles: ProfileRef[],
  context: BuildContext,
): ResolvedProfileResult[] {
  return profiles.map(ref => {
    const sketchId = ref.sketchId as FeatureId;
    const sketchOutputs = context.featureOutputs.get(sketchId);

    if (!sketchOutputs?.data) {
      return {
        profileRef: ref,
        status: 'missing' as const,
        error: `Sketch output not found for ${sketchId}`,
      };
    }

    // Get detected regions from sketch output
    const resolvedRegions = sketchOutputs.data.resolvedRegions as Record<string, SketchRegion> | undefined;
    const detectedRegions = resolvedRegions
      ? Object.values(resolvedRegions)
      : [];

    return resolveProfile(ref, detectedRegions);
  });
}

/**
 * Convert a resolved SketchRegion into a ResolvedProfile the kernel can use.
 *
 * Exported so other builders (Sweep, future Loft variants) can reuse
 * the same region → kernel-profile mapping instead of duplicating it.
 * Kept in buildExtrude.ts (rather than moved to a shared module) to
 * minimize churn — the function is tightly coupled to the profile
 * region detector's shape and Extrude is its primary consumer.
 */
export function regionToKernelProfile(
  region: SketchRegion,
  sketchId: FeatureId,
  context: BuildContext,
): ResolvedProfile {
  const sketchOutputs = context.featureOutputs.get(sketchId);
  const plane = sketchOutputs?.data?.plane as ResolvedSketchPlaneData | undefined;
  const resolvedEntities = sketchOutputs?.data?.resolvedEntities as Record<string, ResolvedSketchEntityData> | undefined;
  const normal: Vec3 = plane?.normal ?? [0, 1, 0];
  const uAxis: Vec3 = plane?.uAxis ?? [1, 0, 0];
  const vAxis: Vec3 = plane?.vAxis ?? [0, 0, 1];

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

  if (region.type === 'ellipse') {
    // Sample the ellipse perimeter in sketch-2D (center + major-axis
    // endpoint + minor radius all live there, so the in-plane rotation is
    // preserved), then lift each point to world. The kernel fits one
    // periodic B-spline face through the ring.
    const major = region.ellipseMajorEnd ?? region.center;
    const minor = region.ellipseMinorRadius ?? 0;
    const ring2d = sampleEllipse(region.center, major, minor, ELLIPSE_KERNEL_SAMPLES);
    const vertices = ring2d.map(p => sketchToWorld(p, plane));
    const center = sketchToWorld(region.center, plane);
    return { type: 'closedSpline', vertices, center, normal, origin: center, uAxis, vAxis };
  }

  if (region.type === 'closedSpline') {
    const ctrl = region.splineControlPoints ?? [];
    // Sample a *periodic* Catmull-Rom through the control ring — seam-free,
    // so the curve follows the drawn shape all the way around (the editor's
    // open Catmull-Rom kinks at the closure, which both looked wrong and
    // tripped the self-intersection guard on otherwise-simple loops).
    const ringSamples = catmullRomClosed(ctrl, CLOSED_SPLINE_SUBDIVISIONS);
    // Self-intersection check on the ACTUAL sampled boundary OCCT will
    // build — a self-crossing curve doesn't bound a valid face and makes
    // makeFace spin (stuck "rebuilding"). Reject up front with a clear
    // error instead of hanging the worker.
    if (ringSelfIntersects(ringSamples)) {
      throw new Error('Closed spline self-intersects — cannot form a face. Simplify the curve or split it into non-crossing loops.');
    }
    const vertices = ringSamples.map(p => sketchToWorld(p, plane));
    const center = sketchToWorld(region.center, plane);
    return { type: 'closedSpline', vertices, center, normal, origin: center, uAxis, vAxis };
  }

  if (region.type === 'polygon') {
    // (Rectangle fast path retired in task F — invariant #11 dropped
    // the `SketchRectangleEntity` composite, so this branch is now
    // unreachable. Rectangles arrive as 4 lines and fall through to the
    // wire / general-polygon paths below.)

    // If any segment carries a native curve (arc or Bézier), emit a
    // `'wire'` profile so the kernel builds a real BREP curve edge per
    // segment — not a 64-facet polygon. See `wireProfile.ts` for the
    // shared implementation.
    if (regionHasCurveSegments(region)) {
      const wireSegments = regionSegmentsToWire(region, plane);
      const center = sharedSketchToWorld(region.center, plane);
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

    // General polygon region (from line loops)
    const vertices = region.vertices.map(vertex => sketchToWorld(vertex, plane));
    if (vertices.length < 3) {
      throw new Error(`Region has fewer than three vertices`);
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

  throw new Error(`Unable to convert region to kernel profile: ${region.type}`);
}


function resolveStartOffset(inputs: ExtrudeFeatureInputs, params: ResolvedParams): number {
  if (inputs.startOffset === undefined) return 0;
  const result = evaluateExpression(inputs.startOffset, params);
  if (!result.ok) throw new Error(`Failed to resolve extrude start offset: ${result.error}`);
  return result.value;
}

/**
 * Pick the bodies this extrude operates against for join/cut. When the
 * feature carries an explicit `targetBodies` list, only those bodies
 * participate. Empty/undefined falls back to the
 * whole context — preserves behavior for documents saved before the
 * picker shipped, and for newBody where the field is irrelevant.
 *
 * Refs that don't resolve in `context.bodies` (e.g. user picked a body
 * that got deleted upstream) are silently dropped — the next stage's
 * "empty selection → newBody fallback" handles the degenerate case.
 */
function selectTargetEntries(
  inputs: ExtrudeFeatureInputs,
  context: BuildContext,
): [BodyId, KernelBody][] {
  const all = Array.from(context.bodies.entries()) as [BodyId, KernelBody][];
  const refs = inputs.targetBodies;
  if (!refs || refs.length === 0) return all;
  const wanted = new Set(refs.map((r: BodyRef) => String(r.bodyId)));
  return all.filter(([id]) => wanted.has(String(id)));
}

/**
 * Compute the unit vector along which the extrude grows. Encodes the
 * `direction` field once so the per-profile loop and the throughAll /
 * toPlane distance resolvers share the same axis.
 *
 * Symmetric is direction-agnostic — always +profile.normal — because
 * the body straddles the start plane and we encode the asymmetry
 * upstream via the face back-shift.
 */
function resolveExtrudeAxis(
  inputs: ExtrudeFeatureInputs,
  profile: ResolvedProfile | undefined,
): Vec3 {
  const fallback: Vec3 = [0, 0, 1];
  const pn: Vec3 = profile?.normal ?? fallback;
  if (inputs.extent.type === 'symmetric') return pn;
  if (inputs.direction.type === 'custom') {
    const v = inputs.direction.vector;
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len > 0) return [v[0] / len, v[1] / len, v[2] / len];
    return pn;
  }
  const sign = inputs.direction.type === 'reversed' ? -1 : 1;
  return [pn[0] * sign, pn[1] * sign, pn[2] * sign];
}

/**
 * Resolve `inputs.extent` to a scalar distance along `extrudeAxis`.
 *
 *  - `distance` / `symmetric` evaluate the stored Expression.
 *  - `throughAll` projects each target body's AABB onto the axis and
 *    spans from the start position (sketchPlane.origin + startOffset)
 *    to the farthest projected corner, plus slop. With no targets in
 *    scope, falls back to 100 mm so the feature still produces
 *    geometry.
 *  - `toPlane` resolves the target plane via the shared resolver and
 *    returns the signed projection of (targetOrigin − sketchOrigin)
 *    onto the axis, less the startOffset. Throws if the target is at
 *    or behind the start position (extrude would have zero / negative
 *    length) or if the target plane is parallel to the axis (the
 *    extrude could never reach it).
 */
async function resolveExtentDistance(
  inputs: ExtrudeFeatureInputs,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
  extrudeAxis: Vec3,
  sketchPlane: ResolvedSketchPlaneData | undefined,
  startOffset: number,
  targetHandles: KernelBody[],
): Promise<number> {
  if (inputs.extent.type === 'distance' || inputs.extent.type === 'symmetric') {
    const r = evaluateExpression(inputs.extent.value, params);
    if (!r.ok) throw new Error(`Failed to resolve extrude distance: ${r.error}`);
    return r.value;
  }

  const origin: Vec3 = sketchPlane?.origin ?? [0, 0, 0];
  const startProj = dot(origin, extrudeAxis) + startOffset;

  if (inputs.extent.type === 'throughAll') {
    if (targetHandles.length === 0) return 100;
    let maxProj = -Infinity;
    for (const handle of targetHandles) {
      const bbox = await kernel.getBoundingBox(handle);
      // Project all 8 AABB corners onto extrudeAxis; the max projection
      // along the forward direction is what we need to clear.
      for (const x of [bbox.min[0], bbox.max[0]]) {
        for (const y of [bbox.min[1], bbox.max[1]]) {
          for (const z of [bbox.min[2], bbox.max[2]]) {
            const p = x * extrudeAxis[0] + y * extrudeAxis[1] + z * extrudeAxis[2];
            if (p > maxProj) maxProj = p;
          }
        }
      }
    }
    const dist = maxProj - startProj + THROUGH_ALL_SLOP_MM;
    // Guard against axes pointing away from the target geometry — pick
    // a positive minimum so OCCT gets a valid prism length.
    return Math.max(dist, THROUGH_ALL_SLOP_MM);
  }

  if (inputs.extent.type === 'toPlane') {
    const target = resolvePlaneRef(inputs.extent.plane as PlaneRef, context, params);
    const targetNormal = target.normal;
    const axisDotNormal = dot(extrudeAxis, targetNormal);
    if (Math.abs(axisDotNormal) < 1e-9) {
      throw new Error('Extrude toPlane: target plane is parallel to the extrude direction (would never reach)');
    }
    const targetProj = dot(target.origin, extrudeAxis);
    const signedDist = targetProj - startProj;
    if (signedDist <= 1e-9) {
      throw new Error('Extrude toPlane: target plane is at or behind the start position');
    }
    return signedDist;
  }

  return 10;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function offsetProfile(profile: ResolvedProfile, distance: number): ResolvedProfile {
  const normal = profile.normal;
  const offsetVector: Vec3 = [normal[0] * distance, normal[1] * distance, normal[2] * distance];
  const offsetVec = (value: Vec3 | undefined): Vec3 | undefined => value
    ? [value[0] + offsetVector[0], value[1] + offsetVector[1], value[2] + offsetVector[2]]
    : undefined;

  const result: ResolvedProfile = {
    ...profile,
    origin: offsetVec(profile.origin) ?? profile.origin,
  };

  const center = offsetVec(profile.center);
  if (center) result.center = center;
  if (profile.vertices) {
    result.vertices = profile.vertices.map(vertex => [
      vertex[0] + offsetVector[0],
      vertex[1] + offsetVector[1],
      vertex[2] + offsetVector[2],
    ] as Vec3);
  }
  // Wire profiles (arc / Bézier loops) carry their geometry on the
  // segments, not `vertices` — they must shift too, or a symmetric /
  // offset extrude would leave the curve edges at the un-shifted plane
  // while the rest of the profile moves.
  if (profile.segments) {
    const shiftVec = (v: Vec3): Vec3 => [
      v[0] + offsetVector[0],
      v[1] + offsetVector[1],
      v[2] + offsetVector[2],
    ];
    result.segments = profile.segments.map(seg => {
      switch (seg.kind) {
        case 'line':
          return { ...seg, start: shiftVec(seg.start), end: shiftVec(seg.end) };
        case 'arc3pt':
          return { ...seg, start: shiftVec(seg.start), mid: shiftVec(seg.mid), end: shiftVec(seg.end) };
        case 'bezier':
          return {
            ...seg,
            start: shiftVec(seg.start),
            cp1: shiftVec(seg.cp1),
            cp2: shiftVec(seg.cp2),
            end: shiftVec(seg.end),
          };
        case 'spline':
          return { ...seg, points: seg.points.map(shiftVec) };
      }
    });
  }
  // Holes live at the same plane as their outer profile, so shift them by
  // the same offset (else a washer's hole stays behind on a symmetric or
  // offset extrude).
  if (profile.holes) {
    result.holes = profile.holes.map(h => offsetProfile(h, distance));
  }

  return result;
}

function sketchToWorld(
  point: [number, number],
  plane: ResolvedSketchPlaneData | undefined,
): Vec3 {
  const resolvedPlane = plane ?? {
    name: 'XZ' as const,
    origin: [0, 0, 0] as Vec3,
    uAxis: [1, 0, 0] as Vec3,
    vAxis: [0, 0, 1] as Vec3,
    normal: [0, 1, 0] as Vec3,
  };

  return [
    resolvedPlane.origin[0] + point[0] * resolvedPlane.uAxis[0] + point[1] * resolvedPlane.vAxis[0],
    resolvedPlane.origin[1] + point[0] * resolvedPlane.uAxis[1] + point[1] * resolvedPlane.vAxis[1],
    resolvedPlane.origin[2] + point[0] * resolvedPlane.uAxis[2] + point[1] * resolvedPlane.vAxis[2],
  ];
}

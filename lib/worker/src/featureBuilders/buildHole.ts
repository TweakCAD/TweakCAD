/**
 * Hole feature builder.
 *
 * Drills a cylindrical hole through the picked face into a body, with
 * optional counterbore (cylindrical recess) or countersink (conical
 * recess) shape on top.
 *
 * Pipeline:
 *   1. Resolve `inputs.face` (a {@link FaceRef}) into a face plane via
 *      `resolveFacePlaneRef` — gives us `origin` (face surface centroid)
 *      and `normal` (outward).
 *   2. Build the primary cylinder anchored at the face surface, axis =
 *      `-normal` (inward into the body), height = blind depth or a
 *      through-all distance derived from the target body's AABB.
 *   3. For `kind === 'counterbore'`: fuse a wider, shallower cylinder
 *      anchored at the same face surface.
 *   4. For `kind === 'countersink'`: fuse a cone whose top rim sits at
 *      the face surface and which tapers down. Cone height is derived
 *      from the user-supplied included angle so the cone wall meets the
 *      cylinder at the geometrically-correct depth.
 *   5. Boolean-cut the assembled tool from the target body. The target
 *      is the FaceRef's parent body (looked up via `context.bodies` from
 *      `face.bodyRef.bodyId`). A cut that removes no material (the drill
 *      misses the body) fails the feature, when the kernel can measure
 *      volume.
 *
 * Deterministic IDs: every kernel call passes `node.id` (with suffixes
 * for the secondary shapes) as the topology-tracker origin so a hole
 * rebuilding the same inputs produces the same stable face/edge IDs
 * every time — matching the pattern used by Extrude / Revolve / Loft.
 *
 * The hole tool is assembled via fuse-then-cut composition, cut inline so
 * the user sees the hole appear in the body immediately.
 */

import type {
  FeatureNode,
  HoleFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { bodyId } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import {
  evalNumberOrThrow,
  resolveFacePlaneRef,
} from './resolvePlane.ts';

/**
 * Through-all overshoot multiplier. The through-all height is computed
 * as the body's AABB diagonal multiplied by this factor, so even a hole
 * drilled along an arbitrary axis on a non-axis-aligned body fully
 * exits both sides. AABB diagonal is the longest distance between any
 * two points on the body, so anything past that × 1.0 is guaranteed
 * to clear; we multiply by 2 for slack against floating-point edges.
 */
const THROUGH_ALL_FACTOR = 2;

/**
 * Removed volume (mm³) at or below which the cut counts as having missed
 * the body. Far below any real hole (a 0.1 mm × 0.1 mm hole is ~8e-4 mm³),
 * far above OCCT's volume noise on an unchanged solid.
 */
const MIN_REMOVED_VOLUME = 1e-6;

export async function buildHole(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as HoleFeatureInputs;

  // 1. Resolve the face → tangent plane (origin + outward normal).
  const facePlane = await resolveFacePlaneRef(inputs.face, context, params, kernel);

  // The hole drills INTO the body, so the tool body's axis is the
  // face's INWARD normal (face normal flipped). `DirectionSpec` is
  // honored as a per-feature override (`reversed` flips back out,
  // `custom` overrides entirely) — same convention as extrude.
  const inwardNormal: Vec3 = [
    -facePlane.normal[0],
    -facePlane.normal[1],
    -facePlane.normal[2],
  ];
  const axis = resolveHoleAxis(inputs.direction, inwardNormal);

  // 2. Determine the target body. Only `stableTopology` face refs carry
  // a bodyRef; default-plane / construction-plane / featureOutput refs
  // don't bind to a body so they can't be used to drill — the user
  // would be picking "the XY plane" with no body to cut from.
  if (inputs.face.type !== 'stableTopology') {
    throw new Error(
      `Hole.face must be a stableTopology FaceRef (got ${inputs.face.type}) — ` +
      `pick a face on an existing body, not a datum plane.`,
    );
  }
  const targetBodyId = inputs.face.bodyRef.bodyId;
  const targetHandle = context.bodies.get(targetBodyId);
  if (!targetHandle) {
    throw new Error(
      `Hole target body ${targetBodyId} not in build context — ` +
      `the upstream feature that produced it may have failed.`,
    );
  }

  // 3. Resolve diameter + extent → primary cylinder height.
  const diameter = evalNumberOrThrow(inputs.diameter, params, `hole diameter (${node.id})`);
  if (diameter <= 0) {
    throw new Error(`Hole diameter must be positive (got ${diameter})`);
  }
  const radius = diameter / 2;

  const drillHeight = await resolvePrimaryHeight(
    inputs.extent,
    params,
    node.id,
    kernel,
    targetHandle as KernelBody,
  );

  // 4. Center the primary cylinder: `center` is a (u, v) offset from the
  // face centroid in the face plane's basis (`getFacePlane`). The dialog
  // emits [0, 0]; the AI tool passes real offsets. The centroid of a face
  // with a hole in it (a shelled box's rim) lies off the face, so [0, 0]
  // can miss the body — step 8 reports that.
  const [cu, cv] = evalCenter(inputs.center, params, node.id);
  const drillCenter: Vec3 = [
    facePlane.origin[0] + cu * facePlane.uAxis[0] + cv * facePlane.vAxis[0],
    facePlane.origin[1] + cu * facePlane.uAxis[1] + cv * facePlane.vAxis[1],
    facePlane.origin[2] + cu * facePlane.uAxis[2] + cv * facePlane.vAxis[2],
  ];

  // 5. Build the primary cylinder. `node.id` is forwarded as the
  // topology-tracker origin so the hole's cylindrical face / circular
  // edges get deterministic stable IDs — matches the extrude pattern.
  const primaryResult = await kernel.makeCylinder(
    { center: drillCenter, axis, radius, height: drillHeight },
    `hole_${node.id}_drill`,
  );
  if (!primaryResult.ok) {
    throw new Error(`Hole drill cylinder failed: ${primaryResult.error.message}`);
  }
  let toolBody: KernelBody = primaryResult.value;

  // 6. Optional counterbore: a wider, shallower cylinder anchored at
  // the same face surface. Fused into the tool body before the cut.
  if (inputs.kind === 'counterbore') {
    const cboreDiameter = evalNumberOrThrow(
      requireField(inputs.counterboreDiameter, 'counterboreDiameter'),
      params,
      `counterbore diameter (${node.id})`,
    );
    const cboreDepth = evalNumberOrThrow(
      requireField(inputs.counterboreDepth, 'counterboreDepth'),
      params,
      `counterbore depth (${node.id})`,
    );
    if (cboreDiameter <= 0) {
      throw new Error(`Counterbore diameter must be positive (got ${cboreDiameter})`);
    }
    if (cboreDiameter <= diameter) {
      throw new Error(
        `Counterbore diameter (${cboreDiameter}) must exceed hole diameter (${diameter})`,
      );
    }
    if (cboreDepth <= 0) {
      throw new Error(`Counterbore depth must be positive (got ${cboreDepth})`);
    }

    const cboreResult = await kernel.makeCylinder(
      {
        center: drillCenter,
        axis,
        radius: cboreDiameter / 2,
        height: cboreDepth,
      },
      `hole_${node.id}_cbore`,
    );
    if (!cboreResult.ok) {
      throw new Error(`Counterbore cylinder failed: ${cboreResult.error.message}`);
    }

    const fuseResult = await kernel.booleanFuse([toolBody, cboreResult.value]);
    if (!fuseResult.ok) {
      throw new Error(`Counterbore fuse failed: ${fuseResult.error.message}`);
    }
    toolBody = fuseResult.value;
  }

  // 7. Optional countersink: a cone whose wide rim sits at the face
  // surface and tapers to a point along the drill axis. Cone height is
  // derived from the included angle so the cone wall meets the hole
  // cylinder at the geometrically-correct depth.
  if (inputs.kind === 'countersink') {
    const csinkDiameter = evalNumberOrThrow(
      requireField(inputs.countersinkDiameter, 'countersinkDiameter'),
      params,
      `countersink diameter (${node.id})`,
    );
    const csinkAngleDeg = evalNumberOrThrow(
      requireField(inputs.countersinkAngle, 'countersinkAngle'),
      params,
      `countersink angle (${node.id})`,
    );
    if (csinkDiameter <= 0) {
      throw new Error(`Countersink diameter must be positive (got ${csinkDiameter})`);
    }
    if (csinkDiameter <= diameter) {
      throw new Error(
        `Countersink diameter (${csinkDiameter}) must exceed hole diameter (${diameter})`,
      );
    }
    if (csinkAngleDeg <= 0 || csinkAngleDeg >= 180) {
      throw new Error(
        `Countersink angle must be in (0, 180) degrees (got ${csinkAngleDeg})`,
      );
    }

    // Cone height from cross-section: tan(angle/2) = radiusDelta / height
    // ⇒ height = (csinkR - holeR) / tan(angle/2)
    // At angle=90° this gives height = (csinkR - holeR), so the cone
    // wall slopes at 45° — matches a standard 90° flathead screw recess.
    const csinkR = csinkDiameter / 2;
    const halfAngleRad = (csinkAngleDeg * Math.PI) / 360;
    const csinkHeight = (csinkR - radius) / Math.tan(halfAngleRad);

    // r1 = wide rim at the face surface (z=0 in the cone's local
    // frame), r2 = 0 at the tip (z=height). The part of the cone below
    // the depth where it crosses the cylinder is irrelevant because the
    // cylinder fills it.
    const coneResult = await kernel.makeCone(
      {
        center: drillCenter,
        axis,
        radius1: csinkR,
        radius2: 0,
        height: csinkHeight,
      },
      `hole_${node.id}_csink`,
    );
    if (!coneResult.ok) {
      throw new Error(`Countersink cone failed: ${coneResult.error.message}`);
    }

    const fuseResult = await kernel.booleanFuse([toolBody, coneResult.value]);
    if (!fuseResult.ok) {
      throw new Error(`Countersink fuse failed: ${fuseResult.error.message}`);
    }
    toolBody = fuseResult.value;
  }

  // 8. Subtract the tool body from the target body. The resulting
  // body's bodyId is derived from `node.id` so it stays stable across
  // rebuilds — same pattern as extrude's `body_${node.id}_${i}`.
  const volumeBefore = kernel.getMassProperties
    ? (await kernel.getMassProperties(targetHandle as KernelBody)).volume
    : undefined;
  const cutResult = await kernel.booleanCut(targetHandle as KernelBody, [toolBody]);
  if (!cutResult.ok) {
    throw new Error(`Hole cut failed: ${cutResult.error.message}`);
  }

  // A drill that misses the body leaves it untouched, and the boolean
  // still succeeds. Report that instead of a feature that did nothing.
  if (volumeBefore !== undefined && kernel.getMassProperties) {
    const removed = volumeBefore - (await kernel.getMassProperties(cutResult.value)).volume;
    if (removed <= Math.max(MIN_REMOVED_VOLUME, volumeBefore * 1e-9)) {
      kernel.dispose(cutResult.value);
      const fmt = (v: Vec3) => `[${v.map(n => +n.toFixed(3)).join(', ')}]`;
      throw new Error(
        `Hole cuts nothing: the drill at ${fmt(drillCenter)} along ${fmt(axis)} ` +
        `misses body ${targetBodyId}. center [${cu}, ${cv}] is measured from the ` +
        `face centroid ${fmt(facePlane.origin)} along u ${fmt(facePlane.uAxis)} ` +
        `and v ${fmt(facePlane.vAxis)}.`,
      );
    }
  }

  // Replace the target body in the context: the bodyId stays the same
  // (Hole modifies the existing body, doesn't spawn a new one) so
  // downstream features that reference this body keep
  // working without re-binding.
  const resultBodyId = targetBodyId;

  return {
    bodies: [{ bodyId: bodyId(String(resultBodyId)), handle: cutResult.value }],
    outputs: {
      bodies: { main: bodyId(String(resultBodyId)) } as Record<string, BodyId>,
    },
  };
}

/**
 * Resolve the hole's drill axis. Honors `direction.type`:
 *   - `normal`    → inward (already pre-computed as `defaultInward`)
 *   - `reversed`  → outward (flip back to the face's outward normal)
 *   - `custom`    → use the user-supplied vector verbatim, normalized
 */
function resolveHoleAxis(
  direction: HoleFeatureInputs['direction'],
  defaultInward: Vec3,
): Vec3 {
  if (direction.type === 'normal') return defaultInward;
  if (direction.type === 'reversed') {
    return [-defaultInward[0], -defaultInward[1], -defaultInward[2]];
  }
  // custom — normalize the user-supplied vector
  const [x, y, z] = direction.vector;
  const len = Math.hypot(x, y, z);
  if (len === 0) return defaultInward;
  return [x / len, y / len, z / len];
}

/**
 * Resolve the primary drill cylinder's height from the extent spec.
 *
 *   - `distance`   → user-supplied value (blind hole).
 *   - `throughAll` → derived from target body's AABB diagonal × overshoot.
 *   - `symmetric`  → reject: a hole is intrinsically one-sided.
 *   - `toPlane`    → reject for v1: would need a plane resolver here.
 */
async function resolvePrimaryHeight(
  extent: HoleFeatureInputs['extent'],
  params: ResolvedParams,
  featureIdStr: string,
  kernel: CadKernel,
  targetBody: KernelBody,
): Promise<number> {
  if (extent.type === 'distance') {
    const depth = evalNumberOrThrow(extent.value, params, `hole depth (${featureIdStr})`);
    if (depth <= 0) {
      throw new Error(`Hole depth must be positive (got ${depth})`);
    }
    return depth;
  }
  if (extent.type === 'throughAll') {
    const aabb = await kernel.getBoundingBox(targetBody);
    const dx = aabb.max[0] - aabb.min[0];
    const dy = aabb.max[1] - aabb.min[1];
    const dz = aabb.max[2] - aabb.min[2];
    const diag = Math.hypot(dx, dy, dz);
    return diag * THROUGH_ALL_FACTOR;
  }
  if (extent.type === 'symmetric') {
    throw new Error(`Hole extent 'symmetric' is not supported — pick blind or through-all.`);
  }
  // toPlane
  throw new Error(`Hole extent 'toPlane' is not yet implemented.`);
}

/**
 * Resolve the in-plane center as (u, v) numbers. The dialog emits
 * `["0", "0"]`; `feature_hole` passes the caller's offsets.
 */
function evalCenter(
  center: HoleFeatureInputs['center'],
  params: ResolvedParams,
  featureIdStr: string,
): [number, number] {
  const u = evalNumberOrThrow(center[0], params, `hole center u (${featureIdStr})`);
  const v = evalNumberOrThrow(center[1], params, `hole center v (${featureIdStr})`);
  return [u, v];
}

/**
 * Tiny helper: throw a clear error if a kind-specific param is missing.
 * Keeps the discriminated-by-`kind` ergonomics without the boilerplate
 * of a runtime discriminated union on the input itself.
 */
function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Hole input '${name}' is required for this kind but was not provided.`);
  }
  return value;
}

/**
 * Resolve a {@link PlaneRef} from the document schema into a concrete
 * `ResolvedSketchPlaneData` (origin + uAxis + vAxis + normal) the kernel
 * pipeline can consume.
 *
 * Centralized here so every feature that anchors to a plane —
 * `buildSketch`, `buildConstructionPlane`, and the upcoming `buildHole`
 * with `FaceRef.constructionPlane` — uses the exact same basis. The
 * default-plane bases match `SketchPlanePicker`'s quaternions so a
 * sketch authored on a construction plane offset from XY keeps the same
 * handedness as a sketch on raw XY.
 */

import type { FaceRef, PlaneRef } from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { nearestDefaultPlaneName, sketchFrameOnPlane } from '@tweakcad/core/src/sketch/facePlane.ts';
import type {
  ResolvedSketchPlaneData,
} from './buildSketch.ts';

/**
 * Canonical bases for the three default planes. Each {u, v, n} triad is
 * right-handed (u × v = n), so sketch coordinates read unmirrored from the
 * +normal side, where the sketch camera sits. Must match the editor's
 * `planeConfigFromName` in `SketchSceneManager.ts`.
 */
export const DEFAULT_PLANES = {
  XY: {
    name: 'XY' as const,
    origin: [0, 0, 0] as [number, number, number],
    uAxis: [1, 0, 0] as [number, number, number],
    vAxis: [0, 1, 0] as [number, number, number],
    normal: [0, 0, 1] as [number, number, number],
  },
  XZ: {
    name: 'XZ' as const,
    origin: [0, 0, 0] as [number, number, number],
    uAxis: [1, 0, 0] as [number, number, number],
    vAxis: [0, 0, -1] as [number, number, number],
    normal: [0, 1, 0] as [number, number, number],
  },
  YZ: {
    name: 'YZ' as const,
    origin: [0, 0, 0] as [number, number, number],
    uAxis: [0, 0, -1] as [number, number, number],
    vAxis: [0, 1, 0] as [number, number, number],
    normal: [1, 0, 0] as [number, number, number],
  },
} satisfies Record<'XY' | 'XZ' | 'YZ', ResolvedSketchPlaneData>;

/**
 * Resolve a {@link PlaneRef} to a concrete plane basis.
 *
 *  - `defaultPlane`         → straight lookup in {@link DEFAULT_PLANES}.
 *  - `constructionPlane`    → consume the upstream feature's resolved
 *                              plane from `context.featureOutputs`.
 *                              Requires that the construction-plane
 *                              feature appears earlier in the timeline
 *                              (the rebuilder enforces this by walking
 *                              the timeline in order).
 *  - `featureOutput`        → not yet supported; reserved for the case
 *                              where a face or other feature publishes
 *                              a derived plane.
 *  - `stableTopology`       → a body face; needs the kernel, so it is
 *                              resolved by {@link resolvePlaneRefAsync}
 *                              and this sync resolver throws.
 *
 * Errors are thrown rather than returned so the rebuilder's
 * try/catch reports the feature as failed.
 */
export function resolvePlaneRef(
  ref: PlaneRef,
  context: BuildContext,
  _params: ResolvedParams,
): ResolvedSketchPlaneData {
  if (ref.type === 'defaultPlane') {
    return DEFAULT_PLANES[ref.name];
  }

  if (ref.type === 'constructionPlane') {
    // `planeId` is the FeatureId of the construction-plane feature.
    const outputs = context.featureOutputs.get(ref.planeId as never);
    const plane = outputs?.data?.plane as ResolvedSketchPlaneData | undefined;
    if (!plane) {
      throw new Error(
        `Construction plane ${ref.planeId} has no resolved plane output ` +
        `— it may be later in the timeline than this feature, or its build failed.`,
      );
    }
    return plane;
  }

  if (ref.type === 'featureOutput') {
    throw new Error(
      `PlaneRef.featureOutput is not yet supported (feature=${ref.featureId} output=${ref.output})`,
    );
  }

  // stableTopology — caller must use `resolvePlaneRefAsync` instead so a
  // kernel handle is available for `getFacePlane`. Throw here to make
  // accidental sync calls visible at the call site rather than silently
  // returning a fallback.
  throw new Error(
    `PlaneRef.stableTopology cannot be resolved synchronously; use resolvePlaneRefAsync`,
  );
}

/**
 * Resolve any {@link PlaneRef}, including a body face. A face must be
 * planar; `role` names what the plane is for ("Sketch face", "Extrude
 * start face", ...) so a face that no longer resolves fails the feature
 * with a message saying which reference broke.
 *
 * A face resolves to its own plane: origin at the face centroid, normal
 * outward. Builders that need a sketch frame use {@link resolveSketchPlaneRef}.
 */
export async function resolvePlaneRefAsync(
  ref: PlaneRef,
  context: BuildContext,
  params: ResolvedParams,
  kernel: CadKernel,
  role: string,
): Promise<ResolvedSketchPlaneData> {
  if (ref.type !== 'stableTopology') return resolvePlaneRef(ref, context, params);
  const face = await resolveFacePlane(ref, context, kernel, role);
  if (!face.planar) {
    throw new Error(`${role} ${ref.stableFaceId} is not planar; pick a flat face`);
  }
  return {
    name: nearestDefaultPlaneName(face.normal),
    origin: face.origin,
    uAxis: face.uAxis,
    vAxis: face.vAxis,
    normal: face.normal,
  };
}

/**
 * Resolve a sketch's plane. Default and construction planes resolve as in
 * {@link resolvePlaneRef}; a body face resolves to the face's current plane
 * with the frame from {@link sketchFrameOnPlane} — the same function the
 * editor uses on sketch entry, so both agree on the sketch's 2D axes.
 */
export async function resolveSketchPlaneRef(
  ref: PlaneRef,
  context: BuildContext,
  params: ResolvedParams,
  kernel: CadKernel,
): Promise<ResolvedSketchPlaneData> {
  if (ref.type !== 'stableTopology') return resolvePlaneRef(ref, context, params);
  const plane = await resolvePlaneRefAsync(ref, context, params, kernel, 'Sketch face');
  const frame = sketchFrameOnPlane(plane.normal, plane.origin);
  return { name: plane.name, ...frame };
}

async function resolveFacePlane(
  ref: Extract<PlaneRef, { type: 'stableTopology' }>,
  context: BuildContext,
  kernel: CadKernel,
  role: string,
): ReturnType<CadKernel['getFacePlane']> {
  const bodyHandle = context.bodies.get(ref.bodyRef.bodyId);
  if (!bodyHandle) {
    throw new Error(
      `${role} ${ref.stableFaceId}: body ${ref.bodyRef.bodyId} does not exist at this point in the timeline`,
    );
  }
  const face = ref.repairHint !== undefined
    ? await kernel.resolveFaceRef(bodyHandle as KernelBody, ref.stableFaceId, ref.repairHint)
    : await kernel.resolveFaceRef(bodyHandle as KernelBody, ref.stableFaceId);
  if (!face) {
    throw new Error(
      `${role} ${ref.stableFaceId} no longer exists on body ${ref.bodyRef.bodyId}; ` +
      `an upstream change removed it. Pick the face again.`,
    );
  }
  return kernel.getFacePlane(face);
}

/**
 * Resolve a {@link FaceRef} to a `ResolvedSketchPlaneData` by extracting
 * the face's tangent plane through the kernel. Async because the kernel
 * call is async; otherwise identical contract to {@link resolvePlaneRef}.
 *
 * Used by `buildConstructionPlane` (offsetFromFace mode), and reserved
 * for use by the future Hole builder when it resolves
 * `HoleFeatureInputs.face` to a centroid + normal.
 */
export async function resolveFacePlaneRef(
  ref: FaceRef,
  context: BuildContext,
  params: ResolvedParams,
  kernel: CadKernel,
): Promise<ResolvedSketchPlaneData> {
  if (ref.type === 'defaultPlane') {
    // No kernel call needed — same as the sync resolver.
    return resolvePlaneRef({ type: 'defaultPlane', name: ref.name }, context, params);
  }

  if (ref.type === 'constructionPlane') {
    // Construction planes don't have a body — read the cached plane.
    return resolvePlaneRef(
      { type: 'constructionPlane', planeId: ref.planeId },
      context,
      params,
    );
  }

  if (ref.type === 'stableTopology') {
    const bodyHandle = context.bodies.get(ref.bodyRef.bodyId);
    if (!bodyHandle) {
      throw new Error(
        `FaceRef.stableTopology: target body ${ref.bodyRef.bodyId} not in build context`,
      );
    }
    const repairHint = ref.repairHint;
    const face = repairHint !== undefined
      ? await kernel.resolveFaceRef(bodyHandle as KernelBody, ref.stableFaceId, repairHint)
      : await kernel.resolveFaceRef(bodyHandle as KernelBody, ref.stableFaceId);
    if (!face) {
      throw new Error(
        `FaceRef.stableTopology: could not resolve face ${ref.stableFaceId} on body ${ref.bodyRef.bodyId}`,
      );
    }
    const facePlane = await kernel.getFacePlane(face);
    return {
      name: 'XY', // arbitrary — the editor only uses this for grid orientation
      origin: facePlane.origin,
      uAxis: facePlane.uAxis,
      vAxis: facePlane.vAxis,
      normal: facePlane.normal,
    };
  }

  throw new Error(`FaceRef.featureOutput is not yet supported (feature=${ref.featureId})`);
}

/**
 * Helper: evaluate a single Expression into a number, throwing on
 * failure. Used by builders that take Expression inputs (offset,
 * distance, radius, etc.) and want to keep the call-site one-liner.
 */
export function evalNumberOrThrow(
  expr: string,
  params: ResolvedParams,
  context: string,
): number {
  const r = evaluateExpression(expr, params);
  if (!r.ok) {
    throw new Error(`Failed to evaluate ${context}: ${r.error}`);
  }
  return r.value;
}

/**
 * Offset a resolved plane along its normal by `signedDistance` mm. Returns
 * a new plane with the same axes; only the origin moves.
 */
export function offsetPlaneAlongNormal(
  plane: ResolvedSketchPlaneData,
  signedDistance: number,
): ResolvedSketchPlaneData {
  return {
    name: plane.name,
    origin: [
      plane.origin[0] + plane.normal[0] * signedDistance,
      plane.origin[1] + plane.normal[1] * signedDistance,
      plane.origin[2] + plane.normal[2] * signedDistance,
    ],
    uAxis: plane.uAxis,
    vAxis: plane.vAxis,
    normal: plane.normal,
  };
}

/**
 * Mirror Body feature builder.
 *
 * Resolves the source body + mirror plane, calls `kernel.mirror`, and
 * (for `operation === 'join'`) fuses the reflected copy back with the
 * source to produce a single symmetric body.
 *
 * Pipeline per rebuild:
 *   1. Resolve `inputs.sourceBody.bodyId` from `context.bodies`. If
 *      missing, the build fails — the source feature may have failed
 *      earlier in the timeline.
 *   2. Resolve `inputs.plane` via `resolvePlaneRef` (default planes +
 *      construction planes today; face-as-plane once that resolver path
 *      grows). The resolver returns origin + outward normal — exactly
 *      what OCCT's `gp_Ax2`-based mirror needs.
 *   3. Call `kernel.mirror(body, plane)` — the kernel wraps OCCT's
 *      `BRepBuilderAPI_Transform` via `mirrorWithHistory` so stable
 *      face/edge IDs on the reflected copy derive from the source body
 *      via per-face history mapping.
 *   4. For `operation === 'join'`, fuse the mirror back with the source.
 *      The resulting body reuses the source `bodyId` so downstream
 *      features that reference it keep working without re-binding
 *      (matches the Hole builder's body-replacement convention).
 *      For `operation === 'newBody'`, the mirror is published under a
 *      fresh deterministic id (`body_${node.id}_0`) and the source
 *      stays untouched in the build context.
 *
 * Topology naming: every kernel op forwards a tag derived from
 * `node.id` to the topology tracker. Same op on the same source body
 * across rebuilds produces the same stable ids — user-captured FaceRef
 * / EdgeRef on the mirror survive subsequent edits.
 *
 * The overall shape is a mirror-then-optional-fuse composition, scoped
 * to a single source body.
 */

import type {
  FeatureNode,
  MirrorFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, ResolvedPlane } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { resolvePlaneRef } from './resolvePlane.ts';

export async function buildMirror(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as MirrorFeatureInputs;

  // 1. Resolve source body. `bodyId` is the registry key; the live
  // KernelBody handle is what the kernel op consumes.
  if (!inputs.sourceBody?.bodyId) {
    throw new Error('Mirror requires sourceBody.bodyId');
  }
  const sourceBodyId = inputs.sourceBody.bodyId;
  const sourceHandle = context.bodies.get(sourceBodyId as BodyId);
  if (!sourceHandle) {
    throw new Error(
      `Mirror source body ${sourceBodyId} not in build context — ` +
      `the upstream feature that produced it may have failed.`,
    );
  }
  const sourceBody = sourceHandle as KernelBody;

  // 2. Resolve the mirror plane. resolvePlaneRef yields {origin, uAxis,
  // vAxis, normal}; the kernel only uses origin + normal for the
  // mirror transform, but we adapt to the kernel's ResolvedPlane shape
  // (which expects xDir as well, derived from uAxis).
  const planeData = resolvePlaneRef(inputs.plane, context, params);
  const resolvedPlane: ResolvedPlane = {
    origin: planeData.origin,
    normal: planeData.normal,
    xDir: planeData.uAxis,
  };

  // 3. Mirror.
  const mirrorResult = await kernel.mirror(sourceBody, resolvedPlane);
  if (!mirrorResult.ok) {
    throw new Error(`Mirror failed: ${mirrorResult.error.message}`);
  }
  const mirroredBody = mirrorResult.value;

  // 4. Optional join: fuse the mirror back into the source body so the
  // result is a single symmetric solid (the most common "model one
  // half, mirror to whole" workflow). The fuse consumes the source
  // body's id (matches Hole's in-place modification convention) so
  // downstream features that reference it keep working.
  if (inputs.operation === 'join') {
    const fuseResult = await kernel.booleanFuse([sourceBody, mirroredBody]);
    if (!fuseResult.ok) {
      throw new Error(`Mirror join (fuse) failed: ${fuseResult.error.message}`);
    }
    // Drop the source body from the context — the fused body replaces
    // it. Reuse the source bodyId so downstream refs survive.
    context.bodies.delete(sourceBodyId as BodyId);
    const resultBodyId = sourceBodyId;
    return {
      bodies: [{ bodyId: bodyIdBrand(String(resultBodyId)), handle: fuseResult.value }],
      outputs: {
        bodies: { main: bodyIdBrand(String(resultBodyId)) } as Record<string, BodyId>,
      },
    };
  }

  // newBody mode: source stays in the context (do NOT delete it), the
  // mirror is published under a fresh deterministic id derived from
  // the feature so user-captured FaceRefs on the mirror survive.
  const newBodyId = bodyIdBrand(`body_${node.id}_0`);
  return {
    bodies: [{ bodyId: newBodyId, handle: mirroredBody }],
    outputs: {
      bodies: { main: newBodyId },
    },
  };
}

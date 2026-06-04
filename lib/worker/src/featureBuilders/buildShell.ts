/**
 * Shell feature builder.
 *
 * Hollows the source body to a uniform wall thickness, leaving the
 * listed faces open so the cavity opens through them. This is the
 * standard "shell" / wall-thickness operation.
 *
 * Pipeline per rebuild:
 *   1. Resolve source body from `context.bodies` via `inputs.sourceBody.bodyId`.
 *   2. Validate that every `removedFaces[i]` is a `stableTopology`
 *      FaceRef referencing the same body. Mixed-body / default-plane /
 *      construction-plane refs are rejected — Shell operates on
 *      *body* faces only.
 *   3. Resolve each FaceRef to a runtime KernelFace via
 *      `kernel.resolveFaceRef` (topology-naming layer).
 *   4. Evaluate the user-entered thickness expression and *negate* it
 *      before passing to OCCT so the wall grows inward (the default
 *      direction). Schema stores thickness as a positive number; if a
 *      future "outward shell" toggle lands, it can flip the sign here.
 *   5. Call `kernel.shell(body, faces, -thickness, tolerance)`. The
 *      kernel routes this through `shellWithHistory` for per-face
 *      evolution.
 *   6. Reuse the source bodyId on the result so downstream features
 *      that reference the body keep working without re-binding (same
 *      in-place-modification convention as Hole / Mirror join mode).
 */

import type {
  FeatureNode,
  ShellFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, KernelFace } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';

export async function buildShell(
  node: FeatureNode,
  params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as ShellFeatureInputs;

  // 1. Source body.
  if (!inputs.sourceBody?.bodyId) {
    throw new Error('Shell requires sourceBody');
  }
  const sourceBodyId = inputs.sourceBody.bodyId;
  const sourceHandle = context.bodies.get(sourceBodyId as BodyId);
  if (!sourceHandle) {
    throw new Error(
      `Shell source body ${sourceBodyId} not in build context — ` +
      `the upstream feature that produced it may have failed.`,
    );
  }
  const body = sourceHandle as KernelBody;

  // 2. Validate removed-faces input. At least one; all stableTopology;
  // all reference the same body as sourceBody.
  const faceRefs = Array.isArray(inputs.removedFaces) ? inputs.removedFaces : [];
  if (faceRefs.length === 0) {
    throw new Error('Shell requires at least one face to remove');
  }
  for (const ref of faceRefs) {
    if (ref.type !== 'stableTopology') {
      throw new Error(
        `Shell removedFaces only support stableTopology FaceRefs (got ${ref.type}) — ` +
        `pick faces on the source body, not datum planes.`,
      );
    }
    if (String(ref.bodyRef.bodyId) !== String(sourceBodyId)) {
      throw new Error(
        `Shell removedFaces must all belong to the source body. ` +
        `Saw ${ref.bodyRef.bodyId} but source is ${sourceBodyId}.`,
      );
    }
  }

  // 3. Resolve each FaceRef. The topology-naming layer hands back the
  // current-rebuild KernelFace handle so user-captured face IDs
  // survive upstream edits.
  const faces: KernelFace[] = [];
  for (let i = 0; i < faceRefs.length; i++) {
    const ref = faceRefs[i]!;
    if (ref.type !== 'stableTopology') continue; // validated above
    const repairHint = ref.repairHint;
    const resolved = repairHint !== undefined
      ? await kernel.resolveFaceRef(body, ref.stableFaceId, repairHint)
      : await kernel.resolveFaceRef(body, ref.stableFaceId);
    if (!resolved) {
      throw new Error(
        `Shell face #${i + 1}: could not resolve stable face id ${ref.stableFaceId} on body ${sourceBodyId}`,
      );
    }
    faces.push(resolved);
  }

  // 4. Thickness. Evaluated, validated positive, then negated before
  // passing to OCCT so the shell wall grows inward (the default
  // direction). A future `direction: 'inward' | 'outward'`
  // toggle can sit here without a schema change.
  const thicknessResult = evaluateExpression(inputs.thickness, params);
  if (!thicknessResult.ok) {
    throw new Error(`Failed to resolve shell thickness: ${thicknessResult.error}`);
  }
  if (thicknessResult.value <= 0) {
    throw new Error(`Shell thickness must be positive (got ${thicknessResult.value})`);
  }
  const occtThickness = -thicknessResult.value; // inward
  const tolerance = inputs.tolerance ?? 1e-3;

  // 5. Kernel call. The kernel routes through shellWithHistory and
  // propagates stable IDs through `storeBodyWithHistory`.
  const shellResult = await kernel.shell(body, faces, occtThickness, tolerance);
  if (!shellResult.ok) {
    throw new Error(`Shell failed: ${shellResult.error.message}`);
  }

  // 6. In-place body replacement: drop the source body from the
  // context (so the rebuilder's diff sees it as consumed) and publish
  // the shelled body under the SAME bodyId so downstream features
  // keep their refs working — same convention as Hole.
  context.bodies.delete(sourceBodyId as BodyId);
  return {
    bodies: [{ bodyId: bodyIdBrand(String(sourceBodyId)), handle: shellResult.value }],
    outputs: {
      bodies: { main: bodyIdBrand(String(sourceBodyId)) } as Record<string, BodyId>,
    },
  };
}

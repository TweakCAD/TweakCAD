/**
 * Standalone boolean feature — combine bodies that already exist.
 *
 * Extrude, revolve and the rest each carry an `operation` that subtracts or
 * fuses *as they create*. What none of them can express is combining two
 * bodies that are both already there — two imports, two primitives, an
 * extrude and a component — because neither is being created at the moment
 * the combination is wanted.
 *
 * **The result carries the target's id.** A boolean modifies the target in
 * place as far as the user is concerned: it is still "the part", with
 * material added or removed. Minting a fresh id would invalidate every stored
 * `BodyRef` and `FaceRef` pointing at it (see `bodyIdentity.ts`). Tool bodies
 * are consumed and their ids retire.
 */

import type { FeatureNode, BooleanFeatureInputs, BodyRef } from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { carryBodyId } from './bodyIdentity.ts';

export async function buildBoolean(
  node: FeatureNode,
  _params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as BooleanFeatureInputs;

  const targetId = String(inputs.targetBody?.bodyId ?? '') as BodyId;
  const target = context.bodies.get(targetId) as KernelBody | undefined;
  if (!target) {
    throw new Error(
      `Boolean target "${targetId}" is not in the build — the feature that ` +
      `made it may have failed or been deleted`,
    );
  }

  // Tools that no longer resolve are dropped rather than fatal: deleting one
  // of three tools upstream should leave a boolean that does less, not a
  // second error to clear. Losing *every* tool is different — then the
  // feature has nothing to say and silently passing the target through would
  // hide that.
  const tools: { id: BodyId; handle: KernelBody }[] = [];
  for (const ref of inputs.toolBodies ?? []) {
    const id = String((ref as BodyRef).bodyId) as BodyId;
    if (id === targetId) continue; // combining a body with itself is a no-op
    const handle = context.bodies.get(id) as KernelBody | undefined;
    if (handle) tools.push({ id, handle });
  }
  if (tools.length === 0) {
    throw new Error(
      `Boolean has no tool bodies left — all of them are missing from the build`,
    );
  }

  const toolHandles = tools.map(t => t.handle);
  const result = inputs.operation === 'union'
    ? await kernel.booleanFuse([target, ...toolHandles], node.id)
    : inputs.operation === 'subtract'
      ? await kernel.booleanCut(target, toolHandles, node.id)
      : await kernel.booleanIntersect([target, ...toolHandles], node.id);

  if (!result.ok) {
    throw new Error(`Boolean ${inputs.operation} failed: ${result.error.message}`);
  }

  // Consume the tools. The target is replaced by its own id below, so it does
  // not need deleting first.
  for (const tool of tools) context.bodies.delete(tool.id);

  const bodyId = carryBodyId(targetId);
  return {
    bodies: [{ bodyId, handle: result.value }],
    outputs: { bodies: { main: bodyId } },
  };
}

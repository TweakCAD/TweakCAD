/**
 * Move feature builder — repositions existing bodies in the timeline.
 *
 * The only builder that produces no new geometry. It takes bodies the
 * timeline has already made and applies a rigid transform to them, which is
 * how a derived body (extrude output, a boolean result) gets a placement at
 * all: unlike an import or a component, it has no `transform` field of its
 * own to store one in.
 *
 * **The moved bodies keep their ids.** A move is a modifier in the sense of
 * `bodyIdentity.ts` — it is the same body, somewhere else — so a `BodyRef` or
 * a `FaceRef` captured before the move still resolves after it, and inserting
 * a move upstream of a fillet does not break the fillet's stored edges. The
 * transform is rigid, so OCCT carries the stable face/edge ids across it by
 * hash-match.
 */

import type { FeatureNode, MoveFeatureInputs, BodyRef } from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { Transform3D } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { carryBodyId } from './bodyIdentity.ts';

export async function buildMove(
  node: FeatureNode,
  _params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as MoveFeatureInputs;
  const refs = inputs.targetBodies ?? [];

  if (refs.length === 0) {
    throw new Error('Move has no target bodies — pick a body to move');
  }

  // An identity move is legal and common: the user opened Move, dragged, and
  // dragged back. Doing nothing beats deriving a copy of every target.
  if (isIdentity(inputs.transform)) {
    return { bodies: [] };
  }

  const moved: { bodyId: BodyId; handle: KernelBody }[] = [];
  for (const ref of refs) {
    const id = String(ref.bodyId) as BodyId;
    const handle = context.bodies.get(id) as KernelBody | undefined;
    // A ref that no longer resolves is skipped, not fatal. Deleting the
    // extrude upstream of a move should leave the move with nothing to do,
    // not turn it into a second error the user has to clear.
    if (!handle) continue;

    const result = await kernel.transform(handle, inputs.transform, node.id);
    if (!result.ok) {
      throw new Error(`Move failed for ${id}: ${result.error.message}`);
    }
    // Same body, new place — carry the id so downstream refs survive.
    moved.push({ bodyId: carryBodyId(id), handle: result.value });
  }

  if (moved.length === 0) {
    throw new Error(
      `Move has ${refs.length} target${refs.length === 1 ? '' : 's'} but none of them exist — ` +
      `the feature that made them may have failed or been deleted`,
    );
  }

  // Only the moved bodies are returned. The rebuilder merges them back into
  // the context by id, so untouched bodies stay exactly as they were.
  return {
    bodies: moved,
    outputs: {
      bodies: Object.fromEntries(
        moved.map((b, i) => [i === 0 ? 'main' : `body_${i}`, b.bodyId]),
      ) as Record<string, BodyId>,
    },
  };
}

/** Skip the kernel for a move that does not move anything. */
function isIdentity(t: Transform3D | undefined): boolean {
  if (!t) return true;
  const [px, py, pz] = t.position;
  const [rx, ry, rz, rw] = t.rotation;
  return px === 0 && py === 0 && pz === 0 && rx === 0 && ry === 0 && rz === 0 && rw === 1;
}

/** Whether a move already targets exactly this set of bodies. */
export function targetsExactly(inputs: MoveFeatureInputs, bodyIds: readonly string[]): boolean {
  const have = new Set((inputs.targetBodies ?? []).map((r: BodyRef) => String(r.bodyId)));
  return have.size === bodyIds.length && bodyIds.every(id => have.has(id));
}

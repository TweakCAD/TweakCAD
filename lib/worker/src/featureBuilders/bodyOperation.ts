/**
 * Join and cut for features that create a solid and combine it with the
 * bodies already in the part (extrude, primitive, revolve, loft).
 *
 * **Without picked targets, only bodies the new solid meets take part.** Join
 * fuses each tool solid with the bodies it touches or overlaps; a body it does
 * not reach is left alone, and a tool that reaches no body becomes a new body.
 * Picked `targetBodies` are fused as picked: one body, even where the tool
 * misses them. Cut removes the tool from every candidate (picked or not) it
 * overlaps and fails when that removes nothing.
 *
 * Identity follows `bodyIdentity.ts`: a joined group carries its primary
 * target's id (the first candidate in the group), a cut body carries its own,
 * consumed bodies retire.
 */

import type { BodyRef } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { carryBodyId } from './bodyIdentity.ts';

/** Bodies closer than this (mm) count as touching. */
const TOUCH_TOLERANCE_MM = 1e-6;

/** A cut that changes a body's volume by less than this (mm³) removed nothing. */
const MIN_REMOVED_VOLUME_MM3 = 1e-6;

export type EmittedBody = { bodyId: BodyId; handle: KernelBody };

/**
 * The bodies join/cut may act on: the `targetBodies` list in its order when
 * set, else every body in the build in insertion order. Refs that no longer
 * resolve are dropped.
 */
export function selectTargetCandidates(
  refs: readonly BodyRef[] | undefined,
  context: BuildContext,
): [BodyId, KernelBody][] {
  const all = Array.from(context.bodies.entries()) as [BodyId, KernelBody][];
  if (!refs || refs.length === 0) return all;
  const byId = new Map(all.map(entry => [String(entry[0]), entry]));
  const picked: [BodyId, KernelBody][] = [];
  for (const ref of refs) {
    const entry = byId.get(String(ref.bodyId));
    if (entry && !picked.includes(entry)) picked.push(entry);
  }
  return picked;
}

async function touches(kernel: CadKernel, a: KernelBody, b: KernelBody): Promise<boolean> {
  return (await kernel.distanceBetween(a, b)) <= TOUCH_TOLERANCE_MM;
}

/**
 * Fuse the tools into the candidates. With `explicitTargets`, every tool and
 * candidate becomes one body. Otherwise tools and candidates are grouped by
 * contact (a tool touching two bodies merges them; two touching tools go
 * together), each group with a candidate becomes one body, and tools in
 * groups with no candidate go to `newBodies`.
 *
 * Joined bodies come first, in candidate order, then the new ones.
 *
 * All or nothing: the consumed candidates leave the build context only once
 * every group has fused (see {@link commitConsumed}).
 */
export async function joinTouchingBodies(opts: {
  tools: KernelBody[];
  candidates: [BodyId, KernelBody][];
  context: BuildContext;
  kernel: CadKernel;
  explicitTargets: boolean;
  newBodies: (tools: KernelBody[]) => Promise<EmittedBody[]>;
}): Promise<EmittedBody[]> {
  const { tools, candidates, context, kernel } = opts;
  if (candidates.length === 0) return opts.newBodies(tools);
  if (opts.explicitTargets) {
    const group = await fuseGroup(candidates, tools, kernel);
    commitConsumed(context, group.consumed);
    return [group.body];
  }
  const n = tools.length;

  // Union-find over tools (0..n-1) then candidates (n..n+m-1).
  const parent = Array.from({ length: n + candidates.length }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (await touches(kernel, tools[i]!, tools[j]!)) union(i, j);
    }
    for (let j = 0; j < candidates.length; j++) {
      if (await touches(kernel, tools[i]!, candidates[j]![1])) union(i, n + j);
    }
  }

  const groups = new Map<number, { targets: number[]; tools: number[] }>();
  for (let i = 0; i < n + candidates.length; i++) {
    const root = find(i);
    const group = groups.get(root) ?? { targets: [], tools: [] };
    if (i < n) group.tools.push(i);
    else group.targets.push(i - n);
    groups.set(root, group);
  }

  const joined: { order: number; body: EmittedBody }[] = [];
  const consumed: BodyId[] = [];
  const floating: KernelBody[] = [];
  try {
    for (const group of groups.values()) {
      if (group.tools.length === 0) continue; // a candidate no tool reached
      if (group.targets.length === 0) {
        for (const t of group.tools) floating.push(tools[t]!);
        continue;
      }
      const fused = await fuseGroup(
        group.targets.map(j => candidates[j]!),
        group.tools.map(t => tools[t]!),
        kernel,
      );
      joined.push({ order: group.targets[0]!, body: fused.body });
      consumed.push(...fused.consumed);
    }
    joined.sort((a, b) => a.order - b.order);
    const created = floating.length > 0 ? await opts.newBodies(floating) : [];
    commitConsumed(context, consumed);
    return [...joined.map(j => j.body), ...created];
  } catch (error) {
    release(kernel, joined.map(j => j.body.handle));
    throw error;
  }
}

/**
 * Fuse targets and tools into one body carrying the first target's id. The
 * targets are reported as consumed, not removed: the caller commits once
 * every group has fused.
 */
async function fuseGroup(
  targets: [BodyId, KernelBody][],
  tools: KernelBody[],
  kernel: CadKernel,
): Promise<{ body: EmittedBody; consumed: BodyId[] }> {
  const fused = await kernel.booleanFuse([...targets.map(([, h]) => h), ...tools]);
  if (!fused.ok) throw new Error(`Join failed: ${fused.error.message}`);
  return {
    body: { bodyId: carryBodyId(targets[0]![0]), handle: fused.value },
    consumed: targets.map(([id]) => id),
  };
}

/**
 * Remove the bodies an operation consumed from the build context — only after
 * the whole operation has succeeded. Removing each one as its boolean
 * finished meant a later boolean's failure left the earlier bodies gone: the
 * feature reported failed, and the bodies it never finished changing vanished
 * from the model. The rebuilder frees the consumed shapes once the feature
 * succeeds, by finding their ids gone from the context.
 */
function commitConsumed(context: BuildContext, consumed: readonly BodyId[]): void {
  for (const id of consumed) context.bodies.delete(id);
}

/** Free result shapes an operation produced but will not return. */
function release(kernel: CadKernel, handles: readonly KernelBody[]): void {
  for (const handle of handles) {
    try {
      kernel.dispose(handle);
    } catch (e) {
      console.warn('[bodyOperation] Failed to release an unused result:', e);
    }
  }
}

/**
 * Cut the tools from every candidate they overlap. A candidate the tools only
 * touch, or that loses no volume, is left unchanged. Throws when no candidate
 * loses material.
 *
 * All or nothing: the cut candidates leave the build context only once every
 * cut has succeeded (see {@link commitConsumed}).
 */
export async function cutTouchingBodies(opts: {
  tools: KernelBody[];
  candidates: [BodyId, KernelBody][];
  context: BuildContext;
  kernel: CadKernel;
  explicitTargets: boolean;
}): Promise<EmittedBody[]> {
  const { tools, candidates, context, kernel } = opts;
  const out: EmittedBody[] = [];
  const consumed: BodyId[] = [];
  // Every result shape made so far, so a failure can free them all — including
  // one whose volume check is still running.
  const produced: KernelBody[] = [];
  try {
    for (const [id, handle] of candidates) {
      const reaching: KernelBody[] = [];
      for (const tool of tools) {
        if (await touches(kernel, tool, handle)) reaching.push(tool);
      }
      if (reaching.length === 0) continue;

      const cut = await kernel.booleanCut(handle, reaching);
      if (!cut.ok) throw new Error(`Cut failed: ${cut.error.message}`);
      produced.push(cut.value);
      if (kernel.getMassProperties) {
        const before = (await kernel.getMassProperties(handle)).volume;
        const after = (await kernel.getMassProperties(cut.value)).volume;
        if (before - after < MIN_REMOVED_VOLUME_MM3) {
          // The body stays as it was; the unchanged copy is not used.
          produced.pop();
          release(kernel, [cut.value]);
          continue;
        }
      }
      consumed.push(id);
      out.push({ bodyId: carryBodyId(id), handle: cut.value });
    }
    if (out.length === 0) {
      throw new Error(
        opts.explicitTargets
          ? 'Cut removes nothing: it does not overlap any of the target bodies'
          : 'Cut removes nothing: it does not overlap any body',
      );
    }
  } catch (error) {
    release(kernel, produced);
    throw error;
  }
  commitConsumed(context, consumed);
  return out;
}

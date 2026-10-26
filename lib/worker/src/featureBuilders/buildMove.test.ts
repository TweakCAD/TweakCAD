/**
 * buildMove — the only builder that produces no new geometry.
 *
 * Two properties carry the weight:
 *   1. Moved bodies keep their ids. A move is the same body somewhere else,
 *      so a `BodyRef` or `FaceRef` captured before it still resolves after.
 *      Minting fresh ids here would break every stored reference the moment
 *      someone nudged a body — the exact failure the body-identity rule in
 *      `bodyIdentity.ts` exists to prevent.
 *   2. Bodies it does not target are left alone, including when a target ref
 *      has gone stale.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildMove, targetsExactly } from './buildMove.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { FeatureNode, MoveFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import { featureId, bodyId, partId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const A = bodyId('body_extrude_1_0');
const B = bodyId('body_extrude_2_0');
const NO_PARAMS = {} as ResolvedParams;

const SHIFT = {
  position: [10, 0, 5] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};

function context(): BuildContext {
  const ctx = emptyBuildContext(NO_PARAMS);
  ctx.bodies.set(A, { handle: 'h_a', source: 'mock' });
  ctx.bodies.set(B, { handle: 'h_b', source: 'mock' });
  return ctx;
}

function node(overrides: Partial<MoveFeatureInputs> = {}): FeatureNode {
  const inputs: MoveFeatureInputs = {
    targetBodies: [{ partId: PART, bodyId: A }],
    transform: SHIFT,
    ...overrides,
  };
  return {
    id: featureId('move_1'),
    type: 'move',
    name: 'Move 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
  };
}

async function kernel(): Promise<MockKernel> {
  const k = new MockKernel();
  await k.init();
  return k;
}

describe('buildMove', () => {
  it('keeps the body id so earlier references survive the move', async () => {
    const k = await kernel();
    const result = await buildMove(node(), NO_PARAMS, context(), k);
    expect(result.bodies).toHaveLength(1);
    expect(String(result.bodies[0]!.bodyId)).toBe(String(A));
  });

  it('applies the transform to the kernel once per target', async () => {
    const k = await kernel();
    const spy = vi.spyOn(k, 'transform');
    await buildMove(
      node({ targetBodies: [{ partId: PART, bodyId: A }, { partId: PART, bodyId: B }] }),
      NO_PARAMS, context(), k,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(c => c[1])).toEqual([SHIFT, SHIFT]);
  });

  it('returns only the moved bodies, leaving the rest to the rebuilder', async () => {
    // The runner merges returned bodies into the context by id. Returning
    // untargeted bodies too would re-register them under the same ids for no
    // reason; returning nothing for them leaves them exactly as they were.
    const k = await kernel();
    const result = await buildMove(node(), NO_PARAMS, context(), k);
    expect(result.bodies.map(b => String(b.bodyId))).toEqual([String(A)]);
  });

  it('does nothing at all for an identity transform', async () => {
    // A Move session the user dragged and dragged back. Deriving a copy of
    // every target to put it where it already is helps nobody.
    const k = await kernel();
    const spy = vi.spyOn(k, 'transform');
    const result = await buildMove(
      node({ transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] } }),
      NO_PARAMS, context(), k,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.bodies).toEqual([]);
  });

  it('skips a stale ref but still moves the ones that resolve', async () => {
    const k = await kernel();
    const result = await buildMove(
      node({
        targetBodies: [
          { partId: PART, bodyId: bodyId('body_deleted') },
          { partId: PART, bodyId: B },
        ],
      }),
      NO_PARAMS, context(), k,
    );
    expect(result.bodies.map(b => String(b.bodyId))).toEqual([String(B)]);
  });

  it('fails with a diagnosis when every target has gone', async () => {
    // Distinct from "no targets": the user did pick bodies, and the feature
    // that made them is the thing that broke.
    const k = await kernel();
    await expect(buildMove(
      node({ targetBodies: [{ partId: PART, bodyId: bodyId('body_gone') }] }),
      NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
    )).rejects.toThrow(/none of them exist/);
  });

  it('fails when nothing was picked', async () => {
    const k = await kernel();
    await expect(
      buildMove(node({ targetBodies: [] }), NO_PARAMS, context(), k),
    ).rejects.toThrow(/no target bodies/);
  });

  it('surfaces a kernel failure naming the body', async () => {
    const k = await kernel();
    vi.spyOn(k, 'transform').mockResolvedValue(
      err({ category: 'kernel', code: 'TRANSFORM_FAILED', message: 'bad matrix' }),
    );
    await expect(buildMove(node(), NO_PARAMS, context(), k))
      .rejects.toThrow(new RegExp(`Move failed for ${A}: bad matrix`));
  });
});

describe('targetsExactly', () => {
  // Used by the Move session to decide whether to reuse the trailing move
  // feature or append another, so that nudging one body repeatedly leaves one
  // feature in the timeline rather than a dozen.
  const inputs = (ids: string[]): MoveFeatureInputs => ({
    targetBodies: ids.map(id => ({ partId: PART, bodyId: bodyId(id) })),
    transform: SHIFT,
  });

  it('matches the same set regardless of order', () => {
    expect(targetsExactly(inputs(['a', 'b']), ['b', 'a'])).toBe(true);
  });

  it('rejects a subset and a superset', () => {
    expect(targetsExactly(inputs(['a', 'b']), ['a'])).toBe(false);
    expect(targetsExactly(inputs(['a']), ['a', 'b'])).toBe(false);
  });

  it('rejects a disjoint set of the same size', () => {
    expect(targetsExactly(inputs(['a']), ['b'])).toBe(false);
  });
});

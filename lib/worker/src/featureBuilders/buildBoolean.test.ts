/**
 * buildBoolean — combining bodies that already exist.
 *
 * The property that carries the weight is body identity: a boolean modifies
 * the target in place as far as the user is concerned, so the result keeps
 * the target's id and a `FaceRef` captured before it still resolves after.
 * Tools are consumed. Getting that backwards would break every stored
 * reference the moment anyone combined two bodies.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildBoolean } from './buildBoolean.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { FeatureNode, BooleanFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import { featureId, bodyId, partId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const TARGET = bodyId('body_a');
const TOOL = bodyId('body_b');
const OTHER = bodyId('body_c');
const NO_PARAMS = {} as ResolvedParams;

function context(): BuildContext {
  const ctx = emptyBuildContext(NO_PARAMS);
  ctx.bodies.set(TARGET, { handle: 'h_a', source: 'mock' });
  ctx.bodies.set(TOOL, { handle: 'h_b', source: 'mock' });
  ctx.bodies.set(OTHER, { handle: 'h_c', source: 'mock' });
  return ctx;
}

function node(overrides: Partial<BooleanFeatureInputs> = {}): FeatureNode {
  const inputs: BooleanFeatureInputs = {
    operation: 'subtract',
    targetBody: { partId: PART, bodyId: TARGET },
    toolBodies: [{ partId: PART, bodyId: TOOL }],
    ...overrides,
  };
  return {
    id: featureId('bool_1'),
    type: 'boolean',
    name: 'Cut 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

async function kernel(): Promise<MockKernel> {
  const k = new MockKernel();
  await k.init();
  return k;
}

describe('buildBoolean — operations', () => {
  it('subtract cuts the tools from the target', async () => {
    const k = await kernel();
    const cut = vi.spyOn(k, 'booleanCut');
    await buildBoolean(node(), NO_PARAMS, context(), k);
    expect(cut).toHaveBeenCalledTimes(1);
    expect(cut.mock.calls[0]?.[1]).toHaveLength(1);
  });

  it('union fuses target and tools together', async () => {
    const k = await kernel();
    const fuse = vi.spyOn(k, 'booleanFuse');
    await buildBoolean(node({ operation: 'union' }), NO_PARAMS, context(), k);
    // Target first — it is the one whose identity survives.
    expect(fuse.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('intersect keeps the overlap', async () => {
    const k = await kernel();
    const intersect = vi.spyOn(k, 'booleanIntersect');
    await buildBoolean(node({ operation: 'intersect' }), NO_PARAMS, context(), k);
    expect(intersect).toHaveBeenCalledTimes(1);
  });

  it('takes several tools at once', async () => {
    const k = await kernel();
    const cut = vi.spyOn(k, 'booleanCut');
    await buildBoolean(
      node({ toolBodies: [{ partId: PART, bodyId: TOOL }, { partId: PART, bodyId: OTHER }] }),
      NO_PARAMS, context(), k,
    );
    expect(cut.mock.calls[0]?.[1]).toHaveLength(2);
  });
});

describe('buildBoolean — identity', () => {
  it('the result keeps the target id, so earlier references survive', async () => {
    const k = await kernel();
    const result = await buildBoolean(node(), NO_PARAMS, context(), k);
    expect(String(result.bodies[0]!.bodyId)).toBe(String(TARGET));
  });

  it('consumes the tools', async () => {
    const k = await kernel();
    const ctx = context();
    await buildBoolean(node(), NO_PARAMS, ctx, k);
    expect(ctx.bodies.has(TOOL)).toBe(false);
    // Untouched bodies stay.
    expect(ctx.bodies.has(OTHER)).toBe(true);
  });
});

describe('buildBoolean — degenerate input', () => {
  it('fails when the target is gone', async () => {
    const k = await kernel();
    await expect(buildBoolean(
      node({ targetBody: { partId: PART, bodyId: bodyId('body_gone') } }),
      NO_PARAMS, context(), k,
    )).rejects.toThrow(/is not in the build/);
  });

  it('drops a stale tool but still runs with the ones that resolve', async () => {
    const k = await kernel();
    const cut = vi.spyOn(k, 'booleanCut');
    await buildBoolean(
      node({
        toolBodies: [
          { partId: PART, bodyId: bodyId('body_gone') },
          { partId: PART, bodyId: TOOL },
        ],
      }),
      NO_PARAMS, context(), k,
    );
    expect(cut.mock.calls[0]?.[1]).toHaveLength(1);
  });

  it('fails when every tool has gone, rather than passing the target through', async () => {
    // Silently emitting the untouched target would make a broken feature look
    // like one that simply did nothing.
    const k = await kernel();
    await expect(buildBoolean(
      node({ toolBodies: [{ partId: PART, bodyId: bodyId('body_gone') }] }),
      NO_PARAMS, context(), k,
    )).rejects.toThrow(/no tool bodies left/);
  });

  it('ignores a tool that is the target itself', async () => {
    const k = await kernel();
    await expect(buildBoolean(
      node({ toolBodies: [{ partId: PART, bodyId: TARGET }] }),
      NO_PARAMS, context(), k,
    )).rejects.toThrow(/no tool bodies left/);
  });

  it('surfaces a kernel failure naming the operation', async () => {
    const k = await kernel();
    vi.spyOn(k, 'booleanCut').mockResolvedValue(
      err({ category: 'geometry', code: 'CUT_FAILED', message: 'tools do not touch' }),
    );
    await expect(buildBoolean(node(), NO_PARAMS, context(), k))
      .rejects.toThrow(/Boolean subtract failed: tools do not touch/);
  });
});

/**
 * buildFillet builder tests with MockKernel.
 *
 * Validates the stable-edge resolution path and the all-edges-same-body
 * guard. The MockKernel returns deterministic fake handles for resolveEdgeRef
 * and fillet so we can run in node without OCCT.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildFillet } from './buildFillet.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  FilletFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import {
  featureId,
  bodyId,
  stableEdgeId,
  partId,
} from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const BODY = bodyId('body_a');
const OTHER_BODY = bodyId('body_b');

function makeContextWithOneBody(): BuildContext {
  const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
  ctx.bodies.set(BODY, { handle: 'mock_body_a', source: 'mock' });
  return ctx;
}

/**
 * Make a kernel where resolveEdgeRef returns a fake KernelEdge handle for
 * every stable id (mirrors a healthy topology-naming path). Tests that
 * specifically want a resolve failure override this.
 */
async function makeKernelWithResolvers() {
  const kernel = new MockKernel();
  await kernel.init();
  vi.spyOn(kernel, 'resolveEdgeRef').mockImplementation(async (_b, sid) => ({
    handle: `mock_edge_${String(sid)}`,
    bodyHandle: 'mock_body_a',
  }));
  return kernel;
}

function makeFilletNode(overrides: Partial<FilletFeatureInputs> = {}): FeatureNode {
  const inputs: FilletFeatureInputs = {
    edges: [
      { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableEdgeId: stableEdgeId('e_001') },
      { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableEdgeId: stableEdgeId('e_002') },
    ],
    radius: '2',
    ...overrides,
  };
  return {
    id: featureId('fillet_1'),
    type: 'fillet',
    name: 'Fillet 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  };
}

describe('buildFillet', () => {
  it('resolves stable edge refs and calls kernel.fillet with the right args', async () => {
    const kernel = await makeKernelWithResolvers();
    const resolveSpy = vi.spyOn(kernel, 'resolveEdgeRef');
    const filletSpy = vi.spyOn(kernel, 'fillet');

    const ctx = makeContextWithOneBody();
    const node = makeFilletNode();

    const result = await buildFillet(node, {} as ResolvedParams, ctx, kernel);

    expect(result.bodies).toHaveLength(1);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(filletSpy).toHaveBeenCalledTimes(1);
    const [, edgesArg, radiusArg] = filletSpy.mock.calls[0]!;
    expect(edgesArg).toHaveLength(2);
    expect(radiusArg).toBe(2);
  });

  it('removes the old body from the build context so the rebuilder sees it as consumed', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeFilletNode();

    expect(ctx.bodies.has(BODY)).toBe(true);
    const result = await buildFillet(node, {} as ResolvedParams, ctx, kernel);

    expect(ctx.bodies.has(BODY)).toBe(false);
    // The new body is added by the rebuilder, not the builder, so it's not
    // in ctx.bodies yet — only the result records it.
    expect(result.bodies[0]?.handle).toMatchObject({ source: 'mock' });
  });

  it('throws when no edges are supplied', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeFilletNode({ edges: [] });

    await expect(
      buildFillet(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/at least one edge/);
  });

  it('throws when edges reference different bodies', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeFilletNode({
      edges: [
        { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableEdgeId: stableEdgeId('e_001') },
        { type: 'stableTopology', bodyRef: { partId: PART, bodyId: OTHER_BODY }, stableEdgeId: stableEdgeId('e_999') },
      ],
    });

    await expect(
      buildFillet(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/must all belong to the same body/);
  });

  it('throws when radius is zero or negative', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeFilletNode({ radius: '0' });

    await expect(
      buildFillet(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/radius must be positive/);
  });

  it('throws when an edge fails to resolve via the topology layer', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    // Force resolveEdgeRef to return null (simulates a topology mismatch).
    vi.spyOn(kernel, 'resolveEdgeRef').mockResolvedValue(null);

    const ctx = makeContextWithOneBody();
    const node = makeFilletNode();

    await expect(
      buildFillet(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/could not resolve stable edge id/);
  });

  it('throws when the target body is not present in the build context', async () => {
    const kernel = await makeKernelWithResolvers();
    // Empty context — no bodies registered.
    const ctx = emptyBuildContext({} as ResolvedParams);
    const node = makeFilletNode();

    await expect(
      buildFillet(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/not present in build context/);
  });
});

/**
 * buildChamfer builder tests with MockKernel.
 *
 * Mirrors buildFillet.test.ts case-for-case. The validation paths
 * (no edges, mixed-body refs, missing body, negative distance, resolve
 * failure) are intentionally identical so any regression in the
 * topology-naming path surfaces in both suites.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildChamfer } from './buildChamfer.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  ChamferFeatureInputs,
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

async function makeKernelWithResolvers() {
  const kernel = new MockKernel();
  await kernel.init();
  vi.spyOn(kernel, 'resolveEdgeRef').mockImplementation(async (_b, sid) => ({
    handle: `mock_edge_${String(sid)}`,
    bodyHandle: 'mock_body_a',
  }));
  return kernel;
}

function makeChamferNode(overrides: Partial<ChamferFeatureInputs> = {}): FeatureNode {
  const inputs: ChamferFeatureInputs = {
    edges: [
      { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableEdgeId: stableEdgeId('e_001') },
      { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableEdgeId: stableEdgeId('e_002') },
    ],
    distance: '1.5',
    ...overrides,
  };
  return {
    id: featureId('chamfer_1'),
    type: 'chamfer',
    name: 'Chamfer 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

describe('buildChamfer', () => {
  it('resolves stable edge refs and calls kernel.chamfer with the right args', async () => {
    const kernel = await makeKernelWithResolvers();
    const resolveSpy = vi.spyOn(kernel, 'resolveEdgeRef');
    const chamferSpy = vi.spyOn(kernel, 'chamfer');

    const ctx = makeContextWithOneBody();
    const node = makeChamferNode();

    const result = await buildChamfer(node, {} as ResolvedParams, ctx, kernel);

    expect(result.bodies).toHaveLength(1);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(chamferSpy).toHaveBeenCalledTimes(1);
    const [, edgesArg, distArg] = chamferSpy.mock.calls[0]!;
    expect(edgesArg).toHaveLength(2);
    expect(distArg).toBe(1.5);
  });

  it('removes the old body from the build context so the rebuilder sees it as consumed', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeChamferNode();

    expect(ctx.bodies.has(BODY)).toBe(true);
    const result = await buildChamfer(node, {} as ResolvedParams, ctx, kernel);

    expect(ctx.bodies.has(BODY)).toBe(false);
    expect(result.bodies[0]?.handle).toMatchObject({ source: 'mock' });
  });

  it('throws when no edges are supplied', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeChamferNode({ edges: [] });

    await expect(
      buildChamfer(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/at least one edge/);
  });

  it('throws when edges reference different bodies', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeChamferNode({
      edges: [
        { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableEdgeId: stableEdgeId('e_001') },
        { type: 'stableTopology', bodyRef: { partId: PART, bodyId: OTHER_BODY }, stableEdgeId: stableEdgeId('e_999') },
      ],
    });

    await expect(
      buildChamfer(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/must all belong to the same body/);
  });

  it('throws when distance is zero or negative', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = makeContextWithOneBody();
    const node = makeChamferNode({ distance: '0' });

    await expect(
      buildChamfer(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/distance must be positive/);
  });

  it('throws when an edge fails to resolve via the topology layer', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'resolveEdgeRef').mockResolvedValue(null);

    const ctx = makeContextWithOneBody();
    const node = makeChamferNode();

    await expect(
      buildChamfer(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/could not resolve stable edge id/);
  });

  it('throws when the target body is not present in the build context', async () => {
    const kernel = await makeKernelWithResolvers();
    const ctx = emptyBuildContext({} as ResolvedParams);
    const node = makeChamferNode();

    await expect(
      buildChamfer(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/not present in build context/);
  });
});

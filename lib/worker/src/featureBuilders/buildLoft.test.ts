/**
 * buildLoft builder tests with MockKernel.
 *
 * Validates the cross-sketch resolution path and the validation guards
 * (≥2 profiles required, ruled/closed flags passed through).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildLoft } from './buildLoft.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  LoftFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { featureId, entityId } from '@tweakcad/core/src/ids.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const SKETCH_A = featureId('sketch_a');
const SKETCH_B = featureId('sketch_b');
const CIRCLE_A = entityId('circle_a');
const CIRCLE_B = entityId('circle_b');

function makeContextWithTwoCircleSketches(): BuildContext {
  const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);

  const regionA: SketchRegion = {
    id: 'region_a',
    label: 'Circle A',
    type: 'circle',
    entityIds: [CIRCLE_A],
    allEntityIds: [CIRCLE_A],
    segments: [],
    vertices: [],
    center: [0, 0],
    area: Math.PI * 25,
  };
  const regionB: SketchRegion = {
    id: 'region_b',
    label: 'Circle B',
    type: 'circle',
    entityIds: [CIRCLE_B],
    allEntityIds: [CIRCLE_B],
    segments: [],
    vertices: [],
    center: [0, 0],
    area: Math.PI * 100,
  };

  ctx.featureOutputs.set(SKETCH_A, {
    data: {
      resolvedRegions: { [regionA.id]: regionA },
      resolvedEntities: {
        [CIRCLE_A]: { type: 'circle', center: [0, 0], diameter: 10 },
      },
      plane: {
        name: 'XZ',
        origin: [0, 0, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 0, 1],
        normal: [0, 1, 0],
      },
    },
  });

  // SKETCH_B placed at y=50 (parallel plane shifted along normal). Plane
  // origin shift makes the resulting loft a real frustum if it were OCCT.
  ctx.featureOutputs.set(SKETCH_B, {
    data: {
      resolvedRegions: { [regionB.id]: regionB },
      resolvedEntities: {
        [CIRCLE_B]: { type: 'circle', center: [0, 0], diameter: 20 },
      },
      plane: {
        name: 'XZ',
        origin: [0, 50, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 0, 1],
        normal: [0, 1, 0],
      },
    },
  });

  return ctx;
}

function makeLoftNode(overrides: Partial<LoftFeatureInputs> = {}): FeatureNode {
  const inputs: LoftFeatureInputs = {
    profiles: [
      { sketchId: SKETCH_A, wireEntityIds: [CIRCLE_A] },
      { sketchId: SKETCH_B, wireEntityIds: [CIRCLE_B] },
    ],
    operation: 'newBody',
    ...overrides,
  };
  return {
    id: featureId('loft_1'),
    type: 'loft',
    name: 'Loft 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [SKETCH_A, SKETCH_B],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  };
}

describe('buildLoft', () => {
  it('lofts across two sketches and produces a single body', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const loftSpy = vi.spyOn(kernel, 'loft');
    const ctx = makeContextWithTwoCircleSketches();
    const node = makeLoftNode();

    const result = await buildLoft(node, {} as ResolvedParams, ctx, kernel);

    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]?.handle).toMatchObject({ source: 'mock' });
    expect(loftSpy).toHaveBeenCalledTimes(1);
    const [faces, opts] = loftSpy.mock.calls[0]!;
    expect(faces).toHaveLength(2);
    expect(opts).toEqual({});
  });

  it('passes ruled + closed flags through to the kernel', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const loftSpy = vi.spyOn(kernel, 'loft');
    const ctx = makeContextWithTwoCircleSketches();
    const node = makeLoftNode({ ruled: true, closed: true });

    await buildLoft(node, {} as ResolvedParams, ctx, kernel);

    const [, opts] = loftSpy.mock.calls[0]!;
    expect(opts).toEqual({ ruled: true, closed: true });
  });

  it('rejects fewer than 2 profiles', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeContextWithTwoCircleSketches();
    const node = makeLoftNode({
      profiles: [{ sketchId: SKETCH_A, wireEntityIds: [CIRCLE_A] }],
    });

    await expect(
      buildLoft(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/at least 2 profiles/);
  });

  it('rejects more than 16 profiles', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeContextWithTwoCircleSketches();
    const tooMany = Array.from({ length: 17 }, () => ({
      sketchId: SKETCH_A,
      wireEntityIds: [CIRCLE_A],
    }));
    const node = makeLoftNode({ profiles: tooMany });

    await expect(
      buildLoft(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/at most 16 profiles/);
  });

  it('throws when a profile references a sketch with no output', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeContextWithTwoCircleSketches();
    const node = makeLoftNode({
      profiles: [
        { sketchId: SKETCH_A, wireEntityIds: [CIRCLE_A] },
        { sketchId: featureId('sketch_missing'), wireEntityIds: [entityId('?')] },
      ],
    });

    await expect(
      buildLoft(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/failed to resolve/);
  });
});

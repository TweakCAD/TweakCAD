/**
 * buildRevolve builder tests.
 *
 * Uses MockKernel so we can run in Node without WASM. The mock returns
 * deterministic fake handles; we assert the builder calls the right
 * kernel method (revolve) with the right arguments parsed from the
 * feature node's inputs.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildRevolve } from './buildRevolve.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  RevolveFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { featureId, entityId } from '@tweakcad/core/src/ids.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const SKETCH_ID = featureId('sketch_1');
const RECT_ENTITY_ID = entityId('rect_base');

function makeContextWithRectangleSketch(): BuildContext {
  const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
  const region: SketchRegion = {
    id: 'region_rect',
    label: 'Rectangle',
    type: 'polygon',
    entityIds: [RECT_ENTITY_ID],
    allEntityIds: [RECT_ENTITY_ID],
    segments: [],
    // 10x6 rectangle centered at sketch (20, 0): far enough from the Z axis
    // that the revolved volume is non-degenerate.
    vertices: [
      [15, -3],
      [25, -3],
      [25, 3],
      [15, 3],
    ],
    center: [20, 0],
    area: 60,
  };
  ctx.featureOutputs.set(SKETCH_ID, {
    data: {
      resolvedRegions: { [region.id]: region },
      // No `resolvedEntities` rectangle entry — task F retired the
      // rectangle fast path in buildRevolve. The region builds via the
      // general polygon path using `region.vertices` above.
      resolvedEntities: {},
      plane: {
        name: 'XZ',
        origin: [0, 0, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 0, 1],
        normal: [0, 1, 0],
      },
    },
  });
  return ctx;
}

function makeRevolveNode(overrides: Partial<RevolveFeatureInputs> = {}): FeatureNode {
  const inputs: RevolveFeatureInputs = {
    profile: { sketchId: SKETCH_ID, wireEntityIds: [RECT_ENTITY_ID] },
    axis: { type: 'z' },
    angle: '360',
    operation: 'newBody',
    ...overrides,
  };
  return {
    id: featureId('revolve_1'),
    type: 'revolve',
    name: 'Revolve 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [SKETCH_ID],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  };
}

describe('buildRevolve', () => {
  it('produces a single body for a rectangle profile + Z axis', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeContextWithRectangleSketch();
    const node = makeRevolveNode();

    const result = await buildRevolve(node, {} as ResolvedParams, ctx, kernel);

    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]?.handle).toMatchObject({ source: 'mock' });
    expect(result.outputs?.bodies).toMatchObject({ main: expect.any(String) });
  });

  it('converts the angle from degrees to radians before calling the kernel', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const revolveSpy = vi.spyOn(kernel, 'revolve');
    const ctx = makeContextWithRectangleSketch();
    const node = makeRevolveNode({ angle: '180' });

    await buildRevolve(node, {} as ResolvedParams, ctx, kernel);

    expect(revolveSpy).toHaveBeenCalledTimes(1);
    const [, axis, angleRad] = revolveSpy.mock.calls[0]!;
    expect(angleRad).toBeCloseTo(Math.PI, 6);
    expect(axis).toEqual({ origin: [0, 0, 0], direction: [0, 0, 1] });
  });

  it('resolves a custom axis spec to its raw origin + direction', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const revolveSpy = vi.spyOn(kernel, 'revolve');
    const ctx = makeContextWithRectangleSketch();
    const node = makeRevolveNode({
      axis: { type: 'custom', origin: [10, 0, 0], direction: [0, 1, 0] },
    });

    await buildRevolve(node, {} as ResolvedParams, ctx, kernel);

    const [, axis] = revolveSpy.mock.calls[0]!;
    expect(axis).toEqual({ origin: [10, 0, 0], direction: [0, 1, 0] });
  });

  it('throws when the sketch output is missing', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = emptyBuildContext({} as ResolvedParams); // no sketch outputs registered
    const node = makeRevolveNode();

    await expect(
      buildRevolve(node, {} as ResolvedParams, ctx, kernel),
    ).rejects.toThrow(/Could not resolve revolve profile/);
  });
});

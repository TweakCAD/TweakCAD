/**
 * buildSweep builder tests with MockKernel.
 *
 * Covers the validation guards and the kernel.sweep call shape:
 *  - Missing profile / path.
 *  - Profile sketch not in context.
 *  - Profile sketch has no detected regions.
 *  - Happy path: kernel.sweep called with (profileFace, pathFace, origin).
 *  - Result published under a fresh deterministic id.
 *
 * Note: this builder is tested with mocked sketch outputs (the
 * `featureOutputs` map of the BuildContext carries
 * `resolvedRegions`). The real sketch builder populates that map at
 * runtime; here we synthesize a minimal region by hand to drive
 * resolveProfile through the closed-region path.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildSweep } from './buildSweep.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  SweepFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import { featureId, entityId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';

/**
 * Build a fake "single circle region" for a sketch. Enough geometric
 * data to keep resolveProfile + regionToKernelProfile happy.
 */
function makeFakeCircleRegion(): SketchRegion {
  const cid = entityId('c1');
  return {
    id: 'r1',
    label: 'circle r1',
    type: 'circle',
    entityIds: [cid],
    allEntityIds: [cid],
    center: [0, 0],
    vertices: [],
    segments: [],
    area: 100,
  };
}

/**
 * Stuff a sketch's outputs into the build context so resolveProfile
 * can find its regions, and regionToKernelProfile can find its
 * `resolvedEntities` (for the circle entity diameter).
 */
function seedSketchOutputs(ctx: BuildContext, sketchId: string): void {
  ctx.featureOutputs.set(featureId(sketchId), {
    bodies: {},
    data: {
      resolvedRegions: { r1: makeFakeCircleRegion() },
      resolvedEntities: {
        c1: { type: 'circle', center: [0, 0], diameter: 10 },
      },
      plane: {
        name: 'XZ' as const,
        origin: [0, 0, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 0, 1],
        normal: [0, 1, 0],
      },
    },
  });
}

function makeSweepNode(overrides: Partial<SweepFeatureInputs> = {}): FeatureNode {
  const inputs: SweepFeatureInputs = {
    profile: { sketchId: featureId('sketch_profile'), wireEntityIds: [] },
    path: { sketchId: featureId('sketch_path'), wireEntityIds: [] },
    operation: 'newBody',
    ...overrides,
  };
  return {
    id: featureId('sweep_1'),
    type: 'sweep',
    name: 'Sweep 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

describe('buildSweep', () => {
  it('throws when profile is missing', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeSweepNode();
    (node.inputs as { profile?: unknown }).profile = undefined;
    await expect(buildSweep(node, {} as ResolvedParams, emptyBuildContext({} as ResolvedParams), kernel))
      .rejects.toThrow(/requires a profile/);
  });

  it('throws when path is missing', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeSweepNode();
    (node.inputs as { path?: unknown }).path = undefined;
    await expect(buildSweep(node, {} as ResolvedParams, emptyBuildContext({} as ResolvedParams), kernel))
      .rejects.toThrow(/requires a path/);
  });

  it('throws when profile sketch output is missing', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = emptyBuildContext({} as ResolvedParams);
    // Only seed the PATH sketch; profile sketch absent.
    seedSketchOutputs(ctx, 'sketch_path');
    await expect(buildSweep(makeSweepNode(), {} as ResolvedParams, ctx, kernel))
      .rejects.toThrow(/Sweep profile: sketch output not found/);
  });

  it('throws when profile resolution fails (no regions detected)', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = emptyBuildContext({} as ResolvedParams);
    // Seed both sketches, but blank out resolvedRegions on the
    // profile one so resolveProfile fails.
    seedSketchOutputs(ctx, 'sketch_profile');
    seedSketchOutputs(ctx, 'sketch_path');
    const profileOutputs = ctx.featureOutputs.get(featureId('sketch_profile'));
    if (profileOutputs?.data) profileOutputs.data['resolvedRegions'] = {};
    await expect(buildSweep(makeSweepNode(), {} as ResolvedParams, ctx, kernel))
      .rejects.toThrow(/profile did not match a closed region/);
  });

  it('calls kernel.sweep with profile face, path face, and feature-derived origin', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const sweepSpy = vi.spyOn(kernel, 'sweep');
    const ctx = emptyBuildContext({} as ResolvedParams);
    seedSketchOutputs(ctx, 'sketch_profile');
    seedSketchOutputs(ctx, 'sketch_path');

    await buildSweep(makeSweepNode(), {} as ResolvedParams, ctx, kernel);

    expect(sweepSpy).toHaveBeenCalledTimes(1);
    const [profileArg, pathArg, originArg] = sweepSpy.mock.calls[0]!;
    // Both faces are fresh mock handles, distinct from each other.
    expect(profileArg.handle).not.toBe(pathArg.handle);
    expect(originArg).toBe('sweep_sweep_1');
  });

  it('publishes the swept body under a deterministic id', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = emptyBuildContext({} as ResolvedParams);
    seedSketchOutputs(ctx, 'sketch_profile');
    seedSketchOutputs(ctx, 'sketch_path');

    const result = await buildSweep(makeSweepNode(), {} as ResolvedParams, ctx, kernel);

    expect(result.bodies).toHaveLength(1);
    expect(String(result.bodies[0]!.bodyId)).toBe('body_sweep_1_0');
    expect(result.outputs?.bodies?.main).toBe(result.bodies[0]!.bodyId);
  });

  it('propagates kernel.sweep failure as a build error', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'sweep').mockResolvedValue(
      err({ category: 'kernel', code: 'SWEEP_FAILED', message: 'profile/path normal mismatch' }),
    );
    const ctx = emptyBuildContext({} as ResolvedParams);
    seedSketchOutputs(ctx, 'sketch_profile');
    seedSketchOutputs(ctx, 'sketch_path');

    await expect(buildSweep(makeSweepNode(), {} as ResolvedParams, ctx, kernel))
      .rejects.toThrow(/Sweep failed: profile\/path normal mismatch/);
  });
});

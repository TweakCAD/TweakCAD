/**
 * buildExtrude on nested loops, against the real occt-wasm kernel: an r=4
 * boss circle around an r=2 insert circle in one sketch.
 *
 *  - The ring (`[outer]` or `[outer, inner]`) extrudes as a washer: four
 *    faces (two annular caps, outer and inner walls), no extra face.
 *  - Ring + inner disc fills the hole: a plain cylinder with three faces,
 *    not two bodies fused with a seam circle on each cap.
 */
import { sketchInputs } from '@tweakcad/testing/src/sketchFixtures.ts';
import { describe, expect, it } from 'vitest';
import { buildExtrude } from './buildExtrude.ts';
import { buildSketch } from './buildSketch.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { FINE_TESSELLATION } from '@tweakcad/kernel/src/types.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { FeatureNode, ProfileRef } from '@tweakcad/core/src/document/schema.ts';
import { featureId, entityId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const SKETCH_ID = featureId('sketch_boss');
const HEIGHT = 5;

function node(id: string, type: 'sketch' | 'extrude', inputs: unknown, dependsOn: string[]): FeatureNode {
  return {
    id: featureId(id),
    type,
    name: id,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as Record<string, unknown>,
    dependsOn: dependsOn.map(featureId),
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
  };
}

async function extrudeBoss(wires: string[][]): Promise<{ kernel: OcctKernel; body: KernelBody; count: number }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const context: BuildContext = emptyBuildContext({} as ResolvedParams);
  const sketch = node('sketch_boss', 'sketch', sketchInputs({
    circles: [
      { id: 'outer', center: [0, 0], diameter: 8 },
      { id: 'inner', center: [0, 0], diameter: 4 },
    ],
  }), []);
  const sketchResult = await buildSketch(sketch, {}, context, kernel);
  context.featureOutputs.set(sketch.id, sketchResult.outputs!);

  const profiles: ProfileRef[] = wires.map(ids => ({
    sketchId: SKETCH_ID,
    wireEntityIds: ids.map(entityId),
  }));
  const extrude = node('ex_boss', 'extrude', {
    profiles,
    operation: 'newBody',
    direction: { type: 'normal' },
    extent: { type: 'distance', value: String(HEIGHT) },
  }, ['sketch_boss']);
  const result = await buildExtrude(extrude, {}, context, kernel);
  return { kernel, body: result.bodies[0]!.handle as KernelBody, count: result.bodies.length };
}

async function faceCount(kernel: OcctKernel, body: KernelBody): Promise<number> {
  await kernel.tessellate(body, FINE_TESSELLATION);
  return (await kernel.getTopology(body)).faces.length;
}

const ringVolume = Math.PI * (16 - 4) * HEIGHT;
const discVolume = Math.PI * 16 * HEIGHT;

describe('buildExtrude — nested circles (real kernel)', () => {
  it('[outer] extrudes the ring: a clean washer', async () => {
    const { kernel, body, count } = await extrudeBoss([['outer']]);
    expect(count).toBe(1);
    expect((await kernel.getMassProperties(body)).volume).toBeCloseTo(ringVolume, 3);
    expect(await faceCount(kernel, body)).toBe(4);
  });

  it('[outer, inner] names the same ring', async () => {
    const { kernel, body } = await extrudeBoss([['outer', 'inner']]);
    expect((await kernel.getMassProperties(body)).volume).toBeCloseTo(ringVolume, 3);
    expect(await faceCount(kernel, body)).toBe(4);
  });

  it('[inner] alone extrudes just the insert disc', async () => {
    const { kernel, body } = await extrudeBoss([['inner']]);
    expect((await kernel.getMassProperties(body)).volume).toBeCloseTo(Math.PI * 4 * HEIGHT, 3);
    expect(await faceCount(kernel, body)).toBe(3);
  });

  it('ring + inner disc fills the hole: one cylinder, no seam faces', async () => {
    const { kernel, body, count } = await extrudeBoss([['outer'], ['inner']]);
    expect(count).toBe(1);
    expect((await kernel.getMassProperties(body)).volume).toBeCloseTo(discVolume, 3);
    expect(await faceCount(kernel, body)).toBe(3);
  });
});

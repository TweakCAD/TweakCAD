/**
 * buildRevolve join/cut target selection, against the real occt-wasm kernel.
 *
 * Same contract as extrude (see `bodyOperation.ts`): without `targetBodies`,
 * join fuses only the bodies the revolved solid touches and cut removes
 * material only from the bodies it overlaps. Joined and cut bodies keep their
 * id, consumed bodies leave the build, and bodies it does not reach keep their
 * handle.
 *
 * Layout (Z up): a 20 mm cube `box` centred on the Z axis at z 0..20 and a
 * 20 mm cube `lid` above it at z 40..60. The tool is a torus around the Z
 * axis, revolved from a circle on the XZ sketch plane. With its centre circle
 * on a cube face, exactly half of it lies inside the cube.
 */
import { sketchInputs } from '@tweakcad/testing/src/sketchFixtures.ts';
import { describe, expect, it } from 'vitest';
import { buildRevolve } from './buildRevolve.ts';
import { buildSketch } from './buildSketch.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BodyRef, FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { featureId, entityId, bodyId } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const BOX = bodyId('box');
const LID = bodyId('lid');
const CUBE = 20 ** 3;

/** Torus volume for major radius `R` and minor radius `r`. */
const torus = (R: number, r: number) => 2 * Math.PI ** 2 * R * r ** 2;

function node(id: string, type: 'sketch' | 'revolve', inputs: unknown, dependsOn: string[]): FeatureNode {
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

async function cube(kernel: OcctKernel, z: number): Promise<KernelBody> {
  const r = await kernel.makeBox({ origin: [-10, -10, z], width: 20, height: 20, depth: 20 });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function setup(): Promise<{ kernel: OcctKernel; context: BuildContext }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const context = emptyBuildContext({} as ResolvedParams);
  context.bodies.set(BOX, await cube(kernel, 0));
  context.bodies.set(LID, await cube(kernel, 40));
  return { kernel, context };
}

/**
 * Revolve a circle of radius `r` 360° around the Z axis: a torus of major
 * radius `R` whose centre circle lies at height `z`.
 */
async function revolve(
  kernel: OcctKernel,
  context: BuildContext,
  opts: {
    R: number;
    r: number;
    z: number;
    operation: 'join' | 'cut';
    targetBodies?: BodyRef[];
  },
) {
  const sketch = node('sk', 'sketch', sketchInputs({
    plane: { type: 'defaultPlane', name: 'XZ' },
    // XZ's sketch y is world -Z, so height z sits at sketch y = -z.
    circles: [{ id: 'c', center: [opts.R, -opts.z], diameter: 2 * opts.r }],
  }), []);
  const sketchResult = await buildSketch(sketch, {}, context, kernel);
  context.featureOutputs.set(sketch.id, sketchResult.outputs!);
  const rev = node('rev', 'revolve', {
    profile: { sketchId: featureId('sk'), wireEntityIds: [entityId('c')] },
    axis: { type: 'z' },
    angle: '360',
    operation: opts.operation,
    ...(opts.targetBodies ? { targetBodies: opts.targetBodies } : {}),
  }, ['sk']);
  const result = await buildRevolve(rev, {}, context, kernel);
  for (const b of result.bodies) context.bodies.set(b.bodyId, b.handle);
  return result;
}

async function volume(kernel: OcctKernel, context: BuildContext, id: BodyId): Promise<number> {
  const handle = context.bodies.get(id) as KernelBody | undefined;
  if (!handle) throw new Error(`no body ${id}`);
  return (await kernel.getMassProperties(handle)).volume;
}

describe('buildRevolve — join targets only the bodies it touches (real kernel)', () => {
  it('a ring on the box joins the box and leaves the floating lid alone', async () => {
    const { kernel, context } = await setup();
    const lid = context.bodies.get(LID);
    const result = await revolve(kernel, context, { R: 5, r: 2, z: 20, operation: 'join' });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box']);
    expect(result.outputs?.bodies).toEqual({ main: BOX });
    expect([...context.bodies.keys()].map(String).sort()).toEqual(['box', 'lid']);
    expect(context.bodies.get(LID)).toBe(lid);
    expect(await volume(kernel, context, BOX)).toBeCloseTo(CUBE + torus(5, 2) / 2, 1);
  });

  it('a ring bridging box and lid merges the two into the box', async () => {
    const { kernel, context } = await setup();
    const result = await revolve(kernel, context, { R: 12, r: 11, z: 30, operation: 'join' });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box']);
    expect([...context.bodies.keys()].map(String)).toEqual(['box']);
    expect(await volume(kernel, context, BOX)).toBeGreaterThan(2 * CUBE);
  });

  it('a join that touches nothing creates a new body and leaves every existing body as is', async () => {
    const { kernel, context } = await setup();
    const before = new Map(context.bodies);
    const result = await revolve(kernel, context, { R: 50, r: 2, z: 10, operation: 'join' });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['body_rev_0']);
    for (const [id, handle] of before) expect(context.bodies.get(id)).toBe(handle);
    expect(await volume(kernel, context, bodyId('body_rev_0'))).toBeCloseTo(torus(50, 2), 1);
  });

  it('picked targetBodies are fused as picked, and unpicked bodies it touches are left alone', async () => {
    // The ring touches the box, but only the lid is picked.
    const { kernel, context } = await setup();
    const box0 = context.bodies.get(BOX);
    const result = await revolve(kernel, context, {
      R: 5, r: 2, z: 20, operation: 'join',
      targetBodies: [{ partId: 'p1' as never, bodyId: LID }],
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['lid']);
    expect(context.bodies.get(BOX)).toBe(box0);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE + torus(5, 2), 1);
  });
});

describe('buildRevolve — cut targets only the bodies it overlaps (real kernel)', () => {
  it('cuts the body it overlaps even when it is not first in the build', async () => {
    const { kernel, context } = await setup();
    const box0 = context.bodies.get(BOX);
    const result = await revolve(kernel, context, { R: 5, r: 2, z: 60, operation: 'cut' });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['lid']);
    expect([...context.bodies.keys()].map(String).sort()).toEqual(['box', 'lid']);
    expect(context.bodies.get(BOX)).toBe(box0);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE - torus(5, 2) / 2, 1);
  });

  it('cuts every body it passes through, each keeping its id', async () => {
    const { kernel, context } = await setup();
    const result = await revolve(kernel, context, { R: 12, r: 11, z: 30, operation: 'cut' });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box', 'lid']);
    expect(await volume(kernel, context, BOX)).toBeLessThan(CUBE - 1);
    expect(await volume(kernel, context, LID)).toBeLessThan(CUBE - 1);
  });

  it('fails when the cut removes nothing', async () => {
    const { kernel, context } = await setup();
    await expect(revolve(kernel, context, { R: 5, r: 2, z: 30, operation: 'cut' }))
      .rejects.toThrow(/Cut removes nothing/);
  });
});

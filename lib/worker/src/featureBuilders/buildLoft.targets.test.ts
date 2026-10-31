/**
 * buildLoft join/cut target selection, against the real occt-wasm kernel.
 *
 * Same contract as extrude (see `bodyOperation.ts`): without `targetBodies`,
 * join fuses only the bodies the loft touches and cut removes material only
 * from the bodies it overlaps. Joined and cut bodies keep their id, consumed
 * bodies leave the build, and bodies it does not reach keep their handle.
 *
 * Layout (Z up): a 20 mm cube `box` at z 0..20 and a 20 mm cube `lid`
 * floating at z 40..60. The tool lofts two equal circles on XY-parallel
 * sections, so it is a cylinder.
 */
import { describe, expect, it } from 'vitest';
import { buildLoft } from './buildLoft.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BodyRef, FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { featureId, entityId, bodyId } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { SketchRegion } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const BOX = bodyId('box');
const LID = bodyId('lid');
const CUBE = 20 ** 3;

const cylinder = (d: number, h: number) => Math.PI * (d / 2) ** 2 * h;

async function box(kernel: OcctKernel, origin: [number, number, number]): Promise<KernelBody> {
  const r = await kernel.makeBox({ origin, width: 20, height: 20, depth: 20 });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function setup(): Promise<{ kernel: OcctKernel; context: BuildContext }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const context = emptyBuildContext({} as ResolvedParams);
  context.bodies.set(BOX, await box(kernel, [0, 0, 0]));
  context.bodies.set(LID, await box(kernel, [0, 0, 40]));
  return { kernel, context };
}

/** Publish a sketch holding one circle on the XY plane raised to height `z`. */
function section(context: BuildContext, sketch: string, center: [number, number], z: number, diameter: number) {
  const circle = entityId(`${sketch}_c`);
  const region: SketchRegion = {
    id: `${sketch}_region`,
    label: 'Circle',
    type: 'circle',
    entityIds: [circle],
    allEntityIds: [circle],
    segments: [],
    vertices: [],
    center,
    area: Math.PI * (diameter / 2) ** 2,
  };
  context.featureOutputs.set(featureId(sketch), {
    data: {
      resolvedRegions: { [region.id]: region },
      resolvedEntities: { [circle]: { type: 'circle', center, diameter } },
      plane: {
        name: 'XY',
        origin: [0, 0, z],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
        normal: [0, 0, 1],
      },
    },
  });
  return { sketchId: featureId(sketch), wireEntityIds: [circle] };
}

/** Loft a `diameter` circle at `center` from z = `from` to z = `to`. */
async function loft(
  kernel: OcctKernel,
  context: BuildContext,
  opts: {
    center: [number, number];
    diameter: number;
    from: number;
    to: number;
    operation: 'join' | 'cut';
    targetBodies?: BodyRef[];
  },
) {
  const profiles = [
    section(context, 'sk_a', opts.center, opts.from, opts.diameter),
    section(context, 'sk_b', opts.center, opts.to, opts.diameter),
  ];
  const lo: FeatureNode = {
    id: featureId('lo'),
    type: 'loft',
    name: 'lo',
    version: 1,
    enabled: true,
    visible: true,
    inputs: {
      profiles,
      operation: opts.operation,
      ...(opts.targetBodies ? { targetBodies: opts.targetBodies } : {}),
    },
    dependsOn: [featureId('sk_a'), featureId('sk_b')],
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
  };
  const result = await buildLoft(lo, {}, context, kernel);
  for (const b of result.bodies) context.bodies.set(b.bodyId, b.handle);
  return result;
}

async function volume(kernel: OcctKernel, context: BuildContext, id: BodyId): Promise<number> {
  const handle = context.bodies.get(id) as KernelBody | undefined;
  if (!handle) throw new Error(`no body ${id}`);
  return (await kernel.getMassProperties(handle)).volume;
}

describe('buildLoft — join targets only the bodies it touches (real kernel)', () => {
  it('a boss on the box joins the box and leaves the floating lid alone', async () => {
    const { kernel, context } = await setup();
    const lid = context.bodies.get(LID);
    const result = await loft(kernel, context, {
      center: [10, 10], diameter: 4, from: 20, to: 25, operation: 'join',
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box']);
    expect(result.outputs?.bodies).toEqual({ main: BOX });
    expect([...context.bodies.keys()].map(String).sort()).toEqual(['box', 'lid']);
    expect(context.bodies.get(LID)).toBe(lid);
    expect(await volume(kernel, context, BOX)).toBeCloseTo(CUBE + cylinder(4, 5), 3);
  });

  it('a post bridging box and lid merges the two into the box', async () => {
    const { kernel, context } = await setup();
    const result = await loft(kernel, context, {
      center: [10, 10], diameter: 4, from: 20, to: 40, operation: 'join',
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box']);
    expect([...context.bodies.keys()].map(String)).toEqual(['box']);
    expect(await volume(kernel, context, BOX)).toBeCloseTo(2 * CUBE + cylinder(4, 20), 3);
  });

  it('a join that touches nothing creates a new body and leaves every existing body as is', async () => {
    const { kernel, context } = await setup();
    const before = new Map(context.bodies);
    const result = await loft(kernel, context, {
      center: [100, 100], diameter: 4, from: 0, to: 5, operation: 'join',
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['body_lo_0']);
    for (const [id, handle] of before) expect(context.bodies.get(id)).toBe(handle);
    expect(await volume(kernel, context, bodyId('body_lo_0'))).toBeCloseTo(cylinder(4, 5), 3);
  });

  it('picked targetBodies are fused as picked, and unpicked bodies it touches are left alone', async () => {
    // The boss touches the box, but only the lid is picked.
    const { kernel, context } = await setup();
    const box0 = context.bodies.get(BOX);
    const result = await loft(kernel, context, {
      center: [10, 10], diameter: 4, from: 20, to: 25, operation: 'join',
      targetBodies: [{ partId: 'p1' as never, bodyId: LID }],
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['lid']);
    expect(context.bodies.get(BOX)).toBe(box0);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE + cylinder(4, 5), 3);
  });
});

describe('buildLoft — cut targets only the bodies it overlaps (real kernel)', () => {
  it('cuts every body it passes through, each keeping its id', async () => {
    const { kernel, context } = await setup();
    const result = await loft(kernel, context, {
      center: [10, 10], diameter: 4, from: 15, to: 45, operation: 'cut',
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box', 'lid']);
    expect(await volume(kernel, context, BOX)).toBeCloseTo(CUBE - cylinder(4, 5), 3);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE - cylinder(4, 5), 3);
  });

  it('cuts the body it overlaps even when it is not first in the build', async () => {
    const { kernel, context } = await setup();
    const box0 = context.bodies.get(BOX);
    const result = await loft(kernel, context, {
      center: [10, 10], diameter: 4, from: 50, to: 70, operation: 'cut',
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['lid']);
    expect([...context.bodies.keys()].map(String).sort()).toEqual(['box', 'lid']);
    expect(context.bodies.get(BOX)).toBe(box0);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE - cylinder(4, 10), 3);
  });

  it('fails when the cut removes nothing', async () => {
    const { kernel, context } = await setup();
    await expect(loft(kernel, context, {
      center: [10, 10], diameter: 4, from: 20, to: 25, operation: 'cut',
    })).rejects.toThrow(/Cut removes nothing/);
  });
});

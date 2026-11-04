/**
 * buildExtrude join/cut target selection, against the real occt-wasm kernel.
 *
 * Without `targetBodies`, join fuses only the bodies the new solid touches
 * and cut removes material only from the bodies it overlaps. Bodies it does
 * not reach keep their id and their handle. Picked targets join as picked.
 *
 * Layout (Z up from the XY sketch plane): a 20 mm cube `box` at z 0..20 and a
 * 20 mm cube `lid` floating at z 40..60.
 */
import { sketchInputs } from '@tweakcad/testing/src/sketchFixtures.ts';
import { describe, expect, it } from 'vitest';
import { buildExtrude } from './buildExtrude.ts';
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
/** A body the extrude creates, named after its profile's region. */
const NEW_BODY = /^body_ex~[0-9a-f]{16}$/;

type Circle = { id: string; center: [number, number]; diameter: number };

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

async function box(kernel: OcctKernel, origin: [number, number, number], size: number): Promise<KernelBody> {
  const r = await kernel.makeBox({ origin, width: size, height: size, depth: size });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function setup(): Promise<{ kernel: OcctKernel; context: BuildContext }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const context = emptyBuildContext({} as ResolvedParams);
  context.bodies.set(BOX, await box(kernel, [0, 0, 0], 20));
  context.bodies.set(LID, await box(kernel, [0, 0, 40], 20));
  return { kernel, context };
}

/** Extrude circles on XY from z = `from` to z = `from + height`. */
async function extrude(
  kernel: OcctKernel,
  context: BuildContext,
  opts: {
    circles: Circle[];
    operation: 'join' | 'cut';
    from: number;
    height: number;
    targetBodies?: BodyRef[];
  },
) {
  const sketch = node('sk', 'sketch', sketchInputs({ circles: opts.circles }), []);
  const sketchResult = await buildSketch(sketch, {}, context, kernel);
  context.featureOutputs.set(sketch.id, sketchResult.outputs!);
  const ex = node('ex', 'extrude', {
    profiles: opts.circles.map(c => ({ sketchId: featureId('sk'), wireEntityIds: [entityId(c.id)] })),
    operation: opts.operation,
    direction: { type: 'normal' },
    extent: { type: 'distance', value: String(opts.height) },
    startOffset: String(opts.from),
    ...(opts.targetBodies ? { targetBodies: opts.targetBodies } : {}),
  }, ['sk']);
  const result = await buildExtrude(ex, {}, context, kernel);
  for (const b of result.bodies) context.bodies.set(b.bodyId, b.handle);
  return result;
}

async function volume(kernel: OcctKernel, context: BuildContext, id: BodyId): Promise<number> {
  const handle = context.bodies.get(id) as KernelBody | undefined;
  if (!handle) throw new Error(`no body ${id}`);
  return (await kernel.getMassProperties(handle)).volume;
}

const cylinder = (d: number, h: number) => Math.PI * (d / 2) ** 2 * h;

describe('buildExtrude — join targets only the bodies it touches (real kernel)', () => {
  it('a boss on the box joins the box and leaves the floating lid alone', async () => {
    const { kernel, context } = await setup();
    const lid = context.bodies.get(LID);
    const result = await extrude(kernel, context, {
      circles: [{ id: 'c', center: [10, 10], diameter: 4 }],
      operation: 'join', from: 20, height: 5,
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box']);
    expect([...context.bodies.keys()].map(String).sort()).toEqual(['box', 'lid']);
    expect(context.bodies.get(LID)).toBe(lid);
    expect(await volume(kernel, context, BOX)).toBeCloseTo(CUBE + cylinder(4, 5), 3);
  });

  it('caps on two separate nuts join each nut, not the box under them or the lid', async () => {
    // The nuts sit on the box's top face; the caps touch only the nuts.
    const { kernel, context } = await setup();
    const nutA = bodyId('nut_a');
    const nutB = bodyId('nut_b');
    context.bodies.set(nutA, await box(kernel, [2, 2, 20], 4));
    context.bodies.set(nutB, await box(kernel, [14, 14, 20], 4));
    const boxHandle = context.bodies.get(BOX);

    const result = await extrude(kernel, context, {
      circles: [
        { id: 'a', center: [4, 4], diameter: 2 },
        { id: 'b', center: [16, 16], diameter: 2 },
      ],
      operation: 'join', from: 24, height: 5,
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['nut_a', 'nut_b']);
    expect(context.bodies.size).toBe(4);
    expect(context.bodies.get(BOX)).toBe(boxHandle);
    expect(await volume(kernel, context, nutA)).toBeCloseTo(64 + cylinder(2, 5), 3);
    expect(await volume(kernel, context, nutB)).toBeCloseTo(64 + cylinder(2, 5), 3);
  });

  it('a post bridging box and lid merges the two into the box', async () => {
    const { kernel, context } = await setup();
    const result = await extrude(kernel, context, {
      circles: [{ id: 'c', center: [10, 10], diameter: 4 }],
      operation: 'join', from: 20, height: 20,
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box']);
    expect([...context.bodies.keys()].map(String)).toEqual(['box']);
    expect(await volume(kernel, context, BOX)).toBeCloseTo(2 * CUBE + cylinder(4, 20), 3);
  });

  it('a profile that touches nothing becomes its own body; the touching one still joins', async () => {
    const { kernel, context } = await setup();
    const result = await extrude(kernel, context, {
      circles: [
        { id: 'on', center: [10, 10], diameter: 4 },
        { id: 'off', center: [100, 100], diameter: 4 },
      ],
      operation: 'join', from: 20, height: 5,
    });

    const ids = result.bodies.map(b => String(b.bodyId));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('box');
    expect(ids[1]).toMatch(NEW_BODY);
    expect(context.bodies.size).toBe(3);
    expect(await volume(kernel, context, bodyId(ids[1]!))).toBeCloseTo(cylinder(4, 5), 3);
  });

  it('a join that touches nothing creates a new body and leaves every existing body as is', async () => {
    const { kernel, context } = await setup();
    const before = new Map(context.bodies);
    const result = await extrude(kernel, context, {
      circles: [{ id: 'c', center: [100, 100], diameter: 4 }],
      operation: 'join', from: 0, height: 5,
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual([expect.stringMatching(NEW_BODY)]);
    for (const [id, handle] of before) expect(context.bodies.get(id)).toBe(handle);
  });

  it('picked targetBodies are fused as picked, and unpicked bodies it touches are left alone', async () => {
    // The boss touches the box, but only the lid is picked.
    const { kernel, context } = await setup();
    const box0 = context.bodies.get(BOX);
    const result = await extrude(kernel, context, {
      circles: [{ id: 'c', center: [10, 10], diameter: 4 }],
      operation: 'join', from: 20, height: 5,
      targetBodies: [{ partId: 'p1' as never, bodyId: LID }],
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['lid']);
    expect(context.bodies.get(BOX)).toBe(box0);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE + cylinder(4, 5), 3);
  });
});

describe('buildExtrude — cut targets only the bodies it overlaps (real kernel)', () => {
  it('cuts every body it passes through, each keeping its id', async () => {
    const { kernel, context } = await setup();
    const result = await extrude(kernel, context, {
      circles: [{ id: 'c', center: [10, 10], diameter: 4 }],
      operation: 'cut', from: 15, height: 30, // z 15..45: 5 mm into each
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box', 'lid']);
    expect(await volume(kernel, context, BOX)).toBeCloseTo(CUBE - cylinder(4, 5), 3);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE - cylinder(4, 5), 3);
  });

  it('cuts the body it overlaps even when it is not first in the build', async () => {
    const { kernel, context } = await setup();
    const box0 = context.bodies.get(BOX);
    const result = await extrude(kernel, context, {
      circles: [{ id: 'c', center: [10, 10], diameter: 4 }],
      operation: 'cut', from: 50, height: 20,
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['lid']);
    expect(context.bodies.get(BOX)).toBe(box0);
    expect(await volume(kernel, context, LID)).toBeCloseTo(CUBE - cylinder(4, 10), 3);
  });

  it('a cut that only touches a body leaves it alone', async () => {
    // z 15..40: 5 mm into the box, ending exactly on the lid's bottom face.
    const { kernel, context } = await setup();
    const lid0 = context.bodies.get(LID);
    const result = await extrude(kernel, context, {
      circles: [{ id: 'c', center: [10, 10], diameter: 4 }],
      operation: 'cut', from: 15, height: 25,
    });

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['box']);
    expect(context.bodies.get(LID)).toBe(lid0);
  });

  it('fails when the cut removes nothing', async () => {
    const { kernel, context } = await setup();
    await expect(extrude(kernel, context, {
      circles: [{ id: 'c', center: [10, 10], diameter: 4 }],
      operation: 'cut', from: 20, height: 5, // sits on the box, below the lid
    })).rejects.toThrow(/Cut removes nothing/);
  });
});

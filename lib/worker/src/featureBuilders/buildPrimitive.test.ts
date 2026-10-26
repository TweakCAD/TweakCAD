/**
 * buildPrimitive tests.
 *
 * Two layers, because they catch different mistakes:
 *
 *  - MockKernel + spies pin the canonical-frame arithmetic (what spec does
 *    each shape hand the kernel?) and the boolean routing. A wrong sign on a
 *    half-height is invisible in a bounding box of a symmetric shape but
 *    obvious in the spec.
 *  - Real OCCT pins the end result: a primitive lands centred on
 *    `transform.position`, which is the promise the schema makes and the only
 *    thing a user can see.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildPrimitive } from './buildPrimitive.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  PrimitiveFeatureInputs,
  PrimitiveShape,
} from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import { featureId, bodyId, partId } from '@tweakcad/core/src/ids.ts';
import { identityTransform } from '@tweakcad/core/src/math.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const TARGET = bodyId('body_target');
const NO_PARAMS = {} as ResolvedParams;

function node(
  shape: PrimitiveShape,
  overrides: Partial<PrimitiveFeatureInputs> = {},
): FeatureNode {
  const inputs: PrimitiveFeatureInputs = {
    shape,
    transform: identityTransform(),
    operation: 'newBody',
    ...overrides,
  };
  return {
    id: featureId('prim_1'),
    type: 'primitive',
    name: 'Box 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
  };
}

function contextWithTarget(): BuildContext {
  const ctx: BuildContext = emptyBuildContext(NO_PARAMS);
  ctx.bodies.set(TARGET, { handle: 'mock_target', source: 'mock' });
  return ctx;
}

async function mockKernel(): Promise<MockKernel> {
  const k = new MockKernel();
  await k.init();
  return k;
}

describe('buildPrimitive — canonical frame', () => {
  it('centres a box on its local origin', async () => {
    const k = await mockKernel();
    const spy = vi.spyOn(k, 'makeBox');
    await buildPrimitive(
      node({ kind: 'box', width: '10', height: '20', depth: '30' }),
      NO_PARAMS,
      emptyBuildContext(NO_PARAMS),
      k,
    );
    expect(spy).toHaveBeenCalledWith(
      { origin: [-5, -10, -15], width: 10, height: 20, depth: 30 },
      'prim_1',
    );
  });

  it('starts a cylinder half its height below the origin, along +Y', async () => {
    const k = await mockKernel();
    const spy = vi.spyOn(k, 'makeCylinder');
    await buildPrimitive(
      node({ kind: 'cylinder', radius: '4', height: '12' }),
      NO_PARAMS,
      emptyBuildContext(NO_PARAMS),
      k,
    );
    expect(spy).toHaveBeenCalledWith(
      { center: [0, -6, 0], axis: [0, 1, 0], radius: 4, height: 12 },
      'prim_1',
    );
  });

  it('maps cone bottom/top radius onto radius1/radius2', async () => {
    // radius1 is the z=0 end, which is the base — swapping these builds the
    // cone upside down and nothing else would notice.
    const k = await mockKernel();
    const spy = vi.spyOn(k, 'makeCone');
    await buildPrimitive(
      node({ kind: 'cone', bottomRadius: '8', topRadius: '0', height: '10' }),
      NO_PARAMS,
      emptyBuildContext(NO_PARAMS),
      k,
    );
    expect(spy).toHaveBeenCalledWith(
      { center: [0, -5, 0], axis: [0, 1, 0], radius1: 8, radius2: 0, height: 10 },
      'prim_1',
    );
  });

  it('builds sphere and torus centred, with no placement call at the origin', async () => {
    const k = await mockKernel();
    const transform = vi.spyOn(k, 'transform');
    const sphere = vi.spyOn(k, 'makeSphere');
    const torus = vi.spyOn(k, 'makeTorus');

    await buildPrimitive(
      node({ kind: 'sphere', radius: '5' }),
      NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
    );
    await buildPrimitive(
      node({ kind: 'torus', majorRadius: '10', minorRadius: '2' }),
      NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
    );

    expect(sphere).toHaveBeenCalledWith({ center: [0, 0, 0], radius: 5 }, 'prim_1');
    expect(torus).toHaveBeenCalledWith(
      { center: [0, 0, 0], axis: [0, 1, 0], majorRadius: 10, minorRadius: 2 },
      'prim_1',
    );
    // An identity transform is skipped rather than round-tripped through the
    // kernel, which would derive a pointless second body.
    expect(transform).not.toHaveBeenCalled();
  });

  it('applies a non-identity transform exactly once', async () => {
    const k = await mockKernel();
    const spy = vi.spyOn(k, 'transform');
    const placement = { position: [5, 0, -2] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
    await buildPrimitive(
      node({ kind: 'sphere', radius: '5' }, { transform: placement }),
      NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toEqual(placement);
  });
});

describe('buildPrimitive — dimensions', () => {
  it('resolves dimensions through the parameter table', async () => {
    const k = await mockKernel();
    const spy = vi.spyOn(k, 'makeCylinder');
    const params = { boreRadius: 7, plateThickness: 3 } as unknown as ResolvedParams;
    await buildPrimitive(
      node({ kind: 'cylinder', radius: 'boreRadius', height: 'plateThickness * 2' }),
      params,
      emptyBuildContext(params),
      k,
    );
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ radius: 7, height: 6 });
  });

  it.each([
    ['box', { kind: 'box', width: '0', height: '5', depth: '5' }],
    ['cylinder', { kind: 'cylinder', radius: '-1', height: '5' }],
    ['sphere', { kind: 'sphere', radius: '0' }],
  ] as const)('rejects a non-positive %s dimension', async (_label, shape) => {
    const k = await mockKernel();
    await expect(
      buildPrimitive(node(shape as PrimitiveShape), NO_PARAMS, emptyBuildContext(NO_PARAMS), k),
    ).rejects.toThrow(/must be positive/);
  });

  it('allows a pointed cone but not a zero-radius one', async () => {
    const k = await mockKernel();
    await expect(
      buildPrimitive(
        node({ kind: 'cone', bottomRadius: '5', topRadius: '0', height: '10' }),
        NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
      ),
    ).resolves.toBeDefined();
    await expect(
      buildPrimitive(
        node({ kind: 'cone', bottomRadius: '0', topRadius: '0', height: '10' }),
        NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
      ),
    ).rejects.toThrow(/non-zero radius/);
  });

  it('rejects a self-intersecting torus before it reaches the kernel', async () => {
    const k = await mockKernel();
    const spy = vi.spyOn(k, 'makeTorus');
    await expect(
      buildPrimitive(
        node({ kind: 'torus', majorRadius: '5', minorRadius: '5' }),
        NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
      ),
    ).rejects.toThrow(/passes through itself/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('buildPrimitive — boolean operation', () => {
  it('mints a fresh id in newBody mode and leaves existing bodies alone', async () => {
    const k = await mockKernel();
    const ctx = contextWithTarget();
    const result = await buildPrimitive(
      node({ kind: 'box', width: '1', height: '1', depth: '1' }),
      NO_PARAMS, ctx, k,
    );
    expect(result.bodies).toHaveLength(1);
    expect(String(result.bodies[0]?.bodyId)).toBe('body_prim_1_0');
    expect(ctx.bodies.has(TARGET)).toBe(true);
  });

  it('carries the target id through a join and consumes the target', async () => {
    const k = await mockKernel();
    const ctx = contextWithTarget();
    const fuse = vi.spyOn(k, 'booleanFuse');
    const result = await buildPrimitive(
      node({ kind: 'box', width: '1', height: '1', depth: '1' }, {
        operation: 'join',
        targetBodies: [{ partId: PART, bodyId: TARGET }],
      }),
      NO_PARAMS, ctx, k,
    );
    expect(fuse).toHaveBeenCalledTimes(1);
    expect(String(result.bodies[0]?.bodyId)).toBe(String(TARGET));
    expect(ctx.bodies.has(TARGET)).toBe(false);
  });

  it('carries the target id through a cut', async () => {
    const k = await mockKernel();
    const ctx = contextWithTarget();
    const cut = vi.spyOn(k, 'booleanCut');
    const result = await buildPrimitive(
      node({ kind: 'sphere', radius: '2' }, {
        operation: 'cut',
        targetBodies: [{ partId: PART, bodyId: TARGET }],
      }),
      NO_PARAMS, ctx, k,
    );
    expect(cut).toHaveBeenCalledTimes(1);
    expect(String(result.bodies[0]?.bodyId)).toBe(String(TARGET));
    expect(ctx.bodies.has(TARGET)).toBe(false);
  });

  it('falls back to newBody when the picked target is gone', async () => {
    // The upstream feature that made the target may have failed or been
    // deleted. Producing the primitive on its own beats failing the feature.
    const k = await mockKernel();
    const ctx = emptyBuildContext(NO_PARAMS);
    const cut = vi.spyOn(k, 'booleanCut');
    const result = await buildPrimitive(
      node({ kind: 'sphere', radius: '2' }, {
        operation: 'cut',
        targetBodies: [{ partId: PART, bodyId: TARGET }],
      }),
      NO_PARAMS, ctx, k,
    );
    expect(cut).not.toHaveBeenCalled();
    expect(String(result.bodies[0]?.bodyId)).toBe('body_prim_1_0');
  });

  it('surfaces a kernel failure as a build failure', async () => {
    const k = await mockKernel();
    vi.spyOn(k, 'makeBox').mockResolvedValue(
      err({ category: 'kernel', code: 'BOX_FAILED', message: 'nope' }),
    );
    await expect(
      buildPrimitive(
        node({ kind: 'box', width: '1', height: '1', depth: '1' }),
        NO_PARAMS, emptyBuildContext(NO_PARAMS), k,
      ),
    ).rejects.toThrow(/Failed to create box: nope/);
  });
});

describe('buildPrimitive — against real OCCT', () => {
  it('lands every shape centred on transform.position', async () => {
    const k = new OcctKernel();
    await k.init();
    const at: [number, number, number] = [20, -5, 8];
    const shapes: PrimitiveShape[] = [
      { kind: 'box', width: '10', height: '20', depth: '30' },
      { kind: 'cylinder', radius: '4', height: '12' },
      { kind: 'sphere', radius: '5' },
      { kind: 'cone', bottomRadius: '8', topRadius: '2', height: '10' },
      { kind: 'torus', majorRadius: '10', minorRadius: '2' },
    ];

    for (const shape of shapes) {
      const result = await buildPrimitive(
        node(shape, { transform: { position: at, rotation: [0, 0, 0, 1] } }),
        NO_PARAMS,
        emptyBuildContext(NO_PARAMS),
        k,
      );
      const handle = result.bodies[0]?.handle;
      const bbox = await k.getBoundingBox(handle as Parameters<OcctKernel['getBoundingBox']>[0]);
      for (let axis = 0; axis < 3; axis++) {
        const mid = (bbox.min[axis]! + bbox.max[axis]!) / 2;
        expect(mid, `${shape.kind} axis ${axis}`).toBeCloseTo(at[axis]!, 3);
      }
    }
  });

  it('a cut primitive actually removes material', async () => {
    const k = new OcctKernel();
    await k.init();
    const ctx = emptyBuildContext(NO_PARAMS);
    const block = await k.makeBox({ origin: [-10, -10, -10], width: 20, height: 20, depth: 20 });
    if (!block.ok) throw new Error('precondition failed');
    ctx.bodies.set(TARGET, block.value);

    const result = await buildPrimitive(
      node({ kind: 'sphere', radius: '5' }, {
        operation: 'cut',
        targetBodies: [{ partId: PART, bodyId: TARGET }],
      }),
      NO_PARAMS, ctx, k,
    );

    const handle = result.bodies[0]?.handle as Parameters<OcctKernel['getBoundingBox']>[0];
    const mass = await k.getMassProperties!(handle);
    // 20³ less a 5 mm sphere punched out of the middle.
    expect(mass.volume).toBeCloseTo(8000 - (4 / 3) * Math.PI * 125, 1);
  });
});

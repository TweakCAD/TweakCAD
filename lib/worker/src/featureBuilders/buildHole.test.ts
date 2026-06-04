/**
 * Tests for `buildHole`.
 *
 * Mocks the kernel so we can assert what the builder *asks the kernel
 * to do* — center/axis/radius/height of each primitive, fuse ordering,
 * cut target — without spinning up OCCT-WASM. This catches the
 * geometric logic regressions that don't surface until the kernel call
 * (e.g. drilling outward instead of inward) and keeps the test fast.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildHole } from './buildHole.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { ok } from '@tweakcad/core/src/result.ts';
import type { FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, KernelFace } from '@tweakcad/kernel/src/types.ts';

function makeNode(inputs: Record<string, unknown>): FeatureNode {
  return {
    id: 'hole_test' as FeatureId,
    type: 'hole',
    name: 'Hole 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs,
    dependsOn: [],
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * Build a face-anchored mock kernel. The face plane is configurable so
 * each test can pin it to whatever world orientation is convenient. All
 * primitive ops return a handle and record their call args so the test
 * can assert on (center, axis, radius, height) directly.
 */
function makeMockKernel(facePlane: {
  origin: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  normal: [number, number, number];
}) {
  let nextHandle = 0;
  const cylCalls: Array<{ center: [number, number, number]; axis: [number, number, number]; radius: number; height: number; origin?: string }> = [];
  const coneCalls: Array<{ center: [number, number, number]; axis: [number, number, number]; radius1: number; radius2: number; height: number; origin?: string }> = [];
  const fuseCalls: KernelBody[][] = [];
  const cutCalls: Array<{ target: KernelBody; tools: KernelBody[] }> = [];

  const kernel = {
    makeCylinder: vi.fn(async (spec, origin) => {
      cylCalls.push({ ...spec, origin });
      return ok({ handle: `cyl_${nextHandle++}`, source: 'mock' });
    }),
    makeCone: vi.fn(async (spec, origin) => {
      coneCalls.push({ ...spec, origin });
      return ok({ handle: `cone_${nextHandle++}`, source: 'mock' });
    }),
    booleanFuse: vi.fn(async (bodies: KernelBody[]) => {
      fuseCalls.push(bodies);
      return ok({ handle: `fuse_${nextHandle++}`, source: 'mock' });
    }),
    booleanCut: vi.fn(async (target: KernelBody, tools: KernelBody[]) => {
      cutCalls.push({ target, tools });
      return ok({ handle: `cut_${nextHandle++}`, source: 'mock' });
    }),
    resolveFaceRef: vi.fn(async () => ({ handle: 'face_1', bodyHandle: 'body_1' } as KernelFace)),
    getFacePlane: vi.fn(async () => facePlane),
    getBoundingBox: vi.fn(async () => ({
      // 100x80x60 box centered at origin — diagonal ≈ 140.
      min: [-50, -40, -30] as [number, number, number],
      max: [50, 40, 30] as [number, number, number],
    })),
  } as unknown as CadKernel;

  return { kernel, cylCalls, coneCalls, fuseCalls, cutCalls };
}

/**
 * Standard +Z face plane, used by most tests so the math is easy to
 * eyeball: a hole on this face drills along -Z (inward).
 */
const Z_UP_FACE = {
  origin: [0, 0, 10] as [number, number, number],
  uAxis: [1, 0, 0] as [number, number, number],
  vAxis: [0, 1, 0] as [number, number, number],
  normal: [0, 0, 1] as [number, number, number],
};

function makeBaseCtx() {
  const ctx = emptyBuildContext({});
  ctx.bodies.set('b1' as unknown as BodyId, { handle: 'target_body', source: 'test' } as KernelBody);
  return ctx;
}

const stableFaceRef = {
  type: 'stableTopology' as const,
  bodyRef: { partId: 'p1', bodyId: 'b1' },
  stableFaceId: 'sf_top',
};

describe('buildHole — simple', () => {
  it('drills a single cylinder along the inward face normal', async () => {
    const ctx = makeBaseCtx();
    const { kernel, cylCalls, fuseCalls, cutCalls } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '6',
      extent: { type: 'distance', value: '15' },
      kind: 'simple',
    });

    const result = await buildHole(node, {}, ctx, kernel);

    // One cylinder, no cone, no fuse (single tool), one cut.
    expect(cylCalls).toHaveLength(1);
    expect(fuseCalls).toHaveLength(0);
    expect(cutCalls).toHaveLength(1);

    const drill = cylCalls[0]!;
    expect(drill.center).toEqual([0, 0, 10]);
    // Inward = -normal; face normal is +Z so drill axis is -Z.
    expect(drill.axis).toEqual([-0, -0, -1]);
    expect(drill.radius).toBeCloseTo(3, 10); // diameter / 2
    expect(drill.height).toBe(15);
    expect(drill.origin).toBe('hole_hole_test_drill');

    // Cut target is the target body; tool is the drill cylinder.
    expect(cutCalls[0]!.target.handle).toBe('target_body');
    expect(cutCalls[0]!.tools).toHaveLength(1);

    // Result body re-uses the target body id so downstream features
    // referencing it don't need to rebind.
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]!.bodyId).toBe('b1');
  });

  it('through-all extent uses 2× the body AABB diagonal', async () => {
    const ctx = makeBaseCtx();
    const { kernel, cylCalls } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '4',
      extent: { type: 'throughAll' },
      kind: 'simple',
    });

    await buildHole(node, {}, ctx, kernel);

    // Mock AABB is 100×80×60 → diagonal = √(100²+80²+60²) ≈ 140.0.
    // Builder multiplies by 2 → ~280.
    const expectedDiag = Math.hypot(100, 80, 60);
    expect(cylCalls[0]!.height).toBeCloseTo(expectedDiag * 2, 5);
  });

  it("'reversed' direction drills outward instead of inward", async () => {
    const ctx = makeBaseCtx();
    const { kernel, cylCalls } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'reversed' },
      diameter: '5',
      extent: { type: 'distance', value: '10' },
      kind: 'simple',
    });
    await buildHole(node, {}, ctx, kernel);
    // 'reversed' on a +Z face → +Z drill axis (outward).
    expect(cylCalls[0]!.axis).toEqual([0, 0, 1]);
  });

  it('honors a non-Z face normal (verifies the drill axis comes from the face, not world Z)', async () => {
    const ctx = makeBaseCtx();
    // Face on +X side of a body — normal points +X, drill should go -X.
    const { kernel, cylCalls } = makeMockKernel({
      origin: [25, 5, 5],
      uAxis: [0, 1, 0],
      vAxis: [0, 0, 1],
      normal: [1, 0, 0],
    });
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '4',
      extent: { type: 'distance', value: '20' },
      kind: 'simple',
    });
    await buildHole(node, {}, ctx, kernel);
    expect(cylCalls[0]!.center).toEqual([25, 5, 5]);
    expect(cylCalls[0]!.axis).toEqual([-1, -0, -0]);
  });

  it('rejects a hole on a default plane (no body to cut from)', async () => {
    const ctx = makeBaseCtx();
    const { kernel } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: { type: 'defaultPlane', name: 'XY' },
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '5',
      extent: { type: 'distance', value: '10' },
      kind: 'simple',
    });
    await expect(buildHole(node, {}, ctx, kernel)).rejects.toThrow(
      /must be a stableTopology FaceRef/,
    );
  });

  it('rejects negative diameter so a typo fails loudly rather than silently flipping the cut', async () => {
    const ctx = makeBaseCtx();
    const { kernel } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '-5',
      extent: { type: 'distance', value: '10' },
      kind: 'simple',
    });
    await expect(buildHole(node, {}, ctx, kernel)).rejects.toThrow(/diameter must be positive/);
  });

  it('rejects when the target body is missing from the build context', async () => {
    // Empty context — the FaceRef's bodyId b1 isn't in ctx.bodies.
    const ctx = emptyBuildContext({});
    const { kernel } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '5',
      extent: { type: 'distance', value: '10' },
      kind: 'simple',
    });
    await expect(buildHole(node, {}, ctx, kernel)).rejects.toThrow(/target body b1 not in build context/);
  });
});

describe('buildHole — counterbore', () => {
  it('builds drill + cbore cylinders, fuses, then cuts', async () => {
    const ctx = makeBaseCtx();
    const { kernel, cylCalls, fuseCalls, cutCalls } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '6',
      extent: { type: 'distance', value: '20' },
      kind: 'counterbore',
      counterboreDiameter: '12',
      counterboreDepth: '4',
    });
    await buildHole(node, {}, ctx, kernel);

    expect(cylCalls).toHaveLength(2);
    expect(fuseCalls).toHaveLength(1);
    expect(cutCalls).toHaveLength(1);

    // Drill cylinder: 3mm radius, 20mm height.
    expect(cylCalls[0]!.radius).toBeCloseTo(3, 10);
    expect(cylCalls[0]!.height).toBe(20);

    // Cbore cylinder: 6mm radius, 4mm height, same center as drill.
    expect(cylCalls[1]!.radius).toBeCloseTo(6, 10);
    expect(cylCalls[1]!.height).toBe(4);
    expect(cylCalls[1]!.center).toEqual([0, 0, 10]);
    expect(cylCalls[1]!.origin).toBe('hole_hole_test_cbore');
  });

  it('rejects when the cbore diameter does not exceed the hole diameter', async () => {
    const ctx = makeBaseCtx();
    const { kernel } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '6',
      extent: { type: 'distance', value: '15' },
      kind: 'counterbore',
      counterboreDiameter: '6', // same as hole — should reject
      counterboreDepth: '4',
    });
    await expect(buildHole(node, {}, ctx, kernel)).rejects.toThrow(
      /Counterbore diameter \(6\) must exceed hole diameter \(6\)/,
    );
  });

  it('rejects when a counterbore param is missing entirely', async () => {
    const ctx = makeBaseCtx();
    const { kernel } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '6',
      extent: { type: 'distance', value: '15' },
      kind: 'counterbore',
      counterboreDiameter: '12',
      // counterboreDepth missing
    });
    await expect(buildHole(node, {}, ctx, kernel)).rejects.toThrow(
      /counterboreDepth.*required/,
    );
  });
});

describe('buildHole — countersink', () => {
  it('builds drill + cone, fuses, then cuts; cone height derives from angle', async () => {
    const ctx = makeBaseCtx();
    const { kernel, cylCalls, coneCalls, fuseCalls, cutCalls } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '5',
      extent: { type: 'distance', value: '15' },
      kind: 'countersink',
      countersinkDiameter: '10',
      countersinkAngle: '90', // ISO 7046 default
    });
    await buildHole(node, {}, ctx, kernel);

    expect(cylCalls).toHaveLength(1);
    expect(coneCalls).toHaveLength(1);
    expect(fuseCalls).toHaveLength(1);
    expect(cutCalls).toHaveLength(1);

    // Cone height = (csR - holeR) / tan(angle/2)
    //             = (5 - 2.5) / tan(45°) = 2.5 / 1 = 2.5
    expect(coneCalls[0]!.height).toBeCloseTo(2.5, 10);
    // Wide rim at the face surface, tapering to a point along the
    // drill axis — radius1 = csink rim, radius2 = 0.
    expect(coneCalls[0]!.radius1).toBeCloseTo(5, 10);
    expect(coneCalls[0]!.radius2).toBe(0);
    // Same center + axis as the drill — both anchored to the face.
    expect(coneCalls[0]!.center).toEqual([0, 0, 10]);
    expect(coneCalls[0]!.axis).toEqual([-0, -0, -1]);
  });

  it('uses the 82° flathead-screw angle when supplied', async () => {
    const ctx = makeBaseCtx();
    const { kernel, coneCalls } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '4',
      extent: { type: 'distance', value: '12' },
      kind: 'countersink',
      countersinkDiameter: '8',
      countersinkAngle: '82',
    });
    await buildHole(node, {}, ctx, kernel);
    // (4 - 2) / tan(41°) ≈ 2 / 0.8693 ≈ 2.301
    const expected = (4 - 2) / Math.tan((82 * Math.PI) / 360);
    expect(coneCalls[0]!.height).toBeCloseTo(expected, 6);
  });

  it('rejects an out-of-range angle so a 0° or 180° doesnt produce a degenerate cone', async () => {
    const ctx = makeBaseCtx();
    const { kernel } = makeMockKernel(Z_UP_FACE);
    const node = makeNode({
      face: stableFaceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: '4',
      extent: { type: 'distance', value: '12' },
      kind: 'countersink',
      countersinkDiameter: '8',
      countersinkAngle: '180',
    });
    await expect(buildHole(node, {}, ctx, kernel)).rejects.toThrow(
      /Countersink angle must be in \(0, 180\)/,
    );
  });
});

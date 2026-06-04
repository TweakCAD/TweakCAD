/**
 * Tests for `buildConstructionPlane`.
 *
 * The construction-plane builder is body-less — every test asserts on
 * the resolved plane it stashes in `outputs.data.plane` (same shape
 * `buildSketch` writes), since that's the contract downstream features
 * (sketch on a construction plane, future Hole tool) consume.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildConstructionPlane } from './buildConstructionPlane.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedSketchPlaneData } from './buildSketch.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, KernelFace } from '@tweakcad/kernel/src/types.ts';

/** Synthesize a minimal FeatureNode shape for the builder. */
function makeNode(inputs: Record<string, unknown>): FeatureNode {
  return {
    id: 'cp_test' as FeatureId,
    type: 'constructionPlane',
    name: 'Plane 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs,
    dependsOn: [],
    createdAt: '',
    updatedAt: '',
  };
}

// The builder never touches the kernel — pass a stub.
const stubKernel = {} as CadKernel;

describe('buildConstructionPlane — offsetFromPlane', () => {
  it('offsets the XY plane along +Z by the requested distance', async () => {
    const ctx = emptyBuildContext({});
    const node = makeNode({
      kind: 'offsetFromPlane',
      basePlane: { type: 'defaultPlane', name: 'XY' },
      offset: '12',
    });
    const result = await buildConstructionPlane(node, {}, ctx, stubKernel);

    expect(result.bodies).toHaveLength(0);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData | undefined;
    expect(plane).toBeDefined();
    expect(plane!.name).toBe('XY');
    expect(plane!.origin).toEqual([0, 0, 12]);
    expect(plane!.normal).toEqual([0, 0, 1]);
    // Axes shouldn't move — only the origin walks along the normal.
    expect(plane!.uAxis).toEqual([1, 0, 0]);
    expect(plane!.vAxis).toEqual([0, 1, 0]);
  });

  it('offsets the XZ plane along +Y (matches sketch XZ basis)', async () => {
    const ctx = emptyBuildContext({});
    const node = makeNode({
      kind: 'offsetFromPlane',
      basePlane: { type: 'defaultPlane', name: 'XZ' },
      offset: '5',
    });
    const result = await buildConstructionPlane(node, {}, ctx, stubKernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.name).toBe('XZ');
    expect(plane.origin).toEqual([0, 5, 0]);
    expect(plane.normal).toEqual([0, 1, 0]);
  });

  it('accepts a negative offset (plane below the base)', async () => {
    const ctx = emptyBuildContext({});
    const node = makeNode({
      kind: 'offsetFromPlane',
      basePlane: { type: 'defaultPlane', name: 'YZ' },
      offset: '-7.5',
    });
    const result = await buildConstructionPlane(node, {}, ctx, stubKernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.name).toBe('YZ');
    expect(plane.origin).toEqual([-7.5, 0, 0]);
    expect(plane.normal).toEqual([1, 0, 0]);
  });

  it('accepts offset 0 (plane coincides with base — used as a named reference)', async () => {
    const ctx = emptyBuildContext({});
    const node = makeNode({
      kind: 'offsetFromPlane',
      basePlane: { type: 'defaultPlane', name: 'XY' },
      offset: '0',
    });
    const result = await buildConstructionPlane(node, {}, ctx, stubKernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.origin).toEqual([0, 0, 0]);
  });

  it('evaluates parameter-driven offset expressions', async () => {
    // Offset = "h" → parameters table supplies h=20 → plane lands at z=20.
    const ctx = emptyBuildContext({ h: 20 });
    const node = makeNode({
      kind: 'offsetFromPlane',
      basePlane: { type: 'defaultPlane', name: 'XY' },
      offset: 'h',
    });
    const result = await buildConstructionPlane(node, { h: 20 }, ctx, stubKernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.origin).toEqual([0, 0, 20]);
  });

  it('offsets from an existing construction plane (CP-on-CP chain)', async () => {
    // Set up a CP-1 at z=10, then make CP-2 offset from CP-1 by +5
    // → CP-2 should land at z=15.
    const ctx = emptyBuildContext({});
    const cp1Id = 'cp_1' as unknown as FeatureId;
    ctx.featureOutputs.set(cp1Id, {
      data: {
        plane: {
          name: 'XY',
          origin: [0, 0, 10],
          uAxis: [1, 0, 0],
          vAxis: [0, 1, 0],
          normal: [0, 0, 1],
        } satisfies ResolvedSketchPlaneData,
      },
    });
    const node = makeNode({
      kind: 'offsetFromPlane',
      basePlane: { type: 'constructionPlane', planeId: cp1Id as string },
      offset: '5',
    });
    const result = await buildConstructionPlane(node, {}, ctx, stubKernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.origin).toEqual([0, 0, 15]);
  });

  it('throws on unsupported kind so adding union variants forces a builder update', async () => {
    const ctx = emptyBuildContext({});
    const node = makeNode({ kind: 'angleThroughEdge', edge: 'whatever' });
    await expect(buildConstructionPlane(node, {}, ctx, stubKernel)).rejects.toThrow(
      /Unsupported construction plane kind/,
    );
  });
});

describe('buildConstructionPlane — offsetFromFace', () => {
  /**
   * Mock kernel that returns a fixed face plane and stub-resolves any
   * face id. Lets us exercise the `offsetFromFace` builder branch
   * without spinning up OCCT.
   */
  function makeFaceKernel(facePlane: {
    origin: [number, number, number];
    uAxis: [number, number, number];
    vAxis: [number, number, number];
    normal: [number, number, number];
  }): CadKernel {
    const fakeFace = { handle: 'face_1', bodyHandle: 'body_1' } as KernelFace;
    return {
      resolveFaceRef: vi.fn(async () => fakeFace),
      getFacePlane: vi.fn(async () => facePlane),
    } as unknown as CadKernel;
  }

  it('offsets along the face normal by the requested signed distance', async () => {
    const ctx = emptyBuildContext({});
    // Pretend the target body exists in the build context so the resolver
    // doesn't bail with "body not in context".
    const bodyId = 'b1' as unknown as BodyId;
    ctx.bodies.set(bodyId, {} as KernelBody);

    const node = makeNode({
      kind: 'offsetFromFace',
      face: {
        type: 'stableTopology',
        bodyRef: { partId: 'p1', bodyId: 'b1' },
        stableFaceId: 'sf_top',
      },
      offset: '7',
    });
    const kernel = makeFaceKernel({
      origin: [10, 10, 5],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
    });
    const result = await buildConstructionPlane(node, {}, ctx, kernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    // Origin walks 7 mm along +Z (the face normal).
    expect(plane.origin).toEqual([10, 10, 12]);
    // Axes inherited from the face's tangent frame.
    expect(plane.normal).toEqual([0, 0, 1]);
    expect(plane.uAxis).toEqual([1, 0, 0]);
    expect(plane.vAxis).toEqual([0, 1, 0]);
  });

  it('accepts a negative offset (plane below the face)', async () => {
    const ctx = emptyBuildContext({});
    ctx.bodies.set('b1' as unknown as BodyId, {} as KernelBody);
    const node = makeNode({
      kind: 'offsetFromFace',
      face: { type: 'stableTopology', bodyRef: { partId: 'p1', bodyId: 'b1' }, stableFaceId: 'sf' },
      offset: '-3',
    });
    const kernel = makeFaceKernel({
      origin: [0, 0, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
    });
    const result = await buildConstructionPlane(node, {}, ctx, kernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.origin).toEqual([0, 0, -3]);
  });

  it('offset 0 lands on the face plane itself (used as a "name this face" reference)', async () => {
    const ctx = emptyBuildContext({});
    ctx.bodies.set('b1' as unknown as BodyId, {} as KernelBody);
    const node = makeNode({
      kind: 'offsetFromFace',
      face: { type: 'stableTopology', bodyRef: { partId: 'p1', bodyId: 'b1' }, stableFaceId: 'sf' },
      offset: '0',
    });
    const kernel = makeFaceKernel({
      origin: [5, 6, 7],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
    });
    const result = await buildConstructionPlane(node, {}, ctx, kernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.origin).toEqual([5, 6, 7]);
  });

  it('walks along a non-Z face normal (verifies the offset uses the face frame, not world Z)', async () => {
    // Face normal points along +X — offsetting by 4 should move the
    // origin in +X by 4, leaving Y/Z untouched.
    const ctx = emptyBuildContext({});
    ctx.bodies.set('b1' as unknown as BodyId, {} as KernelBody);
    const node = makeNode({
      kind: 'offsetFromFace',
      face: { type: 'stableTopology', bodyRef: { partId: 'p1', bodyId: 'b1' }, stableFaceId: 'sf' },
      offset: '4',
    });
    const kernel = makeFaceKernel({
      origin: [10, 20, 30],
      uAxis: [0, 0, 1],
      vAxis: [0, 1, 0],
      normal: [1, 0, 0],
    });
    const result = await buildConstructionPlane(node, {}, ctx, kernel);
    const plane = result.outputs?.data?.plane as ResolvedSketchPlaneData;
    expect(plane.origin).toEqual([14, 20, 30]);
    expect(plane.normal).toEqual([1, 0, 0]);
  });

  it('fails clearly when the target body is missing from the build context', async () => {
    // No bodies in the context — the resolver should throw a specific
    // message rather than silently producing nonsense geometry.
    const ctx = emptyBuildContext({});
    const node = makeNode({
      kind: 'offsetFromFace',
      face: { type: 'stableTopology', bodyRef: { partId: 'p1', bodyId: 'b_missing' }, stableFaceId: 'sf' },
      offset: '5',
    });
    const kernel = makeFaceKernel({
      origin: [0, 0, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
    });
    await expect(buildConstructionPlane(node, {}, ctx, kernel)).rejects.toThrow(
      /target body b_missing not in build context/,
    );
  });
});

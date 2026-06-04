/**
 * Tests for the shared `resolvePlaneRef` helper. The resolver is the
 * single point of truth that turns a {@link PlaneRef} from the document
 * schema into a `ResolvedSketchPlaneData` the kernel pipeline consumes,
 * so a sketch on a construction plane sees the exact same basis as a
 * sketch on a default plane offset zero.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolvePlaneRef, offsetPlaneAlongNormal, resolveFacePlaneRef } from './resolvePlane.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedSketchPlaneData } from './buildSketch.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, KernelFace } from '@tweakcad/kernel/src/types.ts';

describe('resolvePlaneRef — default planes', () => {
  it('XY resolves to canonical right-handed basis (u=+X, v=+Y, n=+Z)', () => {
    const plane = resolvePlaneRef({ type: 'defaultPlane', name: 'XY' }, emptyBuildContext({}), {});
    expect(plane.name).toBe('XY');
    expect(plane.origin).toEqual([0, 0, 0]);
    expect(plane.uAxis).toEqual([1, 0, 0]);
    expect(plane.vAxis).toEqual([0, 1, 0]);
    expect(plane.normal).toEqual([0, 0, 1]);
  });

  it('XZ resolves to u=+X, v=+Z, n=+Y (matches buildSketch + SketchPlanePicker)', () => {
    const plane = resolvePlaneRef({ type: 'defaultPlane', name: 'XZ' }, emptyBuildContext({}), {});
    expect(plane.uAxis).toEqual([1, 0, 0]);
    expect(plane.vAxis).toEqual([0, 0, 1]);
    expect(plane.normal).toEqual([0, 1, 0]);
  });

  it('YZ resolves to u=+Z, v=+Y, n=+X (matches sketch editor V=world-up convention)', () => {
    const plane = resolvePlaneRef({ type: 'defaultPlane', name: 'YZ' }, emptyBuildContext({}), {});
    expect(plane.uAxis).toEqual([0, 0, 1]);
    expect(plane.vAxis).toEqual([0, 1, 0]);
    expect(plane.normal).toEqual([1, 0, 0]);
  });
});

describe('resolvePlaneRef — constructionPlane', () => {
  it('reads the plane back from the upstream feature output', () => {
    const ctx = emptyBuildContext({});
    const planeId = 'cp_1' as unknown as FeatureId;
    const cachedPlane: ResolvedSketchPlaneData = {
      name: 'XY',
      origin: [0, 0, 25],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
    };
    ctx.featureOutputs.set(planeId, { data: { plane: cachedPlane } });

    const resolved = resolvePlaneRef(
      { type: 'constructionPlane', planeId: planeId as string },
      ctx,
      {},
    );
    expect(resolved).toBe(cachedPlane);
  });

  it('throws a clear error when the construction plane has no output yet', () => {
    const ctx = emptyBuildContext({});
    expect(() =>
      resolvePlaneRef({ type: 'constructionPlane', planeId: 'cp_missing' }, ctx, {}),
    ).toThrow(/Construction plane cp_missing has no resolved plane output/);
  });
});

describe('resolvePlaneRef — unsupported variants', () => {
  it('throws on featureOutput (reserved for future use)', () => {
    expect(() =>
      resolvePlaneRef(
        { type: 'featureOutput', featureId: 'f1' as unknown as FeatureId, output: 'main' },
        emptyBuildContext({}),
        {},
      ),
    ).toThrow(/PlaneRef\.featureOutput is not yet supported/);
  });

  it('directs stableTopology callers to use resolveFacePlaneRef instead', () => {
    expect(() =>
      resolvePlaneRef(
        {
          type: 'stableTopology',
          bodyRef: { partId: 'p1' as never, bodyId: 'b1' as never },
          stableFaceId: 'sf1' as never,
        },
        emptyBuildContext({}),
        {},
      ),
    ).toThrow(/cannot be resolved synchronously; use resolveFacePlaneRef/);
  });
});

describe('resolveFacePlaneRef', () => {
  /** Stub kernel that returns a fixed face plane and resolves any ref. */
  function makeStubKernel(): { kernel: CadKernel; getFacePlane: ReturnType<typeof vi.fn>; resolveFaceRef: ReturnType<typeof vi.fn> } {
    const getFacePlane = vi.fn(async () => ({
      origin: [1, 2, 3] as [number, number, number],
      uAxis: [1, 0, 0] as [number, number, number],
      vAxis: [0, 1, 0] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
    }));
    const resolveFaceRef = vi.fn(async () => ({ handle: 'face_1', bodyHandle: 'body_1' } as KernelFace));
    return { kernel: { resolveFaceRef, getFacePlane } as unknown as CadKernel, getFacePlane, resolveFaceRef };
  }

  it('handles defaultPlane refs without touching the kernel', async () => {
    const { kernel, getFacePlane, resolveFaceRef } = makeStubKernel();
    const plane = await resolveFacePlaneRef(
      { type: 'defaultPlane', name: 'XY' },
      emptyBuildContext({}),
      {},
      kernel,
    );
    expect(plane.normal).toEqual([0, 0, 1]);
    expect(getFacePlane).not.toHaveBeenCalled();
    expect(resolveFaceRef).not.toHaveBeenCalled();
  });

  it('handles constructionPlane refs by reading the cached output', async () => {
    const ctx = emptyBuildContext({});
    const planeId = 'cp_2' as unknown as FeatureId;
    const cached: ResolvedSketchPlaneData = {
      name: 'XY',
      origin: [0, 0, 50],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
    };
    ctx.featureOutputs.set(planeId, { data: { plane: cached } });
    const { kernel, getFacePlane } = makeStubKernel();
    const plane = await resolveFacePlaneRef(
      { type: 'constructionPlane', planeId: planeId as string },
      ctx,
      {},
      kernel,
    );
    expect(plane).toBe(cached);
    expect(getFacePlane).not.toHaveBeenCalled();
  });

  it('handles stableTopology refs by calling resolveFaceRef + getFacePlane', async () => {
    const ctx = emptyBuildContext({});
    ctx.bodies.set('b1' as unknown as BodyId, {} as KernelBody);
    const { kernel, getFacePlane, resolveFaceRef } = makeStubKernel();
    const plane = await resolveFacePlaneRef(
      {
        type: 'stableTopology',
        bodyRef: { partId: 'p1' as never, bodyId: 'b1' as never },
        stableFaceId: 'sf_top' as never,
      },
      ctx,
      {},
      kernel,
    );
    expect(resolveFaceRef).toHaveBeenCalledOnce();
    expect(getFacePlane).toHaveBeenCalledOnce();
    expect(plane.origin).toEqual([1, 2, 3]);
    expect(plane.normal).toEqual([0, 0, 1]);
  });

  it('fails when the target body is missing from the build context', async () => {
    const ctx = emptyBuildContext({});
    const { kernel } = makeStubKernel();
    await expect(
      resolveFacePlaneRef(
        {
          type: 'stableTopology',
          bodyRef: { partId: 'p1' as never, bodyId: 'b_missing' as never },
          stableFaceId: 'sf' as never,
        },
        ctx,
        {},
        kernel,
      ),
    ).rejects.toThrow(/target body b_missing not in build context/);
  });

  it('fails when resolveFaceRef returns null (face lost during rebuild)', async () => {
    const ctx = emptyBuildContext({});
    ctx.bodies.set('b1' as unknown as BodyId, {} as KernelBody);
    const kernel = {
      resolveFaceRef: vi.fn(async () => null),
      getFacePlane: vi.fn(),
    } as unknown as CadKernel;
    await expect(
      resolveFacePlaneRef(
        {
          type: 'stableTopology',
          bodyRef: { partId: 'p1' as never, bodyId: 'b1' as never },
          stableFaceId: 'sf_lost' as never,
        },
        ctx,
        {},
        kernel,
      ),
    ).rejects.toThrow(/could not resolve face sf_lost on body b1/);
  });
});

describe('offsetPlaneAlongNormal', () => {
  it('moves only the origin; axes stay put', () => {
    const xy: ResolvedSketchPlaneData = {
      name: 'XY',
      origin: [0, 0, 0],
      uAxis: [1, 0, 0],
      vAxis: [0, 1, 0],
      normal: [0, 0, 1],
    };
    const moved = offsetPlaneAlongNormal(xy, 7);
    expect(moved.origin).toEqual([0, 0, 7]);
    expect(moved.uAxis).toBe(xy.uAxis);
    expect(moved.vAxis).toBe(xy.vAxis);
    expect(moved.normal).toBe(xy.normal);
  });

  it('preserves the plane name (so downstream consumers can still branch on it)', () => {
    const yz: ResolvedSketchPlaneData = {
      name: 'YZ',
      origin: [0, 0, 0],
      uAxis: [0, 0, 1],
      vAxis: [0, 1, 0],
      normal: [1, 0, 0],
    };
    const moved = offsetPlaneAlongNormal(yz, -3);
    expect(moved.name).toBe('YZ');
    expect(moved.origin).toEqual([-3, 0, 0]);
  });
});

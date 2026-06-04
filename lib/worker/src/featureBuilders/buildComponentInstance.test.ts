/**
 * buildComponentInstance tests — real geometry library + boolean modes.
 *
 * Uses the MockKernel (deterministic in-memory handles, no WASM) so we
 * can spy on kernel calls and assert the right ops were issued without
 * actually invoking OCCT. We're not validating the geometry math — that
 * lives in the kernel implementation tests — only that the dispatcher,
 * parameter wiring, and boolean modes do what the schema promises.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildComponentInstance } from './buildComponentInstance.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  ComponentInstanceFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { featureId, bodyId } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

function makeNode(overrides: Partial<ComponentInstanceFeatureInputs>): FeatureNode {
  const inputs: ComponentInstanceFeatureInputs = {
    componentProjectId: 'proj_seed_iso-4017-hex-bolt-m5',
    componentSlug: 'iso-4017-hex-bolt-m5',
    componentName: 'M5 hex bolt — ISO 4017',
    manifestVersion: 1,
    parameters: { length: 20, diameter: 5 },
    ...overrides,
  };
  return {
    id: featureId('cmpinst_1'),
    type: 'componentInstance',
    name: 'M5 hex bolt — ISO 4017',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
  };
}

async function freshKernel(): Promise<MockKernel> {
  const kernel = new MockKernel();
  await kernel.init();
  return kernel;
}

describe('buildComponentInstance — hex bolt', () => {
  it('produces a single fused body for an M5 bolt in newBody mode', async () => {
    const kernel = await freshKernel();
    const cylSpy = vi.spyOn(kernel, 'makeCylinder');
    const fuseSpy = vi.spyOn(kernel, 'booleanFuse');
    const cutSpy = vi.spyOn(kernel, 'booleanCut');
    const ctx = emptyBuildContext({} as ResolvedParams);

    const result = await buildComponentInstance(
      makeNode({}),
      {} as ResolvedParams,
      ctx,
      kernel,
    );

    // Head (hex prism = polygon + extrudeFace) + shank (cylinder), fused.
    expect(result.bodies).toHaveLength(1);
    expect(cylSpy).toHaveBeenCalledTimes(1); // shank only
    expect(cylSpy.mock.calls[0]?.[0]?.radius).toBeCloseTo(2.5, 6); // diameter 5 / 2
    expect(fuseSpy).toHaveBeenCalledTimes(1); // head + shank
    expect(cutSpy).not.toHaveBeenCalled(); // newBody mode, no host bodies
  });

  it('reduces shank radius when the diameter parameter is reduced', async () => {
    const kernel = await freshKernel();
    const cylSpy = vi.spyOn(kernel, 'makeCylinder');
    const ctx = emptyBuildContext({} as ResolvedParams);

    await buildComponentInstance(
      makeNode({ parameters: { length: 20, diameter: 4 } }),
      {} as ResolvedParams,
      ctx,
      kernel,
    );

    expect(cylSpy.mock.calls[0]?.[0]?.radius).toBeCloseTo(2.0, 6);
  });
});

describe('buildComponentInstance — hex nut', () => {
  it('cuts a bore from a hex prism for a newBody M5 nut', async () => {
    const kernel = await freshKernel();
    const cylSpy = vi.spyOn(kernel, 'makeCylinder');
    const cutSpy = vi.spyOn(kernel, 'booleanCut');
    const ctx = emptyBuildContext({} as ResolvedParams);

    const result = await buildComponentInstance(
      makeNode({
        componentSlug: 'iso-4032-hex-nut-m5',
        componentName: 'M5 hex nut',
        parameters: { diameter: 5 },
      }),
      {} as ResolvedParams,
      ctx,
      kernel,
    );

    expect(result.bodies).toHaveLength(1);
    expect(cylSpy).toHaveBeenCalledTimes(1); // the bore
    expect(cutSpy).toHaveBeenCalledTimes(1); // hex prism − bore
    expect(cylSpy.mock.calls[0]?.[0]?.radius).toBeCloseTo(2.5, 6);
  });

  it('rejects a nut bore that breaches the hex flats', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    await expect(
      buildComponentInstance(
        makeNode({
          componentSlug: 'iso-4032-hex-nut-m5',
          componentName: 'M5 hex nut',
          parameters: { diameter: 20 }, // > 8 mm across-flats for M5
        }),
        {} as ResolvedParams,
        ctx,
        kernel,
      ),
    ).rejects.toThrow(/bore .* >= across-flats/);
  });
});

describe('buildComponentInstance — boolean cut mode', () => {
  it('subtracts the component from the host body when boolean=cut', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    // Seed a fake host body the bolt should cut through.
    const hostId = bodyId('host_1') as BodyId;
    const hostHandle: KernelBody = { handle: 'host', source: 'test' };
    ctx.bodies.set(hostId, hostHandle);

    const cutSpy = vi.spyOn(kernel, 'booleanCut');

    const result = await buildComponentInstance(
      makeNode({
        componentSlug: 'iso-4017-hex-bolt-m5',
        boolean: 'cut',
        parameters: { length: 20, diameter: 5 },
      }),
      {} as ResolvedParams,
      ctx,
      kernel,
    );

    // bolt builder fuses head + shank → one component body.
    // cutFromHosts then calls booleanCut(host, [componentBody]) once.
    // (booleanCut may be invoked again later by the kernel for ring math,
    // but for a bolt vs. one host body the host-cut call is the last one.)
    expect(cutSpy.mock.calls.some(call => call[0] === hostHandle)).toBe(true);
    expect(ctx.bodies.has(hostId)).toBe(false); // host consumed
    expect(result.bodies).toHaveLength(1); // one output body per host
  });

  it('falls back to newBody when no host bodies exist', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);
    const cutSpy = vi.spyOn(kernel, 'booleanCut');

    const result = await buildComponentInstance(
      makeNode({
        boolean: 'cut',
        parameters: { length: 20, diameter: 5 },
      }),
      {} as ResolvedParams,
      ctx,
      kernel,
    );

    // No host bodies to cut against → bolt is inserted as its own body.
    // booleanCut may have been called internally to build the bolt
    // (it isn't — bolt uses fuse only), but never against a host body.
    const wasCutAgainstHost = cutSpy.mock.calls.some(
      call => call[0].source === 'test',
    );
    expect(wasCutAgainstHost).toBe(false);
    expect(result.bodies).toHaveLength(1);
  });
});

describe('buildComponentInstance — ball bearing 608', () => {
  it('produces two ring bodies for the 608 bearing', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    const result = await buildComponentInstance(
      makeNode({
        componentSlug: 'ball-bearing-608',
        componentName: 'Ball bearing — 608',
        parameters: {},
      }),
      {} as ResolvedParams,
      ctx,
      kernel,
    );

    // outer ring + inner ring (balls intentionally skipped).
    expect(result.bodies).toHaveLength(2);
  });
});

describe('buildComponentInstance — placeholder fallback', () => {
  it('draws a placeholder cylinder for an unknown slug', async () => {
    const kernel = await freshKernel();
    const cylSpy = vi.spyOn(kernel, 'makeCylinder');
    const ctx = emptyBuildContext({} as ResolvedParams);

    const result = await buildComponentInstance(
      makeNode({
        componentSlug: 'not-a-real-component',
        componentName: 'Unknown',
        parameters: { length: 33, diameter: 9 },
      }),
      {} as ResolvedParams,
      ctx,
      kernel,
    );

    expect(result.bodies).toHaveLength(1);
    expect(cylSpy).toHaveBeenCalledTimes(1);
    expect(cylSpy.mock.calls[0]?.[0]?.radius).toBeCloseTo(4.5, 6);
    expect(cylSpy.mock.calls[0]?.[0]?.height).toBe(33);
  });
});

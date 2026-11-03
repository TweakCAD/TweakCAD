/**
 * Join and cut are all or nothing.
 *
 * A cut or join that reaches several bodies runs one boolean per body (or per
 * group of touching bodies). If a later one fails, the feature fails — and
 * the bodies the earlier booleans already handled must still be in the build,
 * unchanged. Removing each from the build context as its boolean finished lost
 * them: the model came out of a *failed* cut missing a body the cut never got
 * to keep.
 *
 * Kernel failures are injected into MockKernel; the rebuild-level case runs
 * the real timeline walk.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { bodyId, featureId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { FeatureNode, PrimitiveFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { cutTouchingBodies, joinTouchingBodies } from './bodyOperation.ts';
import { clearRebuildCache, incrementalRebuild } from '../rebuilder.ts';

const NO_PARAMS = {} as ResolvedParams;
const A = bodyId('body_a');
const B = bodyId('body_b');

async function setup(): Promise<{ kernel: MockKernel; context: BuildContext; a: KernelBody; b: KernelBody; tool: KernelBody }> {
  const kernel = new MockKernel();
  await kernel.init();
  const make = async () => {
    const r = await kernel.makeBox({ origin: [0, 0, 0], width: 1, height: 1, depth: 1 });
    if (!r.ok) throw new Error('box');
    return r.value;
  };
  const context = emptyBuildContext(NO_PARAMS);
  const a = await make();
  const b = await make();
  const tool = await make();
  context.bodies.set(A, a);
  context.bodies.set(B, b);
  return { kernel, context, a, b, tool };
}

/** Make the kernel's `call`-th invocation of `method` fail (1-based). */
function failOnCall(kernel: MockKernel, method: 'booleanCut' | 'booleanFuse', call: number): void {
  const real = kernel[method].bind(kernel) as (...args: never[]) => Promise<unknown>;
  let n = 0;
  vi.spyOn(kernel, method).mockImplementation((async (...args: never[]) => {
    n++;
    if (n === call) return err({ code: 'BOOLEAN_FAILED', message: 'injected' });
    return real(...args);
  }) as never);
}

function disposedHandles(kernel: MockKernel): string[] {
  const seen: string[] = [];
  const real = kernel.dispose.bind(kernel);
  vi.spyOn(kernel, 'dispose').mockImplementation((h) => {
    seen.push(String((h as { handle: string }).handle));
    real(h);
  });
  return seen;
}

describe('cutTouchingBodies — all or nothing', () => {
  it('leaves every candidate in the build when a later cut fails', async () => {
    const { kernel, context, a, b, tool } = await setup();
    failOnCall(kernel, 'booleanCut', 2);
    const disposed = disposedHandles(kernel);

    await expect(cutTouchingBodies({
      tools: [tool],
      candidates: [[A, a], [B, b]],
      context,
      kernel,
      explicitTargets: false,
      featureId: 'cutter',
    })).rejects.toThrow(/Cut failed/);

    expect(context.bodies.get(A)).toBe(a);
    expect(context.bodies.get(B)).toBe(b);
    // The first cut's result and the spent tool are freed, not leaked; the
    // candidates are not.
    expect(disposed).toHaveLength(2);
    expect(disposed).toContain(String(tool.handle));
    expect(disposed).not.toContain(String(a.handle));
    expect(disposed).not.toContain(String(b.handle));
  });

  it('releases the result of a cut that removed nothing', async () => {
    const { kernel, context, a, b, tool } = await setup();
    // Every body reads 1 mm³ except the cut results we mark: A's cut leaves
    // 0.5 (material removed), B's leaves 1 (nothing removed).
    const volumes = new Map<string, number>();
    vi.spyOn(kernel, 'getMassProperties').mockImplementation(async (body) => ({
      volume: volumes.get(String(body.handle)) ?? 1,
      surfaceArea: 6,
      centerOfMass: [0, 0, 0],
    }));
    const cutResults: string[] = [];
    const realCut = kernel.booleanCut.bind(kernel);
    vi.spyOn(kernel, 'booleanCut').mockImplementation(async (target, tools) => {
      const r = await realCut(target, tools);
      if (r.ok) {
        cutResults.push(String(r.value.handle));
        volumes.set(String(r.value.handle), String(target.handle) === String(a.handle) ? 0.5 : 1);
      }
      return r;
    });
    const disposed = disposedHandles(kernel);

    const out = await cutTouchingBodies({
      tools: [tool],
      candidates: [[A, a], [B, b]],
      context,
      kernel,
      explicitTargets: false,
      featureId: 'cutter',
    });

    expect(out.map((o) => String(o.bodyId))).toEqual([String(A)]);
    expect(context.bodies.has(A)).toBe(false);
    expect(context.bodies.get(B)).toBe(b);
    // B's unchanged cut result was freed rather than leaked, and so was the
    // spent tool.
    expect(disposed).toHaveLength(2);
    expect(disposed).toContain(String(tool.handle));
    expect(cutResults.filter((h) => disposed.includes(h))).toHaveLength(1);
  });
});

describe('joinTouchingBodies — all or nothing', () => {
  it('leaves every candidate in the build when a later group fails to fuse', async () => {
    const { kernel, context, a, b } = await setup();
    const make = async () => {
      const r = await kernel.makeBox({ origin: [0, 0, 0], width: 1, height: 1, depth: 1 });
      if (!r.ok) throw new Error('box');
      return r.value;
    };
    const toolA = await make();
    const toolB = await make();
    // Two separate groups: each tool touches only its own candidate.
    const pairs = new Set([
      [toolA.handle, a.handle].join('|'),
      [toolB.handle, b.handle].join('|'),
    ]);
    vi.spyOn(kernel, 'distanceBetween').mockImplementation(async (x, y) =>
      pairs.has([x.handle, y.handle].join('|')) || pairs.has([y.handle, x.handle].join('|')) ? 0 : 10);
    failOnCall(kernel, 'booleanFuse', 2);
    const disposed = disposedHandles(kernel);

    await expect(joinTouchingBodies({
      tools: [toolA, toolB],
      candidates: [[A, a], [B, b]],
      context,
      kernel,
      explicitTargets: false,
      newBodies: async () => [],
      featureId: 'joiner',
    })).rejects.toThrow(/Join failed/);

    expect(context.bodies.get(A)).toBe(a);
    expect(context.bodies.get(B)).toBe(b);
    // The first group's fused result and both tools; neither candidate.
    expect(disposed).toHaveLength(3);
    expect(disposed).toEqual(expect.arrayContaining([String(toolA.handle), String(toolB.handle)]));
    expect(disposed).not.toContain(String(a.handle));
    expect(disposed).not.toContain(String(b.handle));
  });
});

describe('cut through the rebuild — all or nothing', () => {
  function box(id: string, operation: PrimitiveFeatureInputs['operation']): FeatureNode {
    const inputs: PrimitiveFeatureInputs = {
      shape: { kind: 'box', width: '10', height: '10', depth: '10' },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      operation,
    };
    return {
      id: featureId(id),
      type: 'primitive',
      name: id,
      version: 1,
      enabled: true,
      visible: true,
      inputs: inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
  }

  it('keeps both upstream bodies when the cut fails on its second target', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    failOnCall(kernel, 'booleanCut', 2);
    const project = newProjectWithPart('P', 'Part 1');
    const part = Object.values(project.parts)[0]!;
    part.timeline = [box('a', 'newBody'), box('b', 'newBody'), box('cut', 'cut')];

    const result = await incrementalRebuild(part, project, kernel, 0);

    expect(result.featureResults.map((r) => r.status)).toEqual(['success', 'success', 'failed']);
    const bodies = result.bodies.map((x) => String(x.bodyId)).sort();
    expect(bodies).toHaveLength(2);
    expect(bodies.every((id: string) => id.startsWith('body_a') || id.startsWith('body_b'))).toBe(true);
  });
});


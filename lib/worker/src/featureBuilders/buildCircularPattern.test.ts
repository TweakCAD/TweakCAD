/**
 * buildCircularPattern tests with MockKernel.
 *
 * Mirrors buildLinearPattern.test.ts case-for-case where applicable.
 * Adds the fullAngle clamp test (v1 only supports 360°; non-360 logs
 * a warning and proceeds with 360).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCircularPattern } from './buildCircularPattern.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  CircularPatternInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import { featureId, bodyId, partId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const BODY = bodyId('body_src');

function makeCtxWithBody(): BuildContext {
  const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
  ctx.bodies.set(BODY, { handle: 'mock_body_src', source: 'mock' });
  return ctx;
}

function makeNode(overrides: Partial<CircularPatternInputs> = {}): FeatureNode {
  const inputs: CircularPatternInputs = {
    patternType: 'circular',
    sourceBody: { partId: PART, bodyId: BODY },
    axis: { type: 'z' },
    count: '6',
    ...overrides,
  };
  return {
    id: featureId('circpat_1'),
    type: 'circularPattern',
    name: 'Circular Pattern 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

describe('buildCircularPattern', () => {
  it('throws when sourceBody is missing', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeNode();
    (node.inputs as { sourceBody?: unknown }).sourceBody = undefined;
    await expect(buildCircularPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel))
      .rejects.toThrow(/requires sourceBody/);
  });

  it('throws when body not in build context', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
    await expect(buildCircularPattern(makeNode(), {} as ResolvedParams, ctx, kernel))
      .rejects.toThrow(/not in build context/);
  });

  it('throws on count < 1', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeNode({ count: '0' });
    await expect(buildCircularPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel))
      .rejects.toThrow(/count must be at least 1/);
  });

  it.each([
    ['x', [1, 0, 0]],
    ['y', [0, 1, 0]],
    ['z', [0, 0, 1]],
  ] as const)('axis type %s → world axis %j', async (type, expected) => {
    const kernel = new MockKernel();
    await kernel.init();
    const spy = vi.spyOn(kernel, 'circularPattern');
    const node = makeNode({ axis: { type } });
    await buildCircularPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel);
    const axisArg = spy.mock.calls[0]![1];
    expect(axisArg.origin).toEqual([0, 0, 0]);
    expect(axisArg.direction).toEqual(expected);
  });

  it('honors a custom axis origin + direction', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const spy = vi.spyOn(kernel, 'circularPattern');
    const node = makeNode({
      axis: { type: 'custom', origin: [10, 20, 30], direction: [0, 0, 2] }, // not unit
    });
    await buildCircularPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel);
    const a = spy.mock.calls[0]![1];
    expect(a.origin).toEqual([10, 20, 30]);
    // normalized
    expect(a.direction[0]).toBeCloseTo(0);
    expect(a.direction[1]).toBeCloseTo(0);
    expect(a.direction[2]).toBeCloseTo(1);
  });

  it('warns + clamps to 360° when fullAngle is set to something else', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({ fullAngle: '180' });
    await buildCircularPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/not yet supported/));
    warnSpy.mockRestore();
  });

  it('does NOT warn when fullAngle is exactly 360', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({ fullAngle: '360' });
    await buildCircularPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('publishes one fresh body per copy and leaves source alone', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeCtxWithBody();
    const result = await buildCircularPattern(makeNode(), {} as ResolvedParams, ctx, kernel);
    expect(ctx.bodies.has(BODY)).toBe(true);
    expect(result.bodies.map(b => String(b.bodyId))).toEqual(
      [0, 1, 2, 3, 4].map(i => `body_circpat_1_${i}`),
    );
    expect(result.outputs?.bodies?.main).toBe(result.bodies[0]!.bodyId);
  });

  it('propagates kernel.circularPattern failure', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'circularPattern').mockResolvedValue(
      err({ category: 'kernel', code: 'CIRCULAR_PATTERN_FAILED', message: 'boom' }),
    );
    await expect(buildCircularPattern(makeNode(), {} as ResolvedParams, makeCtxWithBody(), kernel))
      .rejects.toThrow(/Circular Pattern failed: boom/);
  });
});

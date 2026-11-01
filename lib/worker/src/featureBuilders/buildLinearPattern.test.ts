/**
 * buildLinearPattern tests with MockKernel.
 *
 * Covers the validation guards and the kernel.linearPattern call shape:
 *  - Missing sourceBody / body absent from context.
 *  - count < 1 / spacing <= 0.
 *  - X/Y/Z direction → world-axis unit vectors.
 *  - Custom direction → normalized.
 *  - Custom zero-length direction → falls back to +X with a warning.
 *  - Result published under a fresh deterministic id; source body
 *    stays in context.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildLinearPattern } from './buildLinearPattern.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  LinearPatternInputs,
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

function makeNode(overrides: Partial<LinearPatternInputs> = {}): FeatureNode {
  const inputs: LinearPatternInputs = {
    patternType: 'linear',
    sourceBody: { partId: PART, bodyId: BODY },
    direction: { type: 'x' },
    count: '3',
    spacing: '20',
    ...overrides,
  };
  return {
    id: featureId('linpat_1'),
    type: 'linearPattern',
    name: 'Linear Pattern 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

describe('buildLinearPattern', () => {
  it('throws when sourceBody is missing', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeCtxWithBody();
    const node = makeNode();
    (node.inputs as { sourceBody?: unknown }).sourceBody = undefined;
    await expect(buildLinearPattern(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /requires sourceBody/,
    );
  });

  it('throws when body is not in build context', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
    await expect(buildLinearPattern(makeNode(), {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /not in build context/,
    );
  });

  it('throws on count < 1', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeNode({ count: '0' });
    await expect(buildLinearPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel))
      .rejects.toThrow(/count must be at least 1/);
  });

  it('throws on spacing <= 0', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeNode({ spacing: '0' });
    await expect(buildLinearPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel))
      .rejects.toThrow(/spacing must be positive/);
  });

  it.each([
    ['x', [1, 0, 0]],
    ['y', [0, 1, 0]],
    ['z', [0, 0, 1]],
  ] as const)('direction type %s → axis %j', async (type, expected) => {
    const kernel = new MockKernel();
    await kernel.init();
    const spy = vi.spyOn(kernel, 'linearPattern');
    const node = makeNode({ direction: { type } });
    await buildLinearPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel);
    const dirArg = spy.mock.calls[0]![1];
    expect(dirArg).toEqual(expected);
  });

  it('normalizes custom direction', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const spy = vi.spyOn(kernel, 'linearPattern');
    const node = makeNode({
      direction: { type: 'custom', origin: [0, 0, 0], direction: [3, 4, 0] },
    });
    await buildLinearPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel);
    const dir = spy.mock.calls[0]![1];
    // (3,4,0) has length 5 → normalized (0.6, 0.8, 0)
    expect(dir[0]).toBeCloseTo(0.6);
    expect(dir[1]).toBeCloseTo(0.8);
    expect(dir[2]).toBeCloseTo(0);
  });

  it('falls back to +X for zero-length custom direction', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const spy = vi.spyOn(kernel, 'linearPattern');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = makeNode({
      direction: { type: 'custom', origin: [0, 0, 0], direction: [0, 0, 0] },
    });
    await buildLinearPattern(node, {} as ResolvedParams, makeCtxWithBody(), kernel);
    expect(spy.mock.calls[0]![1]).toEqual([1, 0, 0]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/zero length/));
    warnSpy.mockRestore();
  });

  it('publishes one fresh body per copy and leaves source in the context', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeCtxWithBody();
    const result = await buildLinearPattern(makeNode(), {} as ResolvedParams, ctx, kernel);
    expect(ctx.bodies.has(BODY)).toBe(true); // source NOT consumed
    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['body_linpat_1_0', 'body_linpat_1_1']);
  });

  it('count 1 publishes no bodies', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const result = await buildLinearPattern(makeNode({ count: '1' }), {} as ResolvedParams, makeCtxWithBody(), kernel);
    expect(result.bodies).toEqual([]);
  });

  it('propagates kernel.linearPattern failure', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'linearPattern').mockResolvedValue(
      err({ category: 'kernel', code: 'LINEAR_PATTERN_FAILED', message: 'boom' }),
    );
    await expect(buildLinearPattern(makeNode(), {} as ResolvedParams, makeCtxWithBody(), kernel))
      .rejects.toThrow(/Linear Pattern failed: boom/);
  });
});

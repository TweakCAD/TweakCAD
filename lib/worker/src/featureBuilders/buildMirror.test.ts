/**
 * buildMirror builder tests with MockKernel.
 *
 * Covers:
 *  - Missing source body → throws with a clear message.
 *  - Source body absent from context → throws with the "upstream may
 *    have failed" hint.
 *  - newBody mode: source stays in the context, mirror is published
 *    under a deterministic id derived from the feature.
 *  - join mode: kernel.booleanFuse is invoked with [source, mirror],
 *    the source body is removed from the context, the result reuses
 *    the source bodyId so downstream refs survive.
 *  - kernel.mirror error surface is propagated as a build failure.
 *
 * Plane resolution is exercised via the default-plane (XY/XZ/YZ) path —
 * `resolvePlaneRef` is a pure function in the worker package and needs
 * no mocking. Construction-plane resolution is covered by its own
 * existing test in buildConstructionPlane.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildMirror } from './buildMirror.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  MirrorFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import { featureId, bodyId, partId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const BODY = bodyId('body_src');

function makeContextWithSourceBody(): BuildContext {
  const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
  ctx.bodies.set(BODY, { handle: 'mock_body_src', source: 'mock' });
  return ctx;
}

function makeMirrorNode(overrides: Partial<MirrorFeatureInputs> = {}): FeatureNode {
  const inputs: MirrorFeatureInputs = {
    sourceBody: { partId: PART, bodyId: BODY },
    plane: { type: 'defaultPlane', name: 'XY' },
    operation: 'newBody',
    ...overrides,
  };
  return {
    id: featureId('mirror_1'),
    type: 'mirror',
    name: 'Mirror 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

describe('buildMirror', () => {
  it('throws when sourceBody is missing', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx = makeContextWithSourceBody();
    const node = makeMirrorNode();
    // Stomp the field out without satisfying the type — the runtime
    // guard is what we're testing.
    (node.inputs as { sourceBody?: unknown }).sourceBody = undefined;

    await expect(buildMirror(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /Mirror requires sourceBody/,
    );
  });

  it('throws with a hint when source body is not in build context', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const ctx: BuildContext = emptyBuildContext({} as ResolvedParams); // no body registered
    const node = makeMirrorNode();

    await expect(buildMirror(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /not in build context/,
    );
  });

  it('newBody: calls kernel.mirror with the resolved plane and publishes a fresh body id', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const mirrorSpy = vi.spyOn(kernel, 'mirror');
    const fuseSpy = vi.spyOn(kernel, 'booleanFuse');

    const ctx = makeContextWithSourceBody();
    const node = makeMirrorNode({ operation: 'newBody' });

    const result = await buildMirror(node, {} as ResolvedParams, ctx, kernel);

    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    const [bodyArg, planeArg] = mirrorSpy.mock.calls[0]!;
    expect(bodyArg.handle).toBe('mock_body_src');
    // XY plane → origin at world origin, normal +Z, xDir +X (from uAxis).
    expect(planeArg.origin).toEqual([0, 0, 0]);
    expect(planeArg.normal).toEqual([0, 0, 1]);
    expect(planeArg.xDir).toEqual([1, 0, 0]);

    // No fuse in newBody mode.
    expect(fuseSpy).not.toHaveBeenCalled();

    // Source body stays in the context (newBody doesn't consume it).
    expect(ctx.bodies.has(BODY)).toBe(true);

    // Result body is a fresh id derived from the feature id.
    expect(result.bodies).toHaveLength(1);
    expect(String(result.bodies[0]!.bodyId)).toBe('body_mirror_1_0');
    expect(result.outputs?.bodies?.main).toBe(result.bodies[0]!.bodyId);
  });

  it('join: fuses mirror with source and reuses the source bodyId', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const fuseSpy = vi.spyOn(kernel, 'booleanFuse');

    const ctx = makeContextWithSourceBody();
    const node = makeMirrorNode({ operation: 'join' });

    const result = await buildMirror(node, {} as ResolvedParams, ctx, kernel);

    expect(fuseSpy).toHaveBeenCalledTimes(1);
    // Fuse is called with [source, mirror] in that order.
    const fuseArgs = fuseSpy.mock.calls[0]![0];
    expect(fuseArgs).toHaveLength(2);
    expect(fuseArgs[0]!.handle).toBe('mock_body_src');
    // The mirror handle is a fresh MockKernel handle (mock_N); we just
    // assert that it's not the source.
    expect(fuseArgs[1]!.handle).not.toBe('mock_body_src');

    // Source body is consumed (removed from context) — the fused body
    // replaces it under the SAME bodyId.
    expect(ctx.bodies.has(BODY)).toBe(false);

    // Result bodyId reuses the source's so downstream refs survive.
    expect(result.bodies).toHaveLength(1);
    expect(String(result.bodies[0]!.bodyId)).toBe(String(BODY));
  });

  it('propagates a kernel.mirror failure as a build error', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'mirror').mockResolvedValue(
      err({ category: 'kernel', code: 'MIRROR_FAILED', message: 'simulated' }),
    );

    const ctx = makeContextWithSourceBody();
    const node = makeMirrorNode();

    await expect(buildMirror(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /Mirror failed: simulated/,
    );
  });

  it('propagates a fuse failure (join mode) as a build error', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'booleanFuse').mockResolvedValue(
      err({ category: 'kernel', code: 'FUSE_FAILED', message: 'fuse boom' }),
    );

    const ctx = makeContextWithSourceBody();
    const node = makeMirrorNode({ operation: 'join' });

    await expect(buildMirror(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /Mirror join \(fuse\) failed: fuse boom/,
    );
  });

  it('honors XZ default plane (origin 0,0,0; normal +Y)', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const mirrorSpy = vi.spyOn(kernel, 'mirror');

    const ctx = makeContextWithSourceBody();
    const node = makeMirrorNode({
      plane: { type: 'defaultPlane', name: 'XZ' },
    });

    await buildMirror(node, {} as ResolvedParams, ctx, kernel);

    const planeArg = mirrorSpy.mock.calls[0]![1];
    expect(planeArg.normal).toEqual([0, 1, 0]);
  });
});

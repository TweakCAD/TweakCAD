/**
 * buildShell builder tests with MockKernel.
 *
 * Covers the validation guards and the kernel.shell call shape:
 *  - Missing sourceBody → throws.
 *  - Empty removedFaces → throws.
 *  - Cross-body face ref → rejected with a clear cross-body message.
 *  - Non-stableTopology face ref → rejected (Shell is body-only).
 *  - Failed face resolution → throws with the face index in the message.
 *  - Non-positive thickness → throws.
 *  - Happy path: kernel.shell called with the right body, faces,
 *    negative-thickness (inward shell), default tolerance.
 *  - Result body reuses the source bodyId so downstream refs survive.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildShell } from './buildShell.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  ShellFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { err } from '@tweakcad/core/src/result.ts';
import {
  featureId,
  bodyId,
  stableFaceId,
  partId,
} from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const BODY = bodyId('body_src');
const OTHER_BODY = bodyId('body_other');

function makeContextWithSourceBody(): BuildContext {
  const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
  ctx.bodies.set(BODY, { handle: 'mock_body_src', source: 'mock' });
  return ctx;
}

async function makeKernelWithFaceResolver() {
  const kernel = new MockKernel();
  await kernel.init();
  vi.spyOn(kernel, 'resolveFaceRef').mockImplementation(async (_b, sid) => ({
    handle: `mock_face_${String(sid)}`,
    bodyHandle: 'mock_body_src',
  }));
  return kernel;
}

function makeShellNode(overrides: Partial<ShellFeatureInputs> = {}): FeatureNode {
  const inputs: ShellFeatureInputs = {
    sourceBody: { partId: PART, bodyId: BODY },
    removedFaces: [
      { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableFaceId: stableFaceId('f_001') },
      { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableFaceId: stableFaceId('f_002') },
    ],
    thickness: '2',
    ...overrides,
  };
  return {
    id: featureId('shell_1'),
    type: 'shell',
    name: 'Shell 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

describe('buildShell', () => {
  it('throws when sourceBody is missing', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const ctx = makeContextWithSourceBody();
    const node = makeShellNode();
    (node.inputs as { sourceBody?: unknown }).sourceBody = undefined;

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /Shell requires sourceBody/,
    );
  });

  it('throws when source body is not in build context', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
    const node = makeShellNode();

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /not in build context/,
    );
  });

  it('throws when removedFaces is empty', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const ctx = makeContextWithSourceBody();
    const node = makeShellNode({ removedFaces: [] });

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /at least one face/,
    );
  });

  it('rejects a face ref that belongs to a different body', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const ctx = makeContextWithSourceBody();
    const node = makeShellNode({
      removedFaces: [
        { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableFaceId: stableFaceId('f_001') },
        { type: 'stableTopology', bodyRef: { partId: PART, bodyId: OTHER_BODY }, stableFaceId: stableFaceId('f_002') },
      ],
    });

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /must all belong to the source body/,
    );
  });

  it('rejects non-stableTopology face refs', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const ctx = makeContextWithSourceBody();
    const node = makeShellNode({
      removedFaces: [{ type: 'defaultPlane', name: 'XY' }],
    });

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /stableTopology FaceRefs/,
    );
  });

  it('throws when a face fails to resolve, including the face index', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    // First resolves, second misses.
    let calls = 0;
    vi.spyOn(kernel, 'resolveFaceRef').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { handle: 'mock_face_001', bodyHandle: 'mock_body_src' };
      return null;
    });

    const ctx = makeContextWithSourceBody();
    const node = makeShellNode();

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /Shell face #2: could not resolve/,
    );
  });

  it('throws when thickness is zero or negative', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const ctx = makeContextWithSourceBody();
    const node = makeShellNode({ thickness: '0' });

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /thickness must be positive/,
    );
  });

  it('calls kernel.shell with negative thickness (inward) and default tolerance', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const shellSpy = vi.spyOn(kernel, 'shell');

    const ctx = makeContextWithSourceBody();
    const node = makeShellNode();

    await buildShell(node, {} as ResolvedParams, ctx, kernel);

    expect(shellSpy).toHaveBeenCalledTimes(1);
    const [bodyArg, facesArg, thicknessArg, toleranceArg] = shellSpy.mock.calls[0]!;
    expect(bodyArg.handle).toBe('mock_body_src');
    expect(facesArg).toHaveLength(2);
    // User entered "2"; builder negates to -2 for inward shell.
    expect(thicknessArg).toBe(-2);
    // Default tolerance is 1e-3 when inputs.tolerance is unset.
    expect(toleranceArg).toBe(1e-3);
  });

  it('honors a custom tolerance from inputs', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const shellSpy = vi.spyOn(kernel, 'shell');

    const ctx = makeContextWithSourceBody();
    const node = makeShellNode({ tolerance: 1e-6 });

    await buildShell(node, {} as ResolvedParams, ctx, kernel);

    expect(shellSpy.mock.calls[0]![3]).toBe(1e-6);
  });

  it('reuses the source bodyId on the result (consumes source)', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const ctx = makeContextWithSourceBody();
    const node = makeShellNode();

    const result = await buildShell(node, {} as ResolvedParams, ctx, kernel);

    expect(ctx.bodies.has(BODY)).toBe(false); // consumed
    expect(result.bodies).toHaveLength(1);
    expect(String(result.bodies[0]!.bodyId)).toBe(String(BODY));
    expect(result.outputs?.bodies?.main).toBe(result.bodies[0]!.bodyId);
  });

  it('propagates a kernel.shell failure as a build error', async () => {
    const kernel = await makeKernelWithFaceResolver();
    vi.spyOn(kernel, 'shell').mockResolvedValue(
      err({ category: 'kernel', code: 'SHELL_FAILED', message: 'thin wall' }),
    );

    const ctx = makeContextWithSourceBody();
    const node = makeShellNode();

    await expect(buildShell(node, {} as ResolvedParams, ctx, kernel)).rejects.toThrow(
      /Shell failed: thin wall/,
    );
  });
});

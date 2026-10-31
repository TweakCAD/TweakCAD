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
 *    the entered (positive, inward) thickness, default tolerance.
 *  - Result body reuses the source bodyId so downstream refs survive.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildShell } from './buildShell.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { FINE_TESSELLATION } from '@tweakcad/kernel/src/types.ts';
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

  it('calls kernel.shell with the entered thickness (inward) and default tolerance', async () => {
    const kernel = await makeKernelWithFaceResolver();
    const shellSpy = vi.spyOn(kernel, 'shell');

    const ctx = makeContextWithSourceBody();
    const node = makeShellNode();

    await buildShell(node, {} as ResolvedParams, ctx, kernel);

    expect(shellSpy).toHaveBeenCalledTimes(1);
    const [bodyArg, facesArg, thicknessArg, toleranceArg] = shellSpy.mock.calls[0]!;
    expect(bodyArg.handle).toBe('mock_body_src');
    expect(facesArg).toHaveLength(2);
    // User entered "2"; the kernel shells inward for positive values.
    expect(thicknessArg).toBe(2);
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

describe('buildShell — against real OCCT', () => {
  it('hollows a box inward: outer bounds unchanged, walls are the entered thickness', async () => {
    const kernel = new OcctKernel();
    await kernel.init();
    const box = await kernel.makeBox({ origin: [0, 0, 0], width: 10, height: 20, depth: 30 });
    if (!box.ok) throw new Error('precondition failed');

    // Find the +Z face (every vertex at z = 30) and leave it open.
    const mesh = await kernel.tessellate(box.value, FINE_TESSELLATION);
    const topo = await kernel.getTopology(box.value);
    const top = topo.faces.find(f => {
      for (let i = 3 * f.triStart; i < 3 * f.triEnd; i++) {
        if (Math.abs(mesh.positions[(mesh.indices[i] as number) * 3 + 2]! - 30) > 1e-6) return false;
      }
      return true;
    });
    if (!top?.stableFaceId) throw new Error('top face not found');

    const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
    ctx.bodies.set(BODY, box.value);
    const node = makeShellNode({
      removedFaces: [
        { type: 'stableTopology', bodyRef: { partId: PART, bodyId: BODY }, stableFaceId: top.stableFaceId },
      ],
      thickness: '2',
    });

    const result = await buildShell(node, {} as ResolvedParams, ctx, kernel);
    const shelled = result.bodies[0]!.handle;

    const bb = await kernel.getBoundingBox(shelled);
    expect(bb.min).toEqual([expect.closeTo(0, 4), expect.closeTo(0, 4), expect.closeTo(0, 4)]);
    expect(bb.max).toEqual([expect.closeTo(10, 4), expect.closeTo(20, 4), expect.closeTo(30, 4)]);
    // 10×20×30 minus a 6×16×28 cavity open at the top.
    const { volume } = await kernel.getMassProperties(shelled);
    expect(volume).toBeCloseTo(6000 - 6 * 16 * 28, 3);
  });
});

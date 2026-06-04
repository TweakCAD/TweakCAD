/**
 * buildImportedGeometry tests with MockKernel.
 *
 * Covers the validation + dispatch paths. The actual STEP/STL parsing
 * lives in occt-wasm (kernel-side), tested separately by its own
 * vitest suite — here we just verify the builder routes inputs.format
 * to the right kernel call, decodes base64 → ArrayBuffer correctly,
 * and publishes per-body deterministic ids.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildImportedGeometry } from './buildImportedGeometry.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  ImportedGeometryFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { err, ok } from '@tweakcad/core/src/result.ts';
import { featureId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const STEP_HEADER = 'ISO-10303-21;\nHEADER;\n';

function makeNode(overrides: Partial<ImportedGeometryFeatureInputs> = {}): FeatureNode {
  const inputs: ImportedGeometryFeatureInputs = {
    fileName: 'cube.step',
    format: 'step',
    // btoa is browser/jsdom-only; use Buffer in Node for the test
    // setup. The builder uses the global atob at runtime.
    data: Buffer.from(STEP_HEADER).toString('base64'),
    ...overrides,
  };
  return {
    id: featureId('import_1'),
    type: 'importedGeometry',
    name: inputs.fileName,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

function emptyCtx(): BuildContext {
  return emptyBuildContext({} as ResolvedParams);
}

describe('buildImportedGeometry', () => {
  it('throws when data is empty', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeNode({ data: '' });
    await expect(buildImportedGeometry(node, {} as ResolvedParams, emptyCtx(), kernel))
      .rejects.toThrow(/empty data/);
  });

  it('throws on unsupported format', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const node = makeNode();
    (node.inputs as { format: string }).format = 'iges';
    await expect(buildImportedGeometry(node, {} as ResolvedParams, emptyCtx(), kernel))
      .rejects.toThrow(/Unsupported import format: iges/);
  });

  it('routes step to kernel.importStep with feature-derived origin', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const stepSpy = vi.spyOn(kernel, 'importStep');
    const stlSpy = vi.spyOn(kernel, 'importStl');

    await buildImportedGeometry(makeNode(), {} as ResolvedParams, emptyCtx(), kernel);

    expect(stepSpy).toHaveBeenCalledTimes(1);
    expect(stlSpy).not.toHaveBeenCalled();
    const [bufArg, originArg] = stepSpy.mock.calls[0]!;
    expect(bufArg).toBeInstanceOf(ArrayBuffer);
    // Round-tripped base64 → bytes should match the original header text
    expect(new TextDecoder().decode(new Uint8Array(bufArg))).toBe(STEP_HEADER);
    expect(originArg).toBe('import_import_1');
  });

  it('routes stl to kernel.importStl', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const stepSpy = vi.spyOn(kernel, 'importStep');
    const stlSpy = vi.spyOn(kernel, 'importStl');

    await buildImportedGeometry(
      makeNode({ fileName: 'mesh.stl', format: 'stl' }),
      {} as ResolvedParams,
      emptyCtx(),
      kernel,
    );

    expect(stlSpy).toHaveBeenCalledTimes(1);
    expect(stepSpy).not.toHaveBeenCalled();
  });

  it('publishes per-body deterministic ids derived from the feature', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    // Mock returns multiple bodies as if a STEP compound was decomposed
    vi.spyOn(kernel, 'importStep').mockResolvedValue(
      ok([
        { handle: 'mock_body_a', source: 'mock' },
        { handle: 'mock_body_b', source: 'mock' },
        { handle: 'mock_body_c', source: 'mock' },
      ]),
    );

    const result = await buildImportedGeometry(makeNode(), {} as ResolvedParams, emptyCtx(), kernel);

    expect(result.bodies).toHaveLength(3);
    expect(String(result.bodies[0]!.bodyId)).toBe('body_import_import_1_0');
    expect(String(result.bodies[1]!.bodyId)).toBe('body_import_import_1_1');
    expect(String(result.bodies[2]!.bodyId)).toBe('body_import_import_1_2');
    expect(result.outputs?.bodies?.main).toBe(result.bodies[0]!.bodyId);
    expect(result.outputs?.bodies?.['body_1']).toBe(result.bodies[1]!.bodyId);
  });

  it('throws when the kernel returns zero bodies', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'importStep').mockResolvedValue(ok([]));
    await expect(buildImportedGeometry(makeNode(), {} as ResolvedParams, emptyCtx(), kernel))
      .rejects.toThrow(/produced no bodies/);
  });

  it('propagates kernel.importStep failure as a build error with the filename', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    vi.spyOn(kernel, 'importStep').mockResolvedValue(
      err({ category: 'kernel', code: 'STEP_IMPORT_FAILED', message: 'unexpected EOF' }),
    );
    await expect(buildImportedGeometry(makeNode(), {} as ResolvedParams, emptyCtx(), kernel))
      .rejects.toThrow(/Import "cube.step" failed: unexpected EOF/);
  });
});

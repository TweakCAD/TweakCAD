/**
 * One malformed feature fails on its own; the rest of the part builds.
 *
 * The loader accepts a document whose feature nodes don't match the schema
 * and reports them per feature, so one bad node doesn't cost the whole file.
 * That only holds if the rebuild isolates the node too. A node without
 * `dependsOn` used to throw at `feature.dependsOn.find` — outside the
 * per-feature try — and the whole part failed to rebuild, independent
 * features included.
 *
 * The document goes through the real loader, then the real rebuilder.
 */
import { describe, expect, it } from 'vitest';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { loadCadDocument } from '@tweakcad/core/src/document/loader.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { serializeCadJson } from '@tweakcad/core/src/document/serialization.ts';
import { clearRebuildCache, incrementalRebuild } from './rebuilder.ts';

function box(id: string): Record<string, unknown> {
  return {
    id,
    type: 'primitive',
    name: id,
    version: 1,
    enabled: true,
    visible: true,
    inputs: {
      shape: { kind: 'box', width: '10', height: '10', depth: '10' },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      operation: 'newBody',
    },
    dependsOn: [],
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
}

async function loadAndRebuild(timeline: unknown[]) {
  const project = newProjectWithPart('P', 'Part 1');
  const partId = Object.keys(project.parts)[0]!;
  project.parts[partId as never]!.timeline = timeline as never;
  const loaded = loadCadDocument(serializeCadJson(project));
  if (!loaded.ok) throw new Error(`fixture did not load: ${loaded.error.message}`);

  clearRebuildCache();
  const kernel = new MockKernel();
  await kernel.init();
  const part = loaded.value.project.parts[partId as never]!;
  const result = await incrementalRebuild(part, loaded.value.project, kernel, 0);
  return { diagnostics: loaded.value.diagnostics, result };
}

describe('a malformed feature in a loaded document', () => {
  it('fails on its own when dependsOn is missing, and the independent feature after it builds', async () => {
    const broken = box('broken');
    delete broken['dependsOn'];

    const { diagnostics, result } = await loadAndRebuild([broken, box('good')]);

    // The loader kept it and said so.
    expect(diagnostics.map((d) => d.featureId)).toEqual(['broken']);
    expect(result.featureResults.map((r) => [r.featureId, r.status])).toEqual([
      ['broken', 'failed'],
      ['good', 'success'],
    ]);
    const failed = result.featureResults[0]!;
    expect(failed.status === 'failed' ? failed.error.code : '').toBe('MALFORMED_FEATURE');
    expect(failed.status === 'failed' ? failed.error.message : '').toContain('dependsOn');
    expect(result.bodies).toHaveLength(1);
  });

  it('fails a node without inputs or enabled the same way, instead of treating it as suppressed', async () => {
    const noInputs = box('no_inputs');
    delete noInputs['inputs'];
    const noEnabled = box('no_enabled');
    delete noEnabled['enabled'];

    const { result } = await loadAndRebuild([noInputs, noEnabled, box('good')]);

    expect(result.featureResults.map((r) => [r.featureId, r.status])).toEqual([
      ['no_inputs', 'failed'],
      ['no_enabled', 'failed'],
      ['good', 'success'],
    ]);
  });

  it('blocks a feature that declares a dependency on the malformed one', async () => {
    const broken = box('broken');
    delete broken['dependsOn'];
    const dependent = { ...box('dependent'), dependsOn: ['broken'] };

    const { result } = await loadAndRebuild([broken, dependent]);

    expect(result.featureResults.map((r) => r.status)).toEqual(['failed', 'blocked']);
  });
});

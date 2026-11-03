/**
 * Rebuild-cycle shape disposal.
 *
 * Nothing in the worker ever called `kernel.dispose`, despite
 * `cadWorker.reset`'s docstring claiming disposal was "managed within the
 * rebuild cycle". Measured against the real kernel, a document with a moved
 * 31,752-facet import accumulated +3 live bodies per rebuild, monotonically,
 * until the WASM heap ran out and tessellation failed with "Array buffer
 * allocation failed" — which surfaced as a body that silently stopped
 * rendering.
 *
 * These tests pin the two halves of the fix with MockKernel: shapes a feature
 * orphans are released during the rebuild, and the previous rebuild's
 * survivors are released when the next one starts.
 *
 * Each builds a part that has bodies, and asserts it did: these tests used to
 * rebuild an empty timeline, so their per-body checks ran zero times and the
 * throwing-dispose case had nothing to dispose.
 */
import { describe, expect, it, vi } from 'vitest';
import { incrementalRebuild, sweepPreviousRebuild, sweepRemovedParts, releaseRebuildBodies, clearRebuildCache } from './rebuilder.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { createPart, newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import type { CadPart, CadProject, FeatureNode } from '@tweakcad/core/src/document/schema.ts';

function firstPart(project: CadProject): CadPart {
  return Object.values(project.parts)[0]!;
}

function box(id: string, operation: 'newBody' | 'cut' = 'newBody'): FeatureNode {
  return {
    id, type: 'primitive', name: id, version: 1, enabled: true, visible: true,
    inputs: {
      shape: { kind: 'box', width: '10', height: '10', depth: '10' },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      operation,
    },
    dependsOn: [],
    createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
  } as unknown as FeatureNode;
}

/** A part with two separate bodies. */
function twoBodies(): CadProject {
  const project = newProjectWithPart('P', 'Part 1');
  firstPart(project).timeline = [box('a'), box('b')];
  return project;
}

/** Track every handle the kernel is asked to release. */
function spyDispose(kernel: MockKernel): string[] {
  const freed: string[] = [];
  vi.spyOn(kernel, 'dispose').mockImplementation((h) => { freed.push(h.handle); });
  return freed;
}

describe('rebuild-cycle disposal', () => {
  it('does not release the bodies of the rebuild it just produced', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = twoBodies();
    const freed = spyDispose(kernel);

    const result = await incrementalRebuild(firstPart(project), project, kernel, 0);
    expect(result.bodies).toHaveLength(2);
    // Whatever this rebuild produced must still be usable by the caller —
    // it is about to be tessellated and possibly exported.
    for (const b of result.bodies) {
      expect(freed).not.toContain((b.handle as { handle: string }).handle);
    }
  });

  it('sweeps the previous rebuild survivors when the next rebuild starts', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = twoBodies();

    const first = await incrementalRebuild(firstPart(project), project, kernel, 0);
    const survivors = first.bodies.map(b => (b.handle as { handle: string }).handle);
    expect(survivors).toHaveLength(2);

    const freed = spyDispose(kernel);
    sweepPreviousRebuild(kernel, String(firstPart(project).id));
    for (const h of survivors) expect(freed).toContain(h);
  });

  it('sweeping twice does not double-release', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = twoBodies();
    await incrementalRebuild(firstPart(project), project, kernel, 0);

    const freed = spyDispose(kernel);
    sweepPreviousRebuild(kernel, String(firstPart(project).id));
    const afterFirst = freed.length;
    expect(afterFirst).toBe(2);
    sweepPreviousRebuild(kernel, String(firstPart(project).id));
    expect(freed).toHaveLength(afterFirst);
  });

  it('sweeping a kernel that has never rebuilt is a no-op', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const freed = spyDispose(kernel);
    sweepPreviousRebuild(kernel, 'part_never_built');
    expect(freed).toHaveLength(0);
  });

  it('a dispose that throws never fails the sweep', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = twoBodies();
    await incrementalRebuild(firstPart(project), project, kernel, 0);

    const dispose = vi.spyOn(kernel, 'dispose').mockImplementation(() => { throw new Error('already released'); });
    // A missed free is a leak; a thrown one would lose the user's geometry.
    expect(() => sweepPreviousRebuild(kernel, String(firstPart(project).id))).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('releases a body a later feature consumed, during the rebuild', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = newProjectWithPart('P', 'Part 1');
    firstPart(project).timeline = [box('a'), box('cutter', 'cut')];
    const freed = spyDispose(kernel);

    const result = await incrementalRebuild(firstPart(project), project, kernel, 0);

    // The cut replaced body a's handle with its result; the old one and the
    // cutting tool are freed, the result is kept.
    expect(result.bodies).toHaveLength(1);
    expect(freed).toHaveLength(2);
    expect(freed).not.toContain((result.bodies[0]!.handle as { handle: string }).handle);
  });

  it('releaseRebuildBodies frees exactly the bodies it is handed', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const freed = spyDispose(kernel);
    releaseRebuildBodies(kernel, [
      { handle: { handle: 'body_a' } as never },
      { handle: { handle: 'body_b' } as never },
    ]);
    expect(freed).toEqual(['body_a', 'body_b']);
  });
});

describe('rebuild-cycle disposal across parts', () => {
  // One worker rebuilds every part, and the viewport shows them all at once.
  // Rebuilding part B used to free part A's bodies, so A — still on screen —
  // could no longer be measured.
  async function twoParts() {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = twoBodies();
    const a = firstPart(project);
    const b = createPart('B');
    b.timeline = [box('c')];
    project.parts[b.id] = b;
    const builtA = await incrementalRebuild(a, project, kernel, 0);
    const handlesA = builtA.bodies.map(x => (x.handle as { handle: string }).handle);
    expect(handlesA).toHaveLength(2);
    return { kernel, project, a, b, handlesA };
  }

  it("rebuilding one part leaves the other part's bodies alive", async () => {
    const { kernel, project, b, handlesA } = await twoParts();
    const freed = spyDispose(kernel);

    sweepPreviousRebuild(kernel, String(b.id));
    sweepRemovedParts(kernel, Object.keys(project.parts));
    await incrementalRebuild(b, project, kernel, 0);

    for (const h of handlesA) expect(freed).not.toContain(h);
  });

  it('frees the bodies of a part that left the document', async () => {
    const { kernel, project, a, b, handlesA } = await twoParts();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- id-keyed record
    delete (project.parts as Record<string, unknown>)[String(a.id)];
    const freed = spyDispose(kernel);

    sweepPreviousRebuild(kernel, String(b.id));
    sweepRemovedParts(kernel, Object.keys(project.parts));

    for (const h of handlesA) expect(freed).toContain(h);
  });
});

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
 */
import { describe, expect, it, vi } from 'vitest';
import { incrementalRebuild, sweepPreviousRebuild, releaseRebuildBodies, clearRebuildCache } from './rebuilder.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import type { CadPart, CadProject } from '@tweakcad/core/src/document/schema.ts';

function firstPart(project: CadProject): CadPart {
  return Object.values(project.parts)[0]!;
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
    const project = newProjectWithPart('P', 'Part 1');
    const freed = spyDispose(kernel);

    const result = await incrementalRebuild(firstPart(project), project, kernel, 0);
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
    const project = newProjectWithPart('P', 'Part 1');

    const first = await incrementalRebuild(firstPart(project), project, kernel, 0);
    const survivors = first.bodies.map(b => (b.handle as { handle: string }).handle);

    const freed = spyDispose(kernel);
    sweepPreviousRebuild(kernel);
    for (const h of survivors) expect(freed).toContain(h);
  });

  it('sweeping twice does not double-release', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = newProjectWithPart('P', 'Part 1');
    await incrementalRebuild(firstPart(project), project, kernel, 0);

    const freed = spyDispose(kernel);
    sweepPreviousRebuild(kernel);
    const afterFirst = freed.length;
    sweepPreviousRebuild(kernel);
    expect(freed).toHaveLength(afterFirst);
  });

  it('sweeping a kernel that has never rebuilt is a no-op', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const freed = spyDispose(kernel);
    sweepPreviousRebuild(kernel);
    expect(freed).toHaveLength(0);
  });

  it('a dispose that throws never fails the sweep', async () => {
    clearRebuildCache();
    const kernel = new MockKernel();
    await kernel.init();
    const project = newProjectWithPart('P', 'Part 1');
    await incrementalRebuild(firstPart(project), project, kernel, 0);

    vi.spyOn(kernel, 'dispose').mockImplementation(() => { throw new Error('already released'); });
    // A missed free is a leak; a thrown one would lose the user's geometry.
    expect(() => sweepPreviousRebuild(kernel)).not.toThrow();
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

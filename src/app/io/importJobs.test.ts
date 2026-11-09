import { afterEach, describe, expect, it } from 'vitest';
import type { ImportedShape, ImportProgress } from '@tweakcad/worker/src/v2/service/client';
import { ImportCancelled, cancelImports, importJobs, ownWorkerImports, type ImportWorker } from './importJobs';

const SHAPE = { bodies: 1 } as ImportedShape;
const BYTES = new Uint8Array([1, 2, 3]);

/** A worker whose import reports what the test sends and ends when the test says so. */
function fakeWorker() {
  const state: {
    terminated: boolean;
    report: (p: ImportProgress) => void;
    finish: (shape: ImportedShape) => void;
    fail: (e: Error) => void;
  } = { terminated: false, report: () => undefined, finish: () => undefined, fail: () => undefined };
  const worker: ImportWorker = {
    init: () => Promise.resolve(),
    importFile: (_bytes, _format, _feature, _name, onProgress) =>
      new Promise((resolve, reject) => {
        state.report = (p) => onProgress?.(p);
        state.finish = resolve;
        state.fail = reject;
      }),
    terminate: () => {
      state.terminated = true;
    },
  };
  return { worker, state };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const labels = () => importJobs.getState().jobs.map((j) => j.status.label);

afterEach(() => importJobs.setState({ jobs: [] }));

describe('imports on a worker of their own', () => {
  it('lists the import with its progress while it runs, then stops its worker', async () => {
    const { worker, state } = fakeWorker();
    const pending = ownWorkerImports(() => worker).importFile(BYTES, 'stl', 'feat_A', 'board.stl');
    expect(labels()).toEqual(['Starting the kernel']);
    await settle();
    state.report({ stage: 'sewing', triangles: 93422 });
    expect(labels()).toEqual(['Sewing 93,422 triangles']);
    state.report({ stage: 'solids', done: 3, total: 39 });
    expect(importJobs.getState().jobs[0]?.status).toEqual({ label: 'Making solids', done: 3, total: 39 });
    state.finish(SHAPE);
    expect(await pending).toBe(SHAPE);
    expect(state.terminated).toBe(true);
    expect(importJobs.getState().jobs).toEqual([]);
  });

  it('ends a cancelled import at once, as ImportCancelled, and stops its worker', async () => {
    const { worker, state } = fakeWorker();
    const pending = ownWorkerImports(() => worker).importFile(BYTES, 'stl', 'feat_A', 'board.stl');
    await settle();
    importJobs.getState().jobs[0]?.cancel();
    await expect(pending).rejects.toBeInstanceOf(ImportCancelled);
    expect(state.terminated).toBe(true);
    expect(importJobs.getState().jobs).toEqual([]);
  });

  it('cancels every import under way, as when another document opens', async () => {
    const a = fakeWorker();
    const b = fakeWorker();
    const workers = [a.worker, b.worker];
    const imports = ownWorkerImports(() => workers.shift() as ImportWorker);
    const first = imports.importFile(BYTES, 'stl', 'feat_A', 'a.stl');
    const second = imports.importFile(BYTES, 'step', 'feat_B', 'b.step');
    expect(importJobs.getState().jobs.map((j) => j.name)).toEqual(['a.stl', 'b.step']);
    cancelImports();
    await expect(first).rejects.toBeInstanceOf(ImportCancelled);
    await expect(second).rejects.toBeInstanceOf(ImportCancelled);
    expect([a.state.terminated, b.state.terminated]).toEqual([true, true]);
  });

  it('passes a failed import on, and stops its worker', async () => {
    const { worker, state } = fakeWorker();
    const pending = ownWorkerImports(() => worker).importFile(BYTES, 'stl', 'feat_A', 'board.stl');
    await settle();
    state.fail(new Error('This STL mesh is not closed'));
    await expect(pending).rejects.toThrow('This STL mesh is not closed');
    expect(state.terminated).toBe(true);
  });
});

/**
 * Geometry imports under way. Each reads its file on a worker of its own,
 * so the document's worker stays free while a large file is read (the
 * window keeps building, and New or Open work at once), and Cancel stops
 * the import by stopping that worker: a kernel call cannot be interrupted
 * any other way. The list is what the toolbar shows while imports run.
 */
import { createStore } from 'zustand/vanilla';
import type { ImportFormat, ImportedShape, ImportProgress } from '@tweakcad/worker/src/v2/service/client';
import type { BuildStatus } from '../display/status';
import type { GeometryClient } from './geometry';

export interface ImportJob {
  id: number;
  /** The file's name. */
  name: string;
  /** What the import is doing now. */
  status: BuildStatus;
  /** When it started, as `Date.now()`. */
  since: number;
  /** Stops the import; it ends as `ImportCancelled`. */
  cancel(): void;
}

export const importJobs = createStore<{ jobs: ImportJob[] }>(() => ({ jobs: [] }));

/** How an import ends when it is cancelled. */
export class ImportCancelled extends Error {
  constructor() {
    super('The import was cancelled');
  }
}

/** The worker an import runs on: loaded, asked to import once, then stopped. */
export interface ImportWorker {
  init(): Promise<unknown>;
  importFile(
    bytes: Uint8Array,
    format: ImportFormat,
    name: string,
    onProgress?: (p: ImportProgress) => void,
  ): Promise<ImportedShape>;
  terminate(): void;
}

/** The status an import's progress shows. */
export function importStatus(p: ImportProgress, name: string): BuildStatus {
  switch (p.stage) {
    case 'reading':
      return { label: `Reading ${name}` };
    case 'sewing':
      return { label: `Sewing ${p.triangles.toLocaleString('en-US')} triangles` };
    case 'solids':
      return { label: 'Making solids', done: p.done, total: p.total };
  }
}

/** Cancels every import under way: the document they were for is closed. */
export function cancelImports(): void {
  for (const job of importJobs.getState().jobs) job.cancel();
}

let nextJob = 0;

const setStatus = (id: number, status: BuildStatus) =>
  importJobs.setState(({ jobs }) => ({ jobs: jobs.map((j) => (j.id === id ? { ...j, status } : j)) }));

/** A `GeometryClient` whose every import runs on a worker of its own from `spawn`, listed in `importJobs` while it runs. */
export function ownWorkerImports(spawn: () => ImportWorker): GeometryClient {
  return {
    async importFile(bytes, format, name) {
      const id = ++nextJob;
      const worker = spawn();
      let cancel: () => void = () => undefined;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new ImportCancelled());
      });
      // A cancel after the import ended is heard by no one.
      cancelled.catch(() => undefined);
      importJobs.setState(({ jobs }) => ({
        jobs: [...jobs, { id, name, status: { label: 'Starting the kernel' }, since: Date.now(), cancel }],
      }));
      const run = async () => {
        await worker.init();
        return worker.importFile(bytes, format, name, (p) => setStatus(id, importStatus(p, name)));
      };
      try {
        return await Promise.race([run(), cancelled]);
      } finally {
        worker.terminate();
        importJobs.setState(({ jobs }) => ({ jobs: jobs.filter((j) => j.id !== id) }));
      }
    },
  };
}

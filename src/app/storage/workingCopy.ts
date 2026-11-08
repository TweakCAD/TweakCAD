/**
 * The working copy of open documents in this browser, in IndexedDB, so a
 * reload or a crash comes back to the work. Documents are kept as their
 * canonical text, which reloads byte for byte. The database holds version-2
 * documents only, under a name no other store uses.
 */

export const WORKING_COPY_DB = 'tweakcad-documents-v2';
const STORE = 'documents';

/**
 * Where the document came from, so a restored copy can say so. The file
 * handle is not kept. A cloud project's copy is the record `cloudRecordId`
 * names, one per project.
 */
export type StorageSnapshot =
  { kind: 'unsaved' } | { kind: 'disk'; filename: string } | { kind: 'cloud'; projectId: string; name: string };

/** The working-copy record of cloud project `projectId`. */
export function cloudRecordId(projectId: string): string {
  return `cloud-${projectId}`;
}

/** Whether record `id` is a cloud project's copy. */
export function isCloudRecord(id: string | null): boolean {
  return id !== null && id.startsWith('cloud-');
}

export interface WorkingCopyRecord {
  id: string;
  name: string;
  /** The document as `saveDocument` writes it. */
  text: string;
  /** ISO time of the write. */
  updatedAt: string;
  storage: StorageSnapshot;
}

export interface WorkingCopyStore {
  put(record: WorkingCopyRecord): Promise<void>;
  get(id: string): Promise<WorkingCopyRecord | undefined>;
  mostRecent(): Promise<WorkingCopyRecord | undefined>;
  clearAll(): Promise<void>;
}

/** The newest of `records`, by write time. */
export function newest(records: readonly WorkingCopyRecord[]): WorkingCopyRecord | undefined {
  return records.reduce<WorkingCopyRecord | undefined>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), undefined);
}

/** An in-memory store, for tests and for browsers without IndexedDB. */
export class MemoryWorkingCopy implements WorkingCopyStore {
  readonly records = new Map<string, WorkingCopyRecord>();

  put(record: WorkingCopyRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
    return Promise.resolve();
  }

  get(id: string): Promise<WorkingCopyRecord | undefined> {
    const r = this.records.get(id);
    return Promise.resolve(r && structuredClone(r));
  }

  mostRecent(): Promise<WorkingCopyRecord | undefined> {
    return Promise.resolve(newest([...this.records.values()]));
  }

  clearAll(): Promise<void> {
    this.records.clear();
    return Promise.resolve();
  }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedDbWorkingCopy implements WorkingCopyStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly name = WORKING_COPY_DB) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    }).catch((e: unknown) => {
      this.db = null;
      throw e;
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async put(record: WorkingCopyRecord): Promise<void> {
    await request((await this.store('readwrite')).put(record));
  }

  async get(id: string): Promise<WorkingCopyRecord | undefined> {
    return (await request((await this.store('readonly')).get(id))) as WorkingCopyRecord | undefined;
  }

  async mostRecent(): Promise<WorkingCopyRecord | undefined> {
    return newest((await request((await this.store('readonly')).getAll())) as WorkingCopyRecord[]);
  }

  async clearAll(): Promise<void> {
    await request((await this.store('readwrite')).clear());
  }
}

/** IndexedDB where the browser has it, otherwise memory (the copy then lasts the session). */
export function defaultWorkingCopy(): WorkingCopyStore {
  return typeof indexedDB === 'undefined' ? new MemoryWorkingCopy() : new IndexedDbWorkingCopy();
}

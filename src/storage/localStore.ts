/**
 * Native IndexedDB wrapper for local CAD document persistence.
 * Implements the offline-first invariant from cad-architecture.md §2:
 * the editor must remain usable without an account or network.
 *
 * Schema (v2):
 *   - DB: cadapp
 *   - Store: projects, keyPath = 'id'
 *     Records: { id, name, doc, thumbnail?, updatedAt,
 *                cloudProjectId?, storage? }
 *     The `storage` field captures the doc's origin (disk filename or
 *     cloud project) so crash-recovery can restore it correctly.
 *
 * v1 → v2: column-additive only — no data migration needed. Records that
 * predate v2 just have `storage === undefined`; we treat those as
 * `{kind:'unsaved'}` (or `{kind:'cloud',...}` when cloudProjectId is set).
 */
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';

const DB_NAME = 'cadapp';
const DB_VERSION = 2;
const STORE_PROJECTS = 'projects';

/**
 * Snapshot of DocumentStorage stored in IDB. The FileSystemFileHandle is
 * intentionally omitted — handles CAN be persisted in IDB, but the
 * permission grant doesn't survive across browser sessions, so we'd have
 * to re-prompt the user anyway. Skipping the handle keeps the schema
 * simpler; the user re-Opens the original file from disk to re-attach.
 */
export type StorageSnapshot =
  | { kind: 'unsaved' }
  | { kind: 'disk'; filename: string; lastSavedAt: number | null }
  | { kind: 'cloud'; projectId: string; slug: string };

export type LocalProjectRecord = {
  /** Local identifier. Distinct from cloud projectId. */
  id: string;
  name: string;
  doc: CadProject;
  thumbnail?: Blob;
  updatedAt: string;
  /** When set, this local project mirrors a cloud project of that ID. */
  cloudProjectId?: string;
  /** Origin of the doc — added in schema v2. Older records lack this field. */
  storage?: StorageSnapshot;
};

/**
 * Backfill a missing `storage` field for legacy v1 records.
 * Pure function — callers decide what to do with the result.
 */
export function inferStorage(record: LocalProjectRecord): StorageSnapshot {
  if (record.storage) return record.storage;
  if (record.cloudProjectId) {
    return { kind: 'cloud', projectId: record.cloudProjectId, slug: record.name };
  }
  return { kind: 'unsaved' };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      // v0 → v1: initial schema
      if (oldVersion < 1) {
        const store = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        store.createIndex('byUpdatedAt', 'updatedAt');
        store.createIndex('byCloudProjectId', 'cloudProjectId', { unique: false });
      }
      // v1 → v2: added `storage` field on each record. No-op migration —
      // the field is optional and missing values are inferred at read time
      // via inferStorage(). The schema change is additive only; we bump
      // the version number so a future write of an updated record
      // structure doesn't surprise the open() call.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = fn(store);
        let result: T | undefined;
        if (req) {
          req.onsuccess = () => {
            result = req.result;
          };
          req.onerror = () => reject(req.error);
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Tx aborted'));
      }),
  );
}

export const localStore = {
  async put(record: LocalProjectRecord): Promise<void> {
    await run(STORE_PROJECTS, 'readwrite', (store) => void store.put(record));
  },

  async get(id: string): Promise<LocalProjectRecord | undefined> {
    return run<LocalProjectRecord>(STORE_PROJECTS, 'readonly', (store) => store.get(id));
  },

  async delete(id: string): Promise<void> {
    await run(STORE_PROJECTS, 'readwrite', (store) => void store.delete(id));
  },

  /**
   * Wipe every locally-stored project. Used by the `?reset` boot escape
   * hatch (see `boot.ts`) to recover from a persisted document that's too
   * heavy to rebuild — the worker would OOM on load and wedge the UI
   * before any in-app "new document" action is reachable.
   */
  async clearAll(): Promise<void> {
    await run(STORE_PROJECTS, 'readwrite', (store) => void store.clear());
  },

  async listAll(): Promise<LocalProjectRecord[]> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result as LocalProjectRecord[]);
      req.onerror = () => reject(req.error);
    });
  },

  async getByCloudProjectId(cloudProjectId: string): Promise<LocalProjectRecord | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const idx = tx.objectStore(STORE_PROJECTS).index('byCloudProjectId');
      const req = idx.get(cloudProjectId);
      req.onsuccess = () => resolve(req.result as LocalProjectRecord | undefined);
      req.onerror = () => reject(req.error);
    });
  },

  async mostRecent(): Promise<LocalProjectRecord | undefined> {
    const all = await this.listAll();
    if (all.length === 0) return undefined;
    return all.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  },
};

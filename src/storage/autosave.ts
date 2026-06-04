/**
 * Autosave scheduler.
 *
 * Subscribes to a DocumentStore and routes saves to whichever backend the
 * current ProjectContext targets (cloud or local-only). Local IDB always
 * gets a copy as a safety net, even for cloud projects, so an offline blip
 * never loses work.
 */
import type { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';
import { localStore, type LocalProjectRecord, type StorageSnapshot } from './localStore.ts';
import { saveCloudProject } from './cloudAdapter.ts';
import type { ProjectContext } from './context.ts';
import type { DocumentStorage } from './documentStorage.ts';

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'offline'; queued: number }
  | { kind: 'error'; message: string };

export type AutosaveOptions = {
  debounceMs?: number;
};

export class AutosaveScheduler {
  private context: ProjectContext;
  /** Sticky storage of the open doc — included in each IDB save so crash
   *  recovery on next boot knows whether it was a disk doc, cloud doc, or
   *  unsaved. */
  private storage: DocumentStorage | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: CadProject | null = null;
  private inFlight = false;
  private status: SaveStatus = { kind: 'idle' };
  private listeners = new Set<(s: SaveStatus) => void>();
  private debounceMs: number;
  private retryDelay = 5_000;
  private offlineRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(context: ProjectContext, opts: AutosaveOptions = {}) {
    this.context = context;
    this.debounceMs = opts.debounceMs ?? 2_000;
  }

  attach(store: DocumentStore): () => void {
    return store.subscribe((state) => this.notifyChange(state));
  }

  setContext(next: ProjectContext): void {
    this.context = next;
  }

  /**
   * Track the doc's current storage origin so each IDB write captures it.
   * Called by App.tsx whenever storage changes (Save As, Open from disk, etc.).
   */
  setStorage(next: DocumentStorage): void {
    this.storage = next;
  }

  getStatus(): SaveStatus {
    return this.status;
  }

  onStatus(fn: (s: SaveStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  notifyChange(doc: CadProject): void {
    this.pending = doc;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Force an immediate flush. Useful for "Save now" UI affordances. */
  async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private setStatus(next: SaveStatus): void {
    this.status = next;
    for (const fn of this.listeners) fn(next);
  }

  private async flush(): Promise<void> {
    if (!this.pending || this.inFlight) return;
    const doc = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.setStatus({ kind: 'saving' });

    try {
      // Local mirror always — survives offline + cloud failures.
      await this.saveLocal(doc);
      // Cloud (best effort).
      if (this.context.kind === 'cloud') {
        await saveCloudProject(this.context.cloudProjectId, doc);
      }
      this.setStatus({ kind: 'saved', at: Date.now() });
    } catch (err) {
      const e = err as Error;
      console.warn('[autosave] save failed', e);
      // If cloud-bound and likely a transient/offline failure, retry later.
      if (this.context.kind === 'cloud') {
        this.setStatus({ kind: 'offline', queued: 1 });
        this.scheduleRetry(doc);
      } else {
        this.setStatus({ kind: 'error', message: e.message });
      }
    } finally {
      this.inFlight = false;
      // If new changes came in while we were saving, schedule another pass.
      if (this.pending) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.debounceMs);
      }
    }
  }

  private scheduleRetry(doc: CadProject): void {
    if (this.offlineRetryTimer) clearTimeout(this.offlineRetryTimer);
    this.offlineRetryTimer = setTimeout(() => {
      this.pending = doc;
      this.flush();
    }, this.retryDelay);
  }

  private async saveLocal(doc: CadProject): Promise<void> {
    const localId =
      this.context.kind === 'local-stored'
        ? this.context.localId
        : this.context.kind === 'cloud'
          ? `cloud-mirror-${this.context.cloudProjectId}`
          : `unsaved`;

    const record: LocalProjectRecord = {
      id: localId,
      name: doc.metadata.name,
      doc,
      updatedAt: new Date().toISOString(),
      ...(this.context.kind === 'cloud'
        ? { cloudProjectId: this.context.cloudProjectId }
        : {}),
      ...(this.storage ? { storage: storageSnapshot(this.storage) } : {}),
    };
    await localStore.put(record);
  }
}

/**
 * Strip the FileSystemFileHandle from a DocumentStorage so the snapshot
 * is plain data — IndexedDB can store handles, but the permission grant
 * doesn't survive across browser sessions so re-attaching requires an
 * Open dialog anyway. Cleaner to just record the filename and re-prompt.
 */
function storageSnapshot(s: DocumentStorage): StorageSnapshot {
  switch (s.kind) {
    case 'unsaved':
      return { kind: 'unsaved' };
    case 'disk':
      return { kind: 'disk', filename: s.filename, lastSavedAt: s.lastSavedAt };
    case 'cloud':
      return { kind: 'cloud', projectId: s.projectId, slug: s.slug };
  }
}

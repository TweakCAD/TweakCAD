/**
 * Writes the open document to the working copy shortly after each change,
 * so nothing is lost to a reload or a crash, and, for a cloud project, to
 * the project's live document after it. A document without a record gets
 * one on its first write; the record's id goes into the address bar
 * (`?local=`), which is what brings a reload back to this document. A cloud
 * project's record is named by the project, and its address by `?project=`.
 *
 * What it writes is always the live document: while another is shown
 * read-only (a revision's preview), showing it or the live one again is no
 * change to write, and a write still pending writes the live document held.
 */
import { saveDocument, type Doc, type Editor } from '@tweakcad/editor';
import type { StorageSnapshot, WorkingCopyStore } from './workingCopy';

export type AutosaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  /**
   * The cloud could not be reached; the work is in the working copy and the
   * write is retried. `queued`: the edits made since the cloud last took
   * the document.
   */
  | { kind: 'offline'; queued: number }
  /**
   * The cloud refused the write: another tab or device moved the project.
   * Not retried, since retrying would replace that work with this tab's.
   */
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

/** Where a cloud project's live document is written. */
export interface CloudWriter {
  save(projectId: string, doc: Doc): Promise<unknown>;
}

export interface AutosaveOptions {
  debounceMs?: number;
  /** How long after a failed cloud write it is tried again. */
  retryMs?: number;
  /** A new record id. */
  mintId: () => string;
  /** Told the record id when one is minted. */
  onMinted?: (id: string) => void;
  cloud?: CloudWriter | null;
  /** Whether a cloud error is a conflict (`CloudConflictError`). */
  isConflict?: (err: unknown) => boolean;
}

export class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private skipReplace = false;
  /** Whether a change waiting to be written is an edit; the write of a document as it was opened is not one, and shows no status. */
  private edited = false;
  private writing: Promise<void> | null = null;
  private status: AutosaveStatus = { kind: 'idle' };
  private readonly listeners = new Set<(s: AutosaveStatus) => void>();
  private readonly debounceMs: number;
  private readonly retryMs: number;
  /** Edits made since the document was opened, and how many of them the cloud has. */
  private edits = 0;
  private sent = 0;

  constructor(
    private readonly editor: Editor,
    private readonly store: WorkingCopyStore,
    private localId: string | null,
    private storage: StorageSnapshot,
    private readonly options: AutosaveOptions,
    /** The cloud project the document is written to, or null. */
    private cloudProject: string | null = null,
  ) {
    this.debounceMs = options.debounceMs ?? 2_000;
    this.retryMs = options.retryMs ?? 5_000;
  }

  /** Saves after document changes; returns the stop function. */
  attach(): () => void {
    const off = this.editor.store.subscribe((change) => {
      if (change.cause === 'readOnly' || change.cause === 'live') return;
      // A new, untouched document leaves no record behind until it is edited.
      if (change.cause === 'replace' && this.skipReplace) {
        this.skipReplace = false;
        return;
      }
      // A document opened in place of the last is written as it is, quietly: nothing was edited yet.
      this.changed(change.cause === 'replace');
    });
    return () => {
      off();
      this.clearTimers();
    };
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  get recordId(): string | null {
    return this.localId;
  }

  /** The cloud project written to, or null. */
  get project(): string | null {
    return this.cloudProject;
  }

  /**
   * Another document: it gets a record of its own on its first write (or
   * the record `localId` names). With `keep` false, its loading is not
   * written; its first edit is.
   */
  reset(localId: string | null, storage: StorageSnapshot, keep = true, cloudProject: string | null = null): void {
    this.clearTimers();
    this.dirty = false;
    this.localId = localId;
    this.storage = storage;
    this.cloudProject = cloudProject;
    this.edits = 0;
    this.sent = 0;
    this.edited = false;
    this.skipReplace = !keep;
    this.setStatus({ kind: 'idle' });
  }

  setStorage(storage: StorageSnapshot): void {
    this.storage = storage;
  }

  /** The next replacement of the document (a restore read back) is not written. */
  skipNextReplace(): void {
    this.skipReplace = true;
  }

  getStatus(): AutosaveStatus {
    return this.status;
  }

  onStatus(listener: (s: AutosaveStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /** Writes the document a moment after this; `quiet` for a write that is not an edit (a document just opened), which the status does not show. */
  changed(quiet = false): void {
    this.dirty = true;
    if (!quiet) this.edited = true;
    this.edits++;
    if (this.status.kind === 'offline') this.setStatus({ kind: 'offline', queued: this.edits - this.sent });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Writes now if anything changed since the last write. */
  async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private async flush(): Promise<void> {
    // One write at a time; a change during a write is written after it.
    while (this.writing) await this.writing;
    if (!this.dirty) return;
    this.dirty = false;
    this.writing = this.write().finally(() => {
      this.writing = null;
    });
    await this.writing;
  }

  private async write(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const shown = this.edited;
    this.edited = false;
    if (shown) this.setStatus({ kind: 'saving' });
    if (this.localId === null) {
      this.localId = this.options.mintId();
      this.options.onMinted?.(this.localId);
    }
    const doc = this.editor.store.liveDocument;
    const edits = this.edits;
    const name = (doc.metadata as { name?: unknown } | undefined)?.name;
    try {
      await this.store.put({
        id: this.localId,
        name: typeof name === 'string' ? name : '',
        text: saveDocument(doc),
        updatedAt: new Date().toISOString(),
        storage: this.storage,
      });
    } catch (e) {
      this.setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    const project = this.cloudProject;
    if (project !== null && this.options.cloud) {
      try {
        await this.options.cloud.save(project, doc);
      } catch (e) {
        if (this.options.isConflict?.(e)) {
          this.setStatus({ kind: 'conflict', message: e instanceof Error ? e.message : String(e) });
          return;
        }
        console.warn('[autosave] cloud save failed', e);
        // The working copy has the work, so trying again is safe.
        this.setStatus({ kind: 'offline', queued: this.edits - this.sent });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.dirty = true;
          void this.flush();
        }, this.retryMs);
        return;
      }
    }
    this.sent = edits;
    if (shown || this.status.kind !== 'idle') this.setStatus({ kind: 'saved', at: Date.now() });
  }

  private setStatus(status: AutosaveStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

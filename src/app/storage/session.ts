/**
 * The open document's life: what boot opens, New, Open, Save and Save As,
 * and a cloud project's revisions. One editor holds the document for the
 * whole session; opening another replaces its document and clears its
 * history, as a load does.
 *
 * A revision is previewed read-only: the editor shows it in place of the
 * live document, which stays held with its undo history and is the only
 * one autosave writes. Closing the preview shows the live document again;
 * Restore is the one way a revision becomes the live document.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { loadDocument, saveDocument, type Doc, type Editor, type IdGenerator } from '@tweakcad/editor';
import { newDocument } from '../document';
import type { OpenedFile, SavedFile } from './disk';
import { safeFileName } from './disk';
import type { Autosave } from './autosave';
import type { CloudProjects, CloudRevision } from './cloud';
import { cloudRecordId, isCloudRecord, type StorageSnapshot, type WorkingCopyStore } from './workingCopy';

/**
 * Where Save writes: nowhere yet, a file on disk (its handle, where the
 * browser gives one), or a cloud project.
 */
export type DocumentStorage =
  | { kind: 'unsaved' }
  | { kind: 'disk'; handle: FileSystemFileHandle | null; filename: string }
  | { kind: 'cloud'; projectId: string; name: string };

export interface DiskApi {
  openFileFromDisk(): Promise<OpenedFile | null>;
  writeToHandle(handle: FileSystemFileHandle, text: string): Promise<SavedFile>;
  saveFileAs(text: string, suggestedName: string): Promise<SavedFile | null>;
}

export type FileOutcome = { ok: true } | { ok: false; message: string } | { ok: 'cancelled' };

export function snapshotOf(storage: DocumentStorage): StorageSnapshot {
  switch (storage.kind) {
    case 'disk':
      return { kind: 'disk', filename: storage.filename };
    case 'cloud':
      return { kind: 'cloud', projectId: storage.projectId, name: storage.name };
    default:
      return { kind: 'unsaved' };
  }
}

/**
 * Whether New or Open asks before replacing the document: not when it was
 * not edited since it was opened or made (there is nothing to lose), nor
 * for an unsaved document with nothing waiting to be written.
 */
export function asksBeforeReplacing(o: {
  edited: boolean;
  storage: DocumentStorage['kind'];
  autosave: string;
}): boolean {
  if (!o.edited) return false;
  return !(o.storage === 'unsaved' && o.autosave === 'idle');
}

/** The plain message for a cloud write another tab or device got in before. */
export const CONFLICT_MESSAGE =
  'This project changed somewhere else since you opened it. Reload to get the current version before saving again.';

/** The notice for files of a cloud document that could not be fetched. */
export function missingFilesNotice(missing: readonly string[]): { title: string; message: string } {
  return {
    title: 'Some files did not load',
    message: `${missing.join(', ')} could not be loaded. The features that use ${missing.length === 1 ? 'it' : 'them'} pause until ${missing.length === 1 ? 'it loads' : 'they load'}.`,
  };
}

export interface BootOptions {
  workingCopy: WorkingCopyStore;
  /** The record the address names (`?local=`), if any. */
  localId: string | null;
  /** Wipe the working copy and start blank (`?reset`). */
  reset: boolean;
  ids: IdGenerator;
  /** The name of a new document. */
  name: () => string;
}

export interface BootResult {
  doc: Doc;
  /** The working-copy record the document is written to, or null for one made on its first write. */
  localId: string | null;
  /** What that record says about where the document came from. */
  storage: StorageSnapshot;
  /** Where Save writes. */
  session: DocumentStorage;
  /** Something to tell the user about what boot opened. */
  /** `reopen`: the notice offers to open the original file again. */
  notice?: { title?: string; message: string; reopen?: boolean };
}

/** The storage a restored record opens with: a file comes back without its handle; a cloud copy comes back detached. */
function sessionOf(snapshot: StorageSnapshot): DocumentStorage {
  return snapshot.kind === 'disk' ? { kind: 'disk', handle: null, filename: snapshot.filename } : { kind: 'unsaved' };
}

/** A new document, written to a fresh record on its first edit. */
export function freshBoot(o: Pick<BootOptions, 'ids' | 'name'>, notice?: BootResult['notice']): BootResult {
  return {
    doc: newDocument({ ids: o.ids, name: o.name() }),
    localId: null,
    storage: { kind: 'unsaved' },
    session: { kind: 'unsaved' },
    ...(notice ? { notice } : {}),
  };
}

/**
 * The document to open at boot from the working copy: the record the
 * address names, otherwise the most recently written one, otherwise a new
 * document.
 */
export async function bootDocument(o: BootOptions): Promise<BootResult> {
  const fresh = (notice?: BootResult['notice']) => freshBoot(o, notice);
  if (o.reset) {
    await o.workingCopy.clearAll().catch(() => undefined);
    return fresh();
  }
  let record;
  try {
    record = o.localId !== null ? await o.workingCopy.get(o.localId) : await o.workingCopy.mostRecent();
  } catch (e) {
    return fresh({
      message: `This browser's copy of your work could not be read: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!record) {
    return o.localId !== null
      ? fresh({ message: 'The document this address names is not in this browser, so a new one was started.' })
      : fresh();
  }
  const loaded = loadDocument(record.text);
  if (!loaded.ok) return fresh({ message: `The document kept in this browser could not be opened. ${loaded.message}` });
  const notice =
    record.storage.kind === 'disk'
      ? {
          title: 'Restored from your last session',
          message: `Showing the work kept for "${record.storage.filename}". The original file is no longer attached: Open it again to save back to it, or Save to write a new file.`,
          reopen: true,
        }
      : record.storage.kind === 'cloud'
        ? {
            title: 'Restored from your last session',
            message: `Showing the copy of "${record.storage.name}" kept in this browser. Changes stay in this browser; open the project from your account to work on it there.`,
          }
        : undefined;
  return {
    doc: loaded.document,
    localId: record.id,
    storage: record.storage,
    session: sessionOf(record.storage),
    ...(notice ? { notice } : {}),
  };
}

/**
 * This browser's copy of cloud project `projectId`, opened detached: it
 * writes to its own record and nowhere else, since bound to the project its
 * first autosave would replace the server's copy with one that may be older.
 */
export async function cloudCopy(
  workingCopy: WorkingCopyStore,
  projectId: string,
  why: string,
): Promise<BootResult | null> {
  const record = await workingCopy.get(cloudRecordId(projectId)).catch(() => undefined);
  if (!record) return null;
  const loaded = loadDocument(record.text);
  if (!loaded.ok) return null;
  return {
    doc: loaded.document,
    localId: record.id,
    storage: record.storage,
    session: { kind: 'unsaved' },
    notice: { message: `${why} Showing the copy saved in this browser; changes stay in this browser.` },
  };
}

/** The revision shown read-only in place of the live document. */
export interface RevisionPreview {
  revisionId: string;
  /** How the revision is named to the user. */
  label: string;
}

/** Why a file command waits while a revision is previewed. */
export const PREVIEW_MESSAGE = 'A revision is shown read-only. Close the preview first.';

export interface SessionState {
  storage: DocumentStorage;
  /** The revision previewed, or null while the live document shows. */
  preview: RevisionPreview | null;
}

export interface SessionOptions {
  editor: Editor;
  disk: DiskApi;
  autosave: Autosave | null;
  ids: IdGenerator;
  /** The name of a new document. */
  newName: () => string;
  storage?: DocumentStorage;
  /** Cloud projects, when the site is there. */
  cloud?: CloudProjects | null;
  /** Told when the document has a fresh working-copy record (New and Open). */
  onRebound?: () => void;
  /** Told when the document's storage changes, so the address names it. */
  onStorage?: (storage: DocumentStorage, localId: string | null) => void;
}

export class DocumentSession {
  readonly state: StoreApi<SessionState>;
  private readonly editor: Editor;
  private readonly disk: DiskApi;
  private readonly autosave: Autosave | null;
  private readonly ids: IdGenerator;
  private readonly newName: () => string;
  private readonly cloud: CloudProjects | null;
  private readonly onRebound: () => void;
  private readonly onStorage: (storage: DocumentStorage, localId: string | null) => void;
  /** Counts preview requests and their ends, so a revision fetched after its preview was closed or replaced is not shown. */
  private previewTurn = 0;

  constructor(o: SessionOptions) {
    this.editor = o.editor;
    this.disk = o.disk;
    this.autosave = o.autosave;
    this.ids = o.ids;
    this.newName = o.newName;
    this.cloud = o.cloud ?? null;
    this.onRebound = o.onRebound ?? (() => undefined);
    this.onStorage = o.onStorage ?? (() => undefined);
    this.state = createStore<SessionState>(() => ({ storage: o.storage ?? { kind: 'unsaved' }, preview: null }));
  }

  get storage(): DocumentStorage {
    return this.state.getState().storage;
  }

  /** The revision previewed, or null. */
  get preview(): RevisionPreview | null {
    return this.state.getState().preview;
  }

  /** The cloud project Save writes to, or null. */
  get cloudProject(): string | null {
    const s = this.storage;
    return s.kind === 'cloud' ? s.projectId : null;
  }

  private setStorage(storage: DocumentStorage): void {
    this.state.setState({ storage });
    this.autosave?.setStorage(snapshotOf(storage));
  }

  /** Replaces the document with `doc`, which gets a working-copy record of its own; `keep` writes it there at once. */
  private adopt(doc: Doc, storage: DocumentStorage, keep: boolean): void {
    this.autosave?.reset(null, snapshotOf(storage), keep);
    // The load ends a preview, with the live document it held.
    this.previewTurn++;
    this.editor.store.replace(doc);
    this.state.setState({ preview: null });
    this.setStorage(storage);
    this.onRebound();
  }

  newDocument(): void {
    this.adopt(newDocument({ ids: this.ids, name: this.newName() }), { kind: 'unsaved' }, false);
  }

  /** Opens a `.cadjson` text; a version-1 or unreadable document is refused with a plain message. */
  openText(text: string, file?: { filename: string; handle: FileSystemFileHandle | null }): FileOutcome {
    const loaded = loadDocument(text);
    if (!loaded.ok) return { ok: false, message: loaded.message };
    this.adopt(
      loaded.document,
      file ? { kind: 'disk', handle: file.handle, filename: file.filename } : { kind: 'unsaved' },
      true,
    );
    return { ok: true };
  }

  async open(): Promise<FileOutcome> {
    const file = await this.disk.openFileFromDisk();
    if (!file) return { ok: 'cancelled' };
    return this.openText(file.text, { filename: file.filename, handle: file.handle });
  }

  /** What the last cloud write left to tell the user, or null when it went through. */
  private cloudProblem(): string | null {
    const status = this.autosave?.getStatus();
    if (status?.kind === 'conflict') return CONFLICT_MESSAGE;
    if (status?.kind === 'offline')
      return 'The cloud could not be reached. Your work is kept in this browser and is sent when the connection is back.';
    if (status?.kind === 'error') return status.message;
    return null;
  }

  /**
   * Writes back to the document's file; without one, asks where (Save As).
   * A cloud project is written at once and a revision is kept of it.
   */
  async save(): Promise<FileOutcome> {
    const storage = this.storage;
    if (storage.kind === 'cloud') {
      if (!this.autosave) return { ok: false, message: 'Cloud saving is not available here.' };
      this.autosave.changed();
      await this.autosave.flushNow();
      const problem = this.cloudProblem();
      if (problem) return { ok: false, message: problem };
      try {
        await this.keepVersion(storage.projectId);
      } catch (e) {
        // The document is saved; only the restorable copy is missing.
        console.warn('[session] the revision was not kept', e);
      }
      return { ok: true };
    }
    if (storage.kind === 'disk' && storage.handle) {
      const saved = await this.disk.writeToHandle(storage.handle, saveDocument(this.editor.store.liveDocument));
      this.setStorage({ kind: 'disk', handle: saved.handle, filename: saved.filename });
      return { ok: true };
    }
    return this.saveAs();
  }

  /** Asks where on disk to save a copy, and saves there from now on. Refused while a revision is previewed. */
  async saveAs(): Promise<FileOutcome> {
    if (this.preview) return { ok: false, message: PREVIEW_MESSAGE };
    const storage = this.storage;
    const name = (this.editor.document.metadata as { name?: unknown }).name;
    const suggested =
      storage.kind === 'disk' ? storage.filename : safeFileName(typeof name === 'string' ? name : '', 'cadjson');
    const saved = await this.disk.saveFileAs(this.editor.save(), suggested);
    if (!saved) return { ok: 'cancelled' };
    const next: DocumentStorage = { kind: 'disk', handle: saved.handle, filename: saved.filename };
    if (storage.kind === 'cloud' || isCloudRecord(this.autosave?.recordId ?? null)) {
      // A copy on disk is a separate document from the project: its own record from now on.
      this.autosave?.reset(null, snapshotOf(next), true);
      this.state.setState({ storage: next });
      this.onStorage(next, null);
      return { ok: true };
    }
    this.setStorage(next);
    return { ok: true };
  }

  /**
   * Saves the document as a new cloud project named `name`, which Save
   * writes to from now on. Its first revision is kept as "Created".
   * Refused while a revision is previewed.
   */
  async saveAsCloud(name: string): Promise<FileOutcome> {
    if (!this.cloud || !this.autosave) return { ok: false, message: 'Cloud projects are not available here.' };
    if (this.preview) return { ok: false, message: PREVIEW_MESSAGE };
    const projectName = name.trim() || 'Untitled';
    let created;
    try {
      created = await this.cloud.create(projectName);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if ((this.editor.document.metadata as { name?: unknown }).name !== created.name) {
      this.editor.dispatch({ type: 'renameDocument', name: created.name });
    }
    const storage: DocumentStorage = { kind: 'cloud', projectId: created.id, name: created.name };
    const localId = cloudRecordId(created.id);
    this.autosave.reset(localId, snapshotOf(storage), true, created.id);
    this.state.setState({ storage });
    this.onStorage(storage, localId);
    this.autosave.changed();
    await this.autosave.flushNow();
    const problem = this.cloudProblem();
    if (problem) return { ok: false, message: problem };
    try {
      await this.cloud.createVersion(created.id, 'Created');
    } catch (e) {
      console.warn('[session] the first revision was not kept', e);
    }
    return { ok: true };
  }

  listRevisions(cursor?: string): Promise<{ items: CloudRevision[]; nextCursor: string | null }> {
    const project = this.cloudProject;
    if (!project || !this.cloud) return Promise.resolve({ items: [], nextCursor: null });
    return this.cloud.listRevisions(project, cursor);
  }

  /** Keeps a revision of the project; the view is its thumbnail unless it shows a preview. */
  private keepVersion(projectId: string, message?: string): Promise<unknown> {
    if (!this.cloud) return Promise.resolve();
    return this.cloud.createVersion(projectId, message, { thumbnail: this.preview === null });
  }

  /**
   * Writes the edits still pending to the working copy and the project, so
   * replacing the document cannot lose them or have them written over the
   * replacement; refused while the project cannot take them.
   */
  private async settle(): Promise<void> {
    if (!this.autosave) return;
    await this.autosave.flushNow();
    const problem = this.cloudProblem();
    if (problem) throw new Error(problem);
  }

  /**
   * Shows a revision read-only in place of the live document, which the
   * editor holds with its undo history; while it shows, edits are refused
   * and autosave writes only the live document. Previewing another revision
   * takes this one's place. `label` names it to the user.
   */
  async previewRevision(revisionId: string, label: string = revisionId): Promise<{ missing: string[] }> {
    const project = this.cloudProject;
    if (!project || !this.cloud) return { missing: [] };
    if (!this.preview && this.editor.store.inTransaction)
      throw new Error('An edit is still running. Preview the revision once it finishes.');
    const turn = ++this.previewTurn;
    const { doc, missing } = await this.cloud.openRevision(project, revisionId);
    // Closed, restored, replaced by a later preview or by another document while it was fetched.
    if (turn !== this.previewTurn || this.cloudProject !== project) return { missing: [] };
    this.editor.store.showReadOnly(doc);
    this.state.setState({ preview: { revisionId, label } });
    return { missing };
  }

  /** Ends the preview: the live document shows again as it was held, with its undo history. */
  closePreview(): void {
    this.previewTurn++;
    this.editor.store.endReadOnly();
    if (this.preview) this.state.setState({ preview: null });
  }

  /**
   * Makes a revision the live document, then reads it back: the restore is
   * the server's copy, and reading it is how the editor is sure to agree.
   * A preview ends with it.
   */
  async restoreRevision(revisionId: string): Promise<{ snapshotVersionId: string; missing: string[] }> {
    const project = this.cloudProject;
    if (!project || !this.cloud) throw new Error('This document is not a cloud project.');
    // The restore keeps the live document as a revision: the pending edits go into it first.
    await this.settle();
    const { snapshotVersionId } = await this.cloud.restoreRevision(project, revisionId);
    const opened = await this.cloud.open(project);
    this.previewTurn++;
    if (opened.doc) {
      this.autosave?.skipNextReplace();
      this.editor.store.replace(opened.doc);
    } else {
      this.editor.store.endReadOnly();
    }
    if (this.preview) this.state.setState({ preview: null });
    return { snapshotVersionId, missing: opened.missing };
  }

  /** At the end of a session (the tab hidden): writes what is pending and keeps a revision. */
  async endOfSession(): Promise<void> {
    const project = this.cloudProject;
    if (!project || !this.cloud || !this.autosave) return;
    await this.autosave.flushNow();
    if (this.cloudProblem()) return;
    await this.keepVersion(project, 'Session end');
  }
}

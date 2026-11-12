/**
 * The session's revision preview, as a state machine: live, previewing
 * (one revision, then another), and back to live by Close or by Restore.
 * While a revision is previewed the live document and its undo history are
 * held untouched, nothing writes the shown revision anywhere, and only an
 * explicit Restore makes it the live document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, loadDocument, seededIds, type Doc } from '@tweakcad/editor';
import { newDocument } from '../document';
import { Autosave } from './autosave';
import { CloudConflictError, CloudProjects } from './cloud';
import { FakeSite } from './fakeSite';
import { asksBeforeReplacing, DocumentSession, PREVIEW_MESSAGE, type DiskApi } from './session';
import { MemoryWorkingCopy, cloudRecordId } from './workingCopy';

const noDisk: DiskApi = {
  openFileFromDisk: () => Promise.resolve(null),
  writeToHandle: (handle) => Promise.resolve({ handle, filename: handle.name }),
  saveFileAs: (_text, suggested) => Promise.resolve({ handle: null, filename: suggested }),
};

const nameOf = (doc: Doc | null | undefined) => (doc?.metadata as { name?: string } | undefined)?.name;
const nameIn = (text: string | null | undefined) => {
  const loaded = loadDocument(text ?? '');
  return loaded.ok ? nameOf(loaded.document) : null;
};

/**
 * A cloud project with two revisions ("First", then "Second") and a live
 * document edited past them, with an undo history: Third, then Fourth,
 * Fourth undone.
 */
async function project() {
  const api = new FakeSite();
  const thumbnail = new Blob(['png']);
  const cloud = new CloudProjects(api, () => Promise.resolve(thumbnail));
  const workingCopy = new MemoryWorkingCopy();
  const ids = seededIds(41);
  const editor = new Editor(newDocument({ ids, name: 'First' }), { ids });
  const autosave = new Autosave(
    editor,
    workingCopy,
    null,
    { kind: 'unsaved' },
    {
      debounceMs: 10,
      retryMs: 50,
      mintId: () => 'doc_local',
      cloud,
      isConflict: (e) => e instanceof CloudConflictError,
    },
  );
  autosave.attach();
  const session = new DocumentSession({ editor, disk: noDisk, autosave, ids, newName: () => 'New', cloud });
  await session.saveAsCloud('First');
  const id = session.cloudProject!;
  editor.dispatch({ type: 'renameDocument', name: 'Second' });
  await session.save();
  const [second, first] = api.projects.get(id)!.revisions.map((r) => r.versionId);
  editor.dispatch({ type: 'renameDocument', name: 'Third' });
  editor.dispatch({ type: 'renameDocument', name: 'Fourth' });
  editor.undo();
  await autosave.flushNow();
  const writes = () => ({
    project: api.projects.get(id)!.text,
    copy: workingCopy.records.get(cloudRecordId(id))?.text,
  });
  return {
    api,
    thumbnail,
    editor,
    autosave,
    session,
    id,
    first: first!,
    second: second!,
    live: editor.document,
    writes,
  };
}

describe('the revision preview of a session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts live', async () => {
    const { session, editor } = await project();
    expect(session.preview).toBeNull();
    expect(editor.store.readOnly).toBe(false);
    expect(nameOf(editor.document)).toBe('Third');
  });

  it('previews a revision read-only, holding the live document and its undo history, and writes nothing', async () => {
    const { session, editor, first, live, writes } = await project();
    const before = writes();
    await session.previewRevision(first, 'First (6 Nov)');
    expect(session.preview).toEqual({ revisionId: first, label: 'First (6 Nov)' });
    expect(nameOf(editor.document)).toBe('First');
    expect(editor.store.readOnly).toBe(true);
    expect(editor.store.liveDocument).toBe(live);
    // Edits, undo and redo are refused.
    const result = editor.dispatch({ type: 'renameDocument', name: 'Edited' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('read-only');
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(nameOf(editor.document)).toBe('First');
    await vi.advanceTimersByTimeAsync(200);
    expect(writes()).toEqual(before);
  });

  it('switches to another revision while previewing, the live document still held', async () => {
    const { session, editor, first, second, live } = await project();
    await session.previewRevision(first, 'First');
    await session.previewRevision(second, 'Second');
    expect(session.preview?.revisionId).toBe(second);
    expect(nameOf(editor.document)).toBe('Second');
    expect(editor.store.liveDocument).toBe(live);
  });

  it('closes back to the live document exactly, with its undo history', async () => {
    const { session, editor, first, second, live, writes } = await project();
    const before = writes();
    await session.previewRevision(first, 'First');
    await session.previewRevision(second, 'Second');
    session.closePreview();
    expect(session.preview).toBeNull();
    expect(editor.store.readOnly).toBe(false);
    expect(editor.document).toBe(live);
    expect(editor.store.undoLabel()).toBe('Rename document');
    expect(editor.store.canRedo()).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(nameOf(editor.document)).toBe('Fourth');
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(nameOf(editor.document)).toBe('Second');
    // Showing the live document again is no change to write.
    expect(writes()).toEqual(before);
  });

  it('restores the previewed revision only through Restore, making it the live document', async () => {
    const { api, session, editor, autosave, id, first, live } = await project();
    await session.previewRevision(first, 'First');
    const { snapshotVersionId } = await session.restoreRevision(first);
    expect(session.preview).toBeNull();
    expect(editor.store.readOnly).toBe(false);
    expect(nameIn(api.projects.get(id)!.text)).toBe('First');
    // Read back from the server, under the site's name for the project.
    expect(editor.document).not.toBe(live);
    expect(nameOf(editor.document)).toBe(api.projects.get(id)!.name);
    // The live document before the restore is kept as a revision.
    const kept = api.projects.get(id)!.revisions.find((r) => r.versionId === snapshotVersionId)!;
    expect(nameIn(kept.text)).toBe('Third');
    // A restore is a load: the history starts again, and the next edit is written.
    expect(editor.store.canUndo()).toBe(false);
    editor.dispatch({ type: 'renameDocument', name: 'After restore' });
    await autosave.flushNow();
    expect(nameIn(api.projects.get(id)!.text)).toBe('After restore');
  });

  it('does not show a revision whose preview was closed while it was fetched', async () => {
    const { session, editor, first, live } = await project();
    const pending = session.previewRevision(first, 'First');
    session.closePreview();
    await pending;
    expect(session.preview).toBeNull();
    expect(editor.document).toBe(live);
  });

  it('writes the live document when saved while previewing, with no thumbnail of the preview', async () => {
    const { api, session, editor, id, first, thumbnail } = await project();
    await session.previewRevision(first, 'First');
    expect(await session.save()).toEqual({ ok: true });
    expect(nameIn(api.projects.get(id)!.text)).toBe('Third');
    expect(api.thumbnails.at(-1)).toBeNull();
    expect(nameOf(editor.document)).toBe('First');
    session.closePreview();
    await session.save();
    expect(api.thumbnails.at(-1)).toBe(thumbnail);
  });

  it('refuses Save As while previewing', async () => {
    const { session, first } = await project();
    await session.previewRevision(first, 'First');
    expect(await session.saveAs()).toEqual({ ok: false, message: PREVIEW_MESSAGE });
    expect(await session.saveAsCloud('Copy')).toEqual({ ok: false, message: PREVIEW_MESSAGE });
    expect(session.storage.kind).toBe('cloud');
  });

  it('ends the preview when another document is opened', async () => {
    const { session, editor, first } = await project();
    await session.previewRevision(first, 'First');
    session.newDocument();
    expect(session.preview).toBeNull();
    expect(editor.store.readOnly).toBe(false);
    expect(nameOf(editor.document)).toBe('New');
  });
});

describe('asking before New or Open replaces the document', () => {
  it('does not ask for a document not edited since it was opened or made, whatever its status says', () => {
    expect(asksBeforeReplacing({ edited: false, storage: 'unsaved', autosave: 'saved' })).toBe(false);
    expect(asksBeforeReplacing({ edited: false, storage: 'disk', autosave: 'saved' })).toBe(false);
  });

  it('asks for an edited document, except an unsaved one with nothing waiting to be written', () => {
    expect(asksBeforeReplacing({ edited: true, storage: 'unsaved', autosave: 'saved' })).toBe(true);
    expect(asksBeforeReplacing({ edited: true, storage: 'disk', autosave: 'saved' })).toBe(true);
    expect(asksBeforeReplacing({ edited: true, storage: 'unsaved', autosave: 'idle' })).toBe(false);
  });
});

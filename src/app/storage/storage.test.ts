import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, VERSION_1_MESSAGE, seededIds } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { newDocument } from '../document';
import { Autosave } from './autosave';
import { safeFileName } from './disk';
import { bootDocument, DocumentSession, type DiskApi } from './session';
import { MemoryWorkingCopy, newest } from './workingCopy';

/** A disk of named files, each holding text; handles stand for paths. */
class FakeDisk implements DiskApi {
  readonly files = new Map<string, string>();
  nextOpen: string | null = null;
  nextSaveName: string | null = 'chosen.cadjson';

  private handle(name: string): FileSystemFileHandle {
    return { kind: 'file', name } as FileSystemFileHandle;
  }

  openFileFromDisk() {
    const name = this.nextOpen;
    if (name === null) return Promise.resolve(null);
    return Promise.resolve({ text: this.files.get(name) ?? '', handle: this.handle(name), filename: name });
  }

  writeToHandle(handle: FileSystemFileHandle, text: string) {
    this.files.set(handle.name, text);
    return Promise.resolve({ handle, filename: handle.name });
  }

  saveFileAs(text: string) {
    const name = this.nextSaveName;
    if (name === null) return Promise.resolve(null);
    this.files.set(name, text);
    return Promise.resolve({ handle: this.handle(name), filename: name });
  }
}

/** A plate made with the builder, as a document someone saved. */
function plateText(): string {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => x.rect(0, 0, 60, 40));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '10 mm' }] });
  return new Editor(d.document()).save();
}

const ids = seededIds(7);
const name = () => 'quiet-ratchet';

describe('the working copy at boot', () => {
  it('starts a new document when the browser holds none', async () => {
    const result = await bootDocument({ workingCopy: new MemoryWorkingCopy(), localId: null, reset: false, ids, name });
    expect(result.localId).toBeNull();
    expect(result.notice).toBeUndefined();
    expect(readDocument(result.doc).diagnostics).toEqual([]);
  });

  it('restores the record the address names, byte for byte', async () => {
    const store = new MemoryWorkingCopy();
    const text = plateText();
    await store.put({
      id: 'doc_a',
      name: 'a',
      text,
      updatedAt: '2026-11-06T10:00:00.000Z',
      storage: { kind: 'unsaved' },
    });
    await store.put({
      id: 'doc_b',
      name: 'b',
      text: new Editor(newDocument({ ids, name: 'b' })).save(),
      updatedAt: '2026-11-06T11:00:00.000Z',
      storage: { kind: 'unsaved' },
    });
    const result = await bootDocument({ workingCopy: store, localId: 'doc_a', reset: false, ids, name });
    expect(result.localId).toBe('doc_a');
    expect(new Editor(result.doc).save()).toBe(text);
  });

  it('restores the most recent record without an address, and says when it came from a file', async () => {
    const store = new MemoryWorkingCopy();
    await store.put({
      id: 'doc_a',
      name: 'a',
      text: plateText(),
      updatedAt: '2026-11-06T10:00:00.000Z',
      storage: { kind: 'unsaved' },
    });
    await store.put({
      id: 'doc_b',
      name: 'b',
      text: plateText(),
      updatedAt: '2026-11-06T12:00:00.000Z',
      storage: { kind: 'disk', filename: 'plate.cadjson' },
    });
    const result = await bootDocument({ workingCopy: store, localId: null, reset: false, ids, name });
    expect(result.localId).toBe('doc_b');
    expect(result.notice?.message).toContain('plate.cadjson');
    // The notice offers to open the original file again.
    expect(result.notice?.reopen).toBe(true);
  });

  it('starts fresh with a notice when the named record is missing, and wipes everything on reset', async () => {
    const store = new MemoryWorkingCopy();
    await store.put({
      id: 'doc_a',
      name: 'a',
      text: plateText(),
      updatedAt: '2026-11-06T10:00:00.000Z',
      storage: { kind: 'unsaved' },
    });
    const missing = await bootDocument({ workingCopy: store, localId: 'doc_gone', reset: false, ids, name });
    expect(missing.localId).toBeNull();
    expect(missing.notice?.message).toMatch(/not in this browser/);
    const reset = await bootDocument({ workingCopy: store, localId: 'doc_a', reset: true, ids, name });
    expect(reset.localId).toBeNull();
    expect(store.records.size).toBe(0);
  });

  it('picks the newest record by write time', () => {
    const r = (id: string, updatedAt: string) => ({
      id,
      name: id,
      text: '',
      updatedAt,
      storage: { kind: 'unsaved' as const },
    });
    expect(
      newest([
        r('a', '2026-01-01T00:00:00.000Z'),
        r('b', '2026-02-01T00:00:00.000Z'),
        r('c', '2025-12-01T00:00:00.000Z'),
      ])?.id,
    ).toBe('b');
    expect(newest([])).toBeUndefined();
  });
});

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the canonical text after changes settle, minting a record once', async () => {
    const store = new MemoryWorkingCopy();
    const editor = new Editor(newDocument({ ids, name: 'a' }));
    const minted: string[] = [];
    const autosave = new Autosave(
      editor,
      store,
      null,
      { kind: 'unsaved' },
      { debounceMs: 100, mintId: () => `doc_${minted.length + 1}`, onMinted: (id) => minted.push(id) },
    );
    autosave.attach();
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    editor.dispatch({ type: 'renameDocument', name: 'c' });
    expect(store.records.size).toBe(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(minted).toEqual(['doc_1']);
    expect(store.records.get('doc_1')?.text).toBe(editor.save());
    expect(store.records.get('doc_1')?.name).toBe('c');
    editor.dispatch({ type: 'renameDocument', name: 'd' });
    await vi.advanceTimersByTimeAsync(150);
    expect(minted).toEqual(['doc_1']);
    expect(store.records.get('doc_1')?.text).toBe(editor.save());
    expect(autosave.getStatus().kind).toBe('saved');
  });

  it('writes nothing when nothing changed, and flushes on demand', async () => {
    const store = new MemoryWorkingCopy();
    const editor = new Editor(newDocument({ ids, name: 'a' }));
    const autosave = new Autosave(editor, store, 'doc_x', { kind: 'unsaved' }, { mintId: () => 'unused' });
    autosave.attach();
    await autosave.flushNow();
    expect(store.records.size).toBe(0);
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    await autosave.flushNow();
    expect(store.records.get('doc_x')?.text).toBe(editor.save());
  });

  it('round-trips through boot: what autosave wrote is what boot opens', async () => {
    const store = new MemoryWorkingCopy();
    const loaded = Editor.open(plateText());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const editor = loaded.editor;
    const autosave = new Autosave(
      editor,
      store,
      null,
      { kind: 'disk', filename: 'plate.cadjson' },
      { debounceMs: 10, mintId: () => 'doc_p' },
    );
    autosave.attach();
    editor.dispatch({ type: 'renameDocument', name: 'Plate' });
    await vi.advanceTimersByTimeAsync(20);
    const boot = await bootDocument({ workingCopy: store, localId: 'doc_p', reset: false, ids, name });
    expect(new Editor(boot.doc).save()).toBe(editor.save());
    expect(boot.storage).toEqual({ kind: 'disk', filename: 'plate.cadjson' });
  });
});

describe('DocumentSession and the working copy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes an opened document at once, and a new one only once it is edited', async () => {
    const store = new MemoryWorkingCopy();
    const editor = new Editor(newDocument({ ids, name: 'a' }));
    let minted = 0;
    const autosave = new Autosave(
      editor,
      store,
      null,
      { kind: 'unsaved' },
      { debounceMs: 10, mintId: () => `doc_${++minted}` },
    );
    autosave.attach();
    const session = new DocumentSession({ editor, disk: new FakeDisk(), autosave, ids, newName: name });
    expect(session.openText(plateText(), { filename: 'plate.cadjson', handle: null })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(20);
    expect(store.records.get('doc_1')?.storage).toEqual({ kind: 'disk', filename: 'plate.cadjson' });
    // Written as opened, which is no edit: the status stays as it was, never saving.
    expect(autosave.getStatus()).toEqual({ kind: 'idle' });
    session.newDocument();
    await vi.advanceTimersByTimeAsync(20);
    expect(store.records.size).toBe(1);
    expect(autosave.getStatus()).toEqual({ kind: 'idle' });
    editor.dispatch({ type: 'renameDocument', name: 'Drawn' });
    await vi.advanceTimersByTimeAsync(20);
    expect(store.records.get('doc_2')?.name).toBe('Drawn');
    expect(autosave.getStatus().kind).toBe('saved');
  });
});

describe('DocumentSession', () => {
  it('saves and reopens the same bytes', async () => {
    const disk = new FakeDisk();
    const editor = new Editor(newDocument({ ids, name: 'Plate holder' }));
    const session = new DocumentSession({ editor, disk, autosave: null, ids, newName: name });
    expect(await session.save()).toEqual({ ok: true });
    expect(session.storage).toMatchObject({ kind: 'disk', filename: 'chosen.cadjson' });
    const saved = disk.files.get('chosen.cadjson')!;
    expect(saved).toBe(editor.save());

    editor.dispatch({ type: 'renameDocument', name: 'Changed' });
    expect(await session.save()).toEqual({ ok: true });
    expect(disk.files.get('chosen.cadjson')).toBe(editor.save());

    const other = new Editor(newDocument({ ids, name: 'x' }));
    const reopen = new DocumentSession({ editor: other, disk, autosave: null, ids, newName: name });
    disk.nextOpen = 'chosen.cadjson';
    expect(await reopen.open()).toEqual({ ok: true });
    expect(other.save()).toBe(disk.files.get('chosen.cadjson'));
    expect(reopen.storage).toMatchObject({ kind: 'disk', filename: 'chosen.cadjson' });
    expect(other.store.canUndo()).toBe(false);
  });

  it('refuses a version-1 file with the plain message and keeps the document', () => {
    const editor = new Editor(newDocument({ ids, name: 'kept' }));
    const before = editor.save();
    const session = new DocumentSession({ editor, disk: new FakeDisk(), autosave: null, ids, newName: name });
    const v1 = JSON.stringify({ schemaVersion: 1, metadata: { name: 'old' }, parts: {}, parameters: {} });
    expect(session.openText(v1)).toEqual({ ok: false, message: VERSION_1_MESSAGE });
    expect(editor.save()).toBe(before);
  });

  it('reports a cancelled picker and starts new documents unsaved', async () => {
    const disk = new FakeDisk();
    disk.nextSaveName = null;
    const editor = new Editor(newDocument({ ids, name: 'a' }));
    let rebound = 0;
    const session = new DocumentSession({
      editor,
      disk,
      autosave: null,
      ids,
      newName: name,
      storage: { kind: 'disk', handle: null, filename: 'a.cadjson' },
      onRebound: () => rebound++,
    });
    expect(await session.save()).toEqual({ ok: 'cancelled' });
    expect(await session.open()).toEqual({ ok: 'cancelled' });
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    session.newDocument();
    expect(session.storage).toEqual({ kind: 'unsaved' });
    expect((editor.document.metadata as { name: string }).name).toBe('quiet-ratchet');
    expect(editor.store.canUndo()).toBe(false);
    expect(rebound).toBe(1);
  });

  it('suggests a file name from the document name', () => {
    expect(safeFileName('My bracket / v2', 'cadjson')).toBe('My-bracket-v2.cadjson');
    expect(safeFileName('  ', 'stl')).toBe('document.stl');
  });
});

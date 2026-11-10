import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash } from '@tweakcad/format';
import { Editor, VERSION_1_MESSAGE, loadDocument, seededIds, type Doc } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { newDocument } from '../document';
import { Autosave } from './autosave';
import { resolveBoot, type ResolveBootOptions } from './boot';
import { CLOUD_FILE_MAX_BYTES, CloudConflictError, CloudProjects, cloudLimitNotice } from './cloud';
import { FakeSite } from './fakeSite';
import { bytesToBase64, externalizeAssets, internalizeAssets } from './cloudAssets';
import { CONFLICT_MESSAGE, DocumentSession, type DiskApi, type DocumentStorage } from './session';
import { MemoryWorkingCopy, cloudRecordId } from './workingCopy';
import { fitRect } from './thumbnail';
import { runAutoExport, shouldAutoExport, type AutoExportStatus } from './autoExport';

const ids = seededIds(21);
const name = () => 'quiet-ratchet';

const STEP = new TextEncoder().encode('ISO-10303-21; a bracket');
const STEP_HASH = contentHash(STEP);

/** A plate with an imported file kept inline, as the editor holds it. */
function plateWithFile(): Doc {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => x.rect(0, 0, 60, 40));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '10 mm' }] });
  const doc = d.document();
  doc.assets = {
    [STEP_HASH]: {
      mediaType: 'model/step',
      name: 'bracket.step',
      size: STEP.length,
      data: { inline: { base64: bytesToBase64(STEP) } },
    },
  };
  const loaded = loadDocument(new Editor(doc).save());
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.document;
}

const assetData = (doc: Doc, hash: string) =>
  ((doc.assets as Record<string, Record<string, unknown>>)[hash]?.data ?? null) as Record<string, unknown> | null;

function site(): { api: FakeSite; cloud: CloudProjects } {
  const api = new FakeSite();
  return { api, cloud: new CloudProjects(api) };
}

const noDisk: DiskApi = {
  openFileFromDisk: () => Promise.resolve(null),
  writeToHandle: (handle) => Promise.resolve({ handle, filename: handle.name }),
  saveFileAs: (_text, suggested) => Promise.resolve({ handle: null, filename: suggested }),
};

describe("a document's files and the cloud", () => {
  it('marks inline files external with their bytes to upload, leaving the document as it was', () => {
    const doc = plateWithFile();
    const { doc: stored, uploads } = externalizeAssets(doc);
    expect(uploads).toEqual([{ hash: STEP_HASH, bytes: STEP }]);
    expect(assetData(stored, STEP_HASH)).toEqual({ external: {} });
    expect(assetData(doc, STEP_HASH)).toHaveProperty('inline');
    expect(loadDocument(new Editor(stored).save()).ok).toBe(true);
  });

  it('fetches external files back inline, and keeps one whose bytes do not match external', async () => {
    const { doc: stored } = externalizeAssets(plateWithFile());
    const back = await internalizeAssets(stored, () => Promise.resolve(STEP));
    expect(back.fetched).toEqual([STEP_HASH]);
    expect(new Editor(back.doc).save()).toBe(new Editor(plateWithFile()).save());
    const wrong = await internalizeAssets(stored, () => Promise.resolve(new TextEncoder().encode('something else')));
    expect(wrong.missing).toEqual(['bracket.step']);
    expect(assetData(wrong.doc, STEP_HASH)).toEqual({ external: {} });
  });
});

describe('CloudProjects', () => {
  it("names a new project with a generated name none of the account's projects has", async () => {
    const { api, cloud } = site();
    const first = await cloud.freshName();
    expect(first).toMatch(/^[a-z]+-[a-z]+$/);
    await cloud.create(first);
    for (let i = 0; i < 20; i++) {
      const next = await cloud.freshName();
      expect(next).not.toBe(first);
    }
    expect([...api.projects.values()].map((p) => p.name)).toEqual([first]);
  });

  it('saves a document with its files uploaded once and stored external, and opens it back whole', async () => {
    const { api, cloud } = site();
    const { id } = await cloud.create('Plate');
    const doc = plateWithFile();
    await cloud.save(id, doc);
    await cloud.save(id, doc);
    expect(api.uploads).toEqual([STEP_HASH]);
    const stored = loadDocument(api.projects.get(id)!.text!);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(assetData(stored.document, STEP_HASH)).toEqual({ external: {} });

    const other = new CloudProjects(api);
    const opened = await other.open(id);
    expect(opened.missing).toEqual([]);
    // Byte for byte, under the name the first save sent to the site.
    expect(new Editor(opened.doc!).save()).toBe(new Editor(doc).save());
    expect(api.projects.get(id)!.name).toBe('Test');
    // Fetched files are known to be stored: saving again uploads nothing.
    await other.save(id, opened.doc!);
    expect(api.uploads).toEqual([STEP_HASH]);
  });

  it('states the etag it replaces, and is refused when another tab moved the project', async () => {
    const { api, cloud } = site();
    const { id } = await cloud.create('Plate');
    const doc = newDocument({ ids, name: 'Plate' });
    await cloud.save(id, doc);
    expect(api.ifMatch).toEqual([null]);
    await cloud.save(id, doc);
    expect(api.ifMatch[1]).toBe('e1');
    api.writeElsewhere(id, api.projects.get(id)!.text!);
    await expect(cloud.save(id, doc)).rejects.toBeInstanceOf(CloudConflictError);
    cloud.forgetEtag(id);
    await expect(cloud.save(id, doc)).resolves.toMatchObject({ etag: 'e4' });
  });

  it('sends a rename made here, and takes a rename made on the site on open', async () => {
    const { api, cloud } = site();
    const { id } = await cloud.create('Plate');
    await cloud.save(id, newDocument({ ids, name: 'Plate' }));
    expect(api.renames).toEqual([]);
    await cloud.save(id, newDocument({ ids, name: 'Bracket' }));
    expect(api.renames).toEqual(['Bracket']);
    api.projects.get(id)!.name = 'Renamed on the site';
    const opened = await cloud.open(id);
    expect((opened.doc!.metadata as { name: string }).name).toBe('Renamed on the site');
  });

  it('opens a project with no document yet as nothing, and refuses a version-1 document plainly', async () => {
    const { api, cloud } = site();
    const { id } = await cloud.create('Empty');
    expect(await cloud.open(id)).toEqual({ name: 'Empty', doc: null, missing: [] });
    api.writeElsewhere(id, JSON.stringify({ schemaVersion: 1, parts: {} }));
    await expect(cloud.open(id)).rejects.toThrow(VERSION_1_MESSAGE);
  });

  it('lists, opens and restores revisions, taking the etag the restore hands back', async () => {
    const { api, cloud } = site();
    const { id } = await cloud.create('Plate');
    await cloud.save(id, newDocument({ ids, name: 'Plate' }));
    const first = await cloud.createVersion(id, 'first');
    await cloud.save(id, plateWithFile());
    const page = await cloud.listRevisions(id);
    expect(page.items.map((r) => r.message)).toEqual(['first']);
    const shown = await cloud.openRevision(id, first.versionId);
    expect(Object.keys(shown.doc.assets as object)).toEqual([]);
    await cloud.restoreRevision(id, first.versionId);
    // The cached etag was replaced, so the next save is not a conflict.
    await expect(cloud.save(id, newDocument({ ids, name: 'Plate' }))).resolves.toBeDefined();
    expect(api.projects.get(id)!.revisions[0]?.message).toBe('Before restore');
  });
});

describe('autosave to a cloud project', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function bound() {
    const { api, cloud } = site();
    const { id } = await cloud.create('Plate');
    const store = new MemoryWorkingCopy();
    const editor = new Editor(newDocument({ ids, name: 'Plate' }));
    const autosave = new Autosave(
      editor,
      store,
      cloudRecordId(id),
      { kind: 'cloud', projectId: id, name: 'Plate' },
      {
        debounceMs: 10,
        retryMs: 50,
        mintId: () => 'unused',
        cloud,
        isConflict: (e) => e instanceof CloudConflictError,
      },
      id,
    );
    autosave.attach();
    return { api, cloud, id, store, editor, autosave };
  }

  it('writes the working copy and the project', async () => {
    const { api, id, store, editor, autosave } = await bound();
    editor.dispatch({ type: 'renameDocument', name: 'Plate 2' });
    await vi.advanceTimersByTimeAsync(20);
    expect(store.records.get(cloudRecordId(id))?.text).toBe(editor.save());
    expect(api.projects.get(id)!.text).toBe(editor.save());
    expect(autosave.getStatus().kind).toBe('saved');
  });

  it('retries when the cloud cannot be reached, keeping the work in the working copy', async () => {
    const { api, id, store, editor, autosave } = await bound();
    api.offline = 1;
    editor.dispatch({ type: 'renameDocument', name: 'Offline edit' });
    await vi.advanceTimersByTimeAsync(20);
    expect(autosave.getStatus()).toEqual({ kind: 'offline', queued: 1 });
    expect(store.records.get(cloudRecordId(id))?.name).toBe('Offline edit');
    // An edit while offline joins the queue.
    editor.dispatch({ type: 'renameDocument', name: 'Offline edit 2' });
    expect(autosave.getStatus()).toEqual({ kind: 'offline', queued: 2 });
    await vi.advanceTimersByTimeAsync(60);
    expect(autosave.getStatus().kind).toBe('saved');
    expect(api.projects.get(id)!.text).toBe(editor.save());
  });

  it('asks before an import past the cloud limit for one file', () => {
    expect(cloudLimitNotice('small.step', CLOUD_FILE_MAX_BYTES)).toBeNull();
    const notice = cloudLimitNotice('scan.stl', CLOUD_FILE_MAX_BYTES + 1);
    expect(notice?.title).toBe('Too large to sync to the cloud');
    expect(notice?.message).toBe(
      'Importing "scan.stl" (100.0 MB) takes this project past the 100.0 MB cloud limit for one file, so it will stop syncing. You can still import it and save to disk. Import anyway?',
    );
  });

  it('stops at a conflict rather than overwrite the other tab', async () => {
    const { api, id, editor, autosave } = await bound();
    editor.dispatch({ type: 'renameDocument', name: 'a' });
    await vi.advanceTimersByTimeAsync(20);
    api.writeElsewhere(id, 'theirs');
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    await vi.advanceTimersByTimeAsync(200);
    expect(autosave.getStatus().kind).toBe('conflict');
    expect(api.projects.get(id)!.text).toBe('theirs');
  });
});

describe('the document session with the cloud', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function session(storage: DocumentStorage = { kind: 'unsaved' }) {
    const { api, cloud } = site();
    const store = new MemoryWorkingCopy();
    const editor = new Editor(plateWithFile());
    const autosave = new Autosave(
      editor,
      store,
      null,
      { kind: 'unsaved' },
      { debounceMs: 10, mintId: () => 'doc_local', cloud, isConflict: (e) => e instanceof CloudConflictError },
    );
    autosave.attach();
    const located: [DocumentStorage, string | null][] = [];
    const s = new DocumentSession({
      editor,
      disk: noDisk,
      autosave,
      ids,
      newName: name,
      storage,
      cloud,
      onStorage: (st, localId) => located.push([st, localId]),
    });
    return { api, cloud, store, editor, autosave, session: s, located };
  }

  it('saves as a new cloud project: named, written with its files, a first revision kept, and Save writing there', async () => {
    const { api, store, editor, session: s, located } = session();
    expect(await s.saveAsCloud('Bracket')).toEqual({ ok: true });
    const [id] = [...api.projects.keys()];
    expect(s.storage).toEqual({ kind: 'cloud', projectId: id, name: 'Bracket' });
    expect(located).toEqual([[s.storage, cloudRecordId(id!)]]);
    expect((editor.document.metadata as { name: string }).name).toBe('Bracket');
    expect(api.uploads).toEqual([STEP_HASH]);
    expect(store.records.get(cloudRecordId(id!))?.storage).toEqual({ kind: 'cloud', projectId: id, name: 'Bracket' });
    expect(api.projects.get(id!)!.revisions.map((r) => r.message)).toEqual(['Created']);

    editor.dispatch({ type: 'renameDocument', name: 'Bracket 2' });
    expect(await s.save()).toEqual({ ok: true });
    expect(api.projects.get(id!)!.revisions).toHaveLength(2);
    expect(loadDocument(api.projects.get(id!)!.text!).ok).toBe(true);
  });

  it('reports a conflict on Save with the plain message', async () => {
    const { api, session: s, editor } = session();
    await s.saveAsCloud('Bracket');
    const [id] = [...api.projects.keys()];
    api.writeElsewhere(id!, 'theirs');
    editor.dispatch({ type: 'renameDocument', name: 'mine' });
    expect(await s.save()).toEqual({ ok: false, message: CONFLICT_MESSAGE });
  });

  it('shows a revision without writing it, and restores one by reading it back', async () => {
    const { api, session: s, editor } = session();
    await s.saveAsCloud('Bracket');
    const [id] = [...api.projects.keys()];
    const created = api.projects.get(id!)!.revisions[0]!.versionId;
    editor.dispatch({ type: 'renameDocument', name: 'Later' });
    await s.save();
    const live = api.projects.get(id!)!.text;
    await s.previewRevision(created);
    expect((editor.document.metadata as { name: string }).name).toBe('Bracket');
    await vi.advanceTimersByTimeAsync(50);
    expect(api.projects.get(id!)!.text).toBe(live);

    const restored = await s.restoreRevision(created);
    expect(restored.missing).toEqual([]);
    const revision = api.projects.get(id!)!.revisions.find((r) => r.versionId === created)!;
    expect(api.projects.get(id!)!.text).toBe(revision.text);
    // Read back from the server, under the site's name (the save renamed the project).
    expect((editor.document.metadata as { name: string }).name).toBe('Later');
    // The restored document carries its file inline again.
    expect(assetData(editor.document, STEP_HASH)).toHaveProperty('inline');
    editor.dispatch({ type: 'renameDocument', name: 'After restore' });
    expect(await s.save()).toEqual({ ok: true });
  });

  it('writes the pending edits of the live document while a revision is shown, never the shown revision', async () => {
    const { api, store, session: s, editor, autosave } = session();
    await s.saveAsCloud('Bracket');
    const [id] = [...api.projects.keys()];
    const created = api.projects.get(id!)!.revisions[0]!.versionId;
    editor.dispatch({ type: 'renameDocument', name: 'Pending' });
    const nameIn = (text: string | null | undefined) => {
      const loaded = loadDocument(text ?? '');
      return loaded.ok ? (loaded.document.metadata as { name: string }).name : null;
    };
    await s.previewRevision(created);
    expect((editor.document.metadata as { name: string }).name).toBe('Bracket');
    await autosave.flushNow();
    await vi.advanceTimersByTimeAsync(50);
    expect(nameIn(api.projects.get(id!)!.text)).toBe('Pending');
    expect(nameIn(store.records.get(cloudRecordId(id!))?.text)).toBe('Pending');
  });

  it('shows a revision while pending edits wait for the cloud, and the retry writes the live document', async () => {
    const { api, session: s, editor, autosave } = session();
    await s.saveAsCloud('Bracket');
    const [id] = [...api.projects.keys()];
    const created = api.projects.get(id!)!.revisions[0]!.versionId;
    api.offline = 1;
    editor.dispatch({ type: 'renameDocument', name: 'Pending' });
    await autosave.flushNow();
    expect(autosave.getStatus().kind).toBe('offline');
    await s.previewRevision(created);
    expect((editor.document.metadata as { name: string }).name).toBe('Bracket');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(autosave.getStatus().kind).toBe('saved');
    const loaded = loadDocument(api.projects.get(id!)!.text ?? '');
    expect(loaded.ok && (loaded.document.metadata as { name: string }).name).toBe('Pending');
  });

  it('keeps a revision at the end of a session', async () => {
    const { api, session: s } = session();
    await s.saveAsCloud('Bracket');
    const [id] = [...api.projects.keys()];
    await s.endOfSession();
    expect(api.projects.get(id!)!.revisions.map((r) => r.message)).toEqual(['Session end', 'Created']);
  });

  it('saving a cloud project as a file gives the file a record of its own', async () => {
    const { session: s, autosave, located } = session();
    await s.saveAsCloud('Bracket');
    expect(await s.saveAs()).toEqual({ ok: true });
    expect(s.storage).toMatchObject({ kind: 'disk', filename: 'Bracket.cadjson' });
    expect(autosave.recordId).toBeNull();
    expect(autosave.project).toBeNull();
    expect(located.at(-1)).toEqual([s.storage, null]);
  });
});

describe('what a window opens at boot', () => {
  function options(over: Partial<ResolveBootOptions>): ResolveBootOptions {
    return {
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      projectId: null,
      reset: false,
      ids,
      name,
      saas: { reachable: true, signedIn: true },
      offlineChosen: false,
      cloud: null,
      ...over,
    };
  }

  it('asks rather than guesses when no document is named', async () => {
    expect(await resolveBoot(options({}))).toEqual({ kind: 'choose' });
    expect(await resolveBoot(options({ saas: { reachable: true, signedIn: false } }))).toEqual({ kind: 'gate' });
    const offline = await resolveBoot(options({ saas: { reachable: true, signedIn: false }, offlineChosen: true }));
    expect(offline.kind).toBe('document');
    const standalone = await resolveBoot(options({ saas: { reachable: false, signedIn: false } }));
    expect(standalone.kind).toBe('document');
  });

  it('opens a named cloud project bound to it, with the files it uses', async () => {
    const { api, cloud } = site();
    const { id } = await cloud.create('Plate');
    await cloud.save(id, plateWithFile());
    const outcome = await resolveBoot(options({ projectId: id, cloud: new CloudProjects(api) }));
    expect(outcome.kind).toBe('document');
    if (outcome.kind !== 'document') return;
    // The first save sent the document's name to the site.
    expect(outcome.boot.session).toEqual({ kind: 'cloud', projectId: id, name: 'Test' });
    expect(outcome.boot.localId).toBe(cloudRecordId(id));
    expect(assetData(outcome.boot.doc, STEP_HASH)).toHaveProperty('inline');
  });

  it('opens a new project with no document yet under its name', async () => {
    const { cloud } = site();
    const { id } = await cloud.create('Fresh');
    const outcome = await resolveBoot(options({ projectId: id, cloud }));
    if (outcome.kind !== 'document') throw new Error(outcome.kind);
    expect((outcome.boot.doc.metadata as { name: string }).name).toBe('Fresh');
    expect(outcome.boot.session.kind).toBe('cloud');
  });

  it("says why a project did not open, or opens this browser's copy of it detached", async () => {
    const { cloud } = site();
    const failed = await resolveBoot(options({ projectId: 'proj_missing', cloud }));
    expect(failed).toEqual({ kind: 'load-failed', message: 'The project was not found in your account.' });

    const workingCopy = new MemoryWorkingCopy();
    const text = new Editor(plateWithFile()).save();
    await workingCopy.put({
      id: cloudRecordId('proj_missing'),
      name: 'Plate',
      text,
      updatedAt: '2026-11-06T10:00:00Z',
      storage: { kind: 'cloud', projectId: 'proj_missing', name: 'Plate' },
    });
    const copy = await resolveBoot(options({ projectId: 'proj_missing', cloud, workingCopy }));
    if (copy.kind !== 'document') throw new Error(copy.kind);
    expect(copy.boot.session).toEqual({ kind: 'unsaved' });
    expect(copy.boot.localId).toBe(cloudRecordId('proj_missing'));
    expect(copy.boot.notice?.message).toMatch(/didn't open.*changes stay in this browser/);

    const signedOut = await resolveBoot(
      options({ projectId: 'proj_missing', cloud, workingCopy, saas: { reachable: true, signedIn: false } }),
    );
    if (signedOut.kind !== 'document') throw new Error(signedOut.kind);
    expect(signedOut.boot.notice?.message).toMatch(/Sign in/);
    const unreachable = await resolveBoot(
      options({ projectId: 'proj_none', saas: { reachable: false, signedIn: false } }),
    );
    if (unreachable.kind !== 'document') throw new Error(unreachable.kind);
    expect(unreachable.boot.notice?.message).toMatch(/not reachable/);
  });

  it('refuses a version-1 cloud document with the plain message', async () => {
    const { api, cloud } = site();
    const { id } = await cloud.create('Old');
    api.writeElsewhere(id, JSON.stringify({ schemaVersion: 1, parts: {} }));
    expect(await resolveBoot(options({ projectId: id, cloud }))).toEqual({
      kind: 'load-failed',
      message: VERSION_1_MESSAGE,
    });
  });
});

describe('auto export and thumbnails', () => {
  it('exports each format and attaches it to the current version', async () => {
    const calls: { url: string; method: string }[] = [];
    const fake = ((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/current-version'))
        return Promise.resolve(new Response(JSON.stringify({ versionLabel: 'v2' })));
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    const statuses: AutoExportStatus[] = [];
    await runAutoExport({
      projectId: 'proj_1',
      exportShown: (f) => Promise.resolve(f === 'step' ? new Uint8Array() : new Uint8Array([1, 2, 3])),
      onStatus: (s) => statuses.push(s),
      fetch: fake,
    });
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual([
      '/api/v1/projects/proj_1/versions/v2/attachments/stl',
      '/api/v1/projects/proj_1/versions/v2/attachments/3mf',
    ]);
    expect(statuses.filter((s) => s.kind === 'failed')).toEqual([
      { kind: 'failed', format: 'step', message: 'The model has no bodies to export.' },
    ]);
    expect(statuses.at(-1)).toEqual({ kind: 'done' });
    expect(shouldAutoExport('?project=p&autoExport=1')).toBe(true);
    expect(shouldAutoExport('?project=p')).toBe(false);
  });

  it('asks to publish first when there is no published version', async () => {
    const statuses: AutoExportStatus[] = [];
    await runAutoExport({
      projectId: 'p',
      exportShown: () => Promise.resolve(new Uint8Array([1])),
      onStatus: (s) => statuses.push(s),
      fetch: (() => Promise.resolve(new Response('', { status: 404 }))) as typeof fetch,
    });
    expect(statuses[0]).toMatchObject({ kind: 'failed', message: 'Publish the project before generating downloads.' });
  });

  it('fits the view into the thumbnail, centred', () => {
    expect(fitRect(1600, 600, 800, 600)).toEqual({ x: 0, y: 150, w: 800, h: 300 });
    expect(fitRect(300, 600, 800, 600)).toEqual({ x: 250, y: 0, w: 300, h: 600 });
  });
});

import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import type { Display, ExportFormat, Picked, PickTarget, ResolveScope } from '@tweakcad/worker/src/v2/service/types';
import { bootApp, type AppServiceClient } from './services';
import { select } from './selection';
import { consoleLog, consoleStore } from './console';
import { resolveBoot } from './storage/boot';
import { CloudProjects } from './storage/cloud';
import { FakeSite } from './storage/fakeSite';
import { MemoryWorkingCopy, cloudRecordId } from './storage/workingCopy';

const display = (generation: number): Display => ({
  generation,
  definitions: [],
  parts: {},
  assemblies: [],
  entities: [],
  pauses: [],
  stale: [],
  outOfDate: [],
  timing: { evaluate: 0, display: 0, resumed: 0 },
});

class FakeService implements AppServiceClient {
  inits = 0;
  evaluated: unknown[] = [];
  picks: PickTarget[] = [];
  exports: { format: ExportFormat; scope: ResolveScope }[] = [];
  private generation = 0;
  init() {
    this.inits++;
    return Promise.resolve({ loadTimeMs: 1 });
  }
  evaluate(doc: unknown) {
    this.evaluated.push(doc);
    return Promise.resolve(display(++this.generation));
  }
  pick(target: PickTarget): Promise<Picked | null> {
    this.picks.push(target);
    return Promise.resolve({ reference: { entity: {} as never }, names: {} });
  }
  exportFreeCad() {
    return Promise.resolve({ bytes: new Uint8Array(), notes: [], bodies: [] });
  }

  exportFile(format: ExportFormat, scope: ResolveScope) {
    this.exports.push({ format, scope });
    return Promise.resolve(new Uint8Array([1, 2, 3]));
  }
  properties() {
    return Promise.resolve(null);
  }
  externalCurves() {
    return Promise.resolve({ shapes: [] });
  }
  measure() {
    return Promise.resolve({ pause: 'not measured' });
  }
  resolve() {
    return Promise.resolve({ outcome: 'gone' as const });
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A service whose evaluates, once `hang` is set, wait until it is restarted, as a worker deep in a long build. */
class SlowService extends FakeService {
  hang = false;
  restarts = 0;
  private waiting: ((e: Error) => void)[] = [];
  override evaluate(doc: unknown) {
    if (!this.hang) return super.evaluate(doc);
    this.evaluated.push(doc);
    return new Promise<Display>((_, reject) => this.waiting.push(reject));
  }
  restart() {
    this.restarts++;
    this.hang = false;
    for (const reject of this.waiting.splice(0)) reject(new Error('The worker was restarted'));
  }
}

describe('another document while one builds', () => {
  const boot = async (client: SlowService) => {
    const { services } = await bootApp({
      client,
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(5),
      name: () => 'slow-build',
    });
    await services.ready;
    await services.whenShown();
    return services;
  };

  it('restarts the worker, and builds the new document without waiting for the old build', async () => {
    const client = new SlowService();
    const services = await boot(client);
    client.hang = true;
    services.session.newDocument();
    await settle();
    expect(services.scheduler.evaluatingNow).toBe(true);
    // A second document while the first still builds: the build stops, the second is shown.
    services.session.newDocument();
    await services.whenShown();
    expect(client.restarts).toBe(1);
    expect(services.display.getState().error).toBeNull();
    expect(client.evaluated.at(-1)).toBe(services.editor.document);
  });

  it('leaves the worker alone when nothing builds', async () => {
    const client = new SlowService();
    const services = await boot(client);
    services.session.newDocument();
    await services.whenShown();
    expect(client.restarts).toBe(0);
  });
});

describe('bootApp', () => {
  it('boots a new document, loads the kernel and shows the first display', async () => {
    const client = new FakeService();
    const { services, notice } = await bootApp({
      client,
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(3),
      name: () => 'quiet-ratchet',
    });
    expect(notice).toBeUndefined();
    expect(client.inits).toBe(1);
    await services.ready;
    await services.scheduler.whenIdle();
    expect(services.display.getState().display?.generation).toBe(1);
    const doc = services.editor.document;
    expect(readDocument(doc).diagnostics).toEqual([]);
    expect((doc.parts as { name: string }[])[0]?.name).toBe('Part 1');
    expect((doc.metadata as { writer: { app: string } }).writer.app).toBe('TweakCAD');
    expect(services.app.getState().mode).toEqual({ kind: 'model' });
    services.dispose();
  });

  it('restores the working copy, evaluates each edit, and undo and redo go through the editor', async () => {
    const workingCopy = new MemoryWorkingCopy();
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 10, 10));
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])] });
    const text = new Editor(d.document()).save();
    await workingCopy.put({
      id: 'doc_w',
      name: 'w',
      text,
      updatedAt: '2026-11-06T00:00:00.000Z',
      storage: { kind: 'unsaved' },
    });
    const client = new FakeService();
    const { services } = await bootApp({ client, workingCopy, localId: 'doc_w', autosaveMs: 1 });
    expect(services.editor.save()).toBe(text);
    await services.scheduler.whenIdle();
    services.editor.dispatch({ type: 'renameDocument', name: 'Renamed' });
    await services.scheduler.whenIdle();
    expect(services.editor.undo()).toBe(true);
    await services.scheduler.whenIdle();
    expect(services.editor.save()).toBe(text);
    expect(services.editor.redo()).toBe(true);
    await services.scheduler.whenIdle();
    expect(client.evaluated).toHaveLength(4);
    await new Promise((r) => setTimeout(r, 20));
    expect(workingCopy.records.get('doc_w')?.text).toBe(services.editor.save());
    services.dispose();
  });

  it('picks only keys of the shown display, and exports the shown part', async () => {
    const client = new FakeService();
    const { services } = await bootApp({ client, workingCopy: new MemoryWorkingCopy(), localId: null });
    await services.scheduler.whenIdle();
    expect(await services.pick({ key: 4 })).not.toBeNull();
    expect(client.picks).toEqual([{ key: 4 }]);
    // An edit between the hover and the pick: the key's display is gone.
    const pending = services.pick({ key: 5 });
    services.editor.dispatch({ type: 'renameDocument', name: 'x' });
    expect(await pending).toBeNull();
    const part = (services.editor.document.parts as { id: string }[])[0]!.id;
    expect(await services.exportShown('stl')).toEqual(new Uint8Array([1, 2, 3]));
    expect(client.exports).toEqual([{ format: 'stl', scope: { part } }]);
    services.dispose();
  });

  it('boots a cloud project bound to it: edits reach its working copy and the project', async () => {
    const site = new FakeSite();
    const cloud = new CloudProjects(site);
    const { id } = await cloud.create('Plate');
    const workingCopy = new MemoryWorkingCopy();
    const ids = seededIds(5);
    const outcome = await resolveBoot({
      workingCopy,
      localId: null,
      projectId: id,
      reset: false,
      ids,
      name: () => 'unused',
      saas: { reachable: true, signedIn: true },
      offlineChosen: false,
      cloud,
    });
    if (outcome.kind !== 'document') throw new Error(outcome.kind);
    const client = new FakeService();
    const { services } = await bootApp({
      client,
      workingCopy,
      localId: null,
      boot: outcome.boot,
      cloud,
      ids,
      autosaveMs: 1,
    });
    expect(services.session.storage).toEqual({ kind: 'cloud', projectId: id, name: 'Plate' });
    services.editor.dispatch({ type: 'renameDocument', name: 'Bracket' });
    await new Promise((r) => setTimeout(r, 20));
    expect(workingCopy.records.get(cloudRecordId(id))?.text).toBe(services.editor.save());
    expect(site.projects.get(id)?.text).toBe(services.editor.save());
    expect(site.renames).toEqual(['Bracket']);
    services.dispose();
  });

  it('clears the selection and the console and returns to modelling when another document opens', async () => {
    const client = new FakeService();
    const { services } = await bootApp({ client, workingCopy: new MemoryWorkingCopy(), localId: null });
    await settle();
    select(services.selection, { feature: 'feat_x' });
    services.app.setState({ mode: { kind: 'sketch', part: 'p', feature: 'f' } });
    consoleLog('warn', 'Extrude 1: the profile is gone', 'rebuild');
    services.session.newDocument();
    expect(services.selection.getState().items).toEqual([]);
    expect(services.app.getState().mode).toEqual({ kind: 'model' });
    expect(consoleStore.getState().entries).toEqual([]);
    services.dispose();
  });
});

describe('a revision previewed in the app', () => {
  /** A cloud project booted in the app with one revision ("Kept") and a live document edited past it ("Live"), not yet written. */
  async function previewable() {
    const site = new FakeSite();
    const cloud = new CloudProjects(site);
    const { id } = await cloud.create('Plate');
    const workingCopy = new MemoryWorkingCopy();
    const ids = seededIds(9);
    const outcome = await resolveBoot({
      workingCopy,
      localId: null,
      projectId: id,
      reset: false,
      ids,
      name: () => 'unused',
      saas: { reachable: true, signedIn: true },
      offlineChosen: false,
      cloud,
    });
    if (outcome.kind !== 'document') throw new Error(outcome.kind);
    const client = new FakeService();
    const { services } = await bootApp({
      client,
      workingCopy,
      localId: null,
      boot: outcome.boot,
      cloud,
      ids,
      autosaveMs: 5,
    });
    services.editor.dispatch({ type: 'renameDocument', name: 'Kept' });
    expect(await services.session.save()).toEqual({ ok: true });
    const revision = site.projects.get(id)!.revisions[0]!.versionId;
    services.editor.dispatch({ type: 'renameDocument', name: 'Live' });
    await new Promise((r) => setTimeout(r, 20));
    const written = () => ({
      project: site.projects.get(id)!.text,
      copy: workingCopy.records.get(cloudRecordId(id))?.text,
    });
    return { site, client, services, id, revision, written };
  }
  const nameOf = (doc: unknown) => (doc as { metadata: { name: string } }).metadata.name;

  it('changes nothing on an edit attempt during the preview, and Close brings the live document back with its undo stack', async () => {
    const { client, services, revision, written } = await previewable();
    const { editor, app, selection } = services;
    const live = editor.document;
    const part = (live.parts as { id: string }[])[0]!.id;
    const before = written();
    app.setState({
      focus: { part },
      mode: { kind: 'sketch', part, feature: 'feat_s' },
      panel: { kind: 'extrude' },
      parametersOpen: true,
    });
    select(selection, { feature: 'feat_s' });

    await services.session.previewRevision(revision, 'Kept');
    expect(nameOf(editor.document)).toBe('Kept');
    // Nothing that edits stays open over the preview.
    expect(app.getState()).toMatchObject({ mode: { kind: 'model' }, panel: null, parametersOpen: false });
    expect(selection.getState().items).toEqual([]);

    // Edit attempts: a command, a transaction (Delete), undo and redo.
    expect(editor.dispatch({ type: 'renameDocument', name: 'Edited' }).ok).toBe(false);
    editor.transaction('Delete features', () => {
      editor.dispatch({ type: 'removeFeature', feature: 'feat_s' });
    });
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(nameOf(editor.document)).toBe('Kept');
    // A sketch or an editing panel opened during the preview closes at once; Measure stays.
    app.setState({ mode: { kind: 'sketch', part, feature: 'feat_s' } });
    expect(app.getState().mode).toEqual({ kind: 'model' });
    app.setState({ panel: { kind: 'fillet' } });
    expect(app.getState().panel).toBeNull();
    app.setState({ panel: { kind: 'measure' } });
    expect(app.getState().panel).toEqual({ kind: 'measure' });
    app.setState({ focus: null });

    // The preview is evaluated and shown, and never written.
    await services.whenShown();
    expect(nameOf(client.evaluated.at(-1))).toBe('Kept');
    await new Promise((r) => setTimeout(r, 20));
    expect(written()).toEqual(before);

    services.session.closePreview();
    expect(editor.document).toBe(live);
    expect(editor.store.undoLabel()).toBe('Rename document');
    expect(app.getState().focus).toEqual({ part });
    await services.whenShown();
    expect(nameOf(client.evaluated.at(-1))).toBe('Live');
    expect(editor.undo()).toBe(true);
    expect(nameOf(editor.document)).toBe('Kept');
    expect(editor.redo()).toBe(true);
    expect(nameOf(editor.document)).toBe('Live');
    await new Promise((r) => setTimeout(r, 20));
    expect(written()).toEqual(before);
    services.dispose();
  });

  it('switches to another revision without touching the live document, and Restore makes one live', async () => {
    const { site, services, id, revision } = await previewable();
    const { editor } = services;
    const live = editor.document;
    await services.session.save();
    const newer = site.projects.get(id)!.revisions[0]!.versionId;
    await services.session.previewRevision(revision, 'Kept');
    await services.session.previewRevision(newer, 'Newer');
    expect(nameOf(editor.document)).toBe('Live');
    expect(editor.document).not.toBe(live);
    expect(editor.store.liveDocument).toBe(live);
    expect(editor.store.readOnly).toBe(true);
    await services.session.restoreRevision(revision);
    expect(services.session.preview).toBeNull();
    expect(editor.store.readOnly).toBe(false);
    expect(editor.dispatch({ type: 'renameDocument', name: 'After' }).ok).toBe(true);
    services.dispose();
  });
});

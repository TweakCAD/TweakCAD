import { describe, expect, it } from 'vitest';
import { Editor, randomIds, type Doc, type Json } from '@tweakcad/editor';
import type { BeforeScope, Display, EvaluateServiceOptions, Progress } from '@tweakcad/worker/src/v2/service/types';
import { setVisible } from '../attributes';
import { newDocument } from '../document';
import { RebuildScheduler, rolledBefore, rolledThrough, type Evaluator } from './scheduler';
import { statusText } from './status';

function display(generation: number): Display {
  return {
    generation,
    definitions: [],
    parts: {},
    assemblies: [],
    entities: [],
    pauses: [],
    stale: [],
    outOfDate: [],
    timing: { evaluate: 0, display: 0, resumed: 0 },
  };
}

/** An evaluator whose calls resolve when the test says so. */
class ManualEvaluator implements Evaluator {
  readonly calls: {
    doc: unknown;
    options: EvaluateServiceOptions | undefined;
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];
  private generation = 0;
  inFlight = 0;
  maxInFlight = 0;

  evaluate(doc: unknown, options?: EvaluateServiceOptions): Promise<Display> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      this.calls.push({
        doc,
        options,
        resolve: () => {
          this.inFlight--;
          resolve(display(generation));
        },
        reject: (e) => {
          this.inFlight--;
          reject(e);
        },
      });
    });
  }

  /** Settles the newest call and lets the scheduler react. */
  async finish(index = this.calls.length - 1): Promise<void> {
    this.calls[index]?.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const docNamed = (name: string) => ({ ...newDocument({ ids: randomIds(), name }) });

describe('RebuildScheduler', () => {
  it('evaluates the current document when it attaches and publishes the display', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    expect(evaluator.calls).toHaveLength(1);
    expect(scheduler.store.getState().evaluating).toBe(true);
    await evaluator.finish();
    const state = scheduler.store.getState();
    expect(state.display?.generation).toBe(1);
    expect(state.revision).toBe(editor.store.revision);
    expect(state.evaluating).toBe(false);
  });

  it('shows what the worker reports while it builds, and what an import holding the worker reports, until idle', async () => {
    const listeners: ((p: Progress) => void)[] = [];
    const evaluator = Object.assign(new ManualEvaluator(), {
      onProgress: (l: (p: Progress) => void) => {
        listeners.push(l);
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
    });
    const post = (p: Progress) => listeners.forEach((l) => l(p));
    const scheduler = new RebuildScheduler(evaluator);
    const state = () => scheduler.store.getState();
    // Idle, nothing shows.
    post({ phase: 'reading' });
    expect(state().status).toBeNull();
    scheduler.attach(new Editor(docNamed('a')).store);
    expect(state().evaluating).toBe(true);
    expect(state().busySince).not.toBeNull();
    post({
      phase: 'building',
      done: 3,
      total: 9,
      kept: 2,
      part: 'part_1',
      feature: 'feat_1',
      name: 'Extrude 2',
      type: 'core.extrude',
    });
    expect(state().status).toEqual({ label: 'Building Extrude 2', done: 3, total: 9 });
    expect(statusText(state().status)).toBe('Building Extrude 2 (4 of 9)');
    // What comes within 100 ms waits, and only the newest shows: the line does not change for every feature.
    post({
      phase: 'building',
      done: 4,
      total: 9,
      kept: 2,
      part: 'part_1',
      feature: 'feat_2',
      name: 'Extrude 3',
      type: 'core.extrude',
    });
    post({ phase: 'meshing', done: 0, total: 5 });
    expect(statusText(state().status)).toBe('Building Extrude 2 (4 of 9)');
    await new Promise((r) => setTimeout(r, 120));
    expect(statusText(state().status)).toBe('Meshing bodies (1 of 5)');
    await evaluator.finish();
    expect(state().status).toBeNull();
    expect(state().busySince).toBeNull();

    let release = () => {};
    const task = scheduler.exclusive(async () => {
      scheduler.report({ label: 'Checking sketches', done: 4, total: 40 });
      await new Promise<void>((r) => (release = r));
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(statusText(state().status, 12_400)).toBe('Checking sketches (5 of 40) · 12 s');
    release();
    await task;
    await evaluator.finish();
    expect(state().status).toBeNull();
    scheduler.dispose();
    expect(listeners).toHaveLength(0);
  });

  it('asks the worker to show a change only to what is shown from the evaluation it keeps', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const part = ((editor.document.parts as Json[])[0] as Json).id as string;
    const plane = { reference: { standard: { name: 'xy' } }, names: {} };
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    const restyle = () => evaluator.calls.at(-1)?.options?.restyle;
    expect(restyle()).toBeUndefined();
    await evaluator.finish();
    setVisible(editor, part, plane, false);
    expect(restyle()).toBe(1);
    await evaluator.finish();
    // A change to what is built is evaluated.
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    expect(restyle()).toBeUndefined();
    await evaluator.finish();
    setVisible(editor, part, plane, true);
    expect(restyle()).toBe(3);
    // A failed evaluate leaves the worker keeping nothing known.
    evaluator.calls.at(-1)?.reject(new Error('no'));
    await new Promise((r) => setTimeout(r, 0));
    setVisible(editor, part, plane, false);
    expect(restyle()).toBeUndefined();
    await evaluator.finish();
    // Work holding the worker evaluates documents of its own.
    await scheduler.exclusive(() => Promise.resolve());
    await evaluator.finish();
    expect(restyle()).toBeUndefined();
    setVisible(editor, part, plane, true);
    expect(restyle()).toBe(6);
  });

  it('keeps one evaluate in flight and lets the newest document win', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    for (const name of ['b', 'c', 'd']) {
      expect(editor.dispatch({ type: 'renameDocument', name }).ok).toBe(true);
    }
    // Three changes while the first evaluate runs: no second call yet.
    expect(evaluator.calls).toHaveLength(1);
    await evaluator.finish(0);
    // The superseded result is not published; only the newest document is asked for.
    expect(scheduler.store.getState().display).toBeNull();
    expect(evaluator.calls).toHaveLength(2);
    expect((evaluator.calls[1]?.doc as { metadata: { name: string } }).metadata.name).toBe('d');
    await evaluator.finish(1);
    expect(scheduler.store.getState().display?.generation).toBe(2);
    expect(scheduler.store.getState().revision).toBe(editor.store.revision);
    expect(evaluator.maxInFlight).toBe(1);
  });

  it('follows undo and redo like any other change', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    await evaluator.finish();
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    await evaluator.finish();
    editor.undo();
    await evaluator.finish();
    const last = evaluator.calls[2]?.doc as { metadata: { name: string } };
    expect(last.metadata.name).toBe('a');
    expect(scheduler.store.getState().display?.generation).toBe(3);
  });

  it('keeps the last display and reports the error when an evaluate fails', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    await evaluator.finish();
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    evaluator.calls[1]?.reject(new Error('kernel gone'));
    await new Promise((r) => setTimeout(r, 0));
    const state = scheduler.store.getState();
    expect(state.display?.generation).toBe(1);
    expect(state.error).toBe('kernel gone');
    expect(state.evaluating).toBe(false);
    editor.dispatch({ type: 'renameDocument', name: 'c' });
    await evaluator.finish();
    expect(scheduler.store.getState().error).toBeNull();
  });

  it('resolves whenIdle after the newest display is published', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    let idle = false;
    const done = scheduler.whenIdle().then(() => {
      idle = true;
    });
    await evaluator.finish(0);
    expect(idle).toBe(false);
    await evaluator.finish(1);
    await done;
    expect(idle).toBe(true);
    expect(scheduler.store.getState().display?.generation).toBe(2);
  });

  it('shows a preview document in place of the editor, then the newest editor document again', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    await evaluator.finish();
    const name = (i: number) => (evaluator.calls[i]?.doc as { metadata: { name: string } }).metadata.name;
    scheduler.setPreview(docNamed('candidate'));
    expect(scheduler.previewing).toBe(true);
    await evaluator.finish();
    expect(name(1)).toBe('candidate');
    expect(scheduler.store.getState().preview).toBe(true);
    // The committed display stays the editor's, for the browser to list.
    expect(scheduler.store.getState().committed?.generation).toBe(1);
    // An editor change while previewing is held back, and the same preview twice asks nothing.
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    const preview = docNamed('again');
    scheduler.setPreview(preview);
    scheduler.setPreview(preview);
    await evaluator.finish();
    expect(evaluator.calls).toHaveLength(3);
    expect(name(2)).toBe('again');
    // Clearing it shows the editor's newest document.
    scheduler.setPreview(null);
    await evaluator.finish();
    expect(name(3)).toBe('b');
    const state = scheduler.store.getState();
    expect(state.preview).toBe(false);
    expect(state.revision).toBe(editor.store.revision);
    expect(state.display?.generation).toBe(4);
    expect(state.committed).toBe(state.display);
  });

  it('lists the state a panel works in after each display, without evaluating, until the panel lets go', async () => {
    const evaluator = new ManualEvaluator();
    const listed: { scope: BeforeScope; generation: number }[] = [];
    let latest = 0;
    const lister: Evaluator = {
      evaluate: (doc) => evaluator.evaluate(doc).then((d) => ((latest = d.generation), d)),
      bodiesBefore: (scope) => {
        listed.push({ scope, generation: latest });
        return Promise.resolve({
          generation: latest,
          bodies: [
            { key: latest, id: 'b', feature: 'feat_a', name: 'Body 1', color: '#6699cc', opacity: 1, visible: true },
          ],
          references: [],
        });
      },
    };
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(lister);
    scheduler.attach(editor.store);
    await evaluator.finish();
    expect(scheduler.store.getState().before).toBeNull();
    // Named while nothing is in flight: listed from the kept evaluation at once.
    scheduler.setBefore({ part: 'part_1', feature: 'feat_cut' });
    await scheduler.whenIdle();
    expect(scheduler.store.getState().before).toMatchObject({ part: 'part_1', feature: 'feat_cut', generation: 1 });
    // A preview's display is followed by a listing from its evaluation; naming the same state again asks nothing.
    scheduler.setPreview(docNamed('candidate'));
    scheduler.setBefore({ part: 'part_1', feature: 'feat_cut' });
    await evaluator.finish();
    await scheduler.whenIdle();
    expect(scheduler.store.getState().before?.generation).toBe(2);
    expect(scheduler.store.getState().before?.bodies[0]?.key).toBe(2);
    expect(listed).toHaveLength(2);
    expect(evaluator.calls).toHaveLength(2);
    scheduler.setBefore(null);
    expect(scheduler.store.getState().before).toBeNull();
    scheduler.setPreview(null);
    await evaluator.finish();
    await scheduler.whenIdle();
    expect(listed).toHaveLength(2);
    expect(scheduler.store.getState().before).toBeNull();
  });

  it('runs a task of its own on the worker alone, then shows the newest document again', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(editor.store);
    let release = () => {};
    const steps: string[] = [];
    const task = () => {
      steps.push('started');
      return new Promise<string>((resolve) => (release = () => resolve('converted')));
    };
    // It waits for the evaluate in flight.
    const outcome = scheduler.exclusive(task);
    await new Promise((r) => setTimeout(r, 0));
    expect(steps).toEqual([]);
    await evaluator.finish();
    expect(steps).toEqual(['started']);
    // A change made meanwhile waits, and so does anyone waiting for the shown document.
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    expect(evaluator.calls).toHaveLength(1);
    expect(scheduler.busy).toBe(true);
    let idle = false;
    const done = scheduler.whenIdle().then(() => (idle = true));
    release();
    expect(await outcome).toBe('converted');
    // The worker's evaluation is the task's, so the newest document is evaluated again before anyone is let go.
    expect(evaluator.calls).toHaveLength(2);
    expect((evaluator.calls[1]?.doc as { metadata: { name: string } }).metadata.name).toBe('b');
    expect(idle).toBe(false);
    await evaluator.finish();
    await done;
    expect(scheduler.store.getState().display?.generation).toBe(2);
    // With no change meanwhile, the same document is evaluated again, and a failed task does the same.
    await expect(scheduler.exclusive(() => Promise.reject(new Error('unreadable')))).rejects.toThrow('unreadable');
    expect(evaluator.calls).toHaveLength(3);
    await evaluator.finish();
    expect(scheduler.busy).toBe(false);
  });

  it('stops following the editor once detached or disposed', async () => {
    const evaluator = new ManualEvaluator();
    const editor = new Editor(docNamed('a'));
    const scheduler = new RebuildScheduler(evaluator);
    const detach = scheduler.attach(editor.store);
    await evaluator.finish();
    detach();
    editor.dispatch({ type: 'renameDocument', name: 'b' });
    expect(evaluator.calls).toHaveLength(1);
    scheduler.dispose();
    scheduler.request(editor.document, editor.store.revision);
    expect(evaluator.calls).toHaveLength(1);
  });
});

/** A document source that holds one document and never changes it. */
function fixedSource(document: Doc) {
  return { document, revision: 1, onRebuild: () => () => undefined };
}

/** A document with one part whose timeline is `a`, `b` (holding `b1`) and `c`, shown at its end. */
function threeFeatures(): Doc {
  return {
    ...docNamed('part'),
    parts: [
      {
        id: 'part_1',
        timeline: [{ id: 'feat_a' }, { id: 'feat_b', children: [{ id: 'feat_b1' }] }, { id: 'feat_c' }],
        rollback: { end: {} },
      },
    ],
  } as Doc;
}

const rollbackOf = (doc: unknown): unknown =>
  ((doc as { parts: { rollback: unknown }[] }).parts[0] as { rollback: unknown }).rollback;
const nameOf = (doc: unknown): string => (doc as { metadata: { name: string } }).metadata.name;

describe('the part a panel works in', () => {
  it('rolls a document back to just before a feature, or to just after it', () => {
    const doc = threeFeatures();
    expect(rollbackOf(rolledBefore(doc, { part: 'part_1', feature: 'feat_b' }))).toEqual({ before: { id: 'feat_b' } });
    expect(rollbackOf(rolledThrough(doc, { part: 'part_1', feature: 'feat_b' }))).toEqual({ before: { id: 'feat_c' } });
    expect(rollbackOf(rolledThrough(doc, { part: 'part_1', feature: 'feat_c' }))).toEqual({ end: {} });
    // A feature inside another rolls back by the top-level row that holds it.
    expect(rollbackOf(rolledBefore(doc, { part: 'part_1', feature: 'feat_b1' }))).toEqual({ before: { id: 'feat_b' } });
    // The document itself, untouched, when it already stands there or does not hold the feature (a new one).
    expect(rolledThrough(doc, { part: 'part_1', feature: 'feat_c' })).toBe(doc);
    expect(rolledBefore(doc, { part: 'part_1', feature: 'feat_new' })).toBe(doc);
    expect(rolledBefore(doc, { part: 'part_2', feature: 'feat_b' })).toBe(doc);
    expect(rollbackOf(doc)).toEqual({ end: {} });
  });

  it('shows the part just before an edited feature, its preview while the input builds, and the state before it again when it does not', async () => {
    const evaluator = new ManualEvaluator();
    const doc = threeFeatures();
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(fixedSource(doc));
    await evaluator.finish();
    const committed = scheduler.store.getState().committed;
    const scope = { part: 'part_1', feature: 'feat_b' };
    const shown = () => rollbackOf(evaluator.calls.at(-1)?.doc);

    // The panel opens on feat_b: the part before it, shown from the kept evaluation.
    scheduler.setBefore(scope);
    expect(evaluator.calls).toHaveLength(2);
    expect(shown()).toEqual({ before: { id: 'feat_b' } });
    expect(evaluator.calls.at(-1)?.options).toMatchObject({ restyle: 1 });
    expect(evaluator.calls.at(-1)?.options?.preview).toBeUndefined();
    await evaluator.finish();
    expect(scheduler.store.getState()).toMatchObject({ preview: true, candidate: false, committed });

    // Valid input: the preview, rolled back to just after feat_b, so feat_c does not show.
    const candidate = { ...threeFeatures(), metadata: { ...(doc.metadata as object), name: 'candidate' } } as Doc;
    scheduler.setPreview(candidate);
    expect(shown()).toEqual({ before: { id: 'feat_c' } });
    expect(nameOf(evaluator.calls.at(-1)?.doc)).toBe('candidate');
    // Asked for as a preview, which the worker builds only up to the rollback.
    expect(evaluator.calls.at(-1)?.options?.preview).toBe(true);
    await evaluator.finish();
    expect(scheduler.store.getState()).toMatchObject({ preview: true, candidate: true });

    // Invalid input: the part before feat_b, not the last preview.
    scheduler.setPreview(null);
    expect(evaluator.calls).toHaveLength(4);
    expect(shown()).toEqual({ before: { id: 'feat_b' } });
    expect(nameOf(evaluator.calls.at(-1)?.doc)).toBe('part');
    await evaluator.finish();
    expect(scheduler.store.getState()).toMatchObject({ preview: true, candidate: false, committed });

    // Valid again: a preview again.
    scheduler.setPreview({ ...candidate });
    expect(shown()).toEqual({ before: { id: 'feat_c' } });
    expect(nameOf(evaluator.calls.at(-1)?.doc)).toBe('candidate');
    await evaluator.finish();

    // Closed: the editor's document as it is.
    scheduler.setPreview(null);
    scheduler.setBefore(null);
    await evaluator.finish();
    await evaluator.finish();
    expect(evaluator.calls.at(-1)?.doc).toBe(doc);
    const state = scheduler.store.getState();
    expect(state.preview).toBe(false);
    expect(state.committed).toBe(state.display);
  });

  it('shows the editor document unchanged for a new feature, which goes in at the rollback', async () => {
    const evaluator = new ManualEvaluator();
    const doc = threeFeatures();
    const scheduler = new RebuildScheduler(evaluator);
    scheduler.attach(fixedSource(doc));
    await evaluator.finish();
    scheduler.setBefore({ part: 'part_1', feature: 'feat_new' });
    await scheduler.whenIdle();
    expect(evaluator.calls).toHaveLength(1);
    expect(scheduler.store.getState().preview).toBe(false);
    scheduler.setBefore(null);
    await scheduler.whenIdle();
    expect(evaluator.calls).toHaveLength(1);
  });
});

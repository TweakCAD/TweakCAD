import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Doc } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { newDocument } from '../document';
import { shownRoot } from '../features';
import { RebuildScheduler, type Evaluator } from '../display/scheduler';
import type { AppServices } from '../services';
import { newAssemblyCommands } from './assembly';
import { CANCELLED, candidateOf, commitSolved } from './commit';

const empty = (generation: number): Display => ({
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

/** An evaluator whose calls resolve when the test says so. */
class ManualEvaluator implements Evaluator {
  readonly calls: { doc: unknown; resolve: () => void }[] = [];
  evaluate(doc: unknown): Promise<Display> {
    return new Promise((resolve) => this.calls.push({ doc, resolve: () => resolve(empty(this.calls.length)) }));
  }
  async finishAll(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      for (const c of this.calls.splice(0)) c.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

/** A document whose root is an assembly holding its part, with the services `commitSolved` uses. */
function setup() {
  const editor = new Editor(newDocument({ ids: seededIds(3), name: 'Doc' }), { ids: seededIds(4) });
  const part = (shownRoot(editor.document) as { part: string }).part;
  const made = newAssemblyCommands(editor, 'Assembly 1', [part]);
  for (const c of made.commands) expect(editor.dispatch(c).ok).toBe(true);
  const evaluator = new ManualEvaluator();
  const scheduler = new RebuildScheduler(evaluator);
  scheduler.attach(editor.store);
  const services = { editor, scheduler, display: scheduler.store } as unknown as AppServices;
  return { editor, evaluator, scheduler, services, assembly: made.assembly };
}

const rename = (assembly: string, name: string) => [{ type: 'renameAssembly' as const, assembly, name }];

describe('commitSolved', () => {
  it('refuses when another preview replaced its own while it waited, and leaves that preview alone', async () => {
    const { editor, evaluator, scheduler, services, assembly } = setup();
    await evaluator.finishAll();
    const before = editor.save();
    const pending = commitSolved(services, 'Rename', rename(assembly, 'A'));
    const other = candidateOf(editor.document, rename(assembly, 'B'));
    if (!other.ok) throw new Error(other.message);
    scheduler.setPreview(other.doc);
    await evaluator.finishAll();
    expect(await pending).toEqual({ ok: false, message: 'The model changed before it was solved; try again' });
    expect(editor.save()).toBe(before);
    expect(scheduler.previewDocument).toBe(other.doc);
  });

  it('writes nothing when called off while it waited', async () => {
    const { editor, evaluator, scheduler, services, assembly } = setup();
    await evaluator.finishAll();
    const before = editor.save();
    let live = true;
    const pending = commitSolved(services, 'Rename', rename(assembly, 'A'), () => live);
    live = false;
    scheduler.setPreview(null);
    await evaluator.finishAll();
    expect(await pending).toEqual({ ok: false, message: CANCELLED });
    expect(editor.save()).toBe(before);
  });

  it('writes the commands once its own preview is shown, and clears it', async () => {
    const { editor, evaluator, scheduler, services, assembly } = setup();
    await evaluator.finishAll();
    const pending = commitSolved(services, 'Rename', rename(assembly, 'A'));
    await evaluator.finishAll();
    expect(await pending).toEqual({ ok: true });
    expect(((editor.document as Doc).assemblies as { name: string }[])[0]?.name).toBe('A');
    expect(scheduler.previewDocument).toBeNull();
  });
});

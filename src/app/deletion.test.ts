import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { readDocument } from '@tweakcad/format';
import { standardDocument } from '../../lib/editor/src/testDocs';
import { candidateOf } from './assembly/commit';
import { confirmMessage, deletePlan, usesOf } from './deletion';

function setup() {
  const { doc, ids, t } = standardDocument();
  const spare = t.part('Spare').id as string;
  const editor = new Editor(doc, { ids: seededIds(3) });
  return { editor, ids, t, spare };
}

const run = (editor: Editor, label: string, commands: Parameters<typeof candidateOf>[1]) =>
  editor.transaction(label, () => {
    for (const c of commands) {
      const r = editor.dispatch(c);
      if (!r.ok) throw new Error(r.error.message);
    }
  });

describe('deleting a part or an assembly', () => {
  it('deletes a part nothing uses at once, as one undo step, folder entry and all', () => {
    const { editor, spare } = setup();
    editor.dispatch({ type: 'addFolder', folder: { id: editor.newId('fld'), name: 'F', members: [spare] } });
    const plan = deletePlan(editor.document, spare);
    expect(plan.kind).toBe('now');
    if (plan.kind !== 'now') return;
    expect(plan.label).toBe('Delete Spare');
    run(editor, plan.label, plan.commands);
    expect((editor.document.parts as Json[]).some((p) => p.id === spare)).toBe(false);
    expect((editor.document.folders as Json[])[0]?.members).toEqual([]);
    expect(readDocument(editor.document).refused).toBe(false);
    editor.undo();
    expect((editor.document.parts as Json[]).some((p) => p.id === spare)).toBe(true);
  });

  it("refuses the document's root, saying so", () => {
    const { editor, ids } = setup();
    expect(usesOf(editor.document, ids.part).map((u) => u.kind)).toContain('root');
    const plan = deletePlan(editor.document, ids.part);
    expect(plan).toMatchObject({ kind: 'blocked' });
    expect(plan.kind === 'blocked' && plan.message).toMatch(/Bracket cannot be deleted: it is the document's root/);
  });

  it('asks before deleting a part instances place, and then removes them with their joints', () => {
    const { editor, ids } = setup();
    editor.dispatch({ type: 'setRoot', root: { assembly: { id: ids.assembly } } });
    const plan = deletePlan(editor.document, ids.part);
    expect(plan.kind).toBe('confirm');
    if (plan.kind !== 'confirm') return;
    expect(plan.instances.map((u) => u.instance)).toEqual(ids.instances);
    expect(confirmMessage('Bracket', plan.instances)).toBe(
      'Bracket is placed 2 times in Assembly. Deleting it also removes those instances and their joints.',
    );
    const candidate = candidateOf(editor.document, plan.commands);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    // The test document's joint stands on fixed frames, not on the instances, so it stays.
    expect(((candidate.doc.assemblies as Json[])[0] as Json).instances).toEqual([]);
    expect((candidate.doc.parts as Json[]).some((p) => p.id === ids.part)).toBe(false);
  });

  it("refuses a part another part's feature uses, naming the feature", () => {
    const { doc, t } = standardDocument();
    const spare = t.part('Spare').id as string;
    (t.part('Host').timeline as Json[]).push(t.feature('core.derive', { of: { part: { id: spare } } }, 'Derive 1'));
    const plan = deletePlan(doc, spare);
    expect(plan.kind === 'blocked' && plan.message).toBe(
      'Spare cannot be deleted: Derive 1 in Host uses it; remove or change that first.',
    );
  });

  it('refuses the root assembly', () => {
    const { editor, ids } = setup();
    editor.dispatch({ type: 'setRoot', root: { assembly: { id: ids.assembly } } });
    expect(deletePlan(editor.document, ids.assembly)).toMatchObject({ kind: 'blocked' });
  });
});

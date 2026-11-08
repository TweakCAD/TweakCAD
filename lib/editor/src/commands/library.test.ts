import { contentHash, nameHash, readDocument, writeDocument } from '@tweakcad/format';
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor';
import { seededIds } from '../ids';
import type { Json } from '../rows';
import { standardDocument } from '../testDocs';
import type { EditorCommand } from './types';

function setup() {
  const { doc, ids, t } = standardDocument();
  return { editor: new Editor(doc, { ids: seededIds(11) }), ids, t };
}

/** Runs a command that must succeed, with the result read without refusals and undo restoring the bytes. */
function run(editor: Editor, command: EditorCommand): void {
  const before = writeDocument(editor.document);
  const result = editor.dispatch(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
  expect(readDocument(editor.document).refused).toBe(false);
  const after = writeDocument(editor.document);
  expect(editor.undo()).toBe(true);
  expect(writeDocument(editor.document)).toBe(before);
  expect(editor.redo()).toBe(true);
  expect(writeDocument(editor.document)).toBe(after);
}

function refusal(editor: Editor, command: EditorCommand): string {
  const before = writeDocument(editor.document);
  const result = editor.dispatch(command);
  if (result.ok) throw new Error(`${command.type} was not refused`);
  expect(writeDocument(editor.document)).toBe(before);
  return result.error.code;
}

/** A one-part document to embed: the standard document's part alone. */
function embedded(): Json {
  const { doc } = standardDocument();
  return { ...doc, assemblies: [], assets: {} };
}

const bytes = new TextEncoder().encode('solid');
const asset = {
  mediaType: 'model/x.brep',
  name: 'shape.brep',
  size: bytes.length,
  data: { inline: { base64: btoa('solid') } },
};

describe('library entries', () => {
  it('embeds a document with its assets, and removes it once nothing inserts it', () => {
    const { editor, t, ids } = setup();
    const content = { inline: { definition: embedded() } };
    const entry = {
      id: t.id('lib'),
      hash: nameHash(content),
      kind: 'document',
      content,
      source: { local: {} },
      name: 'Bracket',
    };
    run(editor, { type: 'addLibraryEntry', entry, assets: { [contentHash(bytes)]: asset } });
    expect((editor.document.assets as Json)[contentHash(bytes)]).toEqual(asset);
    expect(editor.store.undoLabel()).toBe('Add Bracket');

    // An instance of it holds it.
    const instance = {
      ...t.instance(ids.part),
      of: {
        component: {
          value: {
            id: t.id('val'),
            def: { expr: { text: 'c', grammar: 1, refs: { c: { library: { id: entry.id } } } } },
          },
        },
      },
    };
    run(editor, { type: 'addAssemblyRow', assembly: ids.assembly, table: 'instances', row: instance });
    expect(refusal(editor, { type: 'removeLibraryEntry', entry: entry.id })).toBe('not-allowed');
    run(editor, { type: 'removeAssemblyRow', row: instance.id as string });
    run(editor, { type: 'removeLibraryEntry', entry: entry.id });
  });

  it("refuses an embedded document whose hash is not its content's, and a second entry of one id", () => {
    const { editor, t } = setup();
    const content = { inline: { definition: embedded() } };
    const entry = {
      id: t.id('lib'),
      hash: nameHash(content),
      kind: 'document',
      content,
      source: { local: {} },
      name: 'Bracket',
    };
    expect(refusal(editor, { type: 'addLibraryEntry', entry: { ...entry, hash: nameHash({}) } })).toBe('invalid');
    run(editor, { type: 'addLibraryEntry', entry });
    expect(refusal(editor, { type: 'addLibraryEntry', entry })).toBe('invalid');
  });
});

describe('contexts', () => {
  it("adds a part's context, re-captures it and removes it", () => {
    const { editor, t, ids } = setup();
    const context = {
      id: t.id('ctx'),
      assembly: { id: ids.assembly },
      at: { path: [{ instance: { id: ids.instances[0] } }] },
      captured: { set: [] },
      source: nameHash({}),
      policy: 'manual',
      capturedAt: '2026-11-06T00:00:00Z',
    };
    run(editor, { type: 'addContext', part: ids.part, context });
    run(editor, {
      type: 'editContext',
      context: context.id,
      set: { policy: 'automatic', capturedAt: '2026-11-06T01:00:00Z' },
      assets: { [contentHash(bytes)]: asset },
    });
    expect(editor.store.undoLabel()).toBe('Update context');
    // The assembly and the instance path name the context; they do not change.
    expect(
      refusal(editor, {
        type: 'editContext',
        context: context.id,
        set: { at: { path: [{ instance: { id: ids.instances[1] } }] } },
      }),
    ).toBe('bad-argument');
    expect(
      refusal(editor, { type: 'editContext', context: context.id, set: { policy: 'sometimes', capturedAt: 'later' } }),
    ).toBe('invalid');
    run(editor, { type: 'removeContext', context: context.id });
    expect(refusal(editor, { type: 'removeContext', context: context.id })).toBe('not-found');
  });
});

describe('amending the newest undo step', () => {
  it('folds edits into the step before, so one undo takes both back', () => {
    const { editor, ids } = setup();
    const start = writeDocument(editor.document);
    expect(editor.dispatch({ type: 'renamePart', part: ids.part, name: 'Plate' }).ok).toBe(true);
    editor.amend('Follow', () => editor.dispatch({ type: 'renameDocument', name: 'Plates' }));
    expect(editor.store.undoLabel()).toBe('Rename Bracket');
    expect(editor.undo()).toBe(true);
    expect(writeDocument(editor.document)).toBe(start);
    expect(editor.redo()).toBe(true);
    expect((editor.document.metadata as Json).name).toBe('Plates');
    expect(editor.store.canRedo()).toBe(false);
  });

  it('makes a step of its own when there is none, and reverts when it throws', () => {
    const { editor, ids } = setup();
    editor.amend('Rename', () => editor.dispatch({ type: 'renamePart', part: ids.part, name: 'Plate' }));
    expect(editor.store.undoLabel()).toBe('Rename');
    const before = writeDocument(editor.document);
    expect(() =>
      editor.amend('Fails', () => {
        editor.dispatch({ type: 'renameDocument', name: 'Gone' });
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(writeDocument(editor.document)).toBe(before);
    expect(editor.store.undoLabel()).toBe('Rename');
  });
});

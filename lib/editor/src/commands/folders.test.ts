import { nameHash, readDocument, writeDocument } from '@tweakcad/format';
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor';
import { seededIds } from '../ids';
import type { Json } from '../rows';
import { standardDocument } from '../testDocs';
import type { EditorCommand } from './types';

function setup() {
  const { doc, ids, t } = standardDocument();
  const spare = t.part('Spare');
  const editor = new Editor(doc, { ids: seededIds(13) });
  return { editor, ids: { ...ids, spare: spare.id as string }, t };
}

/** Runs a command that must change the document, with the result read without refusals and undo restoring the bytes. */
function run(editor: Editor, command: EditorCommand): void {
  const before = writeDocument(editor.document);
  const result = editor.dispatch(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
  expect(result.changed).toBe(true);
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

const folders = (editor: Editor) => editor.document.folders as Json[];
const folder = (editor: Editor, id: string) => folders(editor).find((f) => f.id === id) as Json;
/** Each folder as `name: members` with its parent, for short expectations. */
const outline = (editor: Editor) =>
  folders(editor).map((f) => {
    const parent = (f.parent as { folder?: { id: string } }).folder?.id;
    const parentName = parent ? folder(editor, parent).name : 'top';
    return `${f.name as string} in ${parentName as string}: ${(f.members as string[]).join(',')}`;
  });

function addFolder(editor: Editor, name: string, extra: Json = {}): string {
  const id = editor.newId('fld');
  run(editor, { type: 'addFolder', folder: { id, name, ...extra } });
  return id;
}

describe('folders', () => {
  it('makes, renames and nests folders that hold parts and assemblies', () => {
    const { editor, ids } = setup();
    const frame = addFolder(editor, 'Frame', { members: [ids.part, ids.assembly] });
    expect(editor.store.undoLabel()).toBe('New Frame');
    const bolts = addFolder(editor, 'Bolts', { parent: { folder: { id: frame } } });
    run(editor, { type: 'renameFolder', folder: bolts, name: 'Fasteners' });
    expect(editor.store.undoLabel()).toBe('Rename Bolts');
    expect(outline(editor)).toEqual([`Frame in top: ${ids.part},${ids.assembly}`, 'Fasteners in Frame: ']);
  });

  it('moves items between folders, in order, and back to the top level', () => {
    const { editor, ids } = setup();
    const a = addFolder(editor, 'A', { members: [ids.part, ids.spare] });
    const b = addFolder(editor, 'B');
    run(editor, { type: 'moveToFolder', items: [ids.spare], folder: b });
    expect(editor.store.undoLabel()).toBe('Move to B');
    run(editor, { type: 'moveToFolder', items: [ids.part, ids.assembly], folder: b, before: ids.spare });
    expect(outline(editor)).toEqual(['A in top: ', `B in top: ${ids.part},${ids.assembly},${ids.spare}`]);
    // Reordering within the folder.
    run(editor, { type: 'moveToFolder', items: [ids.spare], folder: b, before: ids.part });
    expect(folder(editor, b).members).toEqual([ids.spare, ids.part, ids.assembly]);
    run(editor, { type: 'moveToFolder', items: [ids.part] });
    expect(editor.store.undoLabel()).toBe('Move to top level');
    expect(folder(editor, b).members).toEqual([ids.spare, ids.assembly]);
    expect(folder(editor, a).members).toEqual([]);
  });

  it('moves folders into others and orders them, never inside themselves', () => {
    const { editor } = setup();
    const a = addFolder(editor, 'A');
    const b = addFolder(editor, 'B');
    const c = addFolder(editor, 'C');
    run(editor, { type: 'moveFolder', folder: c, before: a });
    expect(outline(editor)).toEqual(['C in top: ', 'A in top: ', 'B in top: ']);
    run(editor, { type: 'moveFolder', folder: b, parent: a });
    run(editor, { type: 'moveFolder', folder: c, parent: b });
    expect(outline(editor)).toEqual(['A in top: ', 'B in A: ', 'C in B: ']);
    expect(refusal(editor, { type: 'moveFolder', folder: a, parent: c })).toBe('not-allowed');
    expect(refusal(editor, { type: 'moveFolder', folder: a, parent: a })).toBe('not-allowed');
    expect(refusal(editor, { type: 'moveFolder', folder: a, before: a })).toBe('bad-argument');
    run(editor, { type: 'moveFolder', folder: c });
    expect(outline(editor)).toEqual(['A in top: ', 'B in A: ', 'C in top: ']);
  });

  it('gives a removed folder’s items and folders to its parent, and removes nothing else', () => {
    const { editor, ids } = setup();
    const outer = addFolder(editor, 'Outer', { members: [ids.assembly] });
    const inner = addFolder(editor, 'Inner', { members: [ids.part, ids.spare], parent: { folder: { id: outer } } });
    addFolder(editor, 'Deep', { parent: { folder: { id: inner } } });
    run(editor, { type: 'removeFolder', folder: inner });
    expect(editor.store.undoLabel()).toBe('Remove Inner');
    expect(outline(editor)).toEqual([`Outer in top: ${ids.assembly},${ids.part},${ids.spare}`, 'Deep in Outer: ']);
    run(editor, { type: 'removeFolder', folder: outer });
    expect(outline(editor)).toEqual(['Deep in top: ']);
    expect((editor.document.parts as Json[]).map((p) => p.id)).toEqual([ids.part, ids.spare]);
  });

  it('keeps an item in one folder at most', () => {
    const { editor, ids } = setup();
    const a = addFolder(editor, 'A', { members: [ids.part] });
    const b = addFolder(editor, 'B', { members: [ids.part, ids.part] });
    expect(folder(editor, a).members).toEqual([]);
    expect(folder(editor, b).members).toEqual([ids.part]);
  });

  it('refuses what is not a folder’s item, unknown folders and bad positions', () => {
    const { editor, ids } = setup();
    const a = addFolder(editor, 'A', { members: [ids.part] });
    expect(
      refusal(editor, { type: 'addFolder', folder: { id: editor.newId('fld'), name: 'X', members: [ids.sketch] } }),
    ).toBe('bad-argument');
    expect(refusal(editor, { type: 'addFolder', folder: { id: a, name: 'Again' } })).toBe('bad-argument');
    expect(
      refusal(editor, {
        type: 'addFolder',
        folder: { id: editor.newId('fld'), name: 'X', parent: { folder: { id: 'fld_none' } } },
      }),
    ).toBe('not-found');
    expect(refusal(editor, { type: 'moveToFolder', items: ['part_none'], folder: a })).toBe('not-found');
    expect(refusal(editor, { type: 'moveToFolder', items: [ids.spare], folder: a, before: ids.assembly })).toBe(
      'not-found',
    );
    expect(refusal(editor, { type: 'moveToFolder', items: [ids.part], folder: a, before: ids.part })).toBe(
      'bad-argument',
    );
    expect(refusal(editor, { type: 'moveToFolder', items: [ids.part], before: ids.part })).toBe('bad-argument');
    expect(refusal(editor, { type: 'renameFolder', folder: 'fld_none', name: 'X' })).toBe('not-found');
    expect(refusal(editor, { type: 'removeFolder', folder: 'fld_none' })).toBe('not-found');
  });

  it('drops a removed part, assembly or library entry from its folder', () => {
    const { editor, ids, t } = setup();
    const content = { inline: { definition: { ...standardDocument().doc, assemblies: [], assets: {} } } };
    const entry = {
      id: t.id('lib'),
      hash: nameHash(content),
      kind: 'document',
      content,
      source: { local: {} },
      name: 'Kit',
    };
    run(editor, { type: 'addLibraryEntry', entry });
    const a = addFolder(editor, 'A', { members: [ids.spare, entry.id] });
    const asm = editor.newId('asm');
    run(editor, {
      type: 'addAssembly',
      assembly: {
        ...(editor.document.assemblies as Json[])[0],
        id: asm,
        name: 'Second',
        instances: [],
        jointOrigins: [],
        joints: [],
        positions: [],
      },
    });
    run(editor, { type: 'moveToFolder', items: [asm], folder: a });
    run(editor, { type: 'removePart', part: ids.spare });
    run(editor, { type: 'removeLibraryEntry', entry: entry.id });
    run(editor, { type: 'removeAssembly', assembly: asm });
    expect(folder(editor, a).members).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { Editor, seededIds } from '@tweakcad/editor';
import { standardDocument } from '../../lib/editor/src/testDocs';
import { foldersOf } from '../app/folders';
import type { AiContext } from './context';
import { executeTool } from './executor';

function setup() {
  const { doc, ids, t } = standardDocument();
  const spare = t.part('Spare');
  const editor = new Editor(doc, { ids: seededIds(5) });
  const services = { editor, scheduler: { previewing: false }, app: { getState: () => ({ panel: null }) } };
  const ctx = { services } as unknown as AiContext;
  const transactions = { begin: () => undefined, end: () => undefined };
  const call = async (name: string, input: unknown) => {
    const result = await executeTool(name, input, { ctx, transactions });
    if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
    return result.value as Record<string, unknown>;
  };
  const refused = async (name: string, input: unknown) => {
    const result = await executeTool(name, input, { ctx, transactions });
    if (result.ok) throw new Error(`${name} was not refused`);
    return result.error.code;
  };
  return { editor, call, refused, part: ids.part, assembly: ids.assembly, spare: spare.id as string };
}

describe('the folder tools', () => {
  it('make, fill, nest, rename, reorder and delete folders, each as one undo step', async () => {
    const { editor, call, part, assembly, spare } = setup();
    const frame = (await call('folder_create', { name: 'Frame', items: [part, assembly] })).folder as string;
    const bought = (await call('folder_create', { name: 'Bought', parent: frame })).folder as string;
    const first = (await call('folder_create', { name: 'First', before: frame })).folder as string;
    expect(editor.store.undoLabel()).toBe('New folder');
    await call('folder_move_items', { items: [spare], folder: bought });
    await call('folder_move_items', { items: [assembly], folder: frame, before: part });
    await call('folder_edit', { folder: bought, name: 'Purchased', parent: 'top', before: first });
    expect(foldersOf(editor.document).map((f) => [f.name, f.parent, f.members])).toEqual([
      ['Purchased', null, [spare]],
      ['First', null, []],
      ['Frame', null, [assembly, part]],
    ]);
    // One undo takes back the rename and the move together.
    editor.undo();
    expect(foldersOf(editor.document).find((f) => f.id === bought)).toMatchObject({ name: 'Bought', parent: frame });
    editor.redo();
    await call('folder_move_items', { items: [part], folder: 'top' });
    await call('folder_delete', { folder: bought });
    expect(foldersOf(editor.document).map((f) => [f.name, f.members])).toEqual([
      ['First', []],
      ['Frame', [assembly]],
    ]);
  });

  it('refuses unknown folders and a folder inside itself, changing nothing', async () => {
    const { editor, call, refused, part } = setup();
    const outer = (await call('folder_create', {})).folder as string;
    const inner = (await call('folder_create', { parent: outer })).folder as string;
    const before = editor.save();
    expect(await refused('folder_edit', { folder: outer, parent: inner })).toBe('REFUSED');
    expect(await refused('folder_delete', { folder: 'fld_none' })).toBe('NOT_FOUND');
    expect(await refused('folder_move_items', { items: [part], before: part })).toBe('INVALID_INPUT');
    expect(await refused('folder_create', { name: 'X', items: ['feat_nope'] })).toBe('REFUSED');
    expect(editor.save()).toBe(before);
  });
});

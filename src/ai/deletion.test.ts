import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../lib/editor/src/testDocs';
import { createSelectionStore } from '../app/selection';
import type { AiContext } from './context';
import { executeTool } from './executor';

function setup() {
  const { doc, ids, t } = standardDocument();
  const spare = t.part('Spare').id as string;
  const editor = new Editor(doc, { ids: seededIds(4) });
  let state: Json = { panel: null, focus: { part: spare } };
  const app = { getState: () => state, setState: (s: Json) => void (state = { ...state, ...s }) };
  const services = { editor, scheduler: { previewing: false }, app, selection: createSelectionStore() };
  const ctx = { services } as unknown as AiContext;
  const transactions = { begin: () => undefined, end: () => undefined };
  const result = (name: string, input: unknown) => executeTool(name, input, { ctx, transactions });
  return { editor, ids, spare, result, focus: () => state.focus };
}

describe('part_delete', () => {
  it('deletes a part nothing uses, and stops showing it', async () => {
    const { editor, spare, result, focus } = setup();
    expect(await result('part_delete', { part: spare })).toEqual({
      ok: true,
      value: { deleted: spare, removedInstances: [] },
    });
    expect((editor.document.parts as Json[]).some((p) => p.id === spare)).toBe(false);
    expect(focus()).toBeNull();
    expect(editor.store.undoLabel()).toBe('Delete Spare');
  });

  it('refuses the root, and instances it was not told to delete', async () => {
    const { editor, ids, result } = setup();
    const root = await result('part_delete', { part: ids.part });
    expect(root.ok === false && root.error.code).toBe('REFUSED');
    editor.dispatch({ type: 'setRoot', root: { assembly: { id: ids.assembly } } });
    const placed = await result('part_delete', { part: ids.part });
    expect(placed.ok === false && placed.error.message).toMatch(/placed 2 times in Assembly.*withInstances: true/);
    expect((editor.document.parts as Json[]).some((p) => p.id === ids.part)).toBe(true);
    const wrong = await result('part_delete', { part: ids.assembly });
    expect(wrong.ok === false && wrong.error.code).toBe('INVALID_INPUT');
  });
});

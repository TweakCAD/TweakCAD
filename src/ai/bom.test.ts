import { describe, expect, it } from 'vitest';
import { Editor, seededIds } from '@tweakcad/editor';
import { standardDocument } from '../../lib/editor/src/testDocs';
import { bomOf } from '../app/attributes';
import type { AiContext } from './context';
import { executeTool } from './executor';

function setup() {
  const { doc, ids, t } = standardDocument();
  const bolt = t.part('Bolt').id as string;
  const nut = t.part('Nut').id as string;
  const editor = new Editor(doc, { ids: seededIds(9) });
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
  return { editor, call, refused, part: ids.part, bolt, nut };
}

describe('part_set_bom', () => {
  it('marks parts, or every part in a folder and its folders, as one undo step', async () => {
    const { editor, call, part, bolt, nut } = setup();
    const hardware = (await call('folder_create', { name: 'Hardware', items: [bolt] })).folder as string;
    await call('folder_create', { name: 'Nuts', parent: hardware, items: [nut] });
    expect(await call('part_set_bom', { kind: 'purchased', folder: hardware })).toEqual({
      kind: 'purchased',
      parts: [bolt, nut],
    });
    expect([part, bolt, nut].map((p) => bomOf(editor.document, p))).toEqual(['normal', 'purchased', 'purchased']);
    editor.undo();
    expect(bomOf(editor.document, nut)).toBe('normal');
    await call('part_set_bom', { kind: 'reference', parts: [part] });
    expect(bomOf(editor.document, part)).toBe('reference');
  });

  it('refuses an unknown kind, part or folder, and a call with neither', async () => {
    const { refused, part } = setup();
    expect(await refused('part_set_bom', { kind: 'bought', parts: [part] })).toBe('INVALID_INPUT');
    expect(await refused('part_set_bom', { kind: 'purchased', parts: ['part_none'] })).toBe('NOT_FOUND');
    expect(await refused('part_set_bom', { kind: 'purchased', folder: 'fld_none' })).toBe('NOT_FOUND');
    expect(await refused('part_set_bom', { kind: 'purchased' })).toBe('INVALID_INPUT');
  });
});

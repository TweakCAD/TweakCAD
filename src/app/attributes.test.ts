import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { newDocument } from './document';
import { ORIGIN_ITEMS, bomOf, originShown, setBom, setOriginShown } from './attributes';

function setup() {
  const ids = seededIds(81);
  const editor = new Editor(newDocument({ ids, name: 'Origin' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  return { editor, part };
}

describe('origin visibility', () => {
  it('is kept in the document for each plane, axis and the point, so a reload shows them as they were left', () => {
    const { editor, part } = setup();
    expect([...originShown(editor.document, part)]).toEqual([]);
    expect(setOriginShown(editor, part, ['xy', 'z'], true).ok).toBe(true);
    expect([...originShown(editor.document, part)]).toEqual(['xy', 'z']);
    // As saved and read back.
    const reloaded = readDocument(JSON.parse(editor.save()));
    expect(reloaded.refused).toBe(false);
    expect([...originShown(JSON.parse(editor.save()) as Json, part)]).toEqual(['xy', 'z']);
    expect(setOriginShown(editor, part, ORIGIN_ITEMS, true).ok).toBe(true);
    expect([...originShown(editor.document, part)]).toEqual(ORIGIN_ITEMS);
    expect(setOriginShown(editor, part, ORIGIN_ITEMS, false).ok).toBe(true);
    expect([...originShown(editor.document, part)]).toEqual([]);
    expect((((editor.document.parts as Json[])[0] as Json).attributes as Json[] | undefined) ?? []).toEqual([]);
  });

  it('is one undo step each way', () => {
    const { editor, part } = setup();
    setOriginShown(editor, part, ORIGIN_ITEMS, true);
    expect(editor.store.undoLabel()).toBe('Show origin');
    editor.undo();
    expect([...originShown(editor.document, part)]).toEqual([]);
  });
});

describe('bill-of-materials kind', () => {
  it('marks parts purchased or reference as one undo step, kept through a save, and normal clears it', () => {
    const { editor, part } = setup();
    expect(bomOf(editor.document, part)).toBe('normal');
    expect(setBom(editor, [part], 'purchased').ok).toBe(true);
    expect(editor.store.undoLabel()).toBe('Mark Purchased');
    expect(bomOf(JSON.parse(editor.save()) as Json, part)).toBe('purchased');
    expect(readDocument(JSON.parse(editor.save())).refused).toBe(false);
    expect(setBom(editor, [part], 'reference').ok).toBe(true);
    expect(bomOf(editor.document, part)).toBe('reference');
    expect(setBom(editor, [part], 'normal').ok).toBe(true);
    expect((((editor.document.parts as Json[])[0] as Json).attributes as Json[] | undefined) ?? []).toEqual([]);
    editor.undo();
    expect(bomOf(editor.document, part)).toBe('reference');
  });

  it('takes back every part when one is refused', () => {
    const { editor, part } = setup();
    const before = editor.save();
    expect(setBom(editor, [part, 'part_none'], 'purchased').ok).toBe(false);
    expect(editor.save()).toBe(before);
  });
});

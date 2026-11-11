import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { newDocument } from './document';
import { ORIGIN_ITEMS, originShown, setOriginShown } from './attributes';

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

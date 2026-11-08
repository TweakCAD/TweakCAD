import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { newDocument } from './document';
import { originShown, setOriginShown } from './attributes';

function setup() {
  const ids = seededIds(81);
  const editor = new Editor(newDocument({ ids, name: 'Origin' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  return { editor, part };
}

describe('origin plane visibility', () => {
  it('is kept in the document, so a reload shows the planes as they were left', () => {
    const { editor, part } = setup();
    expect(originShown(editor.document, part)).toBe(false);
    expect(setOriginShown(editor, part, true).ok).toBe(true);
    expect(originShown(editor.document, part)).toBe(true);
    // As saved and read back.
    const reloaded = readDocument(JSON.parse(editor.save()));
    expect(reloaded.refused).toBe(false);
    expect(originShown(JSON.parse(editor.save()) as Json, part)).toBe(true);
    expect(setOriginShown(editor, part, false).ok).toBe(true);
    expect(originShown(editor.document, part)).toBe(false);
    expect((((editor.document.parts as Json[])[0] as Json).attributes as Json[] | undefined) ?? []).toEqual([]);
  });

  it('is one undo step each way', () => {
    const { editor, part } = setup();
    setOriginShown(editor, part, true);
    expect(editor.store.undoLabel()).toBe('Show origin planes');
    editor.undo();
    expect(originShown(editor.document, part)).toBe(false);
  });
});

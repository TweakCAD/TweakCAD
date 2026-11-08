import { describe, expect, it } from 'vitest';
import { Editor, randomIds, type Json } from '@tweakcad/editor';
import { newDocument } from '../document';
import { setColor, setVisible } from '../attributes';
import { displayOnly } from './displayOnly';

const target = { reference: { standard: { name: 'xy' } }, names: {} };

describe('displayOnly', () => {
  it('holds for a target hidden, coloured, shown again and undone, and not for a feature edit', () => {
    const editor = new Editor(newDocument({ ids: randomIds(), name: 'a' }));
    const part = ((editor.document.parts as Json[])[0] as Json).id as string;
    const start = editor.document;
    expect(setVisible(editor, part, target, false).ok).toBe(true);
    const hidden = editor.document;
    expect(displayOnly(start, hidden)).toBe(true);
    setColor(editor, part, target, '#ff0000');
    expect(displayOnly(hidden, editor.document)).toBe(true);
    setVisible(editor, part, target, true);
    expect(displayOnly(hidden, editor.document)).toBe(true);
    editor.undo();
    editor.undo();
    editor.undo();
    // Undone to the start.
    expect(displayOnly(hidden, editor.document)).toBe(true);
    expect(displayOnly(start, start)).toBe(true);

    editor.dispatch({ type: 'renameDocument', name: 'b' });
    expect(displayOnly(start, editor.document)).toBe(false);
  });

  it('holds for equal documents that share nothing and for a rollback moved, and not for a part row changed beside them', () => {
    const doc = newDocument({ ids: randomIds(), name: 'a' }) as Json;
    expect(displayOnly(doc, structuredClone(doc))).toBe(true);
    const moved = structuredClone(doc);
    ((moved.parts as Json[])[0] as Json).rollback = { before: { id: 'feat_x' } };
    expect(displayOnly(doc, moved)).toBe(true);
    const renamed = structuredClone(doc);
    ((renamed.parts as Json[])[0] as Json).name = 'Other';
    expect(displayOnly(doc, renamed)).toBe(false);
    const styled = structuredClone(doc);
    ((styled.parts as Json[])[0] as Json).attributes = [{ id: 'attr_1' }];
    expect(displayOnly(doc, styled)).toBe(true);
    const more = structuredClone(doc);
    (more.parts as Json[]).push({ id: 'part_2' });
    expect(displayOnly(doc, more)).toBe(false);
  });
});

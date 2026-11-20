import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { emptyPart, newDocument } from './document';
import {
  ORIGIN_ITEMS,
  bomOf,
  originShown,
  partHidden,
  setBom,
  setOriginShown,
  setPartsVisible,
  setVisible,
} from './attributes';

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

describe('part visibility', () => {
  const attributes = (editor: Editor) =>
    (((editor.document.parts as Json[])[0] as Json).attributes as Json[] | undefined) ?? [];

  it('hides a part as an attribute on it, kept through a save, and showing clears it', () => {
    const { editor, part } = setup();
    expect(partHidden(editor.document, part)).toBe(false);
    expect(setPartsVisible(editor, [part], false)).toMatchObject({ ok: true, changed: true });
    expect(editor.store.undoLabel()).toBe('Hide');
    expect(attributes(editor)).toHaveLength(1);
    expect(attributes(editor)[0]!.target).toEqual({ object: { part: { id: part } } });
    expect(readDocument(JSON.parse(editor.save())).refused).toBe(false);
    expect(partHidden(JSON.parse(editor.save()) as Json, part)).toBe(true);
    // Hiding again changes nothing.
    expect(setPartsVisible(editor, [part], false)).toMatchObject({ ok: true, changed: false });
    expect(setPartsVisible(editor, [part], true)).toMatchObject({ ok: true, changed: true });
    expect(partHidden(editor.document, part)).toBe(false);
    expect(attributes(editor)).toEqual([]);
  });

  it('is one undo step for several parts', () => {
    const { editor, part } = setup();
    const second = editor.newId('part');
    expect(editor.dispatch({ type: 'addPart', part: emptyPart(second, 'Second') }).ok).toBe(true);
    expect(setPartsVisible(editor, [part, second], false).ok).toBe(true);
    expect(partHidden(editor.document, part)).toBe(true);
    expect(partHidden(editor.document, second)).toBe(true);
    editor.undo();
    expect(partHidden(editor.document, part)).toBe(false);
    expect(partHidden(editor.document, second)).toBe(false);
    editor.redo();
    expect(partHidden(editor.document, second)).toBe(true);
  });

  it("shares the part's attribute with its BOM kind", () => {
    const { editor, part } = setup();
    setBom(editor, [part], 'purchased');
    setPartsVisible(editor, [part], false);
    expect(attributes(editor)).toHaveLength(1);
    setPartsVisible(editor, [part], true);
    expect(bomOf(editor.document, part)).toBe('purchased');
    expect(Object.keys(attributes(editor)[0]!.properties as Json)).toEqual(['bom']);
  });

  it('is shown again, in the same undo step, by showing a feature inside it', () => {
    const { editor, part } = setup();
    const feature = editor.newId('feat');
    setVisible(editor, part, { feature }, false);
    setPartsVisible(editor, [part], false);
    expect(setVisible(editor, part, { feature }, true)).toMatchObject({ ok: true, changed: true });
    expect(partHidden(editor.document, part)).toBe(false);
    expect(attributes(editor)).toEqual([]);
    editor.undo();
    expect(partHidden(editor.document, part)).toBe(true);
    expect(attributes(editor)).toHaveLength(2);
    // Hiding something inside leaves the part as it is.
    setVisible(editor, part, { feature }, false);
    expect(partHidden(editor.document, part)).toBe(true);
  });

  it('takes back every part when one is refused', () => {
    const { editor, part } = setup();
    const before = editor.save();
    expect(setPartsVisible(editor, [part, 'part_none'], false).ok).toBe(false);
    expect(editor.save()).toBe(before);
  });
});

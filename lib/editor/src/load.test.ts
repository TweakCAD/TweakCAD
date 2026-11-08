import { writeDocument } from '@tweakcad/format';
import { describe, expect, it } from 'vitest';
import { Editor } from './editor';
import { loadDocument, saveDocument, VERSION_1_MESSAGE } from './load';
import type { Json } from './rows';
import { standardDocument } from './testDocs';

describe('load and save', () => {
  it('round-trips a document byte for byte', () => {
    const text = writeDocument(standardDocument().doc);
    const loaded = loadDocument(text);
    if (!loaded.ok) throw new Error(loaded.message);
    expect(loaded.warnings).toEqual([]);
    expect(saveDocument(loaded.document)).toBe(text);
  });

  it('round-trips through the editor after edits are undone, and after edits saved and reloaded', () => {
    const { doc, ids } = standardDocument();
    const text = writeDocument(doc);
    const opened = Editor.open(text);
    if (!opened.ok) throw new Error(opened.message);
    const editor = opened.editor;
    editor.dispatch({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
    editor.dispatch({ type: 'setValueDef', value: ids.depth, def: { expr: { text: '7 mm', grammar: 1, refs: {} } } });
    const edited = editor.save();
    editor.undo();
    editor.undo();
    expect(editor.save()).toBe(text);
    const reopened = Editor.open(edited);
    if (!reopened.ok) throw new Error(reopened.message);
    expect(reopened.editor.save()).toBe(edited);
  });

  it('keeps unknown keys and extensions through load, edit and save', () => {
    const { doc, ids } = standardDocument();
    const part = (doc.parts as Json[])[0] as Json;
    const extrude = (part.timeline as Json[])[1] as Json;
    extrude.extensions = { acme: { colour: 'teal' } };
    doc.views = [
      {
        id: 'view_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'Front',
        camera: {
          position: [0, 0, 1],
          target: [0, 0, 0],
          up: [0, 1, 0],
          projection: { perspective: { fieldOfView: 45 } },
          lens: 'wide',
        },
        position: { current: {} },
      },
    ];
    const opened = Editor.open(writeDocument(doc));
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.warnings.map((w) => w.severity)).toEqual(['ignore']);
    opened.editor.dispatch({ type: 'renameFeature', feature: ids.extrude, name: 'Base' });
    const saved = JSON.parse(opened.editor.save());
    expect(saved.parts[0].timeline[1].extensions).toEqual({ acme: { colour: 'teal' } });
    expect(saved.views[0].camera.lens).toBe('wide');
  });

  it('keeps pauses as warnings', () => {
    const { doc, t } = standardDocument();
    ((doc.parts as Json[])[0]?.timeline as Json[]).push(t.feature('acme.gear', { teeth: 12 }));
    const loaded = loadDocument(writeDocument(doc));
    if (!loaded.ok) throw new Error(loaded.message);
    expect(loaded.warnings).toMatchObject([{ severity: 'pause', code: 'unknown-variant' }]);
  });

  it('refuses a version-1 document with a plain message', () => {
    const loaded = loadDocument(JSON.stringify({ schemaVersion: 1, parts: {}, parameters: { values: {} } }));
    expect(loaded).toMatchObject({ ok: false, message: VERSION_1_MESSAGE });
  });

  it('refuses text that is not JSON, and a document the format refuses', () => {
    expect(loadDocument('{"format": ').ok).toBe(false);
    const { doc } = standardDocument();
    const broken = loadDocument(writeDocument({ ...doc, root: { part: { id: 'part_aaaaaaaaaaaaaaaaaaaaaaaaaa' } } }));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.message).toMatch(/does not exist/);
    expect(loadDocument(writeDocument({ ...doc, schemaVersion: 3 })).ok).toBe(false);
  });
});

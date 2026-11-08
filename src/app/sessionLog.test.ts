import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { standardDocument } from '../../lib/editor/src/testDocs';
import { createAppStore } from './appState';
import { clearConsole, consoleStore } from './console';
import { newDocument } from './document';
import { findFeature } from './features';
import { extrudeLines, installSessionLog } from './sessionLog';
import type { AppServices } from './services';

const messages = () => consoleStore.getState().entries.map((e) => e.message);

describe('the session log', () => {
  it('logs an extrude written and an extrude edited', () => {
    const { doc, ids } = standardDocument();
    const without = structuredClone(doc);
    for (const p of without.parts as Json[]) p.timeline = (p.timeline as Json[]).filter((f) => f.id !== ids.extrude2);
    const name = String(findFeature(doc, ids.extrude2)?.name);
    const [created] = extrudeLines(without, doc);
    expect(created).toMatch(
      new RegExp(`^Created extrude feature: ${name}: .* (normal|reversed), offset .* \\(\\d+ profiles?\\)$`),
    );
    const edited = structuredClone(doc);
    const row = findFeature(edited, ids.extrude2) as Json;
    (row.inputs as Json).extra = 1;
    expect(extrudeLines(doc, edited)).toEqual([expect.stringMatching(new RegExp(`^Updated extrude feature: ${name}`))]);
    expect(extrudeLines(doc, structuredClone(doc))).toEqual([]);
  });

  it('logs the start, a change of active part and the end of sketch mode', () => {
    clearConsole();
    const ids = seededIds(71);
    const editor = new Editor(newDocument({ ids, name: 'Doc' }), { ids });
    const part = String(((editor.document.parts as Json[])[0] as Json).id);
    const second = editor.newId('part');
    const added = editor.dispatch({
      type: 'addPart',
      part: {
        ...structuredClone((editor.document.parts as Json[])[0] as Json),
        id: second,
        name: 'Bracket',
        timeline: [],
      },
    });
    const app = createAppStore();
    const stop = installSessionLog({ app, editor } as unknown as AppServices);
    expect(messages()).toEqual(['CAD application initialized']);
    app.setState({ mode: { kind: 'sketch', part, feature: 'feat_x' } });
    app.setState({ mode: { kind: 'model' } });
    expect(messages()).toContain('Sketch mode exited');
    expect(added.ok).toBe(true);
    app.setState({ focus: { part: second } });
    expect(messages()).toContain('Active part: Bracket');
    stop();
  });
});

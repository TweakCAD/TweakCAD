import { readDocument, writeDocument } from '@tweakcad/format';
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor';
import { seededIds } from '../ids';
import type { Json } from '../rows';
import { solvedSketch, standardDocument, type StandardIds, type TestDoc } from '../testDocs';
import type { EditSketch } from './types';

function setup(): { editor: Editor; ids: StandardIds; t: TestDoc } {
  const { doc, ids, t } = standardDocument();
  return { editor: new Editor(doc, { ids: seededIds(11) }), ids, t };
}

function inputs(editor: Editor): Json {
  const part = (editor.document.parts as Json[])[0] as Json;
  return ((part.timeline as Json[])[0] as Json).inputs as Json;
}

function rowIds(editor: Editor, table: string): string[] {
  return (inputs(editor)[table] as Json[]).map((r) => r.id as string);
}

/**
 * Applies an edit with the solved sketch computed from what the edit leaves
 * (stored positions stand for the solve here), as the sketch editor would.
 */
function edit(editor: Editor, edits: Omit<EditSketch, 'type' | 'solved' | 'sketch'>, withSolved = true): void {
  const part = (editor.document.parts as Json[])[0] as Json;
  const command = { ...edits, sketch: ((part.timeline as Json[])[0] as Json).id as string };
  const before = writeDocument(editor.document);
  let solved;
  if (withSolved) {
    // Dry run to learn the rows after the edit; the solve is of those.
    const probe = new Editor(editor.document, { ids: seededIds(99) });
    const dry = probe.dispatch({ type: 'editSketch', ...command });
    if (!dry.ok) throw new Error(dry.error.message);
    solved = solvedSketch(inputs(probe));
  }
  const result = editor.dispatch({ type: 'editSketch', ...command, ...(solved ? { solved } : {}) });
  if (!result.ok) throw new Error(result.error.message);
  expect(readDocument(editor.document).refused).toBe(false);
  const after = writeDocument(editor.document);
  editor.undo();
  expect(writeDocument(editor.document)).toBe(before);
  editor.redo();
  expect(writeDocument(editor.document)).toBe(after);
}

describe('editSketch', () => {
  it('stores moved points and solved numbers as given', () => {
    const { editor, ids } = setup();
    edit(
      editor,
      {
        label: 'Drag',
        update: [
          { id: ids.points[1] as string, set: { x: 50 } },
          { id: ids.points[2] as string, set: { x: 50 } },
          { id: ids.dimension, set: { solved: 50 } },
        ],
      },
      false,
    );
    expect((inputs(editor).points as Json[])[1]).toMatchObject({ x: 50, y: 0 });
    expect(editor.store.undoLabel()).toBe('Drag');
  });

  it('writes split fates when a new line divides a region', () => {
    const { editor, ids, t } = setup();
    const a = t.point(10, -5);
    const b = t.point(10, 25);
    const line = t.line(a.id as string, b.id as string);
    edit(editor, { label: 'Draw line', add: { points: [a, b], curves: [line] } });
    const regions = inputs(editor).regions as Json[];
    expect(regions).toHaveLength(2);
    for (const r of regions) expect(r.origin).toEqual({ from: { id: ids.region } });
    const retired = inputs(editor).retired as Json[];
    expect(retired.map((r) => [r.id, r.fate])).toEqual([[ids.region, { split: {} }]]);
    // The log entry carries the region ids the command made, for a replay.
    expect(editor.log.filter((e) => e.kind === 'command').at(-1)?.ids).toEqual(regions.map((r) => r.id));
  });

  it('writes a merge fate and retires the removed curve the retired region still names', () => {
    const { editor, t } = setup();
    const a = t.point(10, -5);
    const b = t.point(10, 25);
    const line = t.line(a.id as string, b.id as string);
    edit(editor, { add: { points: [a, b], curves: [line] } });
    const [left, right] = (inputs(editor).regions as Json[]).map((r) => r.id as string);
    edit(editor, { label: 'Delete line', remove: [line.id as string] });
    const regions = inputs(editor).regions as Json[];
    // The larger piece shares most boundary with the merged region and keeps its id.
    const kept = regions.map((r) => r.id);
    expect(kept).toHaveLength(1);
    const merged = kept[0] === right ? left : right;
    const retired = inputs(editor).retired as Json[];
    expect(retired.find((r) => r.id === merged)?.fate).toEqual({ merged: { into: { id: kept[0] } } });
    // The line is named by the retired region, so it is retired, not dropped, and keeps its points.
    expect(retired.find((r) => r.id === line.id)?.fate).toEqual({ deleted: {} });
    expect(rowIds(editor, 'points')).toContain(a.id);
  });

  it('writes fates for a curve made construction, as for a removed one, and not for a solve moving a radius', () => {
    const { editor, t } = setup();
    const a = t.point(10, -5);
    const b = t.point(10, 25);
    const line = t.line(a.id as string, b.id as string);
    edit(editor, { add: { points: [a, b], curves: [line] } });
    expect(inputs(editor).regions as Json[]).toHaveLength(2);
    const flag = { ...(line.construction as Json), def: t.val('true').def };
    edit(editor, { label: 'Make construction', update: [{ id: line.id as string, set: { construction: flag } }] });
    expect(inputs(editor).regions as Json[]).toHaveLength(1);
    expect((inputs(editor).retired as Json[]).some((r) => 'merged' in (r.fate as Json))).toBe(true);

    const center = t.point(30, 10);
    const circle: Json = {
      ...t.line(center.id as string, center.id as string),
      kind: 'circle',
      center: center.id,
      radius: 3,
    };
    delete circle.start;
    delete circle.end;
    edit(editor, { add: { points: [center], curves: [circle] } });
    const regions = JSON.stringify(inputs(editor).regions);
    edit(editor, { label: 'Drag', update: [{ id: circle.id as string, set: { radius: 4 } }] });
    expect(JSON.stringify(inputs(editor).regions)).toBe(regions);
  });

  it('merges a point into another: every row naming it, stored region uses included, names the other, and it goes', () => {
    const { editor, ids, t } = setup();
    const corner = ids.points[1] as string;
    const q = t.point(40, 0);
    edit(editor, { add: { points: [q] } }, false);
    expect(JSON.stringify(inputs(editor).regions)).toContain(corner);
    edit(editor, { label: 'Constrain coincident', merge: [{ from: corner, into: q.id as string }] }, false);
    const after = JSON.stringify(inputs(editor));
    expect(after).not.toContain(corner);
    expect(rowIds(editor, 'points')).not.toContain(corner);
    expect(JSON.stringify(inputs(editor).regions)).toContain(q.id as string);
    expect(((inputs(editor).constraints as Json[])[0] as Json).b).toEqual({ point: { id: q.id } });
    expect((inputs(editor).curves as Json[])[0]).toMatchObject({ end: q.id });
    expect(editor.store.undoLabel()).toBe('Constrain coincident');

    // With the solved sketch, the merged curves get fates: the region keeps its id.
    const region = ((inputs(editor).regions as Json[])[0] as Json).id;
    const r = t.point(40, 0);
    edit(editor, { add: { points: [r] } }, false);
    edit(editor, { merge: [{ from: q.id as string, into: r.id as string }] });
    expect((inputs(editor).regions as Json[]).map((x) => x.id)).toEqual([region]);
    expect(JSON.stringify(inputs(editor).regions)).toContain(r.id as string);

    for (const merge of [
      [{ from: 'pt_aaaaaaaaaaaaaaaaaaaaaaaaaa', into: r.id as string }],
      [{ from: r.id as string, into: r.id as string }],
      [
        { from: ids.points[0] as string, into: r.id as string },
        { from: r.id as string, into: ids.points[2] as string },
      ],
    ]) {
      expect(editor.dispatch({ type: 'editSketch', sketch: ids.sketch, merge }).ok).toBe(false);
    }
  });

  it('removes the constraints on a removed curve, and points nothing else uses', () => {
    const { editor, ids, t } = setup();
    const a = t.point(60, 0);
    const b = t.point(70, 0);
    const line = t.line(a.id as string, b.id as string);
    const horizontal = { id: t.id('con'), kind: 'horizontal', active: t.flag(true), of: { curve: { id: line.id } } };
    edit(editor, { add: { points: [a, b], curves: [line], constraints: [horizontal] } });
    edit(editor, { remove: [line.id as string] });
    expect(rowIds(editor, 'curves')).not.toContain(line.id);
    expect(rowIds(editor, 'constraints')).toEqual([ids.dimension]);
    expect(rowIds(editor, 'points')).toEqual(ids.points);
    expect(inputs(editor).retired).toEqual([]);
  });

  it('removing a point removes its constraints; a point a curve uses cannot go', () => {
    const { editor, ids, t } = setup();
    const refusal = editor.dispatch({ type: 'editSketch', sketch: ids.sketch, remove: [ids.points[0] as string] });
    expect(refusal.ok).toBe(false);
    // A free point goes with the constraint on it.
    const free = t.point(80, 80);
    const fixed = { id: t.id('con'), kind: 'fixed', active: t.flag(true), point: { point: { id: free.id } } };
    edit(editor, { add: { points: [free], constraints: [fixed] } }, false);
    edit(editor, { remove: [free.id as string] }, false);
    expect(rowIds(editor, 'points')).toEqual(ids.points);
    expect(rowIds(editor, 'constraints')).toEqual([ids.dimension]);
  });

  it('retires a split curve and adds the pieces that descend from it', () => {
    const { editor, ids, t } = setup();
    const a = t.point(60, 0);
    const m = t.point(65, 0);
    const b = t.point(70, 0);
    const line = t.line(a.id as string, b.id as string);
    edit(editor, { add: { points: [a, m, b], curves: [line] } });
    const left: Json = { ...t.line(a.id as string, m.id as string), origin: { from: { id: line.id } } };
    const right: Json = { ...t.line(m.id as string, b.id as string), origin: { from: { id: line.id } } };
    edit(editor, {
      label: 'Split',
      retire: [{ id: line.id as string, fate: 'split' }],
      add: { curves: [left, right] },
    });
    expect((inputs(editor).retired as Json[]).at(-1)).toMatchObject({
      id: line.id,
      fate: { split: {} },
      was: { curve: { kind: 'line' } },
    });
    expect(rowIds(editor, 'curves').slice(-2)).toEqual([left.id, right.id]);
    // A retired curve is no longer a live row to remove.
    const removeRetired = editor.dispatch({ type: 'editSketch', sketch: ids.sketch, remove: [line.id as string] });
    expect(removeRetired.ok).toBe(false);
  });

  it('refuses what it cannot do and leaves the store alone', () => {
    const { editor, ids, t } = setup();
    const before = writeDocument(editor.document);
    const cases: EditSketch[] = [
      { type: 'editSketch', sketch: ids.extrude, remove: [] },
      { type: 'editSketch', sketch: ids.sketch, remove: ['crv_aaaaaaaaaaaaaaaaaaaaaaaaaa'] },
      { type: 'editSketch', sketch: ids.sketch, update: [{ id: ids.region, set: { x: 1 } }] },
      { type: 'editSketch', sketch: ids.sketch, retire: [{ id: ids.points[0] as string, fate: 'split' }] },
      { type: 'editSketch', sketch: ids.sketch, add: { curves: [t.point(1, 1)] } },
      {
        type: 'editSketch',
        sketch: ids.sketch,
        add: { curves: [t.line(ids.points[0] as string, 'pt_aaaaaaaaaaaaaaaaaaaaaaaaaa')] },
      },
      { type: 'editSketch', sketch: ids.sketch, update: [{ id: ids.points[0] as string, set: { x: 'left' } }] },
    ];
    for (const command of cases) {
      const result = editor.dispatch(command);
      expect(result.ok, JSON.stringify(command)).toBe(false);
      expect(writeDocument(editor.document)).toBe(before);
    }
    expect(editor.log).toEqual([]);
  });
});

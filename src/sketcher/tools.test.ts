import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { openTestSession, pointXY, readsClean, rowsOf, type TestSession } from './testKit';
import { loadTestSolver } from './testSetup';
import type { Json } from './rows';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

const kinds = (inputs: Json, table: string) => rowsOf(inputs, table).map((r) => r.kind);

/** Checks the last command left a clean document, and that undo and redo restore it exactly. */
function undoable(t: TestSession): void {
  expect(readsClean(t.editor)).toBe(true);
  const after = t.editor.save();
  expect(t.editor.undo()).toBe(true);
  const before = t.editor.save();
  expect(before).not.toBe(after);
  expect(t.editor.redo()).toBe(true);
  expect(t.editor.save()).toBe(after);
}

describe('line tool', () => {
  it('draws a chain of lines sharing their points, horizontal and vertical where drawn nearly so', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 11);
    let inputs = t.inputs();
    expect(rowsOf(inputs, 'points')).toHaveLength(2);
    expect(kinds(inputs, 'curves')).toEqual(['line']);
    expect(kinds(inputs, 'constraints')).toEqual(['horizontal']);
    const [first] = rowsOf(inputs, 'curves') as [Json];
    expect(pointXY(inputs, first.start as string)[1]).toBeCloseTo(pointXY(inputs, first.end as string)[1], 9);
    expect(readsClean(t.editor)).toBe(true);

    t.click(40.5, 30);
    inputs = t.inputs();
    const [, second] = rowsOf(inputs, 'curves') as [Json, Json];
    expect(second.start).toBe(first.end);
    expect(kinds(inputs, 'constraints')).toEqual(['horizontal', 'vertical']);
    expect(t.editor.log.filter((e) => e.kind === 'command').map((e) => e.label)).toEqual(['Draw line', 'Draw line']);
    undoable(t);
  });

  it('ends the chain on an existing point, closing the loop', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 20);
    t.click(20, 40);
    t.click(10.3, 10.2);
    const inputs = t.inputs();
    expect(rowsOf(inputs, 'points')).toHaveLength(3);
    const lines = rowsOf(inputs, 'curves');
    expect(lines).toHaveLength(3);
    expect(lines[2]?.end).toBe(lines[0]?.start);
    // The next click starts a new line rather than continuing.
    t.click(60, 60);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(3);
    t.click(80, 60);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(4);
  });

  it('cancels with Escape, then leaves the tool', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    expect(t.key('Escape')).toBe(true);
    t.click(30, 30);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(0);
    expect(t.key('Escape')).toBe(true);
    expect(t.key('Escape')).toBe(true);
    expect(t.session.tool).toBe('select');
  });

  it('draws a tangent arc when dragged from the end of the chain, then goes on with lines from its end', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 10);
    // Press on the end just drawn and drag: an arc leaving the line along it.
    t.down(40, 10);
    t.move(44, 12);
    t.move(50, 20);
    t.up(50, 20);
    let inputs = t.inputs();
    expect(kinds(inputs, 'curves')).toEqual(['line', 'arc']);
    const [line, arc] = rowsOf(inputs, 'curves') as [Json, Json];
    expect([arc.start, arc.end]).toContain(line.end);
    expect(rowsOf(inputs, 'constraints').find((c) => c.kind === 'tangent')).toMatchObject({
      a: { curve: { id: line.id } },
      b: { curve: { id: arc.id } },
    });
    expect(readsClean(t.editor)).toBe(true);
    // The chain goes on from the end of the arc.
    t.click(50, 40);
    inputs = t.inputs();
    expect(kinds(inputs, 'curves')).toEqual(['line', 'arc', 'line']);
    const next = rowsOf(inputs, 'curves')[2] as Json;
    expect(pointXY(inputs, next.start as string)).toEqual([expect.closeTo(50, 6), expect.closeTo(20, 6)]);
    // A press that does not move is a click: no arc.
    t.key('Escape');
    t.down(50, 40);
    t.up(50, 40);
    t.click(70, 40);
    expect(kinds(t.inputs(), 'curves')).toEqual(['line', 'arc', 'line', 'line']);
  });
});

describe('shape tools', () => {
  it('draws a rectangle as four lines sharing corners, with horizontal and vertical constraints', () => {
    const t = openTestSession(gcs);
    t.session.setTool('rectangle');
    t.click(10, 10);
    t.click(50, 30);
    const inputs = t.inputs();
    expect(rowsOf(inputs, 'points').map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [50, 10],
      [50, 30],
      [10, 30],
    ]);
    const lines = rowsOf(inputs, 'curves');
    expect(lines.map((l) => l.kind)).toEqual(['line', 'line', 'line', 'line']);
    lines.forEach((l, i) => expect(l.start).toBe(lines[(i + 3) % 4]?.end));
    expect(kinds(inputs, 'constraints')).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical']);
    expect(t.editor.store.undoLabel()).toBe('Draw rectangle');
    undoable(t);
  });

  it('draws a circle by centre and radius', () => {
    const t = openTestSession(gcs);
    t.session.setTool('circle');
    t.click(20, 20);
    t.click(30, 20);
    const inputs = t.inputs();
    const [circle] = rowsOf(inputs, 'curves') as [Json];
    expect(circle).toMatchObject({ kind: 'circle', radius: 10 });
    expect(pointXY(inputs, circle.center as string)).toEqual([20, 20]);
    undoable(t);
  });

  it('draws an arc through three points: start, end, then a point it passes', () => {
    const t = openTestSession(gcs);
    t.session.setTool('arc');
    t.click(30, 10);
    t.click(10, 10);
    t.click(20, 20);
    let inputs = t.inputs();
    const [arc] = rowsOf(inputs, 'curves') as [Json];
    expect(arc.kind).toBe('arc');
    // Counter-clockwise from (30, 10) over (20, 20) to (10, 10).
    expect(pointXY(inputs, arc.start as string)).toEqual([30, 10]);
    expect(pointXY(inputs, arc.end as string)).toEqual([10, 10]);
    const [cx, cy] = pointXY(inputs, arc.center as string);
    expect(cx).toBeCloseTo(20, 9);
    expect(cy).toBeCloseTo(10, 9);
    undoable(t);

    // Passing below, the arc runs the other way round.
    t.click(30, 50);
    t.click(10, 50);
    t.click(20, 40);
    inputs = t.inputs();
    const second = rowsOf(inputs, 'curves')[1] as Json;
    expect(pointXY(inputs, second.start as string)).toEqual([10, 50]);
    expect(pointXY(inputs, second.end as string)).toEqual([30, 50]);
  });

  it('places a point as a point curve', () => {
    const t = openTestSession(gcs);
    t.session.setTool('point');
    t.click(15, 25);
    const inputs = t.inputs();
    const [curve] = rowsOf(inputs, 'curves') as [Json];
    expect(curve.kind).toBe('point');
    expect(pointXY(inputs, curve.at as string)).toEqual([15, 25]);
    undoable(t);
  });

  it('draws construction curves in construction mode', () => {
    const t = openTestSession(gcs);
    t.session.setConstructionMode(true);
    t.session.setTool('circle');
    t.click(20, 20);
    t.click(25, 20);
    const [circle] = rowsOf(t.inputs(), 'curves') as [Json];
    expect(((circle.construction as Json).def as Json).expr).toMatchObject({ text: 'true' });
  });
});

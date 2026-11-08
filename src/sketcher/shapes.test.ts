import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Json } from './rows';
import type { SketchTool } from './session';
import { openTestSession, pointXY, readsClean, rowsOf, type TestSession } from './testKit';
import { loadTestSolver } from './testSetup';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

const kinds = (inputs: Json, table: string) => rowsOf(inputs, table).map((r) => r.kind as string);
const count = (list: string[], kind: string) => list.filter((k) => k === kind).length;

/** Draws with a tool by clicks; checks one command, a clean document, and undo and redo restoring it. */
function draw(t: TestSession, tool: SketchTool, clicks: [number, number][]): Json {
  t.session.setTool(tool);
  const before = t.editor.save();
  for (const c of clicks) {
    t.move(...c);
    t.click(...c);
  }
  const message = t.session.getState().message;
  expect(message, message ?? '').toBeNull();
  expect(readsClean(t.editor)).toBe(true);
  const after = t.editor.save();
  expect(after).not.toBe(before);
  t.editor.undo();
  expect(t.editor.save()).toBe(before);
  t.editor.redo();
  expect(t.editor.save()).toBe(after);
  return t.inputs();
}

const xy = (inputs: Json, id: unknown) => pointXY(inputs, id as string);

describe('shape tools', () => {
  it('centre rectangle: four lines about a centre held at a construction diagonal’s middle', () => {
    const t = openTestSession(gcs);
    const inputs = draw(t, 'centerRectangle', [
      [20, 20],
      [35, 28],
    ]);
    const curves = rowsOf(inputs, 'curves');
    expect(count(kinds(inputs, 'curves'), 'line')).toBe(5);
    const constraints = kinds(inputs, 'constraints');
    expect(count(constraints, 'horizontal') + count(constraints, 'vertical')).toBe(4);
    expect(count(constraints, 'midpoint')).toBe(1);
    const first = curves[0] as Json;
    expect(xy(inputs, first.start)).toEqual([5, 12]);
    expect(xy(inputs, first.end)).toEqual([35, 12]);
    expect(t.session.getState().dof).toBe(4);
  });

  it('circles by two and three points', () => {
    const t = openTestSession(gcs);
    let inputs = draw(t, 'circle2', [
      [10, 10],
      [30, 10],
    ]);
    const circle = rowsOf(inputs, 'curves')[0] as Json;
    expect(circle.radius).toBeCloseTo(10, 9);
    expect(xy(inputs, circle.center)).toEqual([20, 10]);
    inputs = draw(t, 'circle3', [
      [60, 0],
      [70, 10],
      [80, 0],
    ]);
    const second = rowsOf(inputs, 'curves')[1] as Json;
    expect(second.radius).toBeCloseTo(10, 9);
    expect(xy(inputs, second.center)[0]).toBeCloseTo(70, 9);
  });

  it('centre-point arc turns the way the pointer turned', () => {
    const t = openTestSession(gcs);
    t.session.setTool('arcCenter');
    t.click(0.01 + 20, 20);
    t.click(30, 20);
    // Clockwise from the start, round to the bottom.
    t.move(29, 17);
    t.move(20, 10);
    t.click(20, 10);
    const inputs = t.inputs();
    const arc = rowsOf(inputs, 'curves')[0] as Json;
    expect(arc.kind).toBe('arc');
    // Stored counter-clockwise: from the end clicked to the start.
    const start = xy(inputs, arc.start);
    expect(start[0]).toBeCloseTo(20, 3);
    expect(start[1]).toBeCloseTo(10, 1);
    expect(readsClean(t.editor)).toBe(true);
  });

  it('tangent arc leaves the end of a line along it, held tangent', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(30, 10.5);
    t.key('Escape');
    const line = rowsOf(t.inputs(), 'curves')[0] as Json;
    const inputs = draw(t, 'tangentArc', [
      [30, 10],
      [40, 20],
    ]);
    const arc = rowsOf(inputs, 'curves')[1] as Json;
    expect(arc.kind).toBe('arc');
    expect([arc.start, arc.end]).toContain(line.end);
    const tangent = rowsOf(inputs, 'constraints').find((c) => c.kind === 'tangent') as Json;
    expect(tangent).toBeDefined();
    const center = xy(inputs, arc.center);
    expect(center[0]).toBeCloseTo(30, 6);
  });

  it('a tangent arc starts only at the end of a line or arc', () => {
    const t = openTestSession(gcs);
    t.session.setTool('tangentArc');
    t.click(5, 5);
    expect(t.session.getState().message).toBe('Start a tangent arc at the end of a line or arc');
  });

  it('polygon: equal sides inscribed in a construction circle, with the sides set', () => {
    const t = openTestSession(gcs);
    t.session.setSettings({ sides: 5 });
    const inputs = draw(t, 'polygon', [
      [0.01 + 20, 20],
      [30, 20],
    ]);
    const curves = kinds(inputs, 'curves');
    expect(count(curves, 'line')).toBe(5);
    expect(count(curves, 'circle')).toBe(1);
    const constraints = kinds(inputs, 'constraints');
    expect(count(constraints, 'pointOnCurve')).toBe(5);
    expect(count(constraints, 'equal')).toBe(4);
    expect(t.session.getState().dof).toBe(4);
  });

  it('circumscribed polygon: the side clicked has its middle there, its sides touching a construction circle', () => {
    const t = openTestSession(gcs);
    t.session.setSettings({ sides: 6 });
    const inputs = draw(t, 'polygonCircumscribed', [
      [0.01 + 20, 20],
      [30, 20],
    ]);
    const curves = rowsOf(inputs, 'curves');
    expect(count(kinds(inputs, 'curves'), 'line')).toBe(6);
    expect(count(kinds(inputs, 'curves'), 'circle')).toBe(2);
    // Across the flats is the distance clicked, twice over.
    const inner = curves.filter((c) => c.kind === 'circle').map((c) => c.radius as number);
    expect(Math.min(...inner)).toBeCloseTo(9.99, 6);
    const lines = curves.filter((c) => c.kind === 'line');
    const middles = lines.map((l) => {
      const [a, b] = [xy(inputs, l.start), xy(inputs, l.end)];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
    });
    expect(middles.some(([x, y]) => Math.abs(x - 30) < 1e-6 && Math.abs(y - 20) < 1e-6)).toBe(true);
    expect(count(kinds(inputs, 'constraints'), 'tangent')).toBe(1);
    expect(t.session.getState().dof).toBe(4);
  });

  it('edge polygon: built on the side clicked, from the two ends of one side', () => {
    const t = openTestSession(gcs);
    t.session.setSettings({ sides: 4 });
    const inputs = draw(t, 'polygonEdge', [
      [10, 10],
      [20, 10],
      [15, 5],
    ]);
    const lines = rowsOf(inputs, 'curves').filter((c) => c.kind === 'line');
    expect(lines).toHaveLength(4);
    const ys = lines.flatMap((l) => [xy(inputs, l.start)[1], xy(inputs, l.end)[1]]);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(10, 6);
    const xs = lines.flatMap((l) => [xy(inputs, l.start)[0], xy(inputs, l.end)[0]]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([expect.closeTo(10, 6), expect.closeTo(20, 6)]);
    expect(t.session.getState().dof).toBe(4);
  });

  it('slot: two lines and two arcs, tangent where they meet, the arcs equal', () => {
    const t = openTestSession(gcs);
    const inputs = draw(t, 'slot', [
      [10, 10],
      [40, 10],
      [25, 15],
    ]);
    const curves = kinds(inputs, 'curves');
    expect(count(curves, 'line')).toBe(3);
    expect(count(curves, 'arc')).toBe(2);
    const constraints = kinds(inputs, 'constraints');
    expect(count(constraints, 'tangent')).toBe(4);
    expect(count(constraints, 'equal')).toBe(1);
    expect(count(constraints, 'horizontal')).toBe(1);
    const arc = rowsOf(inputs, 'curves').find((c) => c.kind === 'arc') as Json;
    const [c, s] = [xy(inputs, arc.center), xy(inputs, arc.start)];
    expect(Math.hypot(s[0] - c[0], s[1] - c[1])).toBeCloseTo(5, 6);
    // The two centres, less the axis held horizontal, and the width.
    expect(t.session.getState().dof).toBe(4);
  });

  it('ellipse: the longer axis is the major one', () => {
    const t = openTestSession(gcs);
    const inputs = draw(t, 'ellipse', [
      [20, 20],
      [30, 20],
      [20, 35],
    ]);
    const e = rowsOf(inputs, 'curves')[0] as Json;
    expect(e.kind).toBe('ellipse');
    expect(e.minorRadius).toBeCloseTo(10, 9);
    expect(xy(inputs, e.majorEnd)).toEqual([20, 35]);
  });

  it('spline: clicks add points, Enter ends it', () => {
    const t = openTestSession(gcs);
    t.session.setTool('spline');
    t.click(0.01 + 10, 10);
    t.click(20, 20);
    t.click(30, 10);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(0);
    t.session.key({ key: 'Enter', target: null } as unknown as KeyboardEvent);
    const inputs = t.inputs();
    const s = rowsOf(inputs, 'curves')[0] as Json;
    expect(s.kind).toBe('spline');
    expect(s.through).toHaveLength(3);
    expect(readsClean(t.editor)).toBe(true);
  });
});

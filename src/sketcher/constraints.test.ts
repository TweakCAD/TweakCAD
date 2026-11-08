import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ConstraintKind } from './constraints';
import type { Json } from './rows';
import { openTestSession, pointXY, readsClean, rowsOf, type TestSession } from './testKit';
import { loadTestSolver } from './testSetup';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

function line(t: TestSession, a: [number, number], b: [number, number]): Json {
  t.session.setTool('line');
  t.click(...a);
  t.click(...b);
  t.key('Escape');
  return rowsOf(t.inputs(), 'curves').at(-1) as Json;
}

function circle(t: TestSession, c: [number, number], r: number): Json {
  t.session.setTool('circle');
  t.click(...c);
  t.click(c[0] + r, c[1]);
  return rowsOf(t.inputs(), 'curves').at(-1) as Json;
}

/** Applies a constraint to a selection; checks a clean document and an undo that restores it. */
function constrain(t: TestSession, kind: ConstraintKind, selection: string[]): Json {
  const before = t.editor.save();
  t.session.select(selection);
  const result = t.session.applyConstraint(kind);
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
  expect(readsClean(t.editor)).toBe(true);
  const after = t.editor.save();
  t.editor.undo();
  expect(t.editor.save()).toBe(before);
  t.editor.redo();
  expect(t.editor.save()).toBe(after);
  return t.inputs();
}

const direction = (inputs: Json, l: Json) => {
  const [a, b] = [pointXY(inputs, l.start as string), pointXY(inputs, l.end as string)];
  const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / n, (b[1] - a[1]) / n] as const;
};
const length = (inputs: Json, l: Json) => {
  const [a, b] = [pointXY(inputs, l.start as string), pointXY(inputs, l.end as string)];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

describe('constraints', () => {
  it('horizontal and vertical on lines, or on two points', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 20]);
    let inputs = constrain(t, 'horizontal', [a.id as string]);
    expect(direction(inputs, a)[1]).toBeCloseTo(0, 9);
    const b = line(t, [60, 10], [70, 40]);
    inputs = constrain(t, 'vertical', [b.start as string, a.end as string]);
    expect(pointXY(inputs, b.start as string)[0]).toBeCloseTo(pointXY(inputs, a.end as string)[0], 9);
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({
      kind: 'vertical',
      of: { points: { a: { point: { id: b.start } } } },
    });
  });

  it('parallel, perpendicular and equal lines', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 25]);
    const b = line(t, [10, 40], [30, 70]);
    let inputs = constrain(t, 'parallel', [a.id as string, b.id as string]);
    let [da, db] = [direction(inputs, a), direction(inputs, b)];
    expect(da[0] * db[1] - da[1] * db[0]).toBeCloseTo(0, 9);
    t.editor.undo();
    inputs = constrain(t, 'perpendicular', [a.id as string, b.id as string]);
    [da, db] = [direction(inputs, a), direction(inputs, b)];
    expect(da[0] * db[0] + da[1] * db[1]).toBeCloseTo(0, 9);
    inputs = constrain(t, 'equal', [a.id as string, b.id as string]);
    expect(length(inputs, a)).toBeCloseTo(length(inputs, b), 9);
  });

  it('equal circles, and a line tangent to a circle', () => {
    const t = openTestSession(gcs);
    const c1 = circle(t, [20, 20], 5);
    const c2 = circle(t, [60, 20], 8);
    let inputs = constrain(t, 'equal', [c1.id as string, c2.id as string]);
    const radius = (id: unknown) => rowsOf(inputs, 'curves').find((c) => c.id === id)?.radius as number;
    expect(radius(c1.id)).toBeCloseTo(radius(c2.id), 9);
    const l = line(t, [0, 40], [80, 32]);
    inputs = constrain(t, 'tangent', [l.id as string, c2.id as string]);
    const tangent = rowsOf(inputs, 'constraints').at(-1) as Json;
    expect(tangent).toMatchObject({ kind: 'tangent', a: { curve: { id: l.id } }, b: { curve: { id: c2.id } } });
    const [p, q] = [pointXY(inputs, l.start as string), pointXY(inputs, l.end as string)];
    const center = pointXY(inputs, c2.center as string);
    const distance =
      Math.abs((q[0] - p[0]) * (center[1] - p[1]) - (q[1] - p[1]) * (center[0] - p[0])) /
      Math.hypot(q[0] - p[0], q[1] - p[1]);
    expect(distance).toBeCloseTo(radius(c2.id), 6);
  });

  it('a point at a line midpoint, and fix that toggles', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [50, 30]);
    t.session.setTool('point');
    t.click(25, 40);
    const point = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    let inputs = constrain(t, 'midpoint', [point.id as string, a.id as string]);
    const [s, e] = [pointXY(inputs, a.start as string), pointXY(inputs, a.end as string)];
    expect(pointXY(inputs, point.at as string)[0]).toBeCloseTo((s[0] + e[0]) / 2, 6);
    expect(pointXY(inputs, point.at as string)[1]).toBeCloseTo((s[1] + e[1]) / 2, 6);
    inputs = constrain(t, 'fix', [a.start as string]);
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({ kind: 'fixed', point: { point: { id: a.start } } });
    inputs = constrain(t, 'fix', [a.start as string]);
    expect(rowsOf(inputs, 'constraints').some((c) => c.kind === 'fixed')).toBe(false);
    inputs = constrain(t, 'fix', [a.id as string]);
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({ kind: 'block', curve: { curve: { id: a.id } } });
  });

  it('coincident merges points into one; a point and a curve get a point-on-curve', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 10]);
    const b = line(t, [42, 12], [60, 40]);
    t.session.select([a.id as string]);
    t.session.applyConstraint('horizontal');
    let inputs = constrain(t, 'coincident', [a.end as string, b.start as string]);
    const merged = rowsOf(inputs, 'curves').find((c) => c.id === b.id) as Json;
    expect(merged.start).toBe(a.end);
    expect(rowsOf(inputs, 'points').some((p) => p.id === b.start)).toBe(false);
    expect(rowsOf(inputs, 'points')).toHaveLength(3);

    const c = circle(t, [20, 60], 6);
    inputs = constrain(t, 'coincident', [b.end as string, c.id as string]);
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({
      kind: 'pointOnCurve',
      point: { point: { id: b.end } },
      curve: { curve: { id: c.id } },
    });
    const center = pointXY(inputs, c.center as string);
    const end = pointXY(inputs, b.end as string);
    const r = rowsOf(inputs, 'curves').find((x) => x.id === c.id)?.radius as number;
    expect(Math.hypot(end[0] - center[0], end[1] - center[1])).toBeCloseTo(r, 6);
  });

  it('point on line and point on circle hold points on the one curve picked with them', () => {
    const t = openTestSession(gcs);
    const l = line(t, [10, 30], [50, 45]);
    t.session.setTool('point');
    t.click(20, 10);
    const p = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    t.session.select([p.id as string, l.id as string]);
    expect(t.session.getState().fits).toMatchObject({ pointOnLine: true, pointOnCircle: false });
    let inputs = constrain(t, 'pointOnLine', [p.id as string, l.id as string]);
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({
      kind: 'pointOnCurve',
      point: { point: { id: p.at } },
      curve: { curve: { id: l.id } },
    });
    const [a, b, q] = [
      pointXY(inputs, l.start as string),
      pointXY(inputs, l.end as string),
      pointXY(inputs, p.at as string),
    ];
    expect((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])).toBeCloseTo(0, 6);

    const c = circle(t, [100, 60], 10);
    t.session.setTool('point');
    t.click(130, 90);
    const r = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    t.session.select([r.id as string, c.id as string]);
    expect(t.session.getState().fits).toMatchObject({ pointOnLine: false, pointOnCircle: true });
    inputs = constrain(t, 'pointOnCircle', [r.id as string, c.id as string]);
    const center = pointXY(inputs, c.center as string);
    const on = pointXY(inputs, r.at as string);
    const radius = rowsOf(inputs, 'curves').find((x) => x.id === c.id)?.radius as number;
    expect(Math.hypot(on[0] - center[0], on[1] - center[1])).toBeCloseTo(radius, 6);
    t.session.select([r.id as string, l.id as string]);
    expect(t.session.applyConstraint('pointOnCircle').ok).toBe(false);
  });

  it('refuses a selection that does not fit, and an over-constraint, changing nothing', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 10]);
    const before = t.editor.save();
    t.session.select([a.start as string]);
    const wrong = t.session.applyConstraint('parallel');
    expect(wrong).toMatchObject({ ok: false, error: { message: 'Select two or more lines' } });
    t.session.select([a.id as string]);
    const again = t.session.applyConstraint('horizontal');
    expect(again).toMatchObject({ ok: false, error: { message: 'That would over-constrain the sketch' } });
    expect(t.session.getState().message).toBe('That would over-constrain the sketch');
    t.session.select([a.id as string]);
    expect(t.session.applyConstraint('vertical').ok).toBe(false);
    expect(t.editor.save()).toBe(before);
  });

  it('H / V picks each line by its run; collinear lines; concentric circles', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 14]);
    const b = line(t, [60, 10], [63, 40]);
    let inputs = constrain(t, 'hv', [a.id as string, b.id as string]);
    expect(rowsOf(inputs, 'constraints').map((c) => c.kind)).toEqual(['horizontal', 'vertical']);
    const c = line(t, [10, 50], [30, 52]);
    const d = line(t, [40, 55], [60, 57]);
    inputs = constrain(t, 'collinear', [c.id as string, d.id as string]);
    const [p, q] = [pointXY(inputs, c.start as string), pointXY(inputs, c.end as string)];
    const r = pointXY(inputs, d.end as string);
    expect((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])).toBeCloseTo(0, 6);
    const c1 = circle(t, [100, 100], 5);
    const c2 = circle(t, [110, 104], 9);
    inputs = constrain(t, 'concentric', [c1.id as string, c2.id as string]);
    const [o1, o2] = [pointXY(inputs, c1.center as string), pointXY(inputs, c2.center as string)];
    expect(Math.hypot(o2[0] - o1[0], o2[1] - o1[1])).toBeCloseTo(0, 6);
  });

  it('symmetric points about a line, the line picked last', () => {
    const t = openTestSession(gcs);
    const axis = line(t, [50, 10.5], [50, 60]);
    const a = line(t, [20, 20], [30, 40]);
    const inputs = constrain(t, 'symmetric', [a.start as string, a.end as string, axis.id as string]);
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({ kind: 'symmetric', axis: { curve: { id: axis.id } } });
    const [p, q] = [pointXY(inputs, a.start as string), pointXY(inputs, a.end as string)];
    const [s, e] = [pointXY(inputs, axis.start as string), pointXY(inputs, axis.end as string)];
    const n = Math.hypot(e[0] - s[0], e[1] - s[1]);
    // The chord is square to the axis.
    expect(((q[0] - p[0]) * (e[0] - s[0]) + (q[1] - p[1]) * (e[1] - s[1])) / n).toBeCloseTo(0, 6);
  });

  it('picks the sketch origin and axes by hand: a point onto the origin, a line parallel to an axis', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 25]);
    t.session.setTool('select');
    // A click on the origin selects it.
    t.click(0.05, 0.05);
    expect(t.session.getState().selection).toEqual(['std:origin']);
    let inputs = constrain(t, 'coincident', [a.start as string, 'std:origin']);
    expect(pointXY(inputs, a.start as string)[0]).toBeCloseTo(0, 9);
    expect(pointXY(inputs, a.start as string)[1]).toBeCloseTo(0, 9);
    expect(
      rowsOf(inputs, 'constraints')
        .slice(-2)
        .map((c) => c.kind),
    ).toEqual(['horizontal', 'vertical']);
    // Clicking along the y axis, away from any curve, selects it.
    t.click(0.05, 70);
    expect(t.session.getState().selection).toEqual(['std:y']);
    inputs = constrain(t, 'parallel', ['std:y', a.id as string]);
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({
      kind: 'parallel',
      a: { sketchStandard: { name: 'y' } },
      b: { curve: { id: a.id } },
    });
    const dir = direction(inputs, a);
    expect(Math.abs(dir[0])).toBeCloseTo(0, 9);
    // The origin and axes alone take nothing.
    t.session.select(['std:x', 'std:y']);
    expect(t.session.applyConstraint('perpendicular')).toMatchObject({
      ok: false,
      error: { message: 'Select sketch geometry as well' },
    });
  });

  it('lists the constraints on the selection and removes one', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 10]);
    t.session.select([a.id as string]);
    const on = t.session.getState().selected[0]?.constraints ?? [];
    expect(on.map((c) => c.kind)).toEqual(['horizontal']);
    expect(t.session.getState().fits).toMatchObject({ horizontal: true, parallel: false, fix: true });
    expect(t.session.removeConstraints([on[0]?.id as string]).ok).toBe(true);
    expect(rowsOf(t.inputs(), 'constraints')).toEqual([]);
  });
});

/** Clicks the middle of a line where it is now. */
function clickLine(t: TestSession, given: Json): void {
  const inputs = t.inputs();
  const l = rowsOf(inputs, 'curves').find((c) => c.id === given.id) as Json;
  const [a, b] = [pointXY(inputs, l.start as string), pointXY(inputs, l.end as string)];
  t.click((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
}

describe('a point on the sketch origin', () => {
  it('shows one Coincident glyph, browser row and listed constraint, and deletes as one', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(0, 0);
    t.click(20, 10);
    t.key('Escape');
    const rows = rowsOf(t.inputs(), 'constraints');
    expect(rows.map((c) => c.kind).sort()).toEqual(['horizontal', 'vertical']);
    const glyphs = t.session.glyphs();
    expect(glyphs.map((g) => [g.kind, g.at])).toEqual([['coincident', [0, 0]]]);
    const browsed = t.session.browse().constraints;
    expect(browsed.map((r) => r.label)).toEqual(['Coincident']);
    expect(browsed[0]?.sub).toContain('origin');
    const line = rowsOf(t.inputs(), 'curves')[0] as Json;
    t.session.setTool('select');
    t.session.select([line.start as string]);
    expect(t.session.getState().selected[0]?.constraints.map((c) => c.kind)).toEqual(['coincident']);
    // The glyph selected and deleted takes both rows.
    t.session.select([glyphs[0]?.id as string]);
    expect(t.session.getState().selected[0]?.kind).toBe('coincident');
    expect(t.session.deleteSelection().ok).toBe(true);
    expect(rowsOf(t.inputs(), 'constraints')).toEqual([]);
    expect(readsClean(t.editor)).toBe(true);
  });
});

describe('constraints chosen before the geometry', () => {
  it('starts the tool with nothing selected, applies once the clicks fit, and waits for the next picks', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 20]);
    const b = line(t, [10, 30], [40, 45]);
    t.session.setTool('select');
    t.session.clearSelection();
    expect(t.session.constrain('parallel')).toBeNull();
    expect(t.session.getState()).toMatchObject({
      tool: 'constrain',
      constraint: 'parallel',
      prompt: 'Click two lines',
    });
    // A click by the end of a line picks the line, as parallel takes lines.
    t.click(39.5, 19.8);
    expect(t.session.getState().selection).toEqual([a.id]);
    t.click(25, 37.5);
    const inputs = t.inputs();
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({
      kind: 'parallel',
      a: { curve: { id: a.id } },
      b: { curve: { id: b.id } },
    });
    expect(direction(inputs, a)[0]).toBeCloseTo(direction(inputs, b)[0], 9);
    expect(t.session.getState()).toMatchObject({
      tool: 'constrain',
      constraint: 'parallel',
      selection: [],
      message: null,
    });
    expect(readsClean(t.editor)).toBe(true);
    // Escape drops the picks, then leaves the tool.
    clickLine(t, a);
    expect(t.session.getState().selection).toEqual([a.id]);
    t.key('Escape');
    expect(t.session.getState()).toMatchObject({ tool: 'constrain', selection: [] });
    t.key('Escape');
    expect(t.session.getState()).toMatchObject({ tool: 'select', constraint: null });
  });

  it('merges two points clicked for coincident, and refuses picks that cannot make the constraint', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [30, 10]);
    const b = line(t, [32, 12], [50, 30]);
    t.session.constrain('coincident');
    t.click(30, 10);
    t.click(32, 12);
    const inputs = t.inputs();
    expect(rowsOf(inputs, 'points')).toHaveLength(3);
    const merged = rowsOf(inputs, 'curves').find((c) => c.id === b.id) as Json;
    expect(merged.start).toBe(a.end);
    // Two lines are no coincidence: refused with the reason, and the picks start again.
    clickLine(t, a);
    clickLine(t, b);
    expect(t.session.getState().message).toBe('Select two or more points, or points and one curve');
    expect(t.session.getState().selection).toEqual([]);
  });

  it('applies at once to a selection that fits, and keeps one that can still grow', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 20]);
    t.session.setTool('select');
    t.session.select([a.id as string]);
    expect(t.session.constrain('horizontal')?.ok).toBe(true);
    expect(t.session.getState().tool).toBe('select');
    const c = line(t, [10, 40], [16, 70]);
    t.session.setTool('select');
    t.session.select([c.id as string]);
    expect(t.session.constrain('perpendicular')).toBeNull();
    expect(t.session.getState()).toMatchObject({ tool: 'constrain', selection: [c.id] });
    clickLine(t, a);
    expect(t.session.getState().message).toBeNull();
    const inputs = t.inputs();
    expect(rowsOf(inputs, 'constraints').at(-1)).toMatchObject({ kind: 'perpendicular' });
    expect(Math.abs(direction(inputs, c)[0])).toBeCloseTo(0, 9);
  });
});

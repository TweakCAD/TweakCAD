import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { fieldText, formatNumber, valueText } from './dimensions';
import type { Json } from './rows';
import { openTestSession, pointXY, readsClean, rowsOf, sketchDocument, type TestSession } from './testKit';
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

const length = (inputs: Json, l: Json) => {
  const [a, b] = [pointXY(inputs, l.start as string), pointXY(inputs, l.end as string)];
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

const lastConstraint = (t: TestSession) => rowsOf(t.inputs(), 'constraints').at(-1) as Json;

describe('placing dimensions', () => {
  it('dimensions a line by its ends, with the label where placed and named for use in expressions', () => {
    const t = openTestSession(gcs);
    const l = line(t, [10, 10], [40, 50]);
    t.session.setTool('dimension');
    t.click(25, 30);
    t.click(10, 40);
    const dim = lastConstraint(t);
    expect(dim).toMatchObject({
      kind: 'distance',
      a: { point: { id: l.start } },
      b: { point: { id: l.end } },
      solved: 50,
      label: { at: { p: [10, 40] } },
      value: { name: 'd1', def: { expr: { text: '50 mm', grammar: 1, refs: {} } } },
    });
    expect(t.session.getState().editing).toBe(dim.id);
    expect(t.session.labels()).toEqual([
      { id: dim.id, at: [10, 40, 0], text: '50 mm', expression: '50 mm', unit: 'mm' },
    ]);
    expect(t.editor.store.undoLabel()).toBe('Add dimension');
    expect(readsClean(t.editor)).toBe(true);
  });

  it('measures along an axis, ordered so the value is positive', () => {
    const t = openTestSession(gcs);
    const l = line(t, [40, 25], [10, 10]);
    t.session.setTool('dimensionX');
    t.click(25, 17.5);
    t.click(25, 0);
    expect(lastConstraint(t)).toMatchObject({
      kind: 'distanceX',
      a: { point: { id: l.end } },
      b: { point: { id: l.start } },
      solved: 30,
    });
    t.session.setTool('dimensionY');
    t.click(25, 17.5);
    t.click(50, 17);
    expect(lastConstraint(t)).toMatchObject({ kind: 'distanceY', solved: 15 });
  });

  it('a circle by its diameter, an arc by its radius, two lines by their angle, a point and a line by their distance', () => {
    const t = openTestSession(gcs);
    t.session.setTool('circle');
    t.click(20, 20);
    t.click(26, 20);
    t.session.setTool('dimension');
    t.click(26, 20);
    t.click(40, 40);
    expect(lastConstraint(t)).toMatchObject({
      kind: 'diameter',
      solved: 12,
      value: { def: { expr: { text: '12 mm' } } },
    });

    t.session.setTool('arc');
    t.click(90, 10);
    t.click(70, 10);
    t.click(80, 20);
    t.session.setTool('dimension');
    t.click(80, 20);
    t.click(100, 30);
    expect(lastConstraint(t)).toMatchObject({ kind: 'radius', solved: 10 });

    const a = line(t, [10, 60], [50, 60]);
    const b = line(t, [10, 70], [40, 100]);
    t.session.setTool('dimension');
    t.click(30, 60);
    t.click(25, 85);
    const angle = lastConstraint(t);
    expect(angle).toMatchObject({ kind: 'angle', a: { curve: { id: a.id } }, b: { curve: { id: b.id } } });
    expect(angle.solved as number).toBeCloseTo(45, 9);
    expect(t.session.labels().find((l) => l.id === angle.id)?.text).toBe('45°');

    t.session.setTool('point');
    t.click(30, 130);
    t.session.setTool('dimension');
    t.click(30, 130);
    t.click(30, 60);
    expect(lastConstraint(t)).toMatchObject({ kind: 'distance', b: { curve: { id: a.id } }, solved: 70 });
    expect(readsClean(t.editor)).toBe(true);
  });

  it('an ellipse alone by its major radius', () => {
    const t = openTestSession(gcs);
    t.session.setTool('ellipse');
    t.click(40, 40);
    t.click(60, 40);
    t.click(40, 50);
    const e = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    expect(e.kind).toBe('ellipse');
    t.session.setTool('dimension');
    t.click(40, 50);
    t.click(100, 100);
    expect(lastConstraint(t)).toMatchObject({
      kind: 'distance',
      a: { point: { id: e.center } },
      b: { point: { id: e.majorEnd } },
      solved: 20,
    });
    expect(readsClean(t.editor)).toBe(true);
  });

  it('refuses a dimension the sketch already sets', () => {
    const t = openTestSession(gcs);
    line(t, [10, 10], [40, 10]);
    t.session.setTool('dimensionY');
    const before = t.editor.save();
    t.click(25, 10);
    t.click(25, 0);
    expect(t.session.getState().message).toBe('That would over-constrain the sketch');
    expect(t.editor.save()).toBe(before);
  });
});

describe('dimensions against the origin and axes', () => {
  it('measures and labels them, and solves them when edited', () => {
    const t = openTestSession(gcs);
    const l = line(t, [10, 0.3], [40, 20]);
    const rows = t.inputs();
    expect(pointXY(rows, l.start as string)[1]).toBeCloseTo(0, 12);
    // A horizontal dimension from the origin to the line's start, written as the sketcher writes one.
    const dim = {
      id: t.editor.newId('con'),
      kind: 'distanceX',
      active: { id: t.editor.newId('val'), def: { expr: { text: 'true', grammar: 1, refs: {} } } },
      a: { sketchStandard: { name: 'origin' } },
      b: { point: { id: l.start } },
      value: { id: t.editor.newId('val'), name: 'd1', def: { expr: { text: '10 mm', grammar: 1, refs: {} } } },
      solved: 10,
      label: { auto: {} },
    };
    expect(t.editor.dispatch({ type: 'editSketch', sketch: t.host.feature, add: { constraints: [dim] } }).ok).toBe(
      true,
    );
    expect(t.session.labels()).toEqual([expect.objectContaining({ id: dim.id, text: '10 mm', at: [5, -4, 0] })]);
    expect(t.session.setDimension(dim.id, '15 mm').ok).toBe(true);
    expect(pointXY(t.inputs(), l.start as string)[0]).toBeCloseTo(15, 9);
    // A bare number is in the label's unit, millimetres.
    expect(t.session.setDimension(dim.id, '12').ok).toBe(true);
    expect(pointXY(t.inputs(), l.start as string)[0]).toBeCloseTo(12, 9);
    expect(t.session.setDimension(dim.id, '15').ok).toBe(true);
    expect(pointXY(t.inputs(), l.start as string)[1]).toBeCloseTo(0, 9);
    expect(readsClean(t.editor)).toBe(true);
  });
});

describe('editing dimensions', () => {
  it('writes the expression, solves and commits; undo restores', () => {
    const t = openTestSession(gcs);
    const l = line(t, [10, 10], [40, 10]);
    t.session.setTool('dimension');
    t.click(25, 10);
    t.click(25, 0);
    const dim = lastConstraint(t);
    const before = t.editor.save();

    const result = t.session.setDimension(dim.id as string, '45 mm');
    expect(result.ok).toBe(true);
    expect(length(t.inputs(), l)).toBeCloseTo(45, 9);
    expect(lastConstraint(t)).toMatchObject({
      solved: 45,
      value: { id: (dim.value as Json).id, name: 'd1', def: { expr: { text: '45 mm' } } },
    });
    expect(t.session.labels()[0]?.text).toBe('45 mm');
    expect(t.editor.store.undoLabel()).toBe('Edit dimension');
    expect(readsClean(t.editor)).toBe(true);
    t.editor.undo();
    expect(t.editor.save()).toBe(before);
    expect(length(t.inputs(), l)).toBeCloseTo(30, 9);
  });

  it('binds parameters and other dimensions by name', () => {
    const t = openTestSession(gcs);
    const a = line(t, [10, 10], [40, 10]);
    const b = line(t, [10, 30], [30, 30]);
    t.session.setTool('dimension');
    t.click(25, 10);
    t.click(25, 0);
    const first = lastConstraint(t);
    t.click(20, 30);
    t.click(20, 40);
    const second = lastConstraint(t);
    expect(t.session.setDimension(first.id as string, 'width + gap').ok).toBe(true);
    expect(length(t.inputs(), a)).toBeCloseTo(45, 9);
    expect(t.session.setDimension(second.id as string, 'd1 / 3').ok).toBe(true);
    expect(length(t.inputs(), b)).toBeCloseTo(15, 9);
    expect((lastConstraint(t).value as Json).def).toMatchObject({
      expr: { text: 'd1 / 3', refs: { d1: { value: { id: (first.value as Json).id } } } },
    });
    // Changing the first moves the second, which depends on it.
    expect(t.session.setDimension(first.id as string, '60 mm').ok).toBe(true);
    expect(length(t.inputs(), b)).toBeCloseTo(20, 9);
    expect(readsClean(t.editor)).toBe(true);
  });

  it('refuses text it cannot bind, a length of nothing, and a value the sketch cannot meet, changing nothing', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(30, 10);
    t.click(20, 25);
    t.click(10.2, 10.1);
    const sides = rowsOf(t.inputs(), 'curves');
    t.session.setTool('dimension');
    const dims: string[] = [];
    for (const [s, at] of [
      [sides[0], [20, 5]],
      [sides[1], [30, 20]],
    ] as const) {
      const [p, q] = [pointXY(t.inputs(), s?.start as string), pointXY(t.inputs(), s?.end as string)];
      t.click((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      t.click(...at);
      dims.push(lastConstraint(t).id as string);
    }
    expect(t.session.setDimension(dims[0] as string, '20 mm').ok).toBe(true);
    expect(t.session.setDimension(dims[1] as string, '20 mm').ok).toBe(true);
    const before = t.editor.save();
    expect(t.session.setDimension(dims[0] as string, 'depth * 2')).toMatchObject({
      ok: false,
      error: { message: 'depth is not a parameter or named value here' },
    });
    expect(t.session.setDimension(dims[0] as string, '0 mm')).toMatchObject({
      ok: false,
      error: { message: 'A length is more than 0 mm' },
    });
    expect(t.session.setDimension(dims[0] as string, '30 deg').ok).toBe(false);
    // The third side would have to be longer than the other two together.
    t.click(15, 17.5);
    t.click(0, 20);
    const third = lastConstraint(t).id as string;
    const withThird = t.editor.save();
    const refused = t.session.setDimension(third, '50 mm');
    expect(refused.ok).toBe(false);
    expect(t.session.getState().message).toBe(refused.ok ? '' : refused.error.message);
    expect(t.editor.save()).toBe(withThird);
    expect(before).not.toBe(withThird);
  });
});

describe('dimensions over measured values', () => {
  it('leaves a value read from a measure to the solve, not to the length check', () => {
    const { doc, part, feature, t: d } = sketchDocument();
    const row = (doc.parts as Json[]).find((p) => p.id === part) as Json;
    const measured = {
      id: d.id('val'),
      name: 'm1',
      def: { measure: { kind: 'area', of: [{ standard: { name: 'xy' } }] } },
    };
    const measure = {
      id: d.id('feat'),
      type: 'core.measure',
      typeVersion: 1,
      name: 'Measure 1',
      suppressed: d.flag(false),
      frozen: { live: {} },
      command: { alone: {} },
      inputs: { values: [measured] },
    };
    (row.timeline as Json[]).unshift(measure);
    const t = openTestSession(gcs, doc, part, feature);
    line(t, [10, 10], [40, 10]);
    t.session.setTool('dimension');
    t.click(25, 10);
    t.click(25, 20);
    const dim = lastConstraint(t);
    const before = t.editor.save();
    const result = t.session.setDimension(dim.id as string, 'm1 / 1 mm');
    // Here the measure has no result, so the solve, not the length check, refuses it.
    expect(result.ok).toBe(false);
    expect(t.session.getState().message).not.toBe('A length is more than 0 mm');
    expect(t.editor.save()).toBe(before);
  });
});

describe('formatting', () => {
  it('rounds labels to hundredths and new values to thousandths', () => {
    expect(formatNumber(12.3456)).toBe('12.35');
    expect(formatNumber(-0.001)).toBe('0');
    expect(valueText(12.34567, false)).toBe('12.346 mm');
    expect(valueText(30, true)).toBe('30 deg');
  });

  it('shows a plain number in the field without the unit beside it', () => {
    expect(fieldText('12.5 mm', 'mm')).toBe('12.5');
    expect(fieldText('-30 deg', 'deg')).toBe('-30');
    expect(fieldText('2 in', 'mm')).toBe('2 in');
    expect(fieldText('d1 * 2', 'mm')).toBe('d1 * 2');
  });
});

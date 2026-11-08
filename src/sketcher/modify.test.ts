import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { base32Encode } from '@tweakcad/format';
import { RowMaker, curveOperand, pointOperand, standardOperand, type Json } from './rows';
import { openTestSession, pointXY, readsClean, rowsOf, type TestSession } from './testKit';
import { loadTestSolver } from './testSetup';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

const kinds = (inputs: Json, table: string) => rowsOf(inputs, table).map((r) => r.kind as string);
const xy = (inputs: Json, id: unknown) => pointXY(inputs, id as string);

function line(t: TestSession, a: [number, number], b: [number, number]): Json {
  t.session.setTool('line');
  t.click(...a);
  t.click(...b);
  t.key('Escape');
  return rowsOf(t.inputs(), 'curves').at(-1) as Json;
}

function rectangle(t: TestSession, a: [number, number], b: [number, number]): Json[] {
  t.session.setTool('rectangle');
  t.click(...a);
  t.click(...b);
  return rowsOf(t.inputs(), 'curves').slice(-4);
}

/** Uses a tool by clicks (and `then`, as the Offset dialog's OK); checks one command, a clean document, and undo and redo restoring it. */
function use(
  t: TestSession,
  tool: Parameters<TestSession['session']['setTool']>[0],
  clicks: [number, number][],
  then?: () => void,
): Json {
  t.session.setTool(tool);
  const before = t.editor.save();
  for (const c of clicks) {
    t.move(...c);
    t.click(...c);
  }
  then?.();
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

describe('trim', () => {
  it('cuts a line back to the lines crossing it, keeping the pieces made from it and retiring it', () => {
    const t = openTestSession(gcs);
    const long = line(t, [2, 10], [40, 10]);
    line(t, [10, 3], [10, 20]);
    line(t, [30, 3], [30, 20]);
    const inputs = use(t, 'trim', [[20, 10]]);
    const pieces = rowsOf(inputs, 'curves').filter((c) => (c.origin as Json).from !== undefined);
    expect(pieces).toHaveLength(2);
    expect(pieces.every((p) => ((p.origin as Json).from as Json).id === long.id)).toBe(true);
    expect(rowsOf(inputs, 'retired').map((r) => [r.id, Object.keys(r.fate as Json)[0]])).toEqual([[long.id, 'split']]);
    expect(xy(inputs, pieces[0]?.end)[0]).toBeCloseTo(10, 9);
    expect(xy(inputs, pieces[1]?.start)[0]).toBeCloseTo(30, 9);
    // The long line's horizontal holds both pieces.
    const horizontal = rowsOf(inputs, 'constraints').filter((c) => c.kind === 'horizontal');
    expect(horizontal.map((c) => ((c.of as Json).curve as Json).id).sort()).toEqual(pieces.map((p) => p.id).sort());
    // The cut ends are held on the crossing lines.
    expect(kinds(inputs, 'constraints').filter((k) => k === 'pointOnCurve')).toHaveLength(2);
  });

  it('refuses a click right on a crossing, which is neither side of it', () => {
    const t = openTestSession(gcs);
    line(t, [10, 20], [30, 20]);
    line(t, [20, 10], [20, 30]);
    const before = t.editor.save();
    t.session.setTool('trim');
    t.move(20, 20);
    t.click(20, 20);
    expect(t.session.getState().message).toBe('Click the part of the curve to remove, beside the crossing');
    expect(t.editor.save()).toBe(before);
  });

  it('deletes a curve nothing crosses, and trims a circle to an arc', () => {
    const t = openTestSession(gcs);
    line(t, [0.01, 50], [20, 50]);
    let inputs = use(t, 'trim', [[10, 50]]);
    expect(rowsOf(inputs, 'curves')).toHaveLength(0);
    t.session.setTool('circle');
    t.click(20, 20);
    t.click(30, 20);
    line(t, [10, 20], [30, 20]);
    inputs = use(t, 'trim', [[20, 30]]);
    const arc = rowsOf(inputs, 'curves').find((c) => c.kind === 'arc') as Json;
    expect(arc).toBeDefined();
    // The lower half is left: counter-clockwise from the left crossing to the right.
    expect(xy(inputs, arc.start)[0]).toBeCloseTo(10, 6);
    expect(xy(inputs, arc.end)[0]).toBeCloseTo(30, 6);
  });
});

describe('extend', () => {
  it('moves a free end of a line to the line it meets, held there', () => {
    const t = openTestSession(gcs);
    const short = line(t, [0.01, 10], [20, 10]);
    line(t, [30, 0.01], [30, 20]);
    const inputs = use(t, 'extend', [[19, 10]]);
    expect(xy(inputs, short.end)[0]).toBeCloseTo(30, 9);
    expect(kinds(inputs, 'constraints')).toContain('pointOnCurve');
  });

  it('refuses an end joined to another curve', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [30, 20]);
    t.session.setTool('extend');
    t.click(29, 10);
    expect(t.session.getState().message).toBe('That end is joined to another curve');
  });
});

describe('fillet', () => {
  it('rounds a rectangle corner with a tangent arc and a radius dimension', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [40, 30]);
    t.session.setSettings({ fillet: 4 });
    const inputs = use(t, 'fillet', [[40, 10]]);
    const arc = rowsOf(inputs, 'curves').find((c) => c.kind === 'arc') as Json;
    expect(arc).toBeDefined();
    const c = xy(inputs, arc.center);
    expect(c[0]).toBeCloseTo(36, 6);
    expect(c[1]).toBeCloseTo(14, 6);
    const constraints = kinds(inputs, 'constraints');
    expect(constraints.filter((k) => k === 'tangent')).toHaveLength(2);
    expect(constraints).toContain('radius');
    // The corner point is gone.
    expect(rowsOf(inputs, 'points').some((p) => p.x === 40 && p.y === 10)).toBe(false);
    expect(t.session.labels().map((l) => l.text)).toContain('R 4 mm');
  });

  it('rounds a centre rectangle corner its construction diagonal also ends at, keeping the diagonal at the sharp corner', () => {
    const t = openTestSession(gcs);
    t.session.setTool('centerRectangle');
    t.click(25, 20);
    t.click(40, 30);
    const dof = t.session.getState().dof;
    const diagonal = rowsOf(t.inputs(), 'curves').find(
      (c) =>
        c.kind === 'line' &&
        (c.construction as Json).def !== undefined &&
        JSON.stringify(c.construction).includes('true'),
    ) as Json;
    expect(diagonal).toBeDefined();
    t.session.setSettings({ fillet: 4 });
    const inputs = use(t, 'fillet', [[40, 30]]);
    expect(kinds(inputs, 'curves')).toContain('arc');
    // The diagonal still ends where the two lines would meet, and nothing came loose.
    const kept = rowsOf(inputs, 'curves').find((c) => c.id === diagonal.id) as Json;
    const end = [kept.start, kept.end].map((p) => xy(inputs, p)).find((p) => p[0] > 30) as [number, number];
    expect(end[0]).toBeCloseTo(40, 6);
    expect(end[1]).toBeCloseTo(30, 6);
    expect(t.session.getState().dof).toBe(dof);
  });

  it('takes two lines in turn', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [40, 30]);
    t.session.setTool('fillet');
    t.click(25, 10);
    expect(t.session.getState().prompt).toBe('Click the second line');
    t.click(40, 20);
    expect(t.session.getState().message).toBeNull();
    expect(kinds(t.inputs(), 'curves')).toContain('arc');
  });
});

/** The Offset dialog's OK, by Enter. */
const ok = (t: TestSession) => () => {
  expect(t.key('Enter')).toBe(true);
};

/** How many shapes the session draws in the preview colour. */
function previewLines(t: TestSession): number {
  let n = 0;
  t.host.group.traverse((o) => {
    const color = (o as { material?: { color?: { getHex(): number } } }).material?.color;
    if (color?.getHex() === 0x22c55e) n++;
  });
  return n;
}

describe('offset', () => {
  it('offsets a rectangle outward into a rectangle, held by offsets sharing one distance', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [40, 30]);
    t.session.setSettings({ offset: 2 });
    const inputs = use(t, 'offset', [[25, 9.6]], ok(t));
    const lines = rowsOf(inputs, 'curves').filter((c) => c.kind === 'line');
    expect(lines).toHaveLength(8);
    const offsets = rowsOf(inputs, 'constraints').filter((c) => c.kind === 'offset');
    expect(offsets).toHaveLength(4);
    const copies = lines.slice(4);
    const xs = copies.flatMap((l) => [xy(inputs, l.start)[0], xy(inputs, l.end)[0]]);
    expect(Math.min(...xs)).toBeCloseTo(8, 6);
    expect(Math.max(...xs)).toBeCloseTo(42, 6);
    // One label edits the distance of every copy.
    const label = t.session.labels().find((l) => l.text === '2 mm');
    expect(label).toBeDefined();
    const result = t.session.setDimension(label?.id as string, '3');
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    const after = t.inputs();
    const all = rowsOf(after, 'curves').filter((c) => c.kind === 'line');
    const span = (list: Json[]) => {
      const xs2 = list.flatMap((l) => [xy(after, l.start)[0], xy(after, l.end)[0]]);
      return Math.max(...xs2) - Math.min(...xs2);
    };
    expect(span(all.slice(4)) - span(all.slice(0, 4))).toBeCloseTo(6, 6);
  });

  it('offsets a chain of lines and arcs meeting smoothly, and the copy follows the distance', () => {
    const t = openTestSession(gcs);
    t.session.setTool('slot');
    t.click(10, 10);
    t.click(40, 10);
    t.click(25, 15);
    t.session.setSettings({ offset: 2 });
    const inputs = use(t, 'offset', [[25, 15.4]], ok(t));
    const arcs = rowsOf(inputs, 'curves').filter((c) => c.kind === 'arc');
    expect(arcs).toHaveLength(4);
    const radius = (arc: Json, rows: Json) => {
      const [c, s] = [xy(rows, arc.center), xy(rows, arc.start)];
      return Math.hypot(s[0] - c[0], s[1] - c[1]);
    };
    expect(radius(arcs[2] as Json, inputs)).toBeCloseTo(7, 6);
    const label = t.session.labels().find((l) => l.text === '2 mm');
    const result = t.session.setDimension(label?.id as string, '3');
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    const after = t.inputs();
    const copies = rowsOf(after, 'curves')
      .filter((c) => c.kind === 'arc')
      .slice(2);
    for (const a of copies)
      expect(
        radius(a, after) - radius(rowsOf(after, 'curves').filter((c) => c.kind === 'arc')[0] as Json, after),
      ).toBeCloseTo(3, 6);
  });

  it('offsets a rectangle with a filleted corner', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [40, 30]);
    t.session.setSettings({ fillet: 4, offset: 2 });
    use(t, 'fillet', [[40, 10]]);
    const inputs = use(t, 'offset', [[25, 9.6]], ok(t));
    expect(rowsOf(inputs, 'curves').filter((c) => c.kind === 'arc')).toHaveLength(2);
    expect(t.session.getState().dof).not.toBeNull();
  });

  it('offsets a circle inward', () => {
    const t = openTestSession(gcs);
    t.session.setTool('circle');
    t.click(20, 20);
    t.click(30, 20);
    t.session.setSettings({ offset: 3 });
    const inputs = use(t, 'offset', [[29.6, 20]], ok(t));
    const circles = rowsOf(inputs, 'curves').filter((c) => c.kind === 'circle');
    expect(circles.map((c) => c.radius)).toEqual([10, 7]);
  });

  it('shows one offset glyph and browser row for the chain, and deletes it as one', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [40, 30]);
    t.session.setSettings({ offset: 2 });
    use(t, 'offset', [[25, 9.6]], ok(t));
    expect(kinds(t.inputs(), 'constraints').filter((k) => k === 'offset')).toHaveLength(4);
    const glyphs = t.session.glyphs().filter((g) => g.kind === 'offset');
    expect(glyphs).toHaveLength(1);
    expect(t.session.browse().constraints.filter((r) => r.kind === 'offset')).toHaveLength(1);
    const copy = rowsOf(t.inputs(), 'curves')[6] as Json;
    t.session.select([copy.id as string]);
    expect(t.session.getState().selected[0]?.constraints.filter((c) => c.kind === 'offset')).toEqual([
      { id: glyphs[0]?.id, kind: 'offset' },
    ]);
    t.session.select([glyphs[0]?.id as string]);
    expect(t.session.deleteSelection().ok).toBe(true);
    expect(kinds(t.inputs(), 'constraints').filter((k) => k === 'offset')).toEqual([]);
    expect(rowsOf(t.inputs(), 'curves').filter((c) => c.kind === 'line')).toHaveLength(8);
  });

  it('opens on the curve clicked, previewing its copies and writing nothing until OK, and Cancel writes nothing', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [40, 30]);
    t.session.setTool('offset');
    const before = t.editor.save();
    t.move(25, 9.6);
    const shown = previewLines(t);
    t.click(25, 9.6);
    expect(t.editor.save()).toBe(before);
    expect(t.session.getState()).toMatchObject({
      tool: 'offset',
      offsetCurve: rowsOf(t.inputs(), 'curves')[0]?.id,
      prompt: 'Set the distance, then OK',
    });
    expect(previewLines(t) - shown).toBe(4);
    t.key('Escape');
    expect(t.session.getState().offsetCurve).toBeNull();
    expect(t.editor.save()).toBe(before);
    t.click(25, 9.6);
    t.session.setTool('select');
    expect(t.editor.save()).toBe(before);
  });

  it('flips to the other side, and offsets both sides with Two sides and Symmetric', () => {
    const t = openTestSession(gcs);
    rectangle(t, [10, 10], [40, 30]);
    const span = (inputs: Json, from: number) => {
      const xs = rowsOf(inputs, 'curves')
        .filter((c) => c.kind === 'line')
        .slice(from, from + 4)
        .flatMap((l) => [xy(inputs, l.start)[0], xy(inputs, l.end)[0]]);
      return [Math.min(...xs), Math.max(...xs)];
    };
    // Clicked outside, flipped: the copy goes inside.
    t.session.setSettings({ offset: 2 });
    let inputs = use(t, 'offset', [[25, 9.6]], () => {
      t.session.flipOffset();
      ok(t)();
    });
    expect(span(inputs, 4)[0]).toBeCloseTo(12, 6);
    expect(span(inputs, 4)[1]).toBeCloseTo(38, 6);
    t.editor.undo();
    // Two sides: a distance each side, each named.
    t.session.setSettings({ offsetDirection: 'two', offset: 2, offset2: 3 });
    inputs = use(t, 'offset', [[25, 9.6]], ok(t));
    expect(span(inputs, 4)).toEqual([expect.closeTo(8, 6), expect.closeTo(42, 6)]);
    expect(span(inputs, 8)).toEqual([expect.closeTo(13, 6), expect.closeTo(37, 6)]);
    expect(
      t.session
        .labels()
        .map((l) => l.text)
        .sort(),
    ).toEqual(['2 mm', '3 mm']);
    t.editor.undo();
    // Symmetric: one distance both sides, one label driving both.
    t.session.setSettings({ offsetDirection: 'symmetric', offset: 2 });
    inputs = use(t, 'offset', [[25, 9.6]], ok(t));
    expect(span(inputs, 4)).toEqual([expect.closeTo(8, 6), expect.closeTo(42, 6)]);
    expect(span(inputs, 8)).toEqual([expect.closeTo(12, 6), expect.closeTo(38, 6)]);
    const labels = t.session.labels();
    expect(labels.map((l) => l.text)).toEqual(['2 mm']);
    expect(t.session.setDimension(labels[0]?.id as string, '4').ok).toBe(true);
    const after = t.inputs();
    const width = (from: number) => (span(after, from)[1] as number) - (span(after, from)[0] as number);
    expect(width(4) - width(0)).toBeCloseTo(8, 6);
    expect(width(0) - width(8)).toBeCloseTo(8, 6);
  });
});

describe('mirror', () => {
  it('copies the selection across a line, each point held symmetric', () => {
    const t = openTestSession(gcs);
    const l = line(t, [10, 10], [20, 25]);
    t.session.setTool('select');
    t.session.select([l.id as string]);
    t.session.setTool('mirror');
    t.session.select([l.id as string]);
    t.move(0, 15);
    t.click(0, 15);
    expect(t.session.getState().message).toBeNull();
    const inputs = t.inputs();
    const copy = rowsOf(inputs, 'curves')[1] as Json;
    expect(xy(inputs, copy.start)[0]).toBeCloseTo(-10, 9);
    expect(xy(inputs, copy.end)[1]).toBeCloseTo(25, 9);
    expect(kinds(inputs, 'constraints').filter((k) => k === 'symmetric')).toHaveLength(2);
    expect(readsClean(t.editor)).toBe(true);
  });

  it('keeps a mirrored ellipse the same shape as its original when that changes', () => {
    const t = openTestSession(gcs);
    const ellipse = (clicks: [number, number][]): Json => {
      t.session.setTool('ellipse');
      for (const c of clicks) {
        t.move(...c);
        t.click(...c);
      }
      return rowsOf(t.inputs(), 'curves').at(-1) as Json;
    };
    const source = ellipse([
      [20, 20],
      [30, 20],
      [20, 25],
    ]);
    const dof = t.session.getState().dof;
    t.session.setTool('mirror');
    t.session.select([source.id as string]);
    t.move(0, 40);
    t.click(0, 40);
    expect(t.session.getState().message).toBeNull();
    // The copy follows its original and takes none of its freedom.
    expect(t.session.getState().dof).toBe(dof);
    const copy = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    expect(copy.id).not.toBe(source.id);
    // Equal to a fatter ellipse: the original's minor radius changes, and the copy's with it.
    const other = ellipse([
      [60, 60],
      [70, 60],
      [60, 68],
    ]);
    t.session.setTool('select');
    t.session.select([source.id as string, other.id as string]);
    expect(t.session.applyConstraint('equal').ok).toBe(true);
    const curves = rowsOf(t.inputs(), 'curves');
    const minor = (id: unknown) => curves.find((c) => c.id === id)?.minorRadius as number;
    expect(Math.abs(minor(source.id) - 5)).toBeGreaterThan(0.5);
    expect(minor(copy.id)).toBeCloseTo(minor(source.id), 6);
    expect(readsClean(t.editor)).toBe(true);
  });

  describe('copies of fully constrained and dragged curves', () => {
    let made = 0;
    // Ids of their own, apart from the test document's and the editor's.
    const m = new RowMaker((kind) => {
      const bytes = new Uint8Array(16);
      bytes[0] = 0xdd;
      new DataView(bytes.buffer).setUint32(12, ++made);
      return `${kind}_${base32Encode(bytes)}`;
    });
    const origin = standardOperand('origin');
    const xAxis = standardOperand('x');
    const P = (row: Json) => pointOperand(row.id as string);
    const C = (row: Json) => curveOperand(row.id as string);
    const dim = (kind: string, fields: Json, mm: number) => m.dimension(kind, fields, m.value(`${mm} mm`), mm);

    /** A point held at the sketch origin, and construction circles about it held by radius dimensions. */
    function hub(rows: { points: Json[]; curves: Json[]; constraints: Json[] }, radii: number[]): Json[] {
      const o = m.point(0, 0);
      rows.points.push(o);
      for (const kind of ['horizontal', 'vertical'])
        rows.constraints.push(m.geometric(kind, { of: { points: { a: origin, b: P(o) } } }));
      return radii.map((r) => {
        const circle = m.circle(o.id as string, r, true);
        rows.curves.push(circle);
        rows.constraints.push(dim('radius', { curve: C(circle) }, r));
        return circle;
      });
    }

    /**
     * A gear tooth flank: an arc from a tip circle (r 45) to a root circle
     * (r 35), its centre on a circle of r 30 and 8 above the x axis, radius 25.
     */
    function flank() {
      const rows = { points: [] as Json[], curves: [] as Json[], constraints: [] as Json[] };
      const [root, tip, centres] = hub(rows, [35, 45, 30]) as [Json, Json, Json];
      const [c, s, e] = [m.point(28.9, 8), m.point(17.6, 30.3), m.point(30.7, 32.9)];
      const arc = m.arc(c.id as string, e.id as string, s.id as string);
      const height = dim('distanceY', { a: origin, b: P(c) }, 8);
      const radius = dim('radius', { curve: C(arc) }, 25);
      rows.points.push(c, s, e);
      rows.curves.push(arc);
      rows.constraints.push(
        m.geometric('pointOnCurve', { point: P(c), curve: C(centres) }),
        m.geometric('pointOnCurve', { point: P(e), curve: C(tip) }),
        m.geometric('pointOnCurve', { point: P(s), curve: C(root) }),
        height,
        radius,
      );
      return { rows, arc, root, height, radius };
    }

    /** A session holding `rows`, solved and fully constrained. */
    function open(rows: { points: Json[]; curves: Json[]; constraints: Json[] }): TestSession {
      const t = openTestSession(gcs);
      expect(t.session.insert({ label: 'Draw', add: rows }).ok).toBe(true);
      expect(t.session.getState().dof).toBe(0);
      return t;
    }

    /** Mirrors the curves across the sketch's x axis; returns the copies, in the order of the originals. */
    function mirrorAcrossX(t: TestSession, curves: string[]): Json[] {
      const before = rowsOf(t.inputs(), 'curves').length;
      t.session.setTool('mirror');
      t.session.select(curves);
      t.move(-70, 0);
      t.click(-70, 0);
      const message = t.session.getState().message;
      expect(message, message ?? '').toBeNull();
      const copies = rowsOf(t.inputs(), 'curves').slice(before);
      expect(copies).toHaveLength(curves.length);
      return copies;
    }

    /** Checks the copy is the original reflected in the x axis, an arc turned round. */
    function expectMirrored(t: TestSession, id: string, copy: Json) {
      const inputs = t.inputs();
      const curves = rowsOf(inputs, 'curves');
      const original = curves.find((c) => c.id === id) as Json;
      const now = curves.find((c) => c.id === copy.id) as Json;
      const pairs: [string, string][] =
        original.kind === 'arc'
          ? [
              ['center', 'center'],
              ['start', 'end'],
              ['end', 'start'],
            ]
          : original.kind === 'circle'
            ? [['center', 'center']]
            : [
                ['start', 'start'],
                ['end', 'end'],
              ];
      for (const [from, to] of pairs) {
        const [x, y] = xy(inputs, original[from]);
        const [u, v] = xy(inputs, now[to]);
        expect(u).toBeCloseTo(x, 7);
        expect(v).toBeCloseTo(-y, 7);
      }
      if (original.kind === 'circle') expect(now.radius as number).toBeCloseTo(original.radius as number, 7);
    }

    it('mirrors an arc, which stays fully constrained and follows its original', () => {
      const { rows, arc, height, radius } = flank();
      const t = open(rows);
      const [copy] = mirrorAcrossX(t, [arc.id as string]) as [Json];
      expect(copy.kind).toBe('arc');
      expectMirrored(t, arc.id as string, copy);
      expect(t.session.getState().dof).toBe(0);
      expect(readsClean(t.editor)).toBe(true);
      expect(t.session.setDimension(height.id as string, '11 mm').ok).toBe(true);
      expect(t.session.setDimension(radius.id as string, '22 mm').ok).toBe(true);
      expect(xy(t.inputs(), copy.center)[1]).toBeCloseTo(-11, 7);
      expectMirrored(t, arc.id as string, copy);
      expect(t.session.getState().dof).toBe(0);
    });

    it('mirrors a circle, which follows its original', () => {
      const rows = { points: [] as Json[], curves: [] as Json[], constraints: [] as Json[] };
      const c = m.point(20, 10);
      const circle = m.circle(c.id as string, 4);
      const height = dim('distanceY', { a: origin, b: P(c) }, 10);
      const radius = dim('radius', { curve: C(circle) }, 4);
      rows.points.push(c);
      rows.curves.push(circle);
      rows.constraints.push(dim('distanceX', { a: origin, b: P(c) }, 20), height, radius);
      const t = open(rows);
      const [copy] = mirrorAcrossX(t, [circle.id as string]) as [Json];
      expectMirrored(t, circle.id as string, copy);
      expect(t.session.getState().dof).toBe(0);
      expect(t.session.setDimension(height.id as string, '13 mm').ok).toBe(true);
      expect(t.session.setDimension(radius.id as string, '6 mm').ok).toBe(true);
      expectMirrored(t, circle.id as string, copy);
      expect(t.session.getState().dof).toBe(0);
    });

    it('mirrors an arc and a line that share an end, the line ending on the axis', () => {
      const { rows, arc, height, radius } = flank();
      // From the arc's end on the root circle straight down to the x axis.
      const s = rows.points.find((p) => p.id === arc.end) as Json;
      const foot = m.point(17.6, 0);
      const line = m.line(s.id as string, foot.id as string);
      rows.points.push(foot);
      rows.curves.push(line);
      rows.constraints.push(
        m.geometric('vertical', { of: C(line) }),
        m.geometric('pointOnCurve', { point: P(foot), curve: xAxis }),
      );
      const t = open(rows);
      const [arcCopy, lineCopy] = mirrorAcrossX(t, [arc.id as string, line.id as string]) as [Json, Json];
      // The copies meet where the originals do, and the line's foot is its own image.
      expect(lineCopy.start).toBe(arcCopy.start);
      expect(lineCopy.end).toBe(foot.id);
      expectMirrored(t, arc.id as string, arcCopy);
      expectMirrored(t, line.id as string, lineCopy);
      expect(t.session.getState().dof).toBe(0);
      expect(t.session.setDimension(height.id as string, '6 mm').ok).toBe(true);
      expect(t.session.setDimension(radius.id as string, '27 mm').ok).toBe(true);
      expectMirrored(t, arc.id as string, arcCopy);
      expectMirrored(t, line.id as string, lineCopy);
      expect(t.session.getState().dof).toBe(0);
      expect(readsClean(t.editor)).toBe(true);
    });

    it('mirrors an arc ending on the axis, and a half circle on it', () => {
      const rows = { points: [] as Json[], curves: [] as Json[], constraints: [] as Json[] };
      const [ring] = hub(rows, [20]) as [Json];
      // An arc from the x axis up round to a point on the ring, centre (30, 5), radius 12.
      const [c, s, e] = [m.point(30, 5), m.point(30 + Math.sqrt(119), 0), m.point(18, 5)];
      const arc = m.arc(c.id as string, s.id as string, e.id as string);
      const radius = dim('radius', { curve: C(arc) }, 12);
      rows.points.push(c, s, e);
      rows.curves.push(arc);
      rows.constraints.push(
        dim('distanceX', { a: origin, b: P(c) }, 30),
        dim('distanceY', { a: origin, b: P(c) }, 5),
        radius,
        m.geometric('pointOnCurve', { point: P(s), curve: xAxis }),
        m.geometric('pointOnCurve', { point: P(e), curve: C(ring) }),
      );
      // A half circle above the axis, its centre and ends on it.
      const [hc, hs, he] = [m.point(-30, 0), m.point(-25, 0), m.point(-35, 0)];
      const half = m.arc(hc.id as string, hs.id as string, he.id as string);
      rows.points.push(hc, hs, he);
      rows.curves.push(half);
      rows.constraints.push(
        dim('distanceX', { a: P(hc), b: origin }, 30),
        dim('radius', { curve: C(half) }, 5),
        ...[hc, hs, he].map((p) => m.geometric('pointOnCurve', { point: P(p), curve: xAxis })),
      );
      const t = open(rows);
      const [arcCopy, halfCopy] = mirrorAcrossX(t, [arc.id as string, half.id as string]) as [Json, Json];
      expect(arcCopy.end).toBe(s.id);
      expect([halfCopy.center, halfCopy.start, halfCopy.end]).toEqual([hc.id, he.id, hs.id]);
      expectMirrored(t, arc.id as string, arcCopy);
      expectMirrored(t, half.id as string, halfCopy);
      expect(t.session.getState().dof).toBe(0);
      expect(t.session.setDimension(radius.id as string, '14 mm').ok).toBe(true);
      expectMirrored(t, arc.id as string, arcCopy);
      expect(t.session.getState().dof).toBe(0);
    });

    it('moves a mirrored arc with its original when that is dragged', () => {
      const t = openTestSession(gcs);
      t.session.setTool('arc');
      t.click(30, 10);
      t.click(10, 10);
      t.click(20, 20);
      const arc = rowsOf(t.inputs(), 'curves').at(-1) as Json;
      const dof = t.session.getState().dof;
      const [copy] = mirrorAcrossX(t, [arc.id as string]) as [Json];
      expect(t.session.getState().dof).toBe(dof);
      t.session.setTool('select');
      t.down(30, 10);
      t.move(31, 12);
      t.up(32, 14);
      expect(xy(t.inputs(), arc.start)).not.toEqual([30, 10]);
      expectMirrored(t, arc.id as string, copy);
      expect(readsClean(t.editor)).toBe(true);
    });
  });
});

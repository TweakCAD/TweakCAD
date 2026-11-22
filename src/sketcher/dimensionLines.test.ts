import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { dimensionLines, type DimensionLines } from './dimensionLines';
import type { Json, P2 } from './rows';
import { openTestSession, rowsOf, type TestSession } from './testKit';
import { loadTestSolver } from './testSetup';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

function line(t: TestSession, a: P2, b: P2): Json {
  t.session.setTool('line');
  t.click(...a);
  t.click(...b);
  t.key('Escape');
  return rowsOf(t.inputs(), 'curves').at(-1) as Json;
}

/** Places a dimension with the tool `tool` by clicking `clicks`, and returns what it draws. */
function place(
  t: TestSession,
  tool: 'dimension' | 'dimensionX' | 'dimensionY',
  ...clicks: P2[]
): DimensionLines | null {
  t.session.setTool(tool);
  for (const c of clicks) t.click(...c);
  t.key('Escape');
  const row = rowsOf(t.inputs(), 'constraints').at(-1) as Json;
  return dimensionLines(t.session.shown, row);
}

/** Rounded to a millionth, so float noise does not matter. */
const r = (v: unknown): unknown =>
  typeof v === 'number' ? Math.round(v * 1e6) / 1e6 + 0 : Array.isArray(v) ? v.map(r) : v;
const rounded = (d: DimensionLines | null) =>
  d && { lines: r(d.lines), arrows: d.arrows.map((a) => ({ at: r(a.at), dir: r(a.dir), span: r(a.span) })) };

describe('dimension lines', () => {
  it('a distance between two points: extension lines out to a dimension line through the label, arrows at its ends', () => {
    const t = openTestSession(gcs);
    line(t, [10, 10], [40, 50]);
    // The line's two ends, the label off to the side.
    const d = place(t, 'dimension', [25, 30], [10, 40]);
    expect(rounded(d)).toEqual({
      lines: [
        [
          [10, 10],
          [-4.4, 20.8],
        ],
        [
          [40, 50],
          [25.6, 60.8],
        ],
        [
          [-4.4, 20.8],
          [25.6, 60.8],
        ],
      ],
      arrows: [
        { at: [-4.4, 20.8], dir: [-0.6, -0.8], span: 50 },
        { at: [25.6, 60.8], dir: [0.6, 0.8], span: 50 },
      ],
    });
  });

  it('runs the dimension line on to a label beyond the measured span', () => {
    const t = openTestSession(gcs);
    line(t, [10, 10], [50, 10]);
    const d = place(t, 'dimension', [30, 10], [70, 20]);
    expect(rounded(d)?.lines.at(-1)).toEqual([
      [10, 20],
      [70, 20],
    ]);
    expect(rounded(d)?.arrows.map((a) => a.at)).toEqual([
      [10, 20],
      [50, 20],
    ]);
  });

  it('a point to a line: measured to the foot on the line, extended from the end of the segment', () => {
    const t = openTestSession(gcs);
    line(t, [10, 60], [50, 60]);
    t.session.setTool('point');
    t.click(70, 30);
    const d = place(t, 'dimension', [70, 30], [30, 60]);
    expect(rounded(d)).toEqual({
      lines: [
        [
          [70, 30],
          [60, 30],
        ],
        [
          [50, 60],
          [60, 60],
        ],
        [
          [60, 30],
          [60, 60],
        ],
      ],
      arrows: [
        { at: [60, 30], dir: [0, -1], span: 30 },
        { at: [60, 60], dir: [0, 1], span: 30 },
      ],
    });
  });

  it('a horizontal distance: a horizontal dimension line at the label, vertical extension lines', () => {
    const t = openTestSession(gcs);
    line(t, [40, 25], [10, 10]);
    const d = place(t, 'dimensionX', [25, 17.5], [25, 0]);
    expect(rounded(d)).toEqual({
      lines: [
        [
          [10, 10],
          [10, 0],
        ],
        [
          [40, 25],
          [40, 0],
        ],
        [
          [10, 0],
          [40, 0],
        ],
      ],
      arrows: [
        { at: [10, 0], dir: [-1, 0], span: 30 },
        { at: [40, 0], dir: [1, 0], span: 30 },
      ],
    });
  });

  it('a diameter across the circle toward the label, a radius from the centre', () => {
    const t = openTestSession(gcs);
    t.session.setTool('circle');
    t.click(20, 20);
    t.click(26, 20);
    const diameter = rounded(place(t, 'dimension', [26, 20], [40, 40]));
    const k = Math.SQRT1_2;
    expect(diameter).toEqual(
      rounded({
        lines: [
          [
            [20 - 6 * k, 20 - 6 * k],
            [40, 40],
          ],
        ],
        arrows: [
          { at: [20 + 6 * k, 20 + 6 * k], dir: [k, k], span: 12 },
          { at: [20 - 6 * k, 20 - 6 * k], dir: [-k, -k], span: 12 },
        ],
      }),
    );

    t.session.setTool('arc');
    t.click(90, 10);
    t.click(70, 10);
    t.click(80, 20);
    expect(rounded(place(t, 'dimension', [80, 20], [80, 15]))).toEqual({
      lines: [
        [
          [80, 10],
          [80, 20],
        ],
      ],
      arrows: [{ at: [80, 20], dir: [0, 1], span: Infinity }],
    });
  });

  it('an angle: an arc about where the lines cross, through the label on its bisector, with arrows along the arc', () => {
    const t = openTestSession(gcs);
    line(t, [10, 60], [50, 60]);
    line(t, [10, 70], [40, 100]);
    const d = place(t, 'dimension', [30, 60], [25, 85]);
    // The lines cross at (0, 60); the label is as far out as the lines' middles, at 22.5 degrees.
    const radius = Math.hypot(27.5, 12.5);
    const half = Math.PI / 8;
    const row = rowsOf(t.inputs(), 'constraints').at(-1) as Json;
    expect(r(t.session.labels().find((l) => l.id === row.id)?.at)).toEqual(
      r([radius * Math.cos(half), 60 + radius * Math.sin(half), 0]),
    );
    // Both lines reach the arc, so the arc is all there is.
    expect(d?.lines).toHaveLength(1);
    const arc = d?.lines[0] as P2[];
    expect(r(arc[0])).toEqual(r([radius, 60]));
    expect(r(arc.at(-1))).toEqual(r([radius * Math.SQRT1_2, 60 + radius * Math.SQRT1_2]));
    for (const p of arc) expect(Math.hypot(p[0], p[1] - 60)).toBeCloseTo(radius, 9);
    expect(rounded(d)?.arrows.map((a) => a.dir)).toEqual(
      r([
        [0, -1],
        [-Math.SQRT1_2, Math.SQRT1_2],
      ]),
    );
  });

  it('an angle to a line that stops short of the arc extends that line out to it', () => {
    const t = openTestSession(gcs);
    line(t, [10, 60], [50, 60]);
    line(t, [10, 70], [40, 100]);
    place(t, 'dimension', [30, 60], [25, 85]);
    const row = rowsOf(t.inputs(), 'constraints').at(-1) as Json;
    const d = dimensionLines(t.session.shown, { ...row, label: { at: { p: [80, 70] } } });
    const radius = Math.hypot(80, 10);
    // The first line ends at x = 50, short of the arc.
    expect(rounded(d)?.lines[0]).toEqual(
      r([
        [50, 60],
        [radius, 60],
      ]),
    );
    expect(d?.lines).toHaveLength(3);
  });
});

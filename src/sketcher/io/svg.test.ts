import { seededIds } from '@tweakcad/editor';
import { prepareCurve, type CurveShape } from '@tweakcad/format';
import { describe, expect, it } from 'vitest';
import type { SketchGeometry } from '../geometry';
import { RowMaker } from '../rows';
import { ImportRows } from './importRows';
import { bezierPieces, sketchToSvg } from './svg';
import { importSvg } from './svgImport';
import { described, geometryOf, imported, sameCurves } from './testRows';

/** An attribute's value at its first occurrence. */
function attr(svg: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(svg)?.[1] ?? null;
}

function sketch(build: (rows: ImportRows, make: RowMaker) => void): SketchGeometry {
  const make = new RowMaker(seededIds(3));
  const rows = new ImportRows(make);
  build(rows, make);
  return geometryOf(rows.points, rows.curves);
}

describe('sketchToSvg', () => {
  it('writes a valid empty svg for an empty sketch', () => {
    const svg = sketchToSvg(sketch(() => undefined));
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 1 1"');
    expect(svg).toContain('</svg>');
  });

  it('writes a <line> with y flipped', () => {
    // Bounds x [-1, 11], y [-1, 1] with the margin: maxY 1, so y 0 is written 1.
    const svg = sketchToSvg(sketch((r) => r.line([0, 0], [10, 0])));
    expect([attr(svg, 'x1'), attr(svg, 'y1'), attr(svg, 'x2'), attr(svg, 'y2')]).toEqual(['0', '1', '10', '1']);
  });

  it('gives a higher sketch point a smaller svg y', () => {
    const svg = sketchToSvg(sketch((r) => r.line([0, 0], [0, 10])));
    expect([attr(svg, 'y1'), attr(svg, 'y2')]).toEqual(['11', '1']);
  });

  it('writes a <circle> with its centre flipped', () => {
    const svg = sketchToSvg(sketch((r) => r.circle([5, 5], 2)));
    expect([attr(svg, 'cx'), attr(svg, 'cy'), attr(svg, 'r')]).toEqual(['5', '3', '2']);
  });

  it('writes an arc as a <path> A command with sweep flag 0', () => {
    const svg = sketchToSvg(sketch((r) => r.arc([0, 0], [10, 0], [0, 10])));
    expect(attr(svg, 'd')).toBe('M 10 11 A 10 10 0 0 0 0 1');
  });

  it('sets the large-arc flag for an arc of more than half a turn', () => {
    const svg = sketchToSvg(sketch((r) => r.arc([0, 0], [0, 10], [10, 0])));
    expect(attr(svg, 'd')).toMatch(/A 10 10 0 1 0 /);
  });

  it('bounds an arc by the quadrant points it passes', () => {
    // From 0 to 90 degrees: x [0, 10], y [0, 10], so 12 by 12 with the margin.
    const svg = sketchToSvg(sketch((r) => r.arc([0, 0], [10, 0], [0, 10])));
    expect(attr(svg, 'viewBox')).toBe('-1 0 12 12');
  });

  it('writes an <ellipse> with a rotate transform, the rotation negated', () => {
    const svg = sketchToSvg(sketch((r) => r.ellipse([0, 0], [0, 4], 2)));
    expect([attr(svg, 'rx'), attr(svg, 'ry')]).toEqual(['4', '2']);
    expect(attr(svg, 'transform')).toMatch(/^rotate\(-90 /);
  });

  it('writes an elliptical arc as a <path> A command', () => {
    const svg = sketchToSvg(sketch((r) => r.ellipticalArc([0, 0], [4, 0], 2, [4, 0], [0, 2])));
    expect(attr(svg, 'd')).toMatch(/^M 4 \S+ A 4 2 0 0 0 0 \S+$/);
  });

  it('writes a bezier as a C command and a spline as its Bézier pieces', () => {
    expect(attr(sketchToSvg(sketch((r) => r.bezier([0, 0], [0, 10], [20, 10], [20, 0]))), 'd')).toBe(
      'M 0 11 C 0 1 20 1 20 11',
    );
    const spline = sketchToSvg(
      sketch((r) =>
        r.spline([
          [0, 0],
          [5, 5],
          [10, 0],
          [15, 5],
          [20, 0],
        ]),
      ),
    );
    expect(attr(spline, 'd')?.match(/C/g)).toHaveLength(2);
  });

  it('writes a conic of rho 1/2 as a Q command and a rational curve as a <polyline>', () => {
    expect(attr(sketchToSvg(sketch((r) => r.conic([0, 0], [5, 10], [10, 0], 0.5))), 'd')).toMatch(/^M \S+ \S+ Q /);
    expect(sketchToSvg(sketch((r) => r.conic([0, 0], [5, 10], [10, 0], 0.3)))).toContain('<polyline');
  });

  it('writes a glyph contour as a closed path of its segments', () => {
    const contour: CurveShape = {
      kind: 'contour',
      segments: [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [10, 0],
          [10, 5],
          [0, 5],
        ],
        [
          [0, 5],
          [-2, 4],
          [-2, 1],
          [0, 0],
        ],
      ],
    };
    const geometry = {
      curves: new Map([['crv_g', { construction: false, kind: 'glyph', shape: contour }]]),
    } as unknown as SketchGeometry;
    expect(attr(sketchToSvg(geometry), 'd')).toMatch(/^M 0 \S+ L \S+ \S+ Q .* C .* Z$/);
  });

  it('sizes the viewBox to the bounds in mm', () => {
    const svg = sketchToSvg(sketch((r) => r.line([0, 0], [10, 20])));
    expect(svg).toContain('width="12mm"');
    expect(svg).toContain('height="22mm"');
    expect(attr(svg, 'viewBox')).toBe('-1 0 12 22');
  });

  it('leaves out construction curves and point curves', () => {
    const svg = sketchToSvg(
      sketch((r, make) => {
        r.curves.push(make.line(r.free([0, 0]), r.free([10, 0]), true), make.pointCurve(r.free([1, 2])));
      }),
    );
    expect(svg).not.toContain('<line');
    expect(svg).toContain('viewBox="0 0 1 1"');
  });
});

describe('bezierPieces', () => {
  it('splits a clamped cubic at its inner knots without changing it', () => {
    const shape: Extract<CurveShape, { kind: 'nurbs' }> = {
      kind: 'nurbs',
      degree: 3,
      poles: [
        [0, 0],
        [1, 3],
        [3, 4],
        [5, 1],
        [7, 2],
        [9, 0],
      ],
      weights: [1, 1, 1, 1, 1, 1],
      knots: [0, 0.3, 0.6, 1],
      multiplicities: [4, 1, 1, 4],
      periodic: false,
    };
    const pieces = bezierPieces(shape) as [number, number][][];
    expect(pieces).toHaveLength(3);
    const curve = prepareCurve(shape, false);
    const spans = [
      [0, 0.3],
      [0.3, 0.6],
      [0.6, 1],
    ] as const;
    pieces.forEach((piece, i) => {
      const [a, b] = spans[i] as readonly [number, number];
      for (const s of [0, 0.25, 0.5, 1]) {
        const t = 1 - s;
        const bez = [0, 1].map(
          (k) =>
            t ** 3 * piece[0]![k]! +
            3 * t * t * s * piece[1]![k]! +
            3 * t * s * s * piece[2]![k]! +
            s ** 3 * piece[3]![k]!,
        );
        const p = curve!.point(a + (b - a) * s);
        expect(bez[0]).toBeCloseTo(p[0], 9);
        expect(bez[1]).toBeCloseTo(p[1], 9);
      }
    });
  });
});

describe('SVG round trip', () => {
  it('keeps kinds and coordinates through export and import, moved so the bottom edge is on the x axis', () => {
    const make = new RowMaker(seededIds(3));
    const rows = new ImportRows(make);
    rows.line([0, 0], [10, 20]);
    rows.arc([10, 10], [10, 20], [0, 10]);
    rows.circle([5, 6], 4);
    rows.ellipse([1, 1], [5, 1], 2);
    rows.ellipticalArc([30, 0], [30, 6], 2, [28, 0], [30, 6]);
    rows.bezier([0, 0], [-5, -5], [-10, 5], [-15, 0]);
    rows.conic([40, 0], [45, 10], [50, 0], 0.5);
    const svg = sketchToSvg(geometryOf(rows.points, rows.curves));
    const back = imported(importSvg(svg, new RowMaker(seededIds(4))));
    // Bounds: the elliptical arc's whole ellipse reaches y -6, the margin 1 more.
    sameCurves(described(rows.points, rows.curves), described(back.points, back.curves), [0, 7]);
    expect(back.points).toHaveLength(rows.points.length);
  });
});

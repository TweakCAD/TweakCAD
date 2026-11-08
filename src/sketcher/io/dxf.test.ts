import { seededIds } from '@tweakcad/editor';
import type { CurveShape } from '@tweakcad/format';
import { describe, expect, it } from 'vitest';
import type { SketchGeometry } from '../geometry';
import { RowMaker, type Json } from '../rows';
import { sketchToDxf } from './dxf';
import { importDxf } from './dxfImport';
import { ImportRows } from './importRows';
import { described, geometryOf, imported, sameCurves } from './testRows';

/** "code\nvalue" lines as [code, value] pairs. */
function pairs(dxf: string): [number, string][] {
  const lines = dxf.split('\n');
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1] as string]);
  return out;
}

/** The pairs of the `n`th entity of `type`, after its type. */
function entity(dxf: string, type: string, n = 0): [number, string][] {
  const ps = pairs(dxf);
  let start = -1;
  for (let seen = -1; seen < n; seen++) start = ps.findIndex(([c, v], i) => i > start && c === 0 && v === type);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = ps.findIndex(([c], i) => i > start && c === 0);
  return ps.slice(start + 1, end);
}

const first = (e: [number, string][], code: number) => Number(e.find(([c]) => c === code)?.[1]);
const all = (e: [number, string][], code: number) => e.filter(([c]) => c === code).map(([, v]) => Number(v));

function sketch(build: (rows: ImportRows, make: RowMaker) => void): SketchGeometry {
  const make = new RowMaker(seededIds(3));
  const rows = new ImportRows(make);
  build(rows, make);
  return geometryOf(rows.points, rows.curves);
}

describe('sketchToDxf', () => {
  it('writes a HEADER with mm units, an ENTITIES section and EOF', () => {
    const dxf = sketchToDxf(sketch(() => undefined));
    const ps = pairs(dxf);
    const units = ps.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
    expect(ps[units + 1]).toEqual([70, '4']);
    expect(dxf).toContain('ENTITIES');
    expect(dxf).not.toContain('LINE');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('writes a line from 10/20 to 11/21', () => {
    const e = entity(sketchToDxf(sketch((r) => r.line([0, 0], [10, 20]))), 'LINE');
    expect([first(e, 10), first(e, 20), first(e, 11), first(e, 21)]).toEqual([0, 0, 10, 20]);
  });

  it('writes a circle with its radius', () => {
    const e = entity(sketchToDxf(sketch((r) => r.circle([5, 6], 4))), 'CIRCLE');
    expect([first(e, 10), first(e, 20), first(e, 40)]).toEqual([5, 6, 4]);
  });

  it('writes an arc with its angles in degrees, counter-clockwise', () => {
    const e = entity(sketchToDxf(sketch((r) => r.arc([0, 0], [0, 10], [-10, 0]))), 'ARC');
    expect(first(e, 40)).toBe(10);
    expect(first(e, 50)).toBeCloseTo(90, 9);
    expect(first(e, 51)).toBeCloseTo(180, 9);
  });

  it('writes a closed arc as a circle', () => {
    const geometry = sketch((r, make) => {
      const [c, p] = [r.free([0, 0]), r.free([3, 0])];
      r.curves.push(make.arc(c, p, p));
    });
    expect(first(entity(sketchToDxf(geometry), 'CIRCLE'), 40)).toBe(3);
  });

  it('writes an ellipse with its major axis relative to the centre and its axis ratio', () => {
    const e = entity(sketchToDxf(sketch((r) => r.ellipse([1, 1], [5, 1], 2))), 'ELLIPSE');
    expect([first(e, 10), first(e, 20), first(e, 11), first(e, 21), first(e, 40)]).toEqual([1, 1, 4, 0, 0.5]);
    expect([first(e, 41), first(e, 42)]).toEqual([0, 2 * Math.PI]);
  });

  it('writes an elliptical arc with its start and end parameters', () => {
    const e = entity(sketchToDxf(sketch((r) => r.ellipticalArc([0, 0], [4, 0], 2, [0, 2], [4, 0]))), 'ELLIPSE');
    expect(first(e, 41)).toBeCloseTo(Math.PI / 2, 12);
    expect(first(e, 42)).toBeCloseTo(2 * Math.PI, 12);
  });

  it('writes a nurbs curve as a SPLINE with its flat knots and weights', () => {
    const geometry = sketch((r) =>
      r.nurbs({
        degree: 2,
        poles: [
          [0, 0],
          [1, 1],
          [2, 0],
          [3, 1],
        ],
        weights: [1, 2, 1, 1],
        knots: [0, 0.5, 1],
        multiplicities: [3, 1, 3],
      }),
    );
    const e = entity(sketchToDxf(geometry), 'SPLINE');
    expect(first(e, 70)).toBe(12);
    expect([first(e, 71), first(e, 72), first(e, 73)]).toEqual([2, 7, 4]);
    expect(all(e, 40)).toEqual([0, 0, 0, 0.5, 1, 1, 1]);
    expect(all(e, 41)).toEqual([1, 2, 1, 1]);
    expect(all(e, 10)).toEqual([0, 1, 2, 3]);
  });

  it('writes a bezier as a polynomial cubic SPLINE', () => {
    const e = entity(sketchToDxf(sketch((r) => r.bezier([0, 0], [0, 10], [20, 10], [20, 0]))), 'SPLINE');
    expect([first(e, 70), first(e, 71), first(e, 73)]).toEqual([8, 3, 4]);
    expect(all(e, 40)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(all(e, 41)).toEqual([]);
  });

  it('writes a glyph contour segment by segment', () => {
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
    const dxf = sketchToDxf(geometry);
    expect(entity(dxf, 'LINE')).toBeDefined();
    expect(first(entity(dxf, 'SPLINE', 0), 71)).toBe(2);
    expect(first(entity(dxf, 'SPLINE', 1), 71)).toBe(3);
  });

  it('leaves out construction curves and point curves', () => {
    const geometry = sketch((r, make) => {
      r.curves.push(make.line(r.free([0, 0]), r.free([1, 1]), true), make.pointCurve(r.free([3, 3])));
    });
    const dxf = sketchToDxf(geometry);
    expect(dxf).not.toContain('LINE');
    expect(dxf).not.toContain('POINT');
  });

  it('writes several curves in one ENTITIES section', () => {
    const dxf = sketchToDxf(
      sketch((r) => {
        r.line([0, 0], [1, 0]);
        r.circle([0, 0], 2);
      }),
    );
    expect(pairs(dxf).filter(([c, v]) => c === 0 && (v === 'LINE' || v === 'CIRCLE'))).toHaveLength(2);
  });
});

describe('DXF round trip', () => {
  it('keeps every kind and coordinate through export and import', () => {
    const make = new RowMaker(seededIds(3));
    const rows = new ImportRows(make);
    rows.line([0, 0], [10, 20]);
    rows.arc([10, 10], [10, 20], [0, 10]);
    rows.circle([5, 6], 4);
    rows.ellipse([1, 1], [5, 1], 2);
    rows.ellipticalArc([30, 0], [30, 6], 2, [28, 0], [30, 6]);
    rows.bezier([0, 0], [-5, -5], [-10, 5], [-15, 0]);
    rows.conic([40, 0], [45, 10], [50, 0], 0.3);
    rows.nurbs({
      degree: 3,
      poles: [
        [60, 0],
        [62, 5],
        [65, 5],
        [67, 0],
        [70, 3],
      ],
      weights: [1, 1, 3, 1, 1],
      knots: [0, 1, 2],
      multiplicities: [4, 1, 4],
    });
    const dxf = sketchToDxf(geometryOf(rows.points, rows.curves));
    const back = imported(importDxf(dxf, new RowMaker(seededIds(4))));
    sameCurves(described(rows.points, rows.curves), described(back.points, back.curves));
    expect(back.points).toHaveLength(rows.points.length);
    expect(back.numbers((back.ofKind('conic')[0] as Json).rho)[0]).toBeCloseTo(0.3, 12);
    const nurbs = back.ofKind('nurbs')[0] as Json;
    expect(back.numbers(nurbs.knots)).toEqual([0, 1, 2]);
    expect(back.numbers(nurbs.weights)).toEqual([1, 1, 3, 1, 1]);
  });
});

import { ValueEvaluator } from '@tweakcad/format';
import { Editor, seededIds } from '@tweakcad/editor';
import { describe, expect, it } from 'vitest';
import { SketchGeometry } from '../geometry';
import { RowMaker, sketchInputs, type Json } from '../rows';
import { readsClean, sketchDocument } from '../testKit';
import { sketchToDxf } from './dxf';
import { importDxf } from './dxfImport';
import { MERGE_EPSILON_MM } from './importRows';
import { described, imported, sameCurves } from './testRows';

const make = () => new RowMaker(seededIds(3));
const read = (text: string) => imported(importDxf(text, make()));

/** A DXF whose ENTITIES section holds the given group codes and values. */
function dxfWith(...pairs: (string | number)[]): string {
  return ['0', 'SECTION', '2', 'ENTITIES', ...pairs.map(String), '0', 'ENDSEC', '0', 'EOF'].join('\n');
}

function withUnits(insunits: number, ...pairs: (string | number)[]): string {
  return [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$INSUNITS',
    '70',
    String(insunits),
    '0',
    'ENDSEC',
    dxfWith(...pairs),
  ].join('\n');
}

describe('importDxf', () => {
  it('reads a LINE from 10/20 to 11/21', () => {
    const r = read(dxfWith(0, 'LINE', 8, 0, 10, 1, 20, 2, 11, 3, 21, 4));
    expect(r.kinds()).toEqual(['line']);
    const [line] = r.curves as [Json];
    expect(r.at(line.start)).toEqual([1, 2]);
    expect(r.at(line.end)).toEqual([3, 4]);
    expect(line).toMatchObject({ origin: { drawn: {} } });
  });

  it('labels the change and adds no constraints', () => {
    const { change } = importDxf(dxfWith(0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 0), make());
    expect(change.label).toBe('Import DXF');
    expect(change.add?.constraints).toBeUndefined();
  });

  it('reads a CIRCLE as centre and radius', () => {
    const r = read(dxfWith(0, 'CIRCLE', 10, 5, 20, 6, 40, 7));
    const [c] = r.curves as [Json];
    expect(c.kind).toBe('circle');
    expect(r.at(c.center)).toEqual([5, 6]);
    expect(c.radius).toBe(7);
  });

  it('reads an ARC counter-clockwise from its start angle to its end angle, in degrees', () => {
    const r = read(dxfWith(0, 'ARC', 10, 0, 20, 0, 40, 10, 50, 0, 51, 90));
    const [a] = r.curves as [Json];
    expect(a.kind).toBe('arc');
    expect(r.at(a.center)).toEqual([0, 0]);
    expect(r.at(a.start)[0]).toBeCloseTo(10, 9);
    expect(r.at(a.start)[1]).toBeCloseTo(0, 9);
    expect(r.at(a.end)[0]).toBeCloseTo(0, 9);
    expect(r.at(a.end)[1]).toBeCloseTo(10, 9);
  });

  it('reads an ARC of a full turn as a circle', () => {
    expect(read(dxfWith(0, 'ARC', 10, 0, 20, 0, 40, 3, 50, 0, 51, 360)).kinds()).toEqual(['circle']);
  });

  it('mirrors an ARC whose extrusion is -Z into the sketch frame', () => {
    const r = read(dxfWith(0, 'ARC', 10, 10, 20, 0, 40, 10, 50, 0, 51, 90, 210, 0, 220, 0, 230, -1));
    const [a] = r.curves as [Json];
    expect(r.at(a.center)).toEqual([-10, 0]);
    // Clockwise from (-20, 0) to (-10, 10), so counter-clockwise the other way.
    expect(r.at(a.start)[0]).toBeCloseTo(-10, 9);
    expect(r.at(a.start)[1]).toBeCloseTo(10, 9);
    expect(r.at(a.end)[0]).toBeCloseTo(-20, 9);
    expect(r.at(a.end)[1]).toBeCloseTo(0, 9);
  });

  it('decodes an ELLIPSE: the major axis relative to the centre and the axis ratio', () => {
    const r = read(dxfWith(0, 'ELLIPSE', 10, 1, 20, 1, 11, 4, 21, 0, 40, 0.5));
    const [e] = r.curves as [Json];
    expect(e.kind).toBe('ellipse');
    expect(r.at(e.center)).toEqual([1, 1]);
    expect(r.at(e.majorEnd)).toEqual([5, 1]);
    expect(e.minorRadius).toBeCloseTo(2, 9);
  });

  it('reads a partial ELLIPSE as an elliptical arc between its parameters', () => {
    const r = read(dxfWith(0, 'ELLIPSE', 10, 1, 20, 1, 11, 4, 21, 0, 40, 0.5, 41, 0, 42, Math.PI / 2));
    const [e] = r.curves as [Json];
    expect(e.kind).toBe('ellipticalArc');
    expect(r.at(e.start)).toEqual([5, 1]);
    expect(r.at(e.end)[0]).toBeCloseTo(1, 9);
    expect(r.at(e.end)[1]).toBeCloseTo(3, 9);
  });

  it('writes the longer axis of an ellipse as its major axis', () => {
    const r = read(dxfWith(0, 'ELLIPSE', 10, 0, 20, 0, 11, 2, 21, 0, 40, 2));
    const [e] = r.curves as [Json];
    expect(r.at(e.majorEnd)[0]).toBeCloseTo(0, 9);
    expect(r.at(e.majorEnd)[1]).toBeCloseTo(4, 9);
    expect(e.minorRadius).toBeCloseTo(2, 9);
  });

  it('expands a closed LWPOLYLINE into lines that share their corners', () => {
    const r = read(dxfWith(0, 'LWPOLYLINE', 90, 3, 70, 1, 10, 0, 20, 0, 10, 10, 20, 0, 10, 0, 20, 10));
    expect(r.kinds()).toEqual(['line', 'line', 'line']);
    expect(r.points).toHaveLength(3);
    const lines = r.curves;
    lines.forEach((l, i) => expect(l.end).toBe((lines[(i + 1) % 3] as Json).start));
    expect(r.at((lines[2] as Json).end)).toEqual([0, 0]);
  });

  it('expands an open LWPOLYLINE into one line fewer than its vertices', () => {
    expect(read(dxfWith(0, 'LWPOLYLINE', 90, 3, 70, 0, 10, 0, 20, 0, 10, 10, 20, 0, 10, 0, 20, 10)).kinds()).toEqual([
      'line',
      'line',
    ]);
  });

  it('reads a bulged LWPOLYLINE segment as an arc, the bulge its own vertex’s', () => {
    // Only the second vertex has a bulge: its segment, (10, 0) to (10, 10), is a counter-clockwise half turn.
    const r = read(dxfWith(0, 'LWPOLYLINE', 90, 3, 70, 0, 10, 0, 20, 0, 10, 10, 20, 0, 42, 1, 10, 10, 20, 10));
    expect(r.kinds()).toEqual(['line', 'arc']);
    const arc = r.curves[1] as Json;
    expect(r.at(arc.center)[0]).toBeCloseTo(10, 9);
    expect(r.at(arc.center)[1]).toBeCloseTo(5, 9);
    expect(r.at(arc.start)).toEqual([10, 0]);
    expect(r.at(arc.end)).toEqual([10, 10]);
    expect(arc.start).toBe((r.curves[0] as Json).end);
  });

  it('reads a clockwise bulge as the counter-clockwise arc the other way', () => {
    const r = read(dxfWith(0, 'LWPOLYLINE', 90, 2, 70, 0, 10, 0, 20, 0, 42, -1, 10, 10, 20, 0));
    const [arc] = r.curves as [Json];
    expect(r.at(arc.start)).toEqual([10, 0]);
    expect(r.at(arc.end)).toEqual([0, 0]);
  });

  it('reads an old-style POLYLINE and its VERTEX run', () => {
    const r = read(
      dxfWith(
        0,
        'POLYLINE',
        70,
        0,
        0,
        'VERTEX',
        10,
        0,
        20,
        0,
        0,
        'VERTEX',
        10,
        5,
        20,
        0,
        0,
        'SEQEND',
        0,
        'LINE',
        10,
        9,
        20,
        9,
        11,
        8,
        21,
        8,
      ),
    );
    expect(r.kinds()).toEqual(['line', 'line']);
    const [first] = r.curves as [Json];
    expect([r.at(first.start), r.at(first.end)]).toEqual([
      [0, 0],
      [5, 0],
    ]);
  });

  it('skips polyface meshes', () => {
    const r = imported(
      importDxf(
        dxfWith(0, 'POLYLINE', 70, 64, 0, 'VERTEX', 10, 0, 20, 0, 0, 'VERTEX', 10, 5, 20, 0, 0, 'SEQEND'),
        make(),
      ),
    );
    expect(r.curves).toEqual([]);
    expect(importDxf(dxfWith(0, 'POLYLINE', 70, 64, 0, 'SEQEND'), make()).skipped).toEqual(['POLYLINE']);
  });

  it('reads a SPLINE as a nurbs row over its control points, knots and weights', () => {
    const r = read(
      dxfWith(
        0,
        'SPLINE',
        70,
        12,
        71,
        3,
        72,
        9,
        73,
        5,
        74,
        0,
        ...[0, 0, 0, 0, 0.5, 1, 1, 1, 1].flatMap((k) => [40, k]),
        ...[1, 2, 1, 1, 1].flatMap((w) => [41, w]),
        ...[
          [0, 0],
          [1, 2],
          [3, 3],
          [5, 1],
          [6, 0],
        ].flatMap(([x, y]) => [10, x as number, 20, y as number, 30, 0]),
      ),
    );
    const [n] = r.curves as [Json];
    expect(n.kind).toBe('nurbs');
    expect((n.poles as string[]).map(r.at)).toEqual([
      [0, 0],
      [1, 2],
      [3, 3],
      [5, 1],
      [6, 0],
    ]);
    expect(r.numbers(n.degree)).toEqual([3]);
    expect(r.numbers(n.knots)).toEqual([0, 0.5, 1]);
    expect(n.multiplicities).toEqual([4, 1, 4]);
    expect(r.numbers(n.weights)).toEqual([1, 2, 1, 1, 1]);
    expect(n.periodic).toMatchObject({ def: { expr: { text: 'false' } } });
  });

  it('gives a SPLINE without knots clamped, evenly spaced ones', () => {
    const r = read(
      dxfWith(
        0,
        'SPLINE',
        71,
        3,
        ...[
          [0, 0],
          [1, 2],
          [3, 1],
          [4, 4],
          [6, 0],
        ].flatMap(([x, y]) => [10, x as number, 20, y as number]),
      ),
    );
    const [n] = r.curves as [Json];
    expect(r.numbers(n.knots)).toEqual([0, 0.5, 1]);
    expect(n.multiplicities).toEqual([4, 1, 4]);
  });

  it('reads a single-span SPLINE as the bezier or conic it is', () => {
    const cubic = read(
      dxfWith(
        0,
        'SPLINE',
        71,
        3,
        ...[0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => [40, k]),
        ...[
          [0, 0],
          [1, 2],
          [3, 2],
          [4, 0],
        ].flatMap(([x, y]) => [10, x as number, 20, y as number]),
      ),
    );
    expect(cubic.kinds()).toEqual(['bezier']);
    const b = cubic.curves[0] as Json;
    expect([b.start, b.c1, b.c2, b.end].map(cubic.at)).toEqual([
      [0, 0],
      [1, 2],
      [3, 2],
      [4, 0],
    ]);
    // Three control points and no knots: a quadratic, the conic with rho 1/2.
    const quadratic = read(dxfWith(0, 'SPLINE', 71, 3, 10, 0, 20, 0, 10, 1, 20, 2, 10, 3, 20, 1));
    const c = quadratic.curves[0] as Json;
    expect(c.kind).toBe('conic');
    expect([c.start, c.apex, c.end].map(quadratic.at)).toEqual([
      [0, 0],
      [1, 2],
      [3, 1],
    ]);
    expect(quadratic.numbers(c.rho)).toEqual([0.5]);
  });

  it('reads a SPLINE of fit points only as a spline through them', () => {
    const r = read(dxfWith(0, 'SPLINE', 71, 3, 74, 3, 11, 0, 21, 0, 11, 5, 21, 5, 11, 10, 21, 0));
    const [s] = r.curves as [Json];
    expect(s.kind).toBe('spline');
    expect((s.through as string[]).map(r.at)).toEqual([
      [0, 0],
      [5, 5],
      [10, 0],
    ]);
  });

  it('reports each unsupported entity type once', () => {
    const result = importDxf(
      dxfWith(0, 'TEXT', 1, 'hi', 0, 'TEXT', 1, 'again', 0, 'HATCH', 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1),
      make(),
    );
    expect(result.change.add?.curves).toHaveLength(1);
    expect([...result.skipped].sort()).toEqual(['HATCH', 'TEXT']);
  });

  it('reads only the ENTITIES section', () => {
    const text = withUnits(4, 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1).replace(
      '0\nSECTION\n2\nENTITIES',
      '0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nB\n0\nCIRCLE\n10\n0\n20\n0\n40\n1\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES',
    );
    const result = importDxf(text, make());
    expect(imported(result).kinds()).toEqual(['line']);
    expect(result.skipped).toEqual([]);
  });

  it('skips degenerate entities', () => {
    expect(
      read(
        dxfWith(
          0,
          'CIRCLE',
          10,
          0,
          20,
          0,
          40,
          0,
          0,
          'LINE',
          10,
          0,
          20,
          0,
          11,
          1,
          21,
          1,
          0,
          'LINE',
          10,
          2,
          20,
          2,
          11,
          2,
          21,
          2,
        ),
      ).kinds(),
    ).toEqual(['line']);
  });
});

describe('importDxf units', () => {
  it('scales an inch drawing to mm', () => {
    const r = read(withUnits(1, 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 0));
    expect(r.at((r.curves[0] as Json).end)[0]).toBeCloseTo(25.4, 9);
  });

  it('leaves a mm or unitless drawing as it is', () => {
    expect((read(withUnits(4, 0, 'CIRCLE', 10, 0, 20, 0, 40, 5)).curves[0] as Json).radius).toBe(5);
    expect((read(dxfWith(0, 'CIRCLE', 10, 0, 20, 0, 40, 3)).curves[0] as Json).radius).toBe(3);
  });

  it('scales metres to mm for lengths and leaves angles', () => {
    const r = read(withUnits(6, 0, 'ARC', 10, 0, 20, 0, 40, 2, 50, 0, 51, 90));
    const a = r.curves[0] as Json;
    expect(r.at(a.start)[0]).toBeCloseTo(2000, 6);
    expect(r.at(a.end)[0]).toBeCloseTo(0, 6);
    expect(r.at(a.end)[1]).toBeCloseTo(2000, 6);
  });

  it('scales every length unit DXF names', () => {
    const cases: [number, number][] = [
      [3, 1609344],
      [7, 1e6],
      [11, 1e-7],
      [12, 1e-6],
      [13, 1e-3],
      [14, 100],
      [15, 1e4],
      [16, 1e5],
      [21, 1200000 / 3937],
      [22, 100000 / 3937],
      [23, 3600000 / 3937],
      [24, 6336000000 / 3937],
    ];
    for (const [code, mm] of cases) {
      const r = read(withUnits(code, 0, 'LINE', 10, 0, 20, 0, 11, 1e7, 21, 0));
      expect(r.at((r.curves[0] as Json).end)[0] / 1e7 / mm).toBeCloseTo(1, 9);
    }
  });

  it('refuses a unit code DXF does not name', () => {
    expect(() => importDxf(withUnits(99, 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 0), make())).toThrow(/unit/);
  });
});

describe('importDxf shared ends', () => {
  it('makes two lines meeting at a point share it', () => {
    const r = read(dxfWith(0, 'LINE', 10, 0, 20, 0, 11, 10, 21, 0, 0, 'LINE', 10, 10, 20, 0, 11, 10, 21, 10));
    expect(r.points).toHaveLength(3);
    expect((r.curves[0] as Json).end).toBe((r.curves[1] as Json).start);
  });

  it('shares ends within MERGE_EPSILON_MM and keeps ends further apart', () => {
    const near = MERGE_EPSILON_MM / 2;
    const r = read(dxfWith(0, 'LINE', 10, 0, 20, 0, 11, 10, 21, 0, 0, 'LINE', 10, 10 + near, 20, near, 11, 10, 21, 10));
    expect(r.points).toHaveLength(3);
    const far = MERGE_EPSILON_MM * 3;
    expect(
      read(dxfWith(0, 'LINE', 10, 0, 20, 0, 11, 10, 21, 0, 0, 'LINE', 10, 10 + far, 20, 0, 11, 10, 21, 10)).points,
    ).toHaveLength(4);
  });

  it('shares arc and spline ends with lines, and keeps centres apart', () => {
    const r = read(
      dxfWith(
        0,
        'LINE',
        10,
        0,
        20,
        0,
        11,
        10,
        21,
        0,
        0,
        'ARC',
        10,
        0,
        20,
        0,
        40,
        10,
        50,
        0,
        51,
        90,
        0,
        'SPLINE',
        71,
        3,
        ...[0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => [40, k]),
        10,
        0,
        20,
        10,
        10,
        -3,
        20,
        8,
        10,
        -3,
        20,
        2,
        10,
        0,
        20,
        0,
      ),
    );
    expect(r.kinds()).toEqual(['line', 'arc', 'bezier']);
    const [line, arc, bezier] = r.curves as [Json, Json, Json];
    expect(arc.start).toBe(line.end);
    expect(bezier.start).toBe(arc.end);
    expect(bezier.end).toBe(line.start);
    expect(arc.center).not.toBe(line.start);
  });
});

describe('importDxf into a sketch', () => {
  const profile = dxfWith(
    0,
    'LWPOLYLINE',
    90,
    4,
    70,
    1,
    10,
    0,
    20,
    0,
    10,
    40,
    20,
    0,
    42,
    0.4142135623730951,
    10,
    40,
    20,
    20,
    10,
    0,
    20,
    20,
    0,
    'CIRCLE',
    10,
    10,
    20,
    10,
    40,
    4,
    0,
    'ELLIPSE',
    10,
    28,
    20,
    10,
    11,
    5,
    21,
    0,
    40,
    0.5,
    0,
    'ELLIPSE',
    10,
    60,
    20,
    10,
    11,
    0,
    21,
    6,
    40,
    0.5,
    41,
    0,
    42,
    3,
    0,
    'SPLINE',
    70,
    12,
    71,
    3,
    72,
    9,
    73,
    5,
    ...[0, 0, 0, 0, 0.5, 1, 1, 1, 1].flatMap((k) => [40, k]),
    ...[1, 2, 1, 1, 1].flatMap((w) => [41, w]),
    ...[
      [0, 30],
      [10, 40],
      [20, 30],
      [30, 40],
      [40, 30],
    ].flatMap(([x, y]) => [10, x as number, 20, y as number]),
    0,
    'SPLINE',
    71,
    2,
    ...[0, 0, 0, 1, 1, 1].flatMap((k) => [40, k]),
    ...[1, 3, 1].flatMap((w) => [41, w]),
    10,
    50,
    20,
    30,
    10,
    55,
    20,
    40,
    10,
    60,
    20,
    30,
    0,
    'SPLINE',
    71,
    3,
    ...[0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => [40, k]),
    10,
    70,
    20,
    30,
    10,
    72,
    20,
    40,
    10,
    78,
    20,
    40,
    10,
    80,
    20,
    30,
  );

  it('adds rows the format reads, and keeps kinds and coordinates through DXF export and import', () => {
    const { doc, part, feature } = sketchDocument();
    const editor = new Editor(doc, { ids: seededIds(7) });
    const { change } = importDxf(profile, new RowMaker((kind) => editor.newId(kind)));
    expect(imported({ change, skipped: [] }).kinds()).toEqual([
      'line',
      'arc',
      'line',
      'line',
      'circle',
      'ellipse',
      'ellipticalArc',
      'nurbs',
      'conic',
      'bezier',
    ]);
    const result = editor.dispatch({ type: 'editSketch', sketch: feature, add: change.add });
    expect(result.ok).toBe(true);
    expect(readsClean(editor)).toBe(true);

    const inputs = sketchInputs(editor.document, part, feature) as Json;
    const dxf = sketchToDxf(new SketchGeometry(inputs, new ValueEvaluator(editor.document)));
    const again = importDxf(dxf, make());
    const r = imported(again);
    sameCurves(described(inputs.points as Json[], inputs.curves as Json[]), described(r.points, r.curves));
    expect(r.points).toHaveLength((inputs.points as Json[]).length);
    const nurbs = r.ofKind('nurbs')[0] as Json;
    expect(r.numbers(nurbs.weights)).toEqual([1, 2, 1, 1, 1]);
    expect(r.numbers(r.ofKind('conic')[0]?.rho)[0]).toBeCloseTo(0.75, 12);
  });
});

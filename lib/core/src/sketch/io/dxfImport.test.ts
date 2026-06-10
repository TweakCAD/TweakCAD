/**
 * Tests for the DXF import pipeline (`parseDxf` + `buildEditorStateFromPrimitives`).
 *
 * Pins:
 *   - LINE / CIRCLE / ARC / LWPOLYLINE / ELLIPSE parse to primitives with
 *     correct numeric values
 *   - arc angles convert DEGREES (group 50/51) → RADIANS
 *   - ellipse decodes group 11/21 (centre-relative major vector) + group 40
 *     (axis ratio) → center / absolute majorEnd / minorRadius
 *   - unsupported entity types are collected in `skipped`
 *   - round-trip: sketchToDxf(export) → parseDxf(import) preserves geometry
 *   - coincident-merge: two LINEs sharing an endpoint → one shared point
 */

import { describe, it, expect } from 'vitest';
import { parseDxf, buildEditorStateFromPrimitives, MERGE_EPSILON_MM } from './dxfImport.ts';
import { sketchToDxf } from './dxf.ts';
import { makeCounterIdFactory } from '../operations.ts';
import type { SketchEntity } from '../../document/schema.ts';
import { entityId } from '../../ids.ts';

/** Build a minimal ASCII DXF wrapping the given ENTITIES-section body. */
function dxfWith(body: string): string {
  return [
    '0', 'SECTION',
    '2', 'ENTITIES',
    body.trim(),
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

describe('parseDxf', () => {
  it('parses a LINE with start (10/20) and end (11/21)', () => {
    const dxf = dxfWith(['0', 'LINE', '8', '0', '10', '1', '20', '2', '11', '3', '21', '4'].join('\n'));
    const { primitives } = parseDxf(dxf);
    expect(primitives).toEqual([{ kind: 'line', start: [1, 2], end: [3, 4] }]);
  });

  it('parses a CIRCLE with center + radius', () => {
    const dxf = dxfWith(['0', 'CIRCLE', '10', '5', '20', '6', '40', '7'].join('\n'));
    const { primitives } = parseDxf(dxf);
    expect(primitives).toEqual([{ kind: 'circle', center: [5, 6], radius: 7 }]);
  });

  it('converts ARC start/end angle from degrees to radians', () => {
    const dxf = dxfWith(['0', 'ARC', '10', '0', '20', '0', '40', '10', '50', '0', '51', '90'].join('\n'));
    const { primitives } = parseDxf(dxf);
    expect(primitives).toHaveLength(1);
    const a = primitives[0]!;
    expect(a.kind).toBe('arc');
    if (a.kind !== 'arc') throw new Error('expected arc');
    expect(a.center).toEqual([0, 0]);
    expect(a.radius).toBe(10);
    expect(a.startAngle).toBeCloseTo(0, 9);
    expect(a.endAngle).toBeCloseTo(Math.PI / 2, 9); // 90° → π/2
  });

  it('decodes an ELLIPSE: centre-relative major vector + ratio → center/majorEnd/minorRadius', () => {
    // center (1,1), major vector (4,0) → majorEnd (5,1), majorR = 4.
    // ratio 0.5 → minorRadius = 2.
    const dxf = dxfWith(
      ['0', 'ELLIPSE', '10', '1', '20', '1', '11', '4', '21', '0', '40', '0.5'].join('\n'),
    );
    const { primitives } = parseDxf(dxf);
    expect(primitives).toHaveLength(1);
    const e = primitives[0]!;
    if (e.kind !== 'ellipse') throw new Error('expected ellipse');
    expect(e.center).toEqual([1, 1]);
    expect(e.majorEnd[0]).toBeCloseTo(5, 9);
    expect(e.majorEnd[1]).toBeCloseTo(1, 9);
    expect(e.minorRadius).toBeCloseTo(2, 9);
  });

  it('expands an LWPOLYLINE into line segments, honoring the closed flag', () => {
    // 3 vertices, closed (flag 1) → 3 line segments forming a triangle.
    const dxf = dxfWith(
      ['0', 'LWPOLYLINE', '90', '3', '70', '1',
        '10', '0', '20', '0',
        '10', '10', '20', '0',
        '10', '0', '20', '10'].join('\n'),
    );
    const { primitives } = parseDxf(dxf);
    expect(primitives).toHaveLength(3);
    expect(primitives.every((p) => p.kind === 'line')).toBe(true);
    // Closing segment goes back to the first vertex.
    const lines = primitives as Array<Extract<typeof primitives[number], { kind: 'line' }>>;
    expect(lines[2]!.end).toEqual([0, 0]);
  });

  it('expands an open LWPOLYLINE into N-1 segments (no closing edge)', () => {
    const dxf = dxfWith(
      ['0', 'LWPOLYLINE', '90', '3', '70', '0',
        '10', '0', '20', '0',
        '10', '10', '20', '0',
        '10', '0', '20', '10'].join('\n'),
    );
    const { primitives } = parseDxf(dxf);
    expect(primitives).toHaveLength(2);
  });

  it('parses an old-style POLYLINE + VERTEX run', () => {
    const dxf = dxfWith(
      ['0', 'POLYLINE', '70', '0',
        '0', 'VERTEX', '10', '0', '20', '0',
        '0', 'VERTEX', '10', '5', '20', '0',
        '0', 'SEQEND'].join('\n'),
    );
    const { primitives } = parseDxf(dxf);
    expect(primitives).toEqual([{ kind: 'line', start: [0, 0], end: [5, 0] }]);
  });

  it('parses a SPLINE from its control points', () => {
    const dxf = dxfWith(
      ['0', 'SPLINE', '71', '3',
        '10', '0', '20', '0',
        '10', '1', '20', '2',
        '10', '3', '20', '1'].join('\n'),
    );
    const { primitives } = parseDxf(dxf);
    expect(primitives).toHaveLength(1);
    const s = primitives[0]!;
    if (s.kind !== 'spline') throw new Error('expected spline');
    expect(s.points).toEqual([[0, 0], [1, 2], [3, 1]]);
  });

  it('collects unsupported entity types into skipped (de-duplicated)', () => {
    const dxf = dxfWith(
      ['0', 'TEXT', '1', 'hi',
        '0', 'TEXT', '1', 'again',
        '0', 'HATCH',
        '0', 'LINE', '10', '0', '20', '0', '11', '1', '21', '1'].join('\n'),
    );
    const { primitives, skipped } = parseDxf(dxf);
    expect(primitives).toHaveLength(1); // the LINE survived
    expect(skipped.sort()).toEqual(['HATCH', 'TEXT']);
  });

  it('ignores entities outside the ENTITIES section', () => {
    const dxf = [
      '0', 'SECTION', '2', 'HEADER',
      '9', '$INSUNITS', '70', '4',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '10', '0', '20', '0', '11', '1', '21', '1',
      '0', 'ENDSEC',
      '0', 'EOF',
    ].join('\n');
    const { primitives, skipped } = parseDxf(dxf);
    expect(primitives).toHaveLength(1);
    expect(skipped).toEqual([]);
  });
});

describe('parseDxf — $INSUNITS unit scaling', () => {
  function withHeaderUnits(insunits: string, body: string): string {
    return [
      '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', insunits, '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', body.trim(), '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
  }

  it('scales an inch drawing to mm (×25.4)', () => {
    const dxf = withHeaderUnits('1', ['0', 'LINE', '10', '0', '20', '0', '11', '1', '21', '0'].join('\n'));
    const { primitives, unitScale, unitName } = parseDxf(dxf);
    expect(unitScale).toBe(25.4);
    expect(unitName).toBe('inches');
    const line = primitives[0]!;
    if (line.kind !== 'line') throw new Error('expected line');
    expect(line.end[0]).toBeCloseTo(25.4, 9);
  });

  it('leaves a mm drawing unscaled (factor 1, no unitName)', () => {
    const dxf = withHeaderUnits('4', ['0', 'CIRCLE', '10', '0', '20', '0', '40', '5'].join('\n'));
    const { primitives, unitScale, unitName } = parseDxf(dxf);
    expect(unitScale).toBe(1);
    expect(unitName).toBeUndefined();
    const c = primitives[0]!;
    if (c.kind !== 'circle') throw new Error('expected circle');
    expect(c.radius).toBe(5);
  });

  it('treats a missing $INSUNITS as mm (factor 1)', () => {
    const dxf = dxfWith(['0', 'CIRCLE', '10', '0', '20', '0', '40', '3'].join('\n'));
    expect(parseDxf(dxf).unitScale).toBe(1);
  });

  it('scales metres to mm (×1000) for lengths but leaves angles untouched', () => {
    const dxf = withHeaderUnits('6', ['0', 'ARC', '10', '0', '20', '0', '40', '2', '50', '0', '51', '90'].join('\n'));
    const { primitives } = parseDxf(dxf);
    const a = primitives[0]!;
    if (a.kind !== 'arc') throw new Error('expected arc');
    expect(a.radius).toBeCloseTo(2000, 6);
    expect(a.startAngle).toBeCloseTo(0, 9);
    expect(a.endAngle).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('buildEditorStateFromPrimitives', () => {
  it('builds geometries for each primitive kind', () => {
    const state = buildEditorStateFromPrimitives(
      [
        { kind: 'line', start: [0, 0], end: [10, 0] },
        { kind: 'circle', center: [20, 20], radius: 5 },
        { kind: 'arc', center: [0, 0], radius: 4, startAngle: 0, endAngle: Math.PI / 2 },
      ],
      { idFactory: makeCounterIdFactory() },
    );
    const kinds = Array.from(state.geometries.values()).map((g) => g.type).sort();
    expect(kinds).toEqual(['arc', 'circle', 'line']);
  });

  it('joins two LINEs sharing an endpoint with a coincident constraint (distinct points)', () => {
    // L1: (0,0)→(10,0).  L2: (10,0)→(10,10).  The shared (10,0) junction is
    // two DISTINCT points joined by a removable coincident constraint — the
    // editor's canonical rectangle/polygon model, not a fused point.
    const state = buildEditorStateFromPrimitives(
      [
        { kind: 'line', start: [0, 0], end: [10, 0] },
        { kind: 'line', start: [10, 0], end: [10, 10] },
      ],
      { idFactory: makeCounterIdFactory() },
    );
    expect(state.geometries.size).toBe(2);
    // 4 distinct points — the junction is NOT collapsed.
    expect(state.points.size).toBe(4);
    const lines = Array.from(state.geometries.values()).filter((g) => g.type === 'line');
    const l1 = lines[0]!;
    const l2 = lines[1]!;
    if (l1.type !== 'line' || l2.type !== 'line') throw new Error('expected lines');
    expect(l1.endId).not.toBe(l2.startId);
    // Exactly one coincident constraint, linking the two junction points.
    const coincidents = Array.from(state.constraints.values()).filter((c) => c.type === 'coincident');
    expect(coincidents).toHaveLength(1);
    const c = coincidents[0]!;
    if (c.type !== 'coincident') throw new Error('expected coincident');
    expect(new Set([c.pointA, c.pointB])).toEqual(new Set([l1.endId, l2.startId]));
  });

  it('joins endpoints within MERGE_EPSILON_MM via a coincident constraint', () => {
    // Endpoints differ by less than the merge epsilon — still treated as a
    // junction (distinct points + one coincident constraint).
    const drift = MERGE_EPSILON_MM / 2;
    const state = buildEditorStateFromPrimitives([
      { kind: 'line', start: [0, 0], end: [10, 0] },
      { kind: 'line', start: [10 + drift, drift], end: [10, 10] },
    ], { idFactory: makeCounterIdFactory() });
    expect(state.points.size).toBe(4);
    const coincidents = Array.from(state.constraints.values()).filter((c) => c.type === 'coincident');
    expect(coincidents).toHaveLength(1);
  });

  it('skips degenerate primitives instead of throwing', () => {
    const state = buildEditorStateFromPrimitives([
      { kind: 'circle', center: [0, 0], radius: 0 }, // invalid radius
      { kind: 'line', start: [0, 0], end: [1, 1] },
    ], { idFactory: makeCounterIdFactory() });
    expect(state.geometries.size).toBe(1);
  });
});

describe('round-trip: sketchToDxf → parseDxf', () => {
  it('preserves a line + circle + arc within epsilon', () => {
    const entities: SketchEntity[] = [
      { id: entityId('l1'), type: 'line', start: ['0', '0'], end: ['10', '20'] },
      { id: entityId('c1'), type: 'circle', center: ['5', '6'], diameter: '8' },
      {
        id: entityId('a1'),
        type: 'arc',
        center: ['0', '0'],
        radius: '10',
        startAngle: '0',
        endAngle: String(Math.PI / 2),
      },
    ];
    const dxf = sketchToDxf(entities, {});
    const { primitives } = parseDxf(dxf);

    const line = primitives.find((p) => p.kind === 'line');
    if (line?.kind !== 'line') throw new Error('line lost');
    expect(line.start).toEqual([0, 0]);
    expect(line.end).toEqual([10, 20]);

    const circle = primitives.find((p) => p.kind === 'circle');
    if (circle?.kind !== 'circle') throw new Error('circle lost');
    expect(circle.center).toEqual([5, 6]);
    expect(circle.radius).toBeCloseTo(4, 9); // diameter 8 / 2

    const arc = primitives.find((p) => p.kind === 'arc');
    if (arc?.kind !== 'arc') throw new Error('arc lost');
    expect(arc.center).toEqual([0, 0]);
    expect(arc.radius).toBeCloseTo(10, 9);
    expect(arc.startAngle).toBeCloseTo(0, 9);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('preserves an ellipse (center/majorEnd/minorRadius) through export+import', () => {
    const entities: SketchEntity[] = [
      { id: entityId('e1'), type: 'ellipse', center: ['1', '1'], majorEnd: ['5', '1'], minorRadius: '2' },
    ];
    const dxf = sketchToDxf(entities, {});
    const { primitives } = parseDxf(dxf);
    const e = primitives.find((p) => p.kind === 'ellipse');
    if (e?.kind !== 'ellipse') throw new Error('ellipse lost');
    expect(e.center).toEqual([1, 1]);
    expect(e.majorEnd[0]).toBeCloseTo(5, 9);
    expect(e.majorEnd[1]).toBeCloseTo(1, 9);
    expect(e.minorRadius).toBeCloseTo(2, 9);
  });
});

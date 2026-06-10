/**
 * Tests for sketchToDxf — the pure sketch → ASCII DXF serializer.
 *
 * Pins:
 *   - native LINE / CIRCLE / ARC / ELLIPSE entities with correct group codes
 *   - arc angle conversion radians → degrees (group 50/51)
 *   - ellipse major-axis vector is relative to centre (group 11/21) and the
 *     axis ratio is minorRadius / majorRadius (group 40)
 *   - parametric Expression coords resolve through `params`
 *   - construction geometry and standalone points are excluded
 *   - empty input → valid DXF with HEADER + empty ENTITIES + EOF
 */

import { describe, it, expect } from 'vitest';
import { sketchToDxf } from './dxf.ts';
import type { SketchEntity } from '../../document/schema.ts';
import { entityId } from '../../ids.ts';

/** Parse "code\nvalue\ncode\nvalue…" into an ordered list of [code, value]. */
function pairs(dxf: string): Array<[number, string]> {
  const lines = dxf.split('\n');
  const out: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    out.push([Number(lines[i]), lines[i + 1]!]);
  }
  return out;
}

/** Group-code values for the first entity of `type` in the DXF. */
function entityCodes(dxf: string, type: string): Map<number, string> {
  const ps = pairs(dxf);
  const start = ps.findIndex(([c, v]) => c === 0 && v === type);
  expect(start).toBeGreaterThanOrEqual(0);
  const codes = new Map<number, string>();
  for (let i = start + 1; i < ps.length; i++) {
    if (ps[i]![0] === 0) break; // next entity
    if (!codes.has(ps[i]![0])) codes.set(ps[i]![0], ps[i]![1]);
  }
  return codes;
}

const line = (n: number): SketchEntity => ({
  id: entityId(`line${n}`),
  type: 'line',
  start: ['0', '0'],
  end: ['10', '20'],
});

describe('sketchToDxf', () => {
  it('emits a valid HEADER with mm units and EOF', () => {
    const dxf = sketchToDxf([], {});
    expect(dxf).toContain('SECTION');
    expect(dxf).toContain('$INSUNITS');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    // $INSUNITS = 4 (millimetres)
    const ps = pairs(dxf);
    const idx = ps.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(ps[idx + 1]).toEqual([70, '4']);
  });

  it('empty input still has an ENTITIES section but no entities', () => {
    const dxf = sketchToDxf([], {});
    expect(dxf).toContain('ENTITIES');
    expect(dxf).not.toContain('LINE');
    expect(dxf).not.toContain('CIRCLE');
  });

  it('serializes a line with start (10/20) and end (11/21)', () => {
    const dxf = sketchToDxf([line(1)], {});
    const c = entityCodes(dxf, 'LINE');
    expect(c.get(10)).toBe('0');
    expect(c.get(20)).toBe('0');
    expect(c.get(11)).toBe('10');
    expect(c.get(21)).toBe('20');
  });

  it('serializes a circle with radius = diameter / 2', () => {
    const circle: SketchEntity = {
      id: entityId('c1'),
      type: 'circle',
      center: ['5', '6'],
      diameter: '8',
    };
    const dxf = sketchToDxf([circle], {});
    const c = entityCodes(dxf, 'CIRCLE');
    expect(c.get(10)).toBe('5');
    expect(c.get(20)).toBe('6');
    expect(c.get(40)).toBe('4'); // 8 / 2
  });

  it('converts arc start/end angle from radians to degrees', () => {
    const arc: SketchEntity = {
      id: entityId('a1'),
      type: 'arc',
      center: ['0', '0'],
      radius: '10',
      startAngle: '0',
      endAngle: String(Math.PI / 2), // 90°
    };
    const dxf = sketchToDxf([arc], {});
    const c = entityCodes(dxf, 'ARC');
    expect(c.get(40)).toBe('10');
    expect(Number(c.get(50))).toBeCloseTo(0, 9);
    expect(Number(c.get(51))).toBeCloseTo(90, 9);
  });

  it('serializes an ellipse with centre-relative major vector and axis ratio', () => {
    // Centre (1,1), majorEnd (5,1) → major vector (4,0), majorR = 4.
    // minorRadius = 2 → ratio = 0.5.
    const ellipse: SketchEntity = {
      id: entityId('e1'),
      type: 'ellipse',
      center: ['1', '1'],
      majorEnd: ['5', '1'],
      minorRadius: '2',
    };
    const dxf = sketchToDxf([ellipse], {});
    const c = entityCodes(dxf, 'ELLIPSE');
    expect(c.get(10)).toBe('1');
    expect(c.get(20)).toBe('1');
    expect(Number(c.get(11))).toBeCloseTo(4, 9); // majorEnd.x - center.x
    expect(Number(c.get(21))).toBeCloseTo(0, 9);
    expect(Number(c.get(40))).toBeCloseTo(0.5, 9); // minor / major
  });

  it('resolves parametric expressions through params', () => {
    const circle: SketchEntity = {
      id: entityId('c1'),
      type: 'circle',
      center: ['cx', '0'],
      diameter: 'D',
    };
    const dxf = sketchToDxf([circle], { cx: 12, D: 6 });
    const c = entityCodes(dxf, 'CIRCLE');
    expect(c.get(10)).toBe('12');
    expect(c.get(40)).toBe('3');
  });

  it('excludes construction geometry', () => {
    const constructionLine: SketchEntity = { ...line(1), construction: true };
    const dxf = sketchToDxf([constructionLine], {});
    expect(dxf).not.toContain('LINE');
  });

  it('excludes standalone points', () => {
    const pt: SketchEntity = { id: entityId('p1'), type: 'point', at: ['1', '2'] };
    const dxf = sketchToDxf([pt], {});
    expect(dxf).not.toContain('POINT');
  });

  it('emits multiple entities in one ENTITIES section', () => {
    const circle: SketchEntity = {
      id: entityId('c1'),
      type: 'circle',
      center: ['0', '0'],
      diameter: '4',
    };
    const dxf = sketchToDxf([line(1), circle], {});
    expect(dxf).toContain('LINE');
    expect(dxf).toContain('CIRCLE');
  });
});

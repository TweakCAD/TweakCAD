/**
 * Tests for the SVG import pipeline (`parseSvg` + `svgToEditorState`).
 *
 * Pins: element coverage (line/rect/circle/ellipse/polyline/polygon/path),
 * the Y-flip (SVG Y-down → sketch Y-up around the viewBox), unit scaling from
 * width/viewBox, `<g>` transforms, curve flattening to splines, skipped
 * elements, and the reuse of the DXF builder (coincident junctions).
 */

import { describe, it, expect } from 'vitest';
import { parseSvg, svgToEditorState } from './svgImport.ts';
import { makeCounterIdFactory } from '../operations.ts';

/** viewBox "0 0 100 100" → flipConst 100, unitScale 1 (no physical width). */
function svg100(body: string, attrs = 'viewBox="0 0 100 100"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
}

describe('parseSvg', () => {
  it('imports a <line>, flipping Y around the viewBox', () => {
    const { primitives, unitScale } = parseSvg(svg100('<line x1="0" y1="20" x2="10" y2="20"/>'));
    expect(unitScale).toBe(1);
    expect(primitives).toHaveLength(1);
    const l = primitives[0]!;
    if (l.kind !== 'line') throw new Error('expected line');
    // y flips: 100 - 20 = 80.
    expect(l.start).toEqual([0, 80]);
    expect(l.end).toEqual([10, 80]);
  });

  it('imports a <rect> as 4 lines', () => {
    const { primitives } = parseSvg(svg100('<rect x="0" y="0" width="10" height="10"/>'));
    expect(primitives).toHaveLength(4);
    expect(primitives.every((p) => p.kind === 'line')).toBe(true);
  });

  it('imports a <circle> with flipped center', () => {
    const { primitives } = parseSvg(svg100('<circle cx="50" cy="40" r="5"/>'));
    const c = primitives[0]!;
    if (c.kind !== 'circle') throw new Error('expected circle');
    expect(c.center).toEqual([50, 60]); // 100 - 40
    expect(c.radius).toBe(5);
  });

  it('imports an <ellipse> (major = longer radius)', () => {
    const { primitives } = parseSvg(svg100('<ellipse cx="0" cy="0" rx="8" ry="3"/>'));
    const e = primitives[0]!;
    if (e.kind !== 'ellipse') throw new Error('expected ellipse');
    expect(e.center).toEqual([0, 100]);
    expect(e.minorRadius).toBeCloseTo(3, 9);
    // major endpoint along +x from center, then flipped.
    expect(e.majorEnd[0]).toBeCloseTo(8, 9);
  });

  it('imports a <polygon> closing back to the first point', () => {
    const { primitives } = parseSvg(svg100('<polygon points="0,0 10,0 10,10"/>'));
    // 3 vertices closed → 3 segments.
    expect(primitives).toHaveLength(3);
    expect(primitives.every((p) => p.kind === 'line')).toBe(true);
  });

  it('scales user units to mm from width / viewBox', () => {
    const { primitives, unitScale } = parseSvg(
      svg100('<line x1="0" y1="0" x2="10" y2="0"/>', 'width="200mm" viewBox="0 0 100 100"'),
    );
    expect(unitScale).toBe(2);
    const l = primitives[0]!;
    if (l.kind !== 'line') throw new Error('expected line');
    expect(l.end[0]).toBeCloseTo(20, 9); // 10 user units × 2 mm/unit
  });

  it('applies a group translate transform', () => {
    const { primitives } = parseSvg(
      svg100('<g transform="translate(5,0)"><line x1="0" y1="0" x2="0" y2="0"/></g>'),
    );
    const l = primitives[0]!;
    if (l.kind !== 'line') throw new Error('expected line');
    expect(l.start[0]).toBeCloseTo(5, 9);
  });

  it('flattens a cubic path segment into a spline', () => {
    const { primitives } = parseSvg(svg100('<path d="M 0 0 C 0 10 10 10 10 0"/>'));
    const s = primitives.find((p) => p.kind === 'spline');
    if (s?.kind !== 'spline') throw new Error('expected spline');
    expect(s.points.length).toBeGreaterThan(2);
  });

  it('imports a path with line + close as lines', () => {
    const { primitives } = parseSvg(svg100('<path d="M 0 0 L 10 0 L 10 10 Z"/>'));
    expect(primitives.filter((p) => p.kind === 'line')).toHaveLength(3); // 2 L + Z close
  });

  it('collects unsupported drawable elements into skipped', () => {
    const { skipped } = parseSvg(svg100('<text x="0" y="0">hi</text><line x1="0" y1="0" x2="1" y2="0"/>'));
    expect(skipped).toContain('text');
  });

  it('returns empty for non-svg root', () => {
    const r = parseSvg('<html><body/></html>');
    expect(r.primitives).toEqual([]);
  });
});

describe('svgToEditorState', () => {
  it('builds a state with coincident junctions for a closed polygon', () => {
    const { state } = svgToEditorState(
      svg100('<polygon points="0,0 10,0 10,10 0,10"/>'),
      { idFactory: makeCounterIdFactory() },
    );
    // 4 edges, distinct endpoints (8 points), 4 coincident junction constraints.
    expect(state.geometries.size).toBe(4);
    expect(state.points.size).toBe(8);
    const coincidents = Array.from(state.constraints.values()).filter((c) => c.type === 'coincident');
    expect(coincidents).toHaveLength(4);
  });
});

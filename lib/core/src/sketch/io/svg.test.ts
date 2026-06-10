/**
 * Tests for sketchToSvg — the pure sketch → SVG serializer.
 *
 * Pins:
 *   - native <line> / <circle> / <path> (arc) / <ellipse> / <polyline> output
 *   - Y is flipped (sketch +Y up → SVG +Y down)
 *   - viewBox sized to the geometry bounds (+ margin) in mm
 *   - parametric Expression coords resolve through `params`
 *   - construction geometry and standalone points are excluded
 *   - empty input → valid empty <svg>
 */

import { describe, it, expect } from 'vitest';
import { sketchToSvg } from './svg.ts';
import type { SketchEntity } from '../../document/schema.ts';
import { entityId } from '../../ids.ts';

/** Pull a numeric attribute value out of the first occurrence in the SVG. */
function attr(svg: string, name: string): string | null {
  const m = svg.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1]! : null;
}

describe('sketchToSvg', () => {
  it('empty input yields a valid empty svg', () => {
    const svg = sketchToSvg([], {});
    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain('<line');
    expect(svg).not.toContain('<circle');
  });

  it('emits a <line> and flips Y', () => {
    // Single horizontal line from (0,0) to (10,0). With MARGIN=1, bounds are
    // x[-1,11] y[-1,1], maxY = 1, so fy(0) = 1. Both endpoints share that y.
    const lineEntity: SketchEntity = {
      id: entityId('l1'),
      type: 'line',
      start: ['0', '0'],
      end: ['10', '0'],
    };
    const svg = sketchToSvg([lineEntity], {});
    expect(svg).toContain('<line');
    expect(attr(svg, 'x1')).toBe('0');
    expect(attr(svg, 'x2')).toBe('10');
    // Y flipped: sketch y=0 → maxY - 0 = 1.
    expect(attr(svg, 'y1')).toBe('1');
    expect(attr(svg, 'y2')).toBe('1');
  });

  it('flips Y so a higher sketch point gets a smaller SVG y', () => {
    // Vertical line (0,0)→(0,10). bounds y[-1,11], maxY=11.
    // fy(0)=11 (bottom), fy(10)=1 (top): higher sketch-y → smaller svg-y.
    const lineEntity: SketchEntity = {
      id: entityId('l1'),
      type: 'line',
      start: ['0', '0'],
      end: ['0', '10'],
    };
    const svg = sketchToSvg([lineEntity], {});
    expect(attr(svg, 'y1')).toBe('11');
    expect(attr(svg, 'y2')).toBe('1');
  });

  it('emits a <circle> with flipped centre', () => {
    const circle: SketchEntity = {
      id: entityId('c1'),
      type: 'circle',
      center: ['5', '5'],
      diameter: '4',
    };
    const svg = sketchToSvg([circle], {});
    expect(svg).toContain('<circle');
    expect(attr(svg, 'cx')).toBe('5');
    expect(attr(svg, 'r')).toBe('2');
    // bounds y[5-2-1, 5+2+1] = [2,8], maxY=8, fy(5)=3.
    expect(attr(svg, 'cy')).toBe('3');
  });

  it('emits an arc as a <path> with an A command', () => {
    const arc: SketchEntity = {
      id: entityId('a1'),
      type: 'arc',
      center: ['0', '0'],
      radius: '10',
      startAngle: '0',
      endAngle: String(Math.PI / 2),
    };
    const svg = sketchToSvg([arc], {});
    expect(svg).toContain('<path');
    expect(svg).toMatch(/d="M [^"]*A [^"]*"/);
  });

  it('emits an <ellipse> with a rotate transform', () => {
    const ellipse: SketchEntity = {
      id: entityId('e1'),
      type: 'ellipse',
      center: ['0', '0'],
      majorEnd: ['4', '0'],
      minorRadius: '2',
    };
    const svg = sketchToSvg([ellipse], {});
    expect(svg).toContain('<ellipse');
    expect(attr(svg, 'rx')).toBe('4');
    expect(attr(svg, 'ry')).toBe('2');
    expect(svg).toContain('transform="rotate(');
  });

  it('emits a spline as a <polyline>', () => {
    const spline: SketchEntity = {
      id: entityId('s1'),
      type: 'spline',
      points: [['0', '0'], ['5', '5'], ['10', '0']],
    };
    const svg = sketchToSvg([spline], {});
    expect(svg).toContain('<polyline');
    expect(attr(svg, 'points')).toContain(',');
  });

  it('sizes the viewBox to the geometry bounds in mm', () => {
    const lineEntity: SketchEntity = {
      id: entityId('l1'),
      type: 'line',
      start: ['0', '0'],
      end: ['10', '20'],
    };
    const svg = sketchToSvg([lineEntity], {});
    // bounds x[-1,11] (width 12), y[-1,21] (height 22).
    expect(svg).toContain('width="12mm"');
    expect(svg).toContain('height="22mm"');
    expect(attr(svg, 'viewBox')).toBe('-1 0 12 22');
  });

  it('resolves parametric expressions through params', () => {
    const circle: SketchEntity = {
      id: entityId('c1'),
      type: 'circle',
      center: ['cx', '0'],
      diameter: 'D',
    };
    const svg = sketchToSvg([circle], { cx: 7, D: 6 });
    expect(attr(svg, 'cx')).toBe('7');
    expect(attr(svg, 'r')).toBe('3');
  });

  it('excludes construction geometry and standalone points', () => {
    const constructionLine: SketchEntity = {
      id: entityId('l1'),
      type: 'line',
      start: ['0', '0'],
      end: ['10', '0'],
      construction: true,
    };
    const pt: SketchEntity = { id: entityId('p1'), type: 'point', at: ['1', '2'] };
    const svg = sketchToSvg([constructionLine, pt], {});
    expect(svg).not.toContain('<line');
    // Only excluded entities → empty svg.
    expect(svg).toContain('viewBox="0 0 1 1"');
  });
});

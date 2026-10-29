/**
 * Tests for the curve-aware loop walker in `detectSketchRegions`.
 *
 * A closed boundary made of `line` / `arc` / `bezier` edges that meet at
 * shared endpoints becomes one region whose curve segments carry their
 * native analytic data (arc angles, Bézier poles) through to the kernel —
 * no polygonalization on this side. Pure-line loops are unaffected.
 */

import { describe, expect, it } from 'vitest';
import { detectSketchRegions } from './profileRegions.ts';
import type { SketchEntity } from '../document/schema.ts';
import { entityId } from '../ids.ts';

describe('detectSketchRegions — curve-loop walker', () => {
  it('detects a "D": one line + one bezier closing on shared endpoints', () => {
    // Flat side: vertical line (0,0)→(0,10). Bulge: cubic Bézier
    // (0,10)→(0,0) curving out to +x. Two entities, one a curve, so the
    // loop is allowed to close with just two edges.
    const entities: Record<string, SketchEntity> = {
      flat: {
        id: entityId('flat'),
        type: 'line',
        start: ['0', '0'],
        end: ['0', '10'],
      },
      bulge: {
        id: entityId('bulge'),
        type: 'bezier',
        start: ['0', '10'],
        cp1: ['10', '10'],
        cp2: ['10', '0'],
        end: ['0', '0'],
      },
    };

    const regions = detectSketchRegions(entities);
    const loop = regions.find(r => r.entityIds.length === 2);
    expect(loop).toBeDefined();
    expect(loop!.segments).toHaveLength(2);

    const bez = loop!.segments.find(s => s.kind === 'bezier');
    expect(bez).toBeDefined();
    expect(bez!.bezierCp1).toBeDefined();
    expect(bez!.bezierCp2).toBeDefined();
    expect(loop!.segments.some(s => s.kind === 'line')).toBe(true);
    // The Bézier bulges to +x, so the region encloses real area.
    expect(loop!.area).toBeGreaterThan(0);
  });

  it('detects a "D": one line + one arc, carrying analytic arc data', () => {
    // Same flat side; the bulge is a half-circle arc (center (0,5), r=5)
    // from (0,0) up through (5,5) to (0,10).
    const entities: Record<string, SketchEntity> = {
      flat: {
        id: entityId('flat'),
        type: 'line',
        start: ['0', '0'],
        end: ['0', '10'],
      },
      bulge: {
        id: entityId('bulge'),
        type: 'arc',
        center: ['0', '5'],
        radius: '5',
        startAngle: String(-Math.PI / 2),
        endAngle: String(Math.PI / 2),
      },
    };

    const regions = detectSketchRegions(entities);
    const loop = regions.find(r => r.entityIds.length === 2);
    expect(loop).toBeDefined();

    const arc = loop!.segments.find(s => s.kind === 'arc');
    expect(arc).toBeDefined();
    expect(arc!.arcCenter).toEqual([0, 5]);
    expect(arc!.arcRadius).toBe(5);
    expect(loop!.area).toBeGreaterThan(0);
  });

  it('orients a reversed bezier by swapping endpoints and poles', () => {
    // The bezier is authored (0,10)→(0,0); walking the loop from the line
    // forces it to be traversed (0,10)→(0,0) in natural order here, but a
    // triangle-with-curve below exercises the reversal path. Build a loop
    // where the bezier must be reversed: line (0,0)→(0,10), then a bezier
    // authored (0,0)→(0,10) (same direction as the line) — to close, the
    // walker must reverse it.
    const entities: Record<string, SketchEntity> = {
      flat: {
        id: entityId('flat'),
        type: 'line',
        start: ['0', '0'],
        end: ['0', '10'],
      },
      bulge: {
        id: entityId('bulge'),
        type: 'bezier',
        start: ['0', '0'],
        cp1: ['10', '0'],
        cp2: ['10', '10'],
        end: ['0', '10'],
      },
    };

    const regions = detectSketchRegions(entities);
    const loop = regions.find(r => r.entityIds.length === 2);
    expect(loop).toBeDefined();
    const bez = loop!.segments.find(s => s.kind === 'bezier')!;
    // Either traversal is a valid answer, but the poles have to travel
    // with the endpoints: cp1 stays next to `start`, cp2 next to `end`.
    // Asserting the four together is the point — checking only that the
    // endpoint *set* is {(0,0), (0,10)} passes for a reversal that
    // forgot to swap the poles, which is the regression this guards.
    const at = (p?: readonly [number, number]) => `${p![0]},${p![1]}`;
    const oriented = {
      start: at(bez.start),
      cp1: at(bez.bezierCp1),
      cp2: at(bez.bezierCp2),
      end: at(bez.end),
    };
    expect([
      { start: '0,0', cp1: '10,0', cp2: '10,10', end: '0,10' },   // as authored
      { start: '0,10', cp1: '10,10', cp2: '10,0', end: '0,0' },   // reversed
    ]).toContainEqual(oriented);
  });

  it('detects an open spline + line as a loop (spline boundary edge)', () => {
    // Open spline (0,0)->(10,0) bulging up, closed by a straight line back.
    const entities: Record<string, SketchEntity> = {
      curve: {
        id: entityId('curve'),
        type: 'spline',
        points: [['0', '0'], ['3', '5'], ['7', '5'], ['10', '0']],
      },
      base: {
        id: entityId('base'),
        type: 'line',
        start: ['10', '0'],
        end: ['0', '0'],
      },
    };
    const regions = detectSketchRegions(entities);
    const loop = regions.find(r => r.entityIds.length === 2);
    expect(loop).toBeDefined();
    const sp = loop!.segments.find(s => s.kind === 'spline');
    expect(sp).toBeDefined();
    expect(sp!.splinePoints!.length).toBe(4);
    expect(loop!.area).toBeGreaterThan(0);
  });

  it('detects a standalone ellipse as its own region', () => {
    const entities: Record<string, SketchEntity> = {
      e: {
        id: entityId('e'),
        type: 'ellipse',
        center: ['0', '0'],
        majorEnd: ['10', '0'], // major radius 10, no rotation
        minorRadius: '5',
      },
    };
    const regions = detectSketchRegions(entities);
    const ell = regions.find(r => r.type === 'ellipse');
    expect(ell).toBeDefined();
    expect(ell!.ellipseMajorEnd).toEqual([10, 0]);
    expect(ell!.ellipseMinorRadius).toBe(5);
    expect(ell!.area).toBeCloseTo(Math.PI * 10 * 5, 4);
    expect(ell!.vertices.length).toBeGreaterThan(8); // sampled perimeter
  });

  it('detects a self-closed spline as its own region', () => {
    // First point == last → closed; the closing duplicate is dropped.
    const entities: Record<string, SketchEntity> = {
      s: {
        id: entityId('s'),
        type: 'spline',
        points: [['0', '0'], ['10', '0'], ['10', '10'], ['0', '10'], ['0', '0']],
      },
    };
    const regions = detectSketchRegions(entities);
    const cs = regions.find(r => r.type === 'closedSpline');
    expect(cs).toBeDefined();
    expect(cs!.splineControlPoints).toHaveLength(4); // 5 - duplicate close
    // Area/outline now follow the smooth periodic Catmull-Rom (so the fill
    // and hit-test match the curve), not the angular control polygon — so
    // it's near, but not exactly, the 100 of the control square.
    expect(cs!.area).toBeGreaterThan(70);
    expect(cs!.area).toBeLessThan(140);
    expect(cs!.vertices.length).toBeGreaterThan(8); // sampled curve, not 4 corners
  });

  it('does not treat an open spline as a standalone region', () => {
    const entities: Record<string, SketchEntity> = {
      s: {
        id: entityId('s'),
        type: 'spline',
        points: [['0', '0'], ['5', '5'], ['10', '0']], // open (first != last)
      },
    };
    const regions = detectSketchRegions(entities);
    expect(regions.find(r => r.type === 'closedSpline')).toBeUndefined();
  });

  it('still detects a pure-line triangle (regression)', () => {
    const entities: Record<string, SketchEntity> = {
      a: { id: entityId('a'), type: 'line', start: ['0', '0'], end: ['10', '0'] },
      b: { id: entityId('b'), type: 'line', start: ['10', '0'], end: ['0', '10'] },
      c: { id: entityId('c'), type: 'line', start: ['0', '10'], end: ['0', '0'] },
    };
    const regions = detectSketchRegions(entities);
    const tri = regions.find(r => r.entityIds.length === 3);
    expect(tri).toBeDefined();
    expect(tri!.type).toBe('polygon');
    expect(tri!.area).toBeCloseTo(50, 6);
    // No curve segments — stays on the polygon (vertices) path.
    expect(tri!.segments.every(s => s.kind === 'line')).toBe(true);
  });
});

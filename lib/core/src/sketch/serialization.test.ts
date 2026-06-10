/**
 * Tests for editorModelToBuildGeometry — the pure serializer that converts
 * the point-based editor model into the flat document `entities` Record
 * the worker rebuilds from.
 *
 * Key behaviors pinned here:
 *   - Every line / circle / arc geometry serializes one-for-one as a
 *     `SketchLineEntity` / `SketchCircleEntity` / `SketchArcEntity`.
 *   - drawRectangle's 4-line decomposition emits **4 line entities**
 *     (no composite collapse — invariant #11).
 *   - The output passes through the region detector to produce
 *     extrudable profiles — proves the contract end-to-end without
 *     spinning up a worker.
 *   - Dangling geometries (missing point refs) are silently skipped so
 *     partial-state observation during edits doesn't throw.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyEditorState,
  drawLine,
  drawRectangle,
  drawCircle,
  drawEllipse,
  drawSpline,
  drawPoint,
  makeCounterIdFactory,
} from './operations.ts';
import { editorModelToBuildGeometry } from './serialization.ts';
import { detectSketchRegions } from './profileRegions.ts';
import type {
  SketchCircleEntity,
  SketchLineEntity,
  SketchEllipseEntity,
  SketchSplineEntity,
  SketchPointEntity,
} from '../document/schema.ts';

describe('editorModelToBuildGeometry — line + circle serialization', () => {
  it('emits a SketchLineEntity for each drawLine geometry', () => {
    const factory = makeCounterIdFactory();
    const state = drawLine(emptyEditorState(), [0, 0], [10, 5], { idFactory: factory }).state;
    const entities = editorModelToBuildGeometry(state);
    const list = Object.values(entities);
    expect(list).toHaveLength(1);
    const line = list[0] as SketchLineEntity;
    expect(line.type).toBe('line');
    expect(line.start).toEqual(['0', '0']);
    expect(line.end).toEqual(['10', '5']);
  });

  it('emits a SketchCircleEntity from drawCircle', () => {
    const factory = makeCounterIdFactory();
    const state = drawCircle(emptyEditorState(), { center: [5, 5], radius: 3 }, { idFactory: factory }).state;
    const entities = editorModelToBuildGeometry(state);
    const list = Object.values(entities);
    expect(list).toHaveLength(1);
    const circle = list[0] as SketchCircleEntity;
    expect(circle.type).toBe('circle');
    expect(circle.center).toEqual(['5', '5']);
    expect(circle.diameter).toBe('6');
  });

  it('preserves construction flag on per-geometry entities', () => {
    const factory = makeCounterIdFactory();
    const state = drawCircle(emptyEditorState(), { center: [0, 0], radius: 1 }, {
      idFactory: factory,
      construction: true,
    }).state;
    const entity = Object.values(editorModelToBuildGeometry(state))[0] as SketchCircleEntity;
    expect(entity.construction).toBe(true);
  });

  it('skips geometries whose referenced points are missing', () => {
    // Manually construct a state with a dangling line (start/end ids not
    // present in the points map). The serializer should silently skip
    // rather than throw — protects against partial-state observation
    // during edits.
    const state = {
      points: new Map(),
      geometries: new Map([
        ['orphan' as never, {
          id: 'orphan' as never,
          type: 'line' as const,
          startId: 'missing-a' as never,
          endId: 'missing-b' as never,
          construction: false,
        }],
      ]) as never,
      constraints: new Map(),
    };
    const entities = editorModelToBuildGeometry(state);
    expect(Object.keys(entities)).toHaveLength(0);
  });
});

describe('editorModelToBuildGeometry — rectangle is 4 lines (invariant #11)', () => {
  it('drawRectangle emits 4 SketchLineEntity records (no composite collapse)', () => {
    const factory = makeCounterIdFactory();
    const state = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 60, height: 30 }, {
      idFactory: factory,
    }).state;
    const entities = editorModelToBuildGeometry(state);
    const list = Object.values(entities);
    // 4 edges → 4 line entities.
    expect(list).toHaveLength(4);
    for (const entity of list) {
      expect(entity.type).toBe('line');
    }
  });

  it('marks individual line entities as construction when drawn that way', () => {
    const factory = makeCounterIdFactory();
    const state = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 5, height: 5 }, {
      idFactory: factory,
      construction: true,
    }).state;
    const entities = Object.values(editorModelToBuildGeometry(state));
    expect(entities).toHaveLength(4);
    for (const entity of entities) {
      expect(entity.construction).toBe(true);
    }
  });
});

describe('editorModelToBuildGeometry — region detector integration', () => {
  it('drawRectangle output produces a closed quad region', () => {
    // With composite rectangles gone, the region detector must walk the
    // 4-line decomposition and find a closed loop on its own. The 4
    // adjacent endpoints share coordinates (the rectangle solver pins
    // them via coincident constraints), so the loop detector picks the
    // quad up via coordinate-matched chaining.
    const factory = makeCounterIdFactory();
    const state = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 40, height: 20 }, {
      idFactory: factory,
    }).state;
    const entities = editorModelToBuildGeometry(state);
    const regions = detectSketchRegions(entities);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    // First region should be the closed quad with the expected area.
    const quad = regions.find((r) => Math.abs(r.area - 800) < 0.1);
    expect(quad).toBeDefined();
    expect(quad?.type).toBe('polygon');
  });

  it('produces a single circle region for a drawn circle', () => {
    const factory = makeCounterIdFactory();
    const state = drawCircle(emptyEditorState(), { center: [0, 0], radius: 5 }, { idFactory: factory }).state;
    const entities = editorModelToBuildGeometry(state);
    const regions = detectSketchRegions(entities);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.type).toBe('circle');
  });

  it('produces a closed region from 4 drawLine calls forming a rectangle', () => {
    // The previous failure mode: 4 line entities with matching coords
    // but no shared structure. With drawLine's findOrCreatePoint, the
    // coords match exactly and the loop detector picks it up.
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    s = drawLine(s, [0, 0], [10, 0], { idFactory: factory }).state;
    s = drawLine(s, [10, 0], [10, 10], { idFactory: factory }).state;
    s = drawLine(s, [10, 10], [0, 10], { idFactory: factory }).state;
    s = drawLine(s, [0, 10], [0, 0], { idFactory: factory }).state;
    const entities = editorModelToBuildGeometry(s);
    const regions = detectSketchRegions(entities);
    // At least one region (the closed quad).
    expect(regions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('editorModelToBuildGeometry — ellipse / spline / point projection (task Q)', () => {
  it('emits a SketchEllipseEntity from drawEllipse', () => {
    const factory = makeCounterIdFactory();
    const state = drawEllipse(emptyEditorState(), {
      center: [0, 0],
      major: [10, 0],
      minorRadius: 4,
    }, { idFactory: factory }).state;
    const entities = Object.values(editorModelToBuildGeometry(state));
    expect(entities).toHaveLength(1);
    const ellipse = entities[0] as SketchEllipseEntity;
    expect(ellipse.type).toBe('ellipse');
    expect(ellipse.center).toEqual(['0', '0']);
    expect(ellipse.majorEnd).toEqual(['10', '0']);
    expect(ellipse.minorRadius).toBe('4');
  });

  it('emits a SketchSplineEntity from drawSpline preserving point order', () => {
    const factory = makeCounterIdFactory();
    const state = drawSpline(emptyEditorState(),
      [[0, 0], [5, 5], [10, 0]],
      { idFactory: factory }).state;
    const entities = Object.values(editorModelToBuildGeometry(state));
    expect(entities).toHaveLength(1);
    const spline = entities[0] as SketchSplineEntity;
    expect(spline.type).toBe('spline');
    expect(spline.points).toEqual([['0', '0'], ['5', '5'], ['10', '0']]);
  });

  it('emits a SketchPointEntity from drawPoint', () => {
    const factory = makeCounterIdFactory();
    const state = drawPoint(emptyEditorState(), [7, 3], { idFactory: factory }).state;
    const entities = Object.values(editorModelToBuildGeometry(state));
    expect(entities).toHaveLength(1);
    const point = entities[0] as SketchPointEntity;
    expect(point.type).toBe('point');
    expect(point.at).toEqual(['7', '3']);
  });

  it('preserves construction flag on ellipse / spline / point', () => {
    const factory = makeCounterIdFactory();
    let s = emptyEditorState();
    s = drawEllipse(s, { center: [0, 0], major: [3, 0], minorRadius: 1 },
      { idFactory: factory, construction: true }).state;
    s = drawSpline(s, [[0, 0], [1, 1]], { idFactory: factory, construction: true }).state;
    s = drawPoint(s, [2, 2], { idFactory: factory, construction: true }).state;
    const entities = Object.values(editorModelToBuildGeometry(s));
    expect(entities).toHaveLength(3);
    for (const e of entities) {
      expect((e as { construction?: boolean }).construction).toBe(true);
    }
  });
});

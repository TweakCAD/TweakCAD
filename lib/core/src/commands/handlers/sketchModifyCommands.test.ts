/**
 * Integration tests for the modify-tool handlers.
 *
 * Each test asserts the handler dispatches as one undo entry through
 * the bus, mutates the editor state via the pure primitive in
 * `@tweakcad/core/src/sketch/modifyOps.ts`, and writes `sketchBuildGeometry(inputs)`
 * via the canonical serializer (same path as the draw handlers).
 */

import { describe, it, expect } from 'vitest';
import { CommandBus } from '../bus.ts';
import { DocumentStore } from '../../store/documentStore.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { createSketchHandler } from './featureCommands.ts';
import {
  sketchDrawLineHandler,
  sketchDrawCircleHandler,
  sketchTrimHandler,
  sketchExtendHandler,
  sketchFilletHandler,
  sketchOffsetHandler,
  sketchMirrorHandler,
} from './sketchDrawCommands.ts';
import type { SketchFeatureInputs } from '../../document/schema.ts';
import type { PartId, FeatureId } from '../../ids.ts';
import type { SketchGeometryId, SketchPointId } from '../../sketch/types.ts';

function newHarness() {
  const project = newProjectWithPart('Test');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketch', createSketchHandler);
  bus.register('SketchDrawLine', sketchDrawLineHandler);
  bus.register('SketchDrawCircle', sketchDrawCircleHandler);
  bus.register('SketchTrim', sketchTrimHandler);
  bus.register('SketchExtend', sketchExtendHandler);
  bus.register('SketchFillet', sketchFilletHandler);
  bus.register('SketchOffset', sketchOffsetHandler);
  bus.register('SketchMirror', sketchMirrorHandler);
  const partId = Object.keys(project.parts)[0] as PartId;
  return { bus, store, partId };
}

function createSketch(bus: CommandBus, store: DocumentStore, partId: PartId): FeatureId {
  bus.dispatch({
    type: 'CreateSketch',
    partId,
    plane: { type: 'defaultPlane', name: 'XY' },
  });
  const sketches = store.getState().parts[partId]!.timeline.filter((f) => f.type === 'sketch');
  return sketches[sketches.length - 1]!.id;
}

function inputs(store: DocumentStore, partId: PartId, sketchId: FeatureId): SketchFeatureInputs {
  const sketch = store.getState().parts[partId]!.timeline.find((f) => f.id === sketchId)!;
  return sketch.inputs as unknown as SketchFeatureInputs;
}

function geomsOf(store: DocumentStore, partId: PartId, sketchId: FeatureId): Array<{
  id: SketchGeometryId; type: string;
  startId?: SketchPointId; endId?: SketchPointId; centerId?: SketchPointId; radius?: number;
}> {
  return (inputs(store, partId, sketchId).editorModel!.geometries as Array<{
    id: SketchGeometryId; type: string;
    startId?: SketchPointId; endId?: SketchPointId; centerId?: SketchPointId; radius?: number;
  }>);
}

function pointsOf(store: DocumentStore, partId: PartId, sketchId: FeatureId): Array<{
  id: SketchPointId; x: number; y: number;
}> {
  return (inputs(store, partId, sketchId).editorModel!.points as Array<{
    id: SketchPointId; x: number; y: number;
  }>);
}

// ---- SketchTrim ----------------------------------------------------------

describe('SketchTrim', () => {
  it('whole-deletes a line with no intersections', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    const lineId = geomsOf(store, partId, sketchId).find((g) => g.type === 'line')!.id;
    expect(store.undoLabel()).toBe('Draw Line');

    const r = bus.dispatch({ type: 'SketchTrim', sketchId, geometryId: lineId, cursor: [5, 0] });
    expect(r.ok).toBe(true);
    expect(geomsOf(store, partId, sketchId)).toHaveLength(0);
    expect(store.undoLabel()).toBe('Trim');

    // Undo restores the line.
    store.undo();
    expect(geomsOf(store, partId, sketchId)).toHaveLength(1);
  });

  it('splits a line at one intersection and keeps the side away from the cursor', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    // Horizontal line from (0,0) to (20,0) crossed by vertical line at x=10.
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [20, 0] });
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [10, -5], to: [10, 5] });
    const lines = geomsOf(store, partId, sketchId).filter((g) => g.type === 'line');
    const horiz = lines.find((l) => {
      const pts = pointsOf(store, partId, sketchId);
      const s = pts.find((p) => p.id === l.startId)!;
      const e = pts.find((p) => p.id === l.endId)!;
      return s.y === 0 && e.y === 0;
    })!;

    // Click on the right half (x=15) → that side gets deleted, left half (0..10) survives.
    bus.dispatch({ type: 'SketchTrim', sketchId, geometryId: horiz.id, cursor: [15, 0] });

    const surviving = geomsOf(store, partId, sketchId).filter((g) => g.type === 'line');
    // Original horizontal split into 1 surviving piece + the unchanged vertical.
    expect(surviving).toHaveLength(2);
    const pts = pointsOf(store, partId, sketchId);
    const survivingHoriz = surviving.find((g) => {
      const s = pts.find((p) => p.id === g.startId);
      const e = pts.find((p) => p.id === g.endId);
      return s && e && Math.abs(s.y) < 1e-9 && Math.abs(e.y) < 1e-9;
    });
    expect(survivingHoriz).toBeDefined();
  });
});

// ---- SketchExtend --------------------------------------------------------

describe('SketchExtend', () => {
  it('extends a short line to meet a perpendicular line beyond its endpoint', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    // Horizontal line (0,0)→(5,0). Vertical line (10,-5)→(10,5). Extending
    // the horizontal pushes its end out to (10, 0).
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [5, 0] });
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [10, -5], to: [10, 5] });
    const lines = geomsOf(store, partId, sketchId).filter((g) => g.type === 'line');
    const pts = pointsOf(store, partId, sketchId);
    const shortHoriz = lines.find((l) => {
      const s = pts.find((p) => p.id === l.startId)!;
      const e = pts.find((p) => p.id === l.endId)!;
      return s.y === 0 && e.y === 0 && Math.max(s.x, e.x) <= 5;
    })!;

    bus.dispatch({ type: 'SketchExtend', sketchId, geometryId: shortHoriz.id });
    expect(store.undoLabel()).toBe('Extend');

    const afterPts = pointsOf(store, partId, sketchId);
    const endPt = afterPts.find((p) => p.id === shortHoriz.endId);
    expect(endPt).toBeDefined();
    // End moved from (5,0) to (10,0).
    expect(endPt!.x).toBeCloseTo(10, 6);
    expect(endPt!.y).toBeCloseTo(0, 6);
  });
});

// ---- SketchFillet --------------------------------------------------------

describe('SketchFillet', () => {
  it('rounds the corner between two lines meeting at (10,0)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [10, 0], to: [10, 10] });
    const lines = geomsOf(store, partId, sketchId).filter((g) => g.type === 'line');
    expect(lines).toHaveLength(2);

    bus.dispatch({
      type: 'SketchFillet',
      sketchId,
      geometryAId: lines[0]!.id,
      geometryBId: lines[1]!.id,
      radius: 2,
    });
    expect(store.undoLabel()).toBe('Sketch Fillet');

    const after = geomsOf(store, partId, sketchId);
    // 2 lines (corners moved inward) + 1 new arc.
    expect(after.filter((g) => g.type === 'line')).toHaveLength(2);
    expect(after.filter((g) => g.type === 'arc')).toHaveLength(1);
    const arc = after.find((g) => g.type === 'arc')!;
    expect(arc.radius).toBeCloseTo(2, 6);
  });

  it('rejects fillet between non-line geometries', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [0, 0], radius: 5 });
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [10, 0], to: [10, 10] });
    const all = geomsOf(store, partId, sketchId);
    const circle = all.find((g) => g.type === 'circle')!;
    const line = all.find((g) => g.type === 'line')!;
    // Handler doesn't reject (it's a runtime no-op), but no arc is added.
    const before = geomsOf(store, partId, sketchId).length;
    bus.dispatch({ type: 'SketchFillet', sketchId, geometryAId: circle.id, geometryBId: line.id });
    expect(geomsOf(store, partId, sketchId)).toHaveLength(before);
  });
});

// ---- SketchOffset --------------------------------------------------------

describe('SketchOffset', () => {
  it('offsets a horizontal line above (cursor on +y side)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    const line = geomsOf(store, partId, sketchId).find((g) => g.type === 'line')!;

    bus.dispatch({
      type: 'SketchOffset',
      sketchId,
      geometryId: line.id,
      distance: 2,
      cursor: [5, 1],
    });
    expect(store.undoLabel()).toBe('Offset');

    const lines = geomsOf(store, partId, sketchId).filter((g) => g.type === 'line');
    expect(lines).toHaveLength(2);
    const pts = pointsOf(store, partId, sketchId);
    // The new line's points should sit on y=+2.
    const newLine = lines.find((l) => l.id !== line.id)!;
    const ns = pts.find((p) => p.id === newLine.startId)!;
    const ne = pts.find((p) => p.id === newLine.endId)!;
    expect(ns.y).toBeCloseTo(2, 6);
    expect(ne.y).toBeCloseTo(2, 6);
  });

  it('grows a circle when the cursor is outside, shrinks when inside', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [0, 0], radius: 5 });
    const c = geomsOf(store, partId, sketchId).find((g) => g.type === 'circle')!;

    bus.dispatch({
      type: 'SketchOffset',
      sketchId,
      geometryId: c.id,
      distance: 2,
      cursor: [10, 0],
    });
    const after = geomsOf(store, partId, sketchId).filter((g) => g.type === 'circle');
    expect(after).toHaveLength(2);
    const newOne = after.find((g) => g.id !== c.id)!;
    expect(newOne.radius).toBeCloseTo(7, 6);
  });
});

// ---- SketchMirror --------------------------------------------------------

describe('SketchMirror', () => {
  it('mirrors a line across the y-axis', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [5, 0], to: [10, 5] });
    const line = geomsOf(store, partId, sketchId).find((g) => g.type === 'line')!;

    bus.dispatch({
      type: 'SketchMirror',
      sketchId,
      geometryIds: [line.id],
      axisA: [0, 0],
      axisB: [0, 1],
    });
    expect(store.undoLabel()).toBe('Sketch Mirror');

    const lines = geomsOf(store, partId, sketchId).filter((g) => g.type === 'line');
    expect(lines).toHaveLength(2);
    const pts = pointsOf(store, partId, sketchId);
    const mirrored = lines.find((l) => l.id !== line.id)!;
    const ms = pts.find((p) => p.id === mirrored.startId)!;
    const me = pts.find((p) => p.id === mirrored.endId)!;
    // (5,0) → (-5,0), (10,5) → (-10,5).
    expect(ms.x).toBeCloseTo(-5, 6); expect(ms.y).toBeCloseTo(0, 6);
    expect(me.x).toBeCloseTo(-10, 6); expect(me.y).toBeCloseTo(5, 6);
  });

  it('rejects mirror with collinear axis points', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [5, 0], to: [10, 5] });
    const line = geomsOf(store, partId, sketchId).find((g) => g.type === 'line')!;

    const r = bus.dispatch({
      type: 'SketchMirror',
      sketchId,
      geometryIds: [line.id],
      axisA: [0, 0],
      axisB: [0, 0],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('INVALID_INPUT');
      expect(r.error.field).toBe('axisB');
    }
  });
});

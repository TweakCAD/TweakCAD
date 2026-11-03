/**
 * Integration tests for the higher-level sketch drawing command handlers.
 *
 * These prove the round-trip:
 *
 *   dispatch SketchDrawRectangle
 *     → handler calls operations.drawRectangle
 *     → writes editorModel (points + geometries) AND buildGeometry
 *     → region detector finds an extrudable profile
 *
 * Pure-function correctness of operations.ts is tested separately in
 * operations.test.ts. Pure-function correctness of the entity serializer
 * is tested in serialization.test.ts. This file tests the GLUE: that
 * the handlers wire those modules together correctly through the
 * CommandBus, and that the dispatched commands produce a document
 * state the downstream pipeline (build worker, profile resolver) can
 * actually consume.
 */

import { sketchBuildGeometry } from '../../sketch/derivedGeometry.ts';
import { describe, it, expect } from 'vitest';
import { CommandBus } from '../bus.ts';
import { DocumentStore } from '../../store/documentStore.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { createSketchHandler } from './featureCommands.ts';
import {
  sketchDrawLineHandler,
  sketchDrawRectangleHandler,
  sketchDrawCircleHandler,
  sketchDrawSlotHandler,
  sketchDrawArcHandler,
  sketchDrawPolygonHandler,
  sketchApplyConstraintHandler,
  sketchRemoveConstraintHandler,
  sketchSetConstructionHandler,
} from './sketchDrawCommands.ts';
import { detectSketchRegions } from '../../sketch/profileRegions.ts';
import type { SketchFeatureInputs } from '../../document/schema.ts';
import type { PartId, FeatureId } from '../../ids.ts';

// ---- Test harness ----------------------------------------------------------

function newHarness(): {
  bus: CommandBus;
  store: DocumentStore;
  partId: PartId;
} {
  const project = newProjectWithPart('Test');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketch', createSketchHandler);
  bus.register('SketchDrawLine', sketchDrawLineHandler);
  bus.register('SketchDrawRectangle', sketchDrawRectangleHandler);
  bus.register('SketchDrawCircle', sketchDrawCircleHandler);
  bus.register('SketchDrawSlot', sketchDrawSlotHandler);
  bus.register('SketchDrawArc', sketchDrawArcHandler);
  bus.register('SketchDrawPolygon', sketchDrawPolygonHandler);
  bus.register('SketchApplyConstraint', sketchApplyConstraintHandler);
  bus.register('SketchRemoveConstraint', sketchRemoveConstraintHandler);
  bus.register('SketchSetConstruction', sketchSetConstructionHandler);
  const partId = Object.keys(project.parts)[0] as PartId;
  return { bus, store, partId };
}

function createSketch(bus: CommandBus, store: DocumentStore, partId: PartId): FeatureId {
  const before = countSketches(store);
  bus.dispatch({
    type: 'CreateSketch',
    partId,
    plane: { type: 'defaultPlane', name: 'XY' },
  });
  const after = countSketches(store);
  expect(after).toBe(before + 1);
  const part = store.getState().parts[partId]!;
  const sketches = part.timeline.filter((f) => f.type === 'sketch');
  return sketches[sketches.length - 1]!.id;
}

function countSketches(store: DocumentStore): number {
  return Object.values(store.getState().parts).reduce(
    (n, p) => n + p.timeline.filter((f) => f.type === 'sketch').length,
    0,
  );
}

function getSketchInputs(
  store: DocumentStore,
  partId: PartId,
  sketchId: FeatureId,
): SketchFeatureInputs {
  const sketch = store.getState().parts[partId]!.timeline.find((f) => f.id === sketchId)!;
  return sketch.inputs as unknown as SketchFeatureInputs;
}

/**
 * Strip the seeded origin point + its `fixed` constraint from
 * `editorModel` so per-test count assertions can keep talking about the
 * user-visible geometry/constraint counts. `CreateSketch` seeds
 * every sketch with `pt_origin` + `con_origin_fixed` to make DOF
 * accounting reach 0; without filtering, every
 * "N points after draw" assertion would need to be bumped by +1.
 */
function userEditorState(inputs: SketchFeatureInputs): {
  points: unknown[]; geometries: unknown[]; constraints: unknown[];
} {
  const s = inputs.editorModel ?? { points: [], geometries: [], constraints: [] };
  return {
    points: (s.points as Array<{ id: string }>).filter((p) => p.id !== 'pt_origin'),
    geometries: s.geometries,
    constraints: (s.constraints as Array<{ id: string }>).filter((c) => c.id !== 'con_origin_fixed'),
  };
}

// ---- SketchDrawLine --------------------------------------------------------

describe('SketchDrawLine', () => {
  it('writes both editorModel (point graph) and buildGeometry (flat record)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    const result = bus.dispatch({
      type: 'SketchDrawLine',
      sketchId,
      from: [0, 0],
      to: [10, 0],
    });
    expect(result.ok).toBe(true);

    const inputs = getSketchInputs(store, partId, sketchId);
    // editorModel should have 2 points + 1 line — but `from: [0, 0]`
    // coincides with the seeded origin, so `findOrCreatePoint`
    // merges into `pt_origin`. The user-visible count is 1 (just the
    // endpoint at [10, 0]); the line's startId IS the origin id, which
    // is the correct behavior — drawing from origin anchors the
    // line. Switch `from` to a non-origin coord (e.g. `[1, 1]`) to see
    // the un-merged 2-point case.
    expect(inputs.editorModel).toBeDefined();
    expect(userEditorState(inputs).points).toHaveLength(1);
    expect(userEditorState(inputs).geometries).toHaveLength(1);
    // entities should have 1 SketchLineEntity with the right coords.
    const entities = Object.values(sketchBuildGeometry(inputs));
    expect(entities).toHaveLength(1);
    expect(entities[0]!.type).toBe('line');
  });

  it('4 sequential SketchDrawLine calls form a closed quad (single shared-corner loop)', () => {
    // This is the smoke test for "MCP can build extrudable rectangles
    // by drawing 4 lines." The findOrCreatePoint logic inside drawLine
    // reuses ids when coordinates match within tolerance — so after
    // 4 dispatches we have exactly 4 points (shared corners) and a
    // closed loop the region detector picks up.
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    const lines: ReadonlyArray<[readonly [number, number], readonly [number, number]]> = [
      [[0, 0], [60, 0]],
      [[60, 0], [60, 30]],
      [[60, 30], [0, 30]],
      [[0, 30], [0, 0]],
    ];
    for (const [from, to] of lines) {
      const r = bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [from[0], from[1]], to: [to[0], to[1]] });
      expect(r.ok).toBe(true);
    }

    const inputs = getSketchInputs(store, partId, sketchId);
    // Shared corners: 4 points geometrically, but the [0, 0] corner
    // merges with the seeded origin so the user-visible count
    // is 3 (the [0,0] corner IS the origin, filtered out of
    // userEditorState).
    expect(userEditorState(inputs).points).toHaveLength(3);
    expect(userEditorState(inputs).geometries).toHaveLength(4);
    // Region detector finds an extrudable profile (the closed quad).
    const regions = detectSketchRegions(sketchBuildGeometry(inputs));
    expect(regions.length).toBeGreaterThanOrEqual(1);
    // Area should match 60×30 = 1800. The closest region wins.
    const quad = regions.find((r) => Math.abs(r.area - 1800) < 0.01);
    expect(quad).toBeDefined();
  });

  it('rejects non-finite coordinates with a clear validation error', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawLine',
      sketchId,
      from: [Number.NaN, 0],
      to: [10, 0],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/finite/);
  });

  it('rejects missing sketch with NOT_FOUND', () => {
    const { bus } = newHarness();
    const result = bus.dispatch({
      type: 'SketchDrawLine',
      sketchId: 'sketch_does_not_exist' as FeatureId,
      from: [0, 0],
      to: [1, 0],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ---- SketchDrawRectangle ---------------------------------------------------

describe('SketchDrawRectangle', () => {
  it('writes the 8-point + 4-edge + 8-constraint editor state and emits 4 line entities', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    const result = bus.dispatch({
      type: 'SketchDrawRectangle',
      sketchId,
      corner: [0, 0],
      width: 60,
      height: 30,
    });
    expect(result.ok).toBe(true);

    const inputs = getSketchInputs(store, partId, sketchId);
    // Canonical decomposition: 8 distinct corner points (one pair per
    // edge), 4 line geometries, 8 constraints (4 coincident + 2 H + 2 V).
    expect(userEditorState(inputs).points).toHaveLength(8);
    expect(userEditorState(inputs).geometries).toHaveLength(4);
    expect(userEditorState(inputs).constraints).toHaveLength(8);
    // The serializer emits one entity per geometry — no composite
    // collapse (invariant #11).
    const ents = Object.values(sketchBuildGeometry(inputs));
    expect(ents).toHaveLength(4);
    for (const ent of ents) {
      expect(ent.type).toBe('line');
    }
  });

  it('the resulting entities form a closed region detected by the region detector', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({
      type: 'SketchDrawRectangle',
      sketchId,
      corner: [0, 0],
      width: 40,
      height: 20,
    });
    const inputs = getSketchInputs(store, partId, sketchId);
    const regions = detectSketchRegions(sketchBuildGeometry(inputs));
    // The loop detector should find at least one closed quad with the
    // expected area.
    expect(regions.length).toBeGreaterThanOrEqual(1);
    const quad = regions.find((r) => Math.abs(r.area - 40 * 20) < 0.1);
    expect(quad).toBeDefined();
  });

  it('rejects zero-width and zero-height', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const r1 = bus.dispatch({
      type: 'SketchDrawRectangle',
      sketchId,
      corner: [0, 0],
      width: 0,
      height: 10,
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error.field).toBe('width');

    const r2 = bus.dispatch({
      type: 'SketchDrawRectangle',
      sketchId,
      corner: [0, 0],
      width: 10,
      height: 0,
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.field).toBe('height');
  });

  it('two rectangles in one sketch produce two profile regions', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawRectangle', sketchId, corner: [0, 0], width: 10, height: 10 });
    bus.dispatch({ type: 'SketchDrawRectangle', sketchId, corner: [20, 0], width: 10, height: 10 });
    const inputs = getSketchInputs(store, partId, sketchId);
    // Canonical decomposition: each rectangle contributes 8 points + 4 edges.
    expect(userEditorState(inputs).points).toHaveLength(16);
    expect(userEditorState(inputs).geometries).toHaveLength(8);
    const regions = detectSketchRegions(sketchBuildGeometry(inputs));
    // At least 2 — the simple rectangle detector finds both. The
    // planar graph may add more (split sub-faces) but never fewer.
    expect(regions.length).toBeGreaterThanOrEqual(2);
  });
});

// ---- SketchDrawCircle ------------------------------------------------------

describe('SketchDrawCircle', () => {
  it('writes a single SketchCircleEntity + 1 center point in editorModel', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawCircle',
      sketchId,
      center: [10, 10],
      radius: 5,
    });
    expect(result.ok).toBe(true);

    const inputs = getSketchInputs(store, partId, sketchId);
    expect(userEditorState(inputs).points).toHaveLength(1);
    expect(userEditorState(inputs).geometries).toHaveLength(1);
    const ents = Object.values(sketchBuildGeometry(inputs));
    expect(ents).toHaveLength(1);
    expect(ents[0]!.type).toBe('circle');
  });

  it('the resulting entity is found by the region detector as a circle', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [0, 0], radius: 5 });
    const inputs = getSketchInputs(store, partId, sketchId);
    const regions = detectSketchRegions(sketchBuildGeometry(inputs));
    expect(regions).toHaveLength(1);
    expect(regions[0]!.type).toBe('circle');
    expect(regions[0]!.area).toBeCloseTo(Math.PI * 25, 6);
  });

  it('rejects zero and negative radius', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const r1 = bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [0, 0], radius: 0 });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error.field).toBe('radius');

    const r2 = bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [0, 0], radius: -1 });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.field).toBe('radius');
  });
});

// ---- Mixed scenarios -------------------------------------------------------

describe('mixed drawing — incremental state', () => {
  it('a rectangle + a hole drawn as a circle yields 2 profile regions', () => {
    // Real-world MCP flow for "bracket with mounting hole": draw the
    // outer rectangle, then drill a circle inside. Both regions are
    // independently extrudable; downstream operations (extrude with
    // operation: 'subtract') would carve the hole out of the boss.
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({
      type: 'SketchDrawRectangle',
      sketchId,
      corner: [0, 0],
      width: 60,
      height: 30,
    });
    bus.dispatch({
      type: 'SketchDrawCircle',
      sketchId,
      center: [15, 15],
      radius: 3,
    });
    const inputs = getSketchInputs(store, partId, sketchId);
    const regions = detectSketchRegions(sketchBuildGeometry(inputs));
    // At least the rectangle and the circle; the planar walker may
    // also find an annular sub-region (rect minus circle) but never
    // fewer than the two we drew.
    expect(regions.length).toBeGreaterThanOrEqual(2);
    const types = new Set(regions.map((r) => r.type));
    expect(types.has('circle')).toBe(true);
  });
});

// ---- SketchDrawSlot --------------------------------------------------------

describe('SketchDrawSlot (decomposed: 2 lines + 2 arcs + constraints)', () => {
  it('emits 2 lines + 2 arcs + 4 coincident + 4 tangent + 1 equal + 1 parallel — no composite slot entity', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    const result = bus.dispatch({
      type: 'SketchDrawSlot',
      sketchId,
      center1: [0, 0],
      center2: [20, 0],
      width: 6,
    });
    expect(result.ok).toBe(true);

    const inputs = getSketchInputs(store, partId, sketchId);
    expect(inputs.editorModel).toBeDefined();
    // 2 centers + 8 distinct corner points (each line/arc owns its
    // endpoints). The center1 at [0, 0] merges with
    // the seeded origin → 9 user-visible points.
    expect(userEditorState(inputs).points).toHaveLength(9);
    // 2 lines + 2 arcs.
    expect(userEditorState(inputs).geometries).toHaveLength(4);
    const geomTypes = (userEditorState(inputs).geometries as Array<{ type: string }>)
      .map((g) => g.type).sort();
    expect(geomTypes).toEqual(['arc', 'arc', 'line', 'line']);
    // 4 coincident + 4 tangent + 1 equal + 1 parallel = 10 constraints.
    expect(userEditorState(inputs).constraints).toHaveLength(10);
    const conTypes = (userEditorState(inputs).constraints as Array<{ type: string }>)
      .map((c) => c.type)
      .sort();
    expect(conTypes).toEqual([
      'coincident', 'coincident', 'coincident', 'coincident',
      'equal',
      'parallel',
      'tangent', 'tangent', 'tangent', 'tangent',
    ]);
    // No composite slot entity in the serialized output — just lines + arcs.
    const entities = Object.values(sketchBuildGeometry(inputs)) as Array<{ type: string }>;
    const entityTypes = entities.map((e) => e.type).sort();
    expect(entityTypes).toEqual(['arc', 'arc', 'line', 'line']);
    expect(entityTypes).not.toContain('slot');
  });

  it('rejects zero-length slot (coincident centers)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawSlot',
      sketchId,
      center1: [5, 5],
      center2: [5, 5],
      width: 4,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.field).toBe('center2');
    }
  });

  it('rejects non-positive width', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawSlot',
      sketchId,
      center1: [0, 0],
      center2: [10, 0],
      width: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('width');
  });
});

// ---- SketchDrawPolygon -----------------------------------------------------

describe('SketchDrawPolygon (decomposed: N lines + center + constraints)', () => {
  it('hexagon emits 6 lines + 1 construction center + 6 coincident + 5 equal + 5 angle', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    const result = bus.dispatch({
      type: 'SketchDrawPolygon',
      sketchId,
      center: [0, 0],
      vertex: [10, 0],
      sides: 6,
    });
    expect(result.ok).toBe(true);

    const inputs = getSketchInputs(store, partId, sketchId);
    expect(inputs.editorModel).toBeDefined();
    // 1 center + 2*N = 13 distinct points, but `center: [0, 0]` merges
    // with the seeded origin so user-visible count is 12.
    expect(userEditorState(inputs).points).toHaveLength(12);
    // N lines + 1 construction-point geometry.
    expect(userEditorState(inputs).geometries).toHaveLength(7);
    // N coincident + (N-1) equal + (N-1) angle = 6+5+5 = 16 constraints.
    expect(userEditorState(inputs).constraints).toHaveLength(16);
    const conTypes = (userEditorState(inputs).constraints as Array<{ type: string }>)
      .map((c) => c.type)
      .sort();
    const counts: Record<string, number> = {};
    for (const t of conTypes) counts[t] = (counts[t] ?? 0) + 1;
    expect(counts['coincident']).toBe(6);
    expect(counts['equal']).toBe(5);
    expect(counts['angle']).toBe(5);
    // No composite polygon entity — only lines + the construction point.
    const entities = Object.values(sketchBuildGeometry(inputs)) as Array<{ type: string }>;
    const entityTypes = entities.map((e) => e.type).sort();
    expect(entityTypes).not.toContain('polygon');
  });

  it('rejects sides < 3', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawPolygon',
      sketchId,
      center: [0, 0],
      vertex: [10, 0],
      sides: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('sides');
  });

  it('rejects coincident center/vertex', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawPolygon',
      sketchId,
      center: [5, 5],
      vertex: [5, 5],
      sides: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('vertex');
  });

  it('rejects non-integer sides', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawPolygon',
      sketchId,
      center: [0, 0],
      vertex: [10, 0],
      sides: 4.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('sides');
  });
});

// ---- SketchDrawArc ---------------------------------------------------------

describe('SketchDrawArc', () => {
  it('writes an arc entity + 3 sketch points (center, start, end)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    const result = bus.dispatch({
      type: 'SketchDrawArc',
      sketchId,
      center: [0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2, // quarter-circle CCW
    });
    expect(result.ok).toBe(true);

    const inputs = getSketchInputs(store, partId, sketchId);
    // 3 points (center, start, end), but the center at [0, 0] merges
    // with the seeded origin → 2 user-visible points.
    expect(userEditorState(inputs).points).toHaveLength(2);
    expect(userEditorState(inputs).geometries).toHaveLength(1);
    const entities = Object.values(sketchBuildGeometry(inputs));
    expect(entities).toHaveLength(1);
    expect(entities[0]!.type).toBe('arc');
  });

  it('rejects zero-sweep arc (start === end)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawArc',
      sketchId,
      center: [0, 0],
      radius: 5,
      startAngle: 1,
      endAngle: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.field).toBe('endAngle');
    }
  });

  it('rejects non-positive radius', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchDrawArc',
      sketchId,
      center: [0, 0],
      radius: -1,
      startAngle: 0,
      endAngle: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.field).toBe('radius');
  });

  it('an arc joining two lines forms a closed loop (shared endpoints)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    // Two line segments meeting at the origin with a 90° arc bridging
    // their other ends. This pattern matters for keyhole-style profiles
    // and rounded-corner brackets.
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 10], to: [0, 0] });
    // Arc from (10, 0) CCW to (0, 10), center (0,0), r=10.
    bus.dispatch({
      type: 'SketchDrawArc',
      sketchId,
      center: [0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    const inputs = getSketchInputs(store, partId, sketchId);
    // Points: (0,0) shared by both lines + arc center (= origin),
    // (10,0) shared by line1+arc, (0,10) shared by line2+arc → 3
    // unique points, but (0, 0) IS the seeded origin so
    // user-visible count is 2.
    expect(userEditorState(inputs).points).toHaveLength(2);
    expect(userEditorState(inputs).geometries).toHaveLength(3); // 2 lines + arc
  });
});

// ---- CreateSketch validator ------------------------------------------------
//
// The validator rejects malformed `plane` payloads up-front instead of
// letting them silently reach the worker. This matters especially for
// MCP callers that build raw JSON — a caller sending
// `plane: "XY"` (string) used to dispatch successfully and fail at build,
// far from the dispatch site. With the validator hardened, they get a
// structured error in the same response.

describe('CreateSketch validation', () => {
  it('rejects a plane string ("XY") with a clear error', () => {
    const { bus, partId } = newHarness();
    // Cast through unknown to bypass TS — the real-world failure mode is
    // raw JSON from an MCP client, which has no compile-time check.
    const result = bus.dispatch({
      type: 'CreateSketch',
      partId,
      plane: 'XY' as unknown as { type: 'defaultPlane'; name: 'XY' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toMatch(/PlaneRef/);
    }
  });

  it('rejects a plane object with bad type', () => {
    const { bus, partId } = newHarness();
    const result = bus.dispatch({
      type: 'CreateSketch',
      partId,
      plane: { type: 'nope', name: 'XY' } as unknown as {
        type: 'defaultPlane';
        name: 'XY';
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.field).toBe('plane.type');
    }
  });

  it('rejects defaultPlane with invalid name', () => {
    const { bus, partId } = newHarness();
    const result = bus.dispatch({
      type: 'CreateSketch',
      partId,
      plane: { type: 'defaultPlane', name: 'XX' } as unknown as {
        type: 'defaultPlane';
        name: 'XY';
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('plane.name');
    }
  });

  it('accepts each of the three valid default planes', () => {
    for (const name of ['XY', 'YZ', 'XZ'] as const) {
      const { bus, partId } = newHarness();
      const result = bus.dispatch({
        type: 'CreateSketch',
        partId,
        plane: { type: 'defaultPlane', name },
      });
      expect(result.ok).toBe(true);
    }
  });

  it('accepts a constructionPlane ref', () => {
    const { bus, partId } = newHarness();
    const result = bus.dispatch({
      type: 'CreateSketch',
      partId,
      plane: { type: 'constructionPlane', planeId: 'cp_test' },
    });
    expect(result.ok).toBe(true);
  });
});

// ---- SketchApplyConstraint -------------------------------------------------

describe('SketchApplyConstraint', () => {
  it('records a horizontal constraint on a freshly drawn line', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 3] });
    const before = getSketchInputs(store, partId, sketchId);
    const lineGeomId = (before.editorModel!.geometries[0]! as { id: string }).id;

    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: lineGeomId as never },
    });
    expect(result.ok).toBe(true);

    const after = getSketchInputs(store, partId, sketchId);
    expect(userEditorState(after).constraints).toHaveLength(1);
    expect((userEditorState(after).constraints[0]! as { type: string }).type).toBe('horizontal');
  });

  it('rejects a malformed tangent constraint (both lineId and secondCircleId)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: {
        type: 'tangent',
        circleId: 'g_a' as never,
        lineId: 'g_b' as never,
        secondCircleId: 'g_c' as never,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/either lineId .* or secondCircleId/);
  });

  it('rejects an unknown constraint type', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'nonsense' as never } as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/unknown constraint type/);
  });

  it('rejects a missing sketch with NOT_FOUND', () => {
    const { bus } = newHarness();
    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId: 'no_such_sketch' as FeatureId,
      constraint: { type: 'horizontal', geometryId: 'g_a' as never },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  // Pre-commit solver behavior.

  it('runs the solver pre-commit so post-solve coords reflect the constraint', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    // Tilted line: applying horizontal should level it.
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 4] });
    const before = getSketchInputs(store, partId, sketchId);
    const lineGeom = before.editorModel!.geometries[0]! as {
      id: string; startId: string; endId: string;
    };

    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: lineGeom.id as never },
    });
    expect(result.ok).toBe(true);

    const after = getSketchInputs(store, partId, sketchId);
    const points = after.editorModel!.points as Array<{ id: string; y: number }>;
    const startPt = points.find((p) => p.id === lineGeom.startId)!;
    const endPt = points.find((p) => p.id === lineGeom.endId)!;
    expect(startPt.y).toBeCloseTo(endPt.y, 6);
  });

  it('dedupes equivalent constraints — second add is a no-op (state + undo unchanged)', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 3] });
    const inputs = getSketchInputs(store, partId, sketchId);
    const lineGeomId = (userEditorState(inputs).geometries[0]! as { id: string }).id;

    bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: lineGeomId as never },
    });
    const after1 = getSketchInputs(store, partId, sketchId);
    expect(userEditorState(after1).constraints).toHaveLength(1);

    // Snapshot undo state — second dispatch must not push an empty step.
    const canUndoBefore = bus.canUndo();
    const r2 = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: lineGeomId as never },
    });
    expect(r2.ok).toBe(true);

    const after2 = getSketchInputs(store, partId, sketchId);
    expect(userEditorState(after2).constraints).toHaveLength(1);
    // No-op recipe → no undo entry recorded.
    expect(bus.canUndo()).toBe(canUndoBefore);
  });

  it('rejects an over-constraining add and never lets it enter the document', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    // Tilted line whose endpoints we then pin in place.
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 5] });
    const inputs = getSketchInputs(store, partId, sketchId);
    const lineGeom = userEditorState(inputs).geometries[0]! as {
      id: string; startId: string; endId: string;
    };
    bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'fixed', pointId: lineGeom.startId as never, x: 0, y: 0 },
    });
    bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'fixed', pointId: lineGeom.endId as never, x: 10, y: 5 },
    });

    const before = getSketchInputs(store, partId, sketchId);
    const countBefore = userEditorState(before).constraints.length;

    // Horizontal on a fixed tilted line is geometrically impossible.
    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: lineGeom.id as never },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONSTRAINT_REJECTED');
      expect(result.error.message).toMatch(/horizontal/);
    }

    // The rejected constraint never landed in the doc.
    const after = getSketchInputs(store, partId, sketchId);
    expect(userEditorState(after).constraints).toHaveLength(countBefore);
    const hasHorizontal = (userEditorState(after).constraints as Array<{ type: string }>)
      .some((c) => c.type === 'horizontal');
    expect(hasHorizontal).toBe(false);
  });
});

describe('SketchRemoveConstraint', () => {
  it('removes a previously applied constraint', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 3] });
    const before = getSketchInputs(store, partId, sketchId);
    const lineGeomId = (before.editorModel!.geometries[0]! as { id: string }).id;
    bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: lineGeomId as never },
    });

    const afterApply = getSketchInputs(store, partId, sketchId);
    expect(userEditorState(afterApply).constraints).toHaveLength(1);
    const constraintId = (userEditorState(afterApply).constraints[0]! as { id: string }).id;

    const remove = bus.dispatch({ type: 'SketchRemoveConstraint', sketchId, constraintId: constraintId as never });
    expect(remove.ok).toBe(true);
    const afterRemove = getSketchInputs(store, partId, sketchId);
    expect(userEditorState(afterRemove).constraints).toHaveLength(0);
  });

  it('is idempotent on missing ids', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    const result = bus.dispatch({
      type: 'SketchRemoveConstraint',
      sketchId,
      constraintId: 'never_existed' as never,
    });
    expect(result.ok).toBe(true);
  });
});

describe('SketchSetConstruction', () => {
  // The bug this replaces: the Sketch Browser toggle wrote the editor store
  // directly and dispatched nothing, so the flag never reached `editorModel`
  // and the next hydration reverted it. Persistence is the point, so these
  // assert the *document*, not the store.
  function lineFixture() {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 3] });
    const inputs = getSketchInputs(store, partId, sketchId);
    const geometryId = (inputs.editorModel!.geometries[0]! as { id: string }).id;
    return { bus, store, partId, sketchId, geometryId };
  }

  function constructionOf(
    store: DocumentStore,
    partId: PartId,
    sketchId: FeatureId,
    geometryId: string,
  ): boolean | undefined {
    const geoms = getSketchInputs(store, partId, sketchId).editorModel!.geometries;
    const found = geoms.find((g) => (g as { id: string }).id === geometryId);
    return (found as { construction?: boolean } | undefined)?.construction;
  }

  it('writes the flag into editorModel', () => {
    const { bus, store, partId, sketchId, geometryId } = lineFixture();

    const res = bus.dispatch({
      type: 'SketchSetConstruction',
      sketchId,
      geometryId: geometryId as never,
      construction: true,
    });

    expect(res.ok).toBe(true);
    expect(constructionOf(store, partId, sketchId, geometryId)).toBe(true);
  });

  it('toggles back to real', () => {
    const { bus, store, partId, sketchId, geometryId } = lineFixture();
    bus.dispatch({
      type: 'SketchSetConstruction', sketchId, geometryId: geometryId as never, construction: true,
    });
    bus.dispatch({
      type: 'SketchSetConstruction', sketchId, geometryId: geometryId as never, construction: false,
    });
    expect(constructionOf(store, partId, sketchId, geometryId)).toBe(false);
  });

  it('is idempotent on a missing geometry', () => {
    const { bus, sketchId } = lineFixture();
    const res = bus.dispatch({
      type: 'SketchSetConstruction',
      sketchId,
      geometryId: 'geo_nope' as never,
      construction: true,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a non-boolean construction value', () => {
    const { bus, sketchId, geometryId } = lineFixture();
    const res = bus.dispatch({
      type: 'SketchSetConstruction',
      sketchId,
      geometryId: geometryId as never,
      construction: 'yes' as never,
    });
    expect(res.ok).toBe(false);
  });
});

describe('SketchApplyConstraint — a sketch that already has an unsatisfied constraint', () => {
  // An import, an edited dimension or a hand-edited file can leave a sketch
  // holding a constraint the solver cannot satisfy. Every later add used to
  // be rejected as "would break another already-satisfied constraint",
  // because the handler assumed nothing was unsatisfied before the add.
  function conflictedSketch() {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 20], to: [10, 23] });
    const geometries = getSketchInputs(store, partId, sketchId).editorModel!.geometries as Array<{
      id: string; startId: string; endId: string;
    }>;
    const pinned = geometries[0]!;
    const free = geometries[1]!;
    // Pin the first line's ends 10 mm apart, then demand 20 between them.
    store.mutate('Conflict', (draft) => {
      const sketch = draft.parts[partId]!.timeline.find((f) => f.id === sketchId)!;
      const model = (sketch.inputs as unknown as SketchFeatureInputs).editorModel as { constraints: unknown[] };
      model.constraints.push(
        { id: 'c_fix_a', type: 'fixed', pointId: pinned.startId, x: 0, y: 0 },
        { id: 'c_fix_b', type: 'fixed', pointId: pinned.endId, x: 10, y: 0 },
        { id: 'c_too_long', type: 'distance', pointA: pinned.startId, pointB: pinned.endId, value: 20 },
      );
    });
    return { bus, store, partId, sketchId, free };
  }

  it('accepts an unrelated constraint', () => {
    const { bus, store, partId, sketchId, free } = conflictedSketch();

    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: free.id as never },
    });

    expect(result.ok ? 'ok' : result.error.message).toBe('ok');
    const types = (userEditorState(getSketchInputs(store, partId, sketchId)).constraints as Array<{ type: string }>)
      .map((c) => c.type);
    expect(types).toContain('horizontal');
  });

  it('still rejects a constraint that cannot be satisfied', () => {
    const { bus, sketchId, free } = conflictedSketch();
    bus.dispatch({ type: 'SketchApplyConstraint', sketchId, constraint: { type: 'horizontal', geometryId: free.id as never } });

    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'vertical', geometryId: free.id as never },
    });

    expect(result.ok).toBe(false);
  });
});

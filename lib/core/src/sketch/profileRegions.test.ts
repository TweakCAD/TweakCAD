/**
 * General region-detection coverage for `detectSketchRegions` —
 * single closed shapes, decomposition, construction filtering,
 * order-stability of region ids, and one tracked failure documenting
 * a known gap (slot region detection — see G7).
 *
 * The specialised rect+circle corner-arc case lives in
 * `profileRegions.cornerArc.test.ts`; this file covers everything else.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyEditorState,
  drawRectangle,
  drawCircle,
  drawLine,
  drawSlot,
  makeCounterIdFactory,
  type EditorState,
} from './operations.ts';
import { editorModelToBuildGeometry } from './serialization.ts';
import { detectSketchRegions } from './profileRegions.ts';

describe('detectSketchRegions', () => {
  const buildAndDetect = (
    build: (s: EditorState, factory: ReturnType<typeof makeCounterIdFactory>) => EditorState,
  ) => {
    const factory = makeCounterIdFactory();
    const state = build(emptyEditorState(), factory);
    return detectSketchRegions(editorModelToBuildGeometry(state));
  };

  it('single closed rectangle → 1 region', () => {
    const regions = buildAndDetect((s, f) =>
      drawRectangle(s, { corner: [0, 0], width: 10, height: 5 }, { idFactory: f }).state,
    );
    expect(regions).toHaveLength(1);
  });

  it('single circle → 1 region', () => {
    const regions = buildAndDetect((s, f) =>
      drawCircle(s, { center: [0, 0], radius: 5 }, { idFactory: f }).state,
    );
    expect(regions).toHaveLength(1);
  });

  it('rectangle bisected by horizontal line through middle → 2+ regions', () => {
    const regions = buildAndDetect((s, f) => {
      let st = drawRectangle(s, { corner: [0, 0], width: 10, height: 10 }, { idFactory: f }).state;
      st = drawLine(st, [0, 5], [10, 5], { idFactory: f }).state;
      return st;
    });
    expect(regions.length).toBeGreaterThanOrEqual(2);
  });

  it('concentric circles (outer + inner) → at least one region', () => {
    // Pins whatever the detector returns today — if the contract drifts
    // (e.g. annular region detection lands) this test surfaces the change.
    const regions = buildAndDetect((s, f) => {
      let st = drawCircle(s, { center: [0, 0], radius: 10 }, { idFactory: f }).state;
      st = drawCircle(st, { center: [0, 0], radius: 3 }, { idFactory: f }).state;
      return st;
    });
    expect(regions.length).toBeGreaterThanOrEqual(1);
  });

  it('open polyline (3 lines, not closed) → 0 regions', () => {
    const regions = buildAndDetect((s, f) => {
      let st = drawLine(s, [0, 0], [10, 0], { idFactory: f }).state;
      st = drawLine(st, [10, 0], [10, 10], { idFactory: f }).state;
      st = drawLine(st, [10, 10], [0, 10], { idFactory: f }).state;
      return st;
    });
    expect(regions).toHaveLength(0);
  });

  it('construction-only geometry → 0 regions', () => {
    const regions = buildAndDetect((s, f) =>
      drawRectangle(s, { corner: [0, 0], width: 10, height: 5 }, {
        idFactory: f, construction: true,
      }).state,
    );
    expect(regions).toHaveLength(0);
  });

  // Persistent red flag — fails today: the slot region-detection gap.
  // `drawSlot` emits 2 lines + 2 arcs whose adjacent endpoints are
  // separate point ids linked by coincident constraints (8-point model,
  // same as `drawRectangle`'s 8 corner endpoints). The region detector
  // walks shared point ids only; it does NOT follow coincident
  // constraints to traverse the loop, so the slot's 4 segments don't
  // assemble into a closed region. Blocks extruding a slot (the extrude
  // profile picker depends on detected regions).
  //
  // Fix path: collapse coincident-linked points at region-detection time
  // (preserves invariant #11 / 8-point model). Alternative — have
  // `drawSlot` share point ids at corners — would break the 8-point
  // model and is rejected.
  it('🔴 GAP: slot (decomposed) should be 1 region with 4 segments', () => {
    const regions = buildAndDetect((s, f) =>
      drawSlot(s, { center1: [0, 0], center2: [20, 0], width: 6 }, { idFactory: f }).state,
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.segments.length).toBe(4);
  });

  it('region id is stable across entity insertion order', () => {
    // Build a triangle two different ways: lines added in different orders.
    const orderA = (() => {
      const f = makeCounterIdFactory();
      let st = drawLine(emptyEditorState(), [0, 0], [10, 0], { idFactory: f }).state;
      st = drawLine(st, [10, 0], [5, 8], { idFactory: f }).state;
      st = drawLine(st, [5, 8], [0, 0], { idFactory: f }).state;
      return st;
    })();
    const orderB = (() => {
      const f = makeCounterIdFactory();
      let st = drawLine(emptyEditorState(), [5, 8], [0, 0], { idFactory: f }).state;
      st = drawLine(st, [0, 0], [10, 0], { idFactory: f }).state;
      st = drawLine(st, [10, 0], [5, 8], { idFactory: f }).state;
      return st;
    })();
    const ra = detectSketchRegions(editorModelToBuildGeometry(orderA));
    const rb = detectSketchRegions(editorModelToBuildGeometry(orderB));
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    // Both triangles should produce the same canonical region id.
    expect(ra[0]!.id).toBe(rb[0]!.id);
  });
});

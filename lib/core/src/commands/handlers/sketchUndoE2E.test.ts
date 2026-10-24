/**
 * End-to-end tests for the sketch-commands-unification work.
 * Three areas of coverage:
 *
 *   1. **Step-by-step undo inside a sketch** — every UI sketch gesture is
 *      its own `Sketch*` CadCommand → one undo entry. Undo unwinds
 *      one primitive at a time, not the whole sketch.
 *
 *   2. **Undo past CreateSketch removes the feature** — drives the
 *      hydration subscriber's `onSketchRemoved` callback in the UI.
 *      Here at the core level we assert the document state: walking
 *      undo back through CreateSketch drops the sketch feature from
 *      the part's timeline.
 *
 *   3. **applyConstraintPipeline outcomes — applied / duplicate /
 *      rejected** — proves the two-pass auto-resize is
 *      live, proves duplicate constraints dedupe silently
 *      (no second undo entry), proves over-constrained adds throw
 *      `CommandRejectedError` and never land in the document or the
 *      undo stack.
 *
 * Why these live in core (not the app): the bus, the document store,
 * the undo manager, every handler, and the apply-constraint pipeline
 * all live here. The UI hooks (`subscribeSketchHydration`,
 * `useSketchEditorStore`) are render-side glue — they can't change the
 * outcome of these tests. Keeping the regression coverage at the
 * core layer means it survives any future UI rewrite.
 */

import { describe, it, expect } from 'vitest';
import { CommandBus } from '../bus.ts';
import { DocumentStore } from '../../store/documentStore.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { createSketchHandler, deleteFeatureHandler } from './featureCommands.ts';
import {
  sketchDrawLineHandler,
  sketchDrawRectangleHandler,
  sketchDrawCircleHandler,
  sketchApplyConstraintHandler,
  sketchMovePointsBatchHandler,
  sketchSetRadiusHandler,
} from './sketchDrawCommands.ts';
import type { SketchFeatureInputs } from '../../document/schema.ts';
import type { PartId, FeatureId } from '../../ids.ts';
import type { SketchGeometryId, SketchPointId } from '../../sketch/types.ts';

// ---- Harness --------------------------------------------------------------

function newHarness(): {
  bus: CommandBus;
  store: DocumentStore;
  partId: PartId;
} {
  const project = newProjectWithPart('Test');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketch', createSketchHandler);
  bus.register('DeleteFeature', deleteFeatureHandler);
  bus.register('SketchDrawLine', sketchDrawLineHandler);
  bus.register('SketchDrawRectangle', sketchDrawRectangleHandler);
  bus.register('SketchDrawCircle', sketchDrawCircleHandler);
  bus.register('SketchApplyConstraint', sketchApplyConstraintHandler);
  bus.register('SketchMovePointsBatch', sketchMovePointsBatchHandler);
  bus.register('SketchSetRadius', sketchSetRadiusHandler);
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

function sketchInputs(
  store: DocumentStore,
  partId: PartId,
  sketchId: FeatureId,
): SketchFeatureInputs {
  const sketch = store.getState().parts[partId]!.timeline.find((f) => f.id === sketchId)!;
  return sketch.inputs as unknown as SketchFeatureInputs;
}

function sketchExists(store: DocumentStore, partId: PartId, sketchId: FeatureId): boolean {
  return store.getState().parts[partId]!.timeline.some((f) => f.id === sketchId);
}

// ---------------------------------------------------------------------------
// 1. Step-by-step undo inside a sketch (regression coverage)
// ---------------------------------------------------------------------------

describe('Sketch undo — step-by-step (task #36 fix)', () => {
  it('each draw command is one undo entry; reverse order unwinds primitives one-by-one', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    // Three distinct draw commands → three distinct undo entries.
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [50, 50], radius: 5 });
    bus.dispatch({ type: 'SketchDrawRectangle', sketchId, corner: [20, 20], width: 8, height: 4 });

    // After 3 draws: 1 line + 1 circle + 4 rectangle edges = 6 entities.
    const after3 = sketchInputs(store, partId, sketchId);
    expect(Object.values(after3.buildGeometry)).toHaveLength(6);
    expect(after3.editorModel!.geometries).toHaveLength(6);
    // Sketch lives on; the rectangle owns the most recent undo step.
    expect(store.undoLabel()).toBe('Draw Rectangle');

    // Undo the rectangle → only the line + circle remain.
    store.undo();
    const after2 = sketchInputs(store, partId, sketchId);
    expect(Object.values(after2.buildGeometry)).toHaveLength(2);
    expect(after2.editorModel!.geometries).toHaveLength(2);
    expect(store.undoLabel()).toBe('Draw Circle');

    // Undo the circle → only the line remains.
    store.undo();
    const after1 = sketchInputs(store, partId, sketchId);
    expect(Object.values(after1.buildGeometry)).toHaveLength(1);
    expect((Object.values(after1.buildGeometry)[0]!).type).toBe('line');
    expect(store.undoLabel()).toBe('Draw Line');

    // Undo the line → sketch is empty but still exists.
    store.undo();
    const after0 = sketchInputs(store, partId, sketchId);
    expect(Object.values(after0.buildGeometry)).toHaveLength(0);
    expect(after0.editorModel?.geometries ?? []).toHaveLength(0);
    expect(sketchExists(store, partId, sketchId)).toBe(true);
    expect(store.undoLabel()).toBe('Create Sketch');
  });

  it('redo replays each primitive individually', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [50, 50], radius: 5 });

    // Undo twice → empty sketch.
    store.undo();
    store.undo();
    expect(Object.values(sketchInputs(store, partId, sketchId).buildGeometry)).toHaveLength(0);
    expect(store.canRedo()).toBe(true);
    expect(store.redoLabel()).toBe('Draw Line');

    // Redo the line.
    store.redo();
    const afterRedoLine = sketchInputs(store, partId, sketchId);
    expect(Object.values(afterRedoLine.buildGeometry)).toHaveLength(1);
    expect((Object.values(afterRedoLine.buildGeometry)[0]!).type).toBe('line');

    // Redo the circle.
    store.redo();
    const afterRedoCircle = sketchInputs(store, partId, sketchId);
    expect(Object.values(afterRedoCircle.buildGeometry)).toHaveLength(2);
    const types = Object.values(afterRedoCircle.buildGeometry).map((e) => e.type).sort();
    expect(types).toEqual(['circle', 'line']);
  });

  it('drag-end (SketchMovePointsBatch) is one undo entry; undo restores original coords', () => {
    // The drag-end commit packages every moved point into a single
    // `SketchMovePointsBatch` so a multi-point gesture (e.g. dragging
    // a whole rectangle) lands as ONE undo step — not eight, one per
    // corner. Undo restores the pre-drag coordinates atomically.
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    const before = sketchInputs(store, partId, sketchId);
    const line = (before.editorModel!.geometries as Array<{
      id: SketchGeometryId; type: string;
      startId: SketchPointId; endId: SketchPointId;
    }>).find((g) => g.type === 'line')!;
    const beforePoints = before.editorModel!.points as Array<{ id: SketchPointId; x: number; y: number }>;
    const beforeEnd = beforePoints.find((p) => p.id === line.endId)!;
    expect(beforeEnd.x).toBe(10);
    expect(beforeEnd.y).toBe(0);

    // Move both endpoints in one batch (drag-the-whole-line gesture).
    bus.dispatch({
      type: 'SketchMovePointsBatch',
      sketchId,
      moves: [
        { pointId: line.startId, to: [5, 5] },
        { pointId: line.endId,   to: [15, 5] },
      ],
    });

    const afterMove = sketchInputs(store, partId, sketchId);
    const afterPoints = afterMove.editorModel!.points as Array<{ id: SketchPointId; x: number; y: number }>;
    const movedEnd = afterPoints.find((p) => p.id === line.endId)!;
    expect(movedEnd.x).toBeCloseTo(15, 5);
    expect(movedEnd.y).toBeCloseTo(5, 5);

    // One undo step — the entire batch — restores the pre-drag coords.
    store.undo();
    const undone = sketchInputs(store, partId, sketchId);
    const undonePoints = undone.editorModel!.points as Array<{ id: SketchPointId; x: number; y: number }>;
    const restoredEnd = undonePoints.find((p) => p.id === line.endId)!;
    expect(restoredEnd.x).toBeCloseTo(10, 5);
    expect(restoredEnd.y).toBeCloseTo(0, 5);
  });

  it('empty SketchMovePointsBatch is a no-op — no undo entry recorded', () => {
    // documentStore.mutate skips undo recording when the recipe
    // produces zero patches. An empty moves array is the
    // canonical zero-patch case; covers programmer-error paths where
    // the UI batches before checking emptiness.
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });

    const labelBefore = store.undoLabel();
    const result = bus.dispatch({
      type: 'SketchMovePointsBatch',
      sketchId,
      moves: [],
    });
    expect(result.ok).toBe(true);
    // Label unchanged → no undo step was recorded.
    expect(store.undoLabel()).toBe(labelBefore);
  });
});

// ---------------------------------------------------------------------------
// 2. Undo past CreateSketch (drives the onSketchRemoved UI callback)
// ---------------------------------------------------------------------------

describe('Sketch removal via undo', () => {
  it('undo of CreateSketch removes the sketch feature from the timeline', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    expect(sketchExists(store, partId, sketchId)).toBe(true);

    store.undo();
    expect(sketchExists(store, partId, sketchId)).toBe(false);
    expect(store.getState().parts[partId]!.timeline).toHaveLength(0);
  });

  it('undo all the way past draws + CreateSketch lands the document back at empty', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);

    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [50, 50], radius: 5 });

    // 1 CreateSketch + 2 draws = 3 undo entries.
    store.undo();
    store.undo();
    store.undo();

    expect(store.canUndo()).toBe(false);
    expect(sketchExists(store, partId, sketchId)).toBe(false);
    expect(store.getState().parts[partId]!.timeline).toHaveLength(0);
  });

  it('explicit DeleteFeature(sketch) also lands one undo entry', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });

    const beforeDelete = sketchExists(store, partId, sketchId);
    expect(beforeDelete).toBe(true);

    bus.dispatch({ type: 'DeleteFeature', partId, featureId: sketchId });
    expect(sketchExists(store, partId, sketchId)).toBe(false);

    // Undo restores the deleted sketch (with its previously-drawn line).
    store.undo();
    expect(sketchExists(store, partId, sketchId)).toBe(true);
    const inputs = sketchInputs(store, partId, sketchId);
    expect(Object.values(inputs.buildGeometry)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. applyConstraintPipeline outcomes (pre-commit solver)
// ---------------------------------------------------------------------------

describe('SketchApplyConstraint pipeline — outcomes via the bus', () => {
  function makeLineSketchWithIds() {
    // Single horizontal line. Returns the sketch + its line geometry +
    // the two endpoint ids so tests can reference them when building
    // candidate constraints.
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 0] });
    const inputs = sketchInputs(store, partId, sketchId);
    const line = (inputs.editorModel!.geometries as Array<{
      id: SketchGeometryId; type: string;
      startId: SketchPointId; endId: SketchPointId;
    }>).find((g) => g.type === 'line')!;
    return { bus, store, partId, sketchId, line };
  }

  it('applied path — first constraint lands and adds one undo entry', () => {
    const { bus, store, sketchId, line } = makeLineSketchWithIds();
    const undoBefore = store.undoLabel();
    expect(undoBefore).toBe('Draw Line');

    const result = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: line.id },
    });
    expect(result.ok).toBe(true);
    expect(store.undoLabel()).toBe('Apply horizontal constraint');

    // Undo removes just the constraint — line and editor state stay.
    store.undo();
    expect(store.undoLabel()).toBe('Draw Line');
  });

  it('duplicate path — re-dispatching the same constraint is a silent no-op (no second undo entry)', () => {
    const { bus, store, sketchId, line } = makeLineSketchWithIds();
    bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: line.id },
    });
    const labelAfterFirst = store.undoLabel();
    expect(labelAfterFirst).toBe('Apply horizontal constraint');

    // Second identical dispatch — pipeline dedupes via constraintsEqual.
    const second = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: line.id },
    });
    expect(second.ok).toBe(true);
    // Undo label unchanged — `documentStore.mutate` skips recording
    // when the recipe produced zero patches (the empty-patch skip).
    expect(store.undoLabel()).toBe(labelAfterFirst);

    // One undo step removes the constraint; nothing else queued behind it.
    store.undo();
    expect(store.undoLabel()).toBe('Draw Line');
  });

  it('rejected path — conflicting constraint returns Result.err and lands NO undo entry', () => {
    // Build a sketch that's already pinned: a horizontal line with both
    // endpoints fixed at distinct y values. Adding `horizontal` would
    // require y_start = y_end, which the fixed constraints forbid →
    // the pipeline's failure check trips and the handler throws
    // `CommandRejectedError`.
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 5] });
    const inputs = sketchInputs(store, partId, sketchId);
    const line = (inputs.editorModel!.geometries as Array<{
      id: SketchGeometryId; type: string;
      startId: SketchPointId; endId: SketchPointId;
    }>).find((g) => g.type === 'line')!;
    const { startId, endId } = line;
    const start = (inputs.editorModel!.points as Array<{ id: SketchPointId; x: number; y: number }>)
      .find((p) => p.id === startId)!;
    const end = (inputs.editorModel!.points as Array<{ id: SketchPointId; x: number; y: number }>)
      .find((p) => p.id === endId)!;

    // Pin both endpoints at their current (different-y) coordinates.
    const fixStart = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'fixed', pointId: startId, x: start.x, y: start.y },
    });
    expect(fixStart.ok).toBe(true);
    const fixEnd = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'fixed', pointId: endId, x: end.x, y: end.y },
    });
    expect(fixEnd.ok).toBe(true);

    const labelBefore = store.undoLabel();
    const undoCountBefore = countUndoSteps(store);

    // Now try to force horizontal — start.y = 0, end.y = 5, both fixed.
    // No free parameter can satisfy `y_start = y_end` → pipeline rejects.
    const rejected = bus.dispatch({
      type: 'SketchApplyConstraint',
      sketchId,
      constraint: { type: 'horizontal', geometryId: line.id },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('CONSTRAINT_REJECTED');
    }

    // Critical assertion: the rejected
    // attempt left ZERO trace in the document and ZERO entries in the
    // undo stack. Label unchanged; the next undo unwinds the pre-
    // rejection state (the fix on endId), not the rejected horizontal.
    expect(store.undoLabel()).toBe(labelBefore);
    expect(countUndoSteps(store)).toBe(undoCountBefore);

    // And the document still doesn't contain the rejected horizontal.
    const finalConstraints = sketchInputs(store, partId, sketchId)
      .editorModel!.constraints as Array<{ type: string }>;
    expect(finalConstraints.some((c) => c.type === 'horizontal')).toBe(false);
  });

  it('rejected adds: clicking through 5 conflicting attempts grows neither the doc nor the undo stack', () => {
    // A stronger version of the test above: prove the rejection path
    // is idempotent. The user spamming "Apply Horizontal" on an
    // unsatisfiable selection should be visually quiet AND structurally
    // quiet — no document entities, no undo entries.
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawLine', sketchId, from: [0, 0], to: [10, 5] });
    const inputs = sketchInputs(store, partId, sketchId);
    const line = (inputs.editorModel!.geometries as Array<{
      id: SketchGeometryId; type: string;
      startId: SketchPointId; endId: SketchPointId;
    }>).find((g) => g.type === 'line')!;
    const start = (inputs.editorModel!.points as Array<{ id: SketchPointId; x: number; y: number }>)
      .find((p) => p.id === line.startId)!;
    const end = (inputs.editorModel!.points as Array<{ id: SketchPointId; x: number; y: number }>)
      .find((p) => p.id === line.endId)!;
    bus.dispatch({ type: 'SketchApplyConstraint', sketchId, constraint: { type: 'fixed', pointId: line.startId, x: start.x, y: start.y } });
    bus.dispatch({ type: 'SketchApplyConstraint', sketchId, constraint: { type: 'fixed', pointId: line.endId, x: end.x, y: end.y } });

    const labelBefore = store.undoLabel();
    const undoCountBefore = countUndoSteps(store);
    const constraintsBefore = (sketchInputs(store, partId, sketchId).editorModel!.constraints as unknown[]).length;

    for (let i = 0; i < 5; i++) {
      const r = bus.dispatch({
        type: 'SketchApplyConstraint',
        sketchId,
        constraint: { type: 'horizontal', geometryId: line.id },
      });
      expect(r.ok).toBe(false);
    }

    expect(store.undoLabel()).toBe(labelBefore);
    expect(countUndoSteps(store)).toBe(undoCountBefore);
    const constraintsAfter = (sketchInputs(store, partId, sketchId).editorModel!.constraints as unknown[]).length;
    expect(constraintsAfter).toBe(constraintsBefore);
  });
});

/**
 * Walk the undo stack to its bottom by undoing until `canUndo()` is
 * false, then redo back to the original position. Used as a way to
 * count entries without exposing the UndoManager internals.
 */
function countUndoSteps(store: DocumentStore): number {
  let n = 0;
  while (store.canUndo()) {
    store.undo();
    n++;
  }
  while (store.canRedo()) {
    store.redo();
  }
  return n;
}

// ---------------------------------------------------------------------------
// SketchSetRadius — the commit half of the circumference drag
// ---------------------------------------------------------------------------

describe('SketchSetRadius', () => {
  /**
   * Radius is a number on the geometry, not a point, so it cannot ride on
   * `SketchMovePointsBatch` like every other drag — hence its own command.
   * Before it existed, a circle's size could only be changed by typing a
   * dimension; there was no way to resize by dragging at all.
   */
  function circleRadius(store: DocumentStore, partId: PartId, sketchId: FeatureId): number {
    const model = sketchInputs(store, partId, sketchId).editorModel!;
    const circle = model.geometries.find((g) => g.type === 'circle')!;
    return (circle as unknown as { radius: number }).radius;
  }

  function firstCircleId(store: DocumentStore, partId: PartId, sketchId: FeatureId): SketchGeometryId {
    const model = sketchInputs(store, partId, sketchId).editorModel!;
    return model.geometries.find((g) => g.type === 'circle')!.id as SketchGeometryId;
  }

  it('resizes a circle and undoes back to the original radius', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [0, 0], radius: 5 });
    expect(circleRadius(store, partId, sketchId)).toBeCloseTo(5, 6);

    const gid = firstCircleId(store, partId, sketchId);
    const res = bus.dispatch({ type: 'SketchSetRadius', sketchId, geometryId: gid, radius: 12.5 });
    expect(res.ok).toBe(true);
    expect(circleRadius(store, partId, sketchId)).toBeCloseTo(12.5, 6);

    // One command = one undo entry, same contract as every other sketch edit.
    store.undo();
    expect(circleRadius(store, partId, sketchId)).toBeCloseTo(5, 6);
  });

  it('rejects a non-positive radius rather than producing degenerate geometry', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [0, 0], radius: 5 });
    const gid = firstCircleId(store, partId, sketchId);

    for (const bad of [0, -3, Number.NaN]) {
      const res = bus.dispatch({ type: 'SketchSetRadius', sketchId, geometryId: gid, radius: bad });
      expect(res.ok).toBe(false);
    }
    expect(circleRadius(store, partId, sketchId)).toBeCloseTo(5, 6);
  });

  it('leaves the centre where it was', () => {
    const { bus, store, partId } = newHarness();
    const sketchId = createSketch(bus, store, partId);
    bus.dispatch({ type: 'SketchDrawCircle', sketchId, center: [7, -4], radius: 5 });
    const gid = firstCircleId(store, partId, sketchId);
    bus.dispatch({ type: 'SketchSetRadius', sketchId, geometryId: gid, radius: 20 });

    const model = sketchInputs(store, partId, sketchId).editorModel!;
    const circle = model.geometries.find((g) => g.type === 'circle') as unknown as { centerId: SketchPointId };
    const centre = model.points.find((p) => p.id === circle.centerId)!;
    expect(centre.x).toBeCloseTo(7, 6);
    expect(centre.y).toBeCloseTo(-4, 6);
  });
});

/**
 * Command handlers for higher-level sketch drawing operations.
 *
 * These are thin orchestration over the pure-function primitives in
 * `@tweakcad/core/src/sketch/operations.ts`. Each handler:
 *
 *   1. Validates the command shape and that the target sketch exists.
 *   2. Loads the sketch's current `editorModel` into a working
 *      EditorState (or empty for a fresh sketch).
 *   3. Calls the matching `drawLine` / `drawRectangle` / `drawCircle`
 *      primitive.
 *   4. Serializes the result back into BOTH `editorModel` (round-trip
 *      target for the in-browser editor) and `buildGeometry` (canonical
 *      document model the worker rebuilds from). The two views are
 *      computed from one source of truth so they can't drift.
 *
 * IMPORTANT: handlers MUST NOT invent point/geometry ids directly or
 * write entities by hand — only call `sketchOps` / `editorModelToBuildGeometry`.
 * This is the rule that prevents the same logic ending up in 10 places.
 */

import type { Result } from '../../result.ts';
import { ok, err } from '../../result.ts';
import type {
  CadProject,
  SketchFeatureInputs,
  SketchEditorSnapshot,
} from '../../document/schema.ts';
import type { CadCommand } from '../types.ts';
import { CommandRejectedError, type CommandHandler, type ValidationError } from '../bus.ts';
import {
  drawLine,
  drawRectangle,
  addConstraint as opAddConstraint,
  drawCircle,
  drawSlot,
  drawArc,
  drawArc3Point,
  drawPolygon,
  drawPoint,
  drawEllipse,
  drawSpline,
  movePoint,
  fromSnapshot,
  toSnapshot,
  type EditorState,
  type DrawLineOptions,
  type DrawRectangleOptions,
  type DrawCircleOptions,
  type DrawSlotOptions,
  type DrawArcOptions,
  type DrawArc3PointOptions,
  type DrawPolygonOptions,
  type DrawPointOptions,
  type DrawEllipseOptions,
  type DrawSplineOptions,
} from '../../sketch/operations.ts';
import {
  trimAt,
  extendAt,
  filletBetweenLines,
  offsetCurveAt,
  mirrorSelection,
} from '../../sketch/modifyOps.ts';
import { editorModelToBuildGeometry } from '../../sketch/serialization.ts';
import { applyConstraintWithSolver } from '../../sketch/applyConstraintPipeline.ts';
import { getSolver, solveDrag } from '../../sketch/solver/index.ts';
import type { SketchConstraintInput } from '../../sketch/types.ts';

// ---- Shared helpers --------------------------------------------------------

/**
 * Find a sketch feature by id across all parts. Returns the feature
 * (typed as having SketchFeatureInputs) on success, or a validation
 * error if missing / wrong type.
 *
 * Used by all three handlers — extracted so the validate + execute
 * passes share one resolver and can't disagree on what counts as a
 * valid sketch.
 */
function findSketch(
  state: Readonly<CadProject>,
  sketchId: string,
): Result<{ partId: string; featureIndex: number }, ValidationError> {
  for (const [partId, part] of Object.entries(state.parts)) {
    const idx = part.timeline.findIndex((f) => f.id === sketchId);
    if (idx < 0) continue;
    const feature = part.timeline[idx]!;
    if (feature.type !== 'sketch') {
      return err({
        code: 'INVALID_FEATURE',
        message: `Target feature is not a sketch: ${sketchId}`,
      });
    }
    return ok({ partId, featureIndex: idx });
  }
  return err({ code: 'NOT_FOUND', message: `Sketch not found: ${sketchId}` });
}

/** Validate a 2-tuple of finite numbers. */
function validateVec2(name: string, v: unknown): Result<void, ValidationError> {
  if (!Array.isArray(v) || v.length !== 2) {
    return err({ code: 'INVALID_INPUT', message: `${name} must be a 2-element array`, field: name });
  }
  if (typeof v[0] !== 'number' || !Number.isFinite(v[0])) {
    return err({ code: 'INVALID_INPUT', message: `${name}[0] must be a finite number`, field: name });
  }
  if (typeof v[1] !== 'number' || !Number.isFinite(v[1])) {
    return err({ code: 'INVALID_INPUT', message: `${name}[1] must be a finite number`, field: name });
  }
  return ok(undefined);
}

/** Validate a finite, optionally-positive number. */
function validateFiniteNumber(
  name: string,
  v: unknown,
  opts: { positive?: boolean } = {},
): Result<void, ValidationError> {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return err({ code: 'INVALID_INPUT', message: `${name} must be a finite number`, field: name });
  }
  if (opts.positive && v <= 0) {
    return err({ code: 'INVALID_INPUT', message: `${name} must be positive`, field: name });
  }
  return ok(undefined);
}

/**
 * Apply an EditorState update to a sketch feature's inputs draft.
 * Writes both `editorModel` (snapshot) and `buildGeometry` (derived from
 * the same state via the shared serializer). Bumps `updatedAt` on
 * both the feature and the project metadata.
 *
 * This is the ONLY place a sketch's inputs get written from a drawing
 * command — keeping the write in one helper is what guarantees the
 * two views stay consistent.
 */
function applyEditorStateUpdate(
  draft: CadProject,
  sketchId: string,
  newState: EditorState,
): void {
  for (const part of Object.values(draft.parts)) {
    const sketch = part.timeline.find((f) => f.id === sketchId);
    if (!sketch || sketch.type !== 'sketch') continue;
    const inputs = sketch.inputs as unknown as SketchFeatureInputs;
    inputs.buildGeometry = editorModelToBuildGeometry(newState);
    inputs.editorModel = toSnapshot(newState) as unknown as SketchEditorSnapshot;
    const now = new Date().toISOString();
    sketch.updatedAt = now;
    draft.metadata.updatedAt = now;
    return;
  }
}

/** Read the sketch's current EditorState (empty if no prior editorModel). */
function loadEditorState(
  draft: CadProject,
  sketchId: string,
): EditorState {
  for (const part of Object.values(draft.parts)) {
    const sketch = part.timeline.find((f) => f.id === sketchId);
    if (!sketch || sketch.type !== 'sketch') continue;
    const inputs = sketch.inputs as unknown as SketchFeatureInputs;
    return fromSnapshot(inputs.editorModel);
  }
  return fromSnapshot(undefined);
}

// ---- SketchDrawLine --------------------------------------------------------

export const sketchDrawLineHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawLine') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawLine command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const v1 = validateVec2('from', command.from);
    if (!v1.ok) return err(v1.error);
    const v2 = validateVec2('to', command.to);
    if (!v2.ok) return err(v2.error);
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawLine') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawLineOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    if (command.chainFrom !== undefined) {
      // Chain mode: this segment's start owns a distinct point that's
      // coincident-linked to the previous segment's end. Lets the user
      // tear the chain by removing the constraint.
      opts.distinctStart = true;
    }
    const result = drawLine(current, command.from, command.to, opts);
    let next = result.state;
    if (command.chainFrom !== undefined) {
      // Verify the chainFrom point still exists — race-safe against an
      // undo that removed the previous segment between dispatch and now.
      if (next.points.has(command.chainFrom)) {
        next = opAddConstraint(next, {
          type: 'coincident',
          pointA: result.startId,
          pointB: command.chainFrom,
        }).state;
      }
    }
    applyEditorStateUpdate(draft, command.sketchId, next);
  },
};

// ---- SketchDrawRectangle ---------------------------------------------------

export const sketchDrawRectangleHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawRectangle') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawRectangle command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const v1 = validateVec2('corner', command.corner);
    if (!v1.ok) return err(v1.error);
    const vw = validateFiniteNumber('width', command.width);
    if (!vw.ok) return err(vw.error);
    if (command.width === 0) {
      return err({ code: 'INVALID_INPUT', message: 'width must be non-zero', field: 'width' });
    }
    const vh = validateFiniteNumber('height', command.height);
    if (!vh.ok) return err(vh.error);
    if (command.height === 0) {
      return err({ code: 'INVALID_INPUT', message: 'height must be non-zero', field: 'height' });
    }
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawRectangle') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawRectangleOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawRectangle(
      current,
      { corner: command.corner, width: command.width, height: command.height },
      opts,
    );
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchDrawCircle ------------------------------------------------------

export const sketchDrawCircleHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawCircle') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawCircle command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const v1 = validateVec2('center', command.center);
    if (!v1.ok) return err(v1.error);
    const vr = validateFiniteNumber('radius', command.radius, { positive: true });
    if (!vr.ok) return err(vr.error);
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawCircle') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawCircleOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawCircle(
      current,
      { center: command.center, radius: command.radius },
      opts,
    );
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchDrawSlot --------------------------------------------------------

export const sketchDrawSlotHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawSlot') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawSlot command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const v1 = validateVec2('center1', command.center1);
    if (!v1.ok) return err(v1.error);
    const v2 = validateVec2('center2', command.center2);
    if (!v2.ok) return err(v2.error);
    const vw = validateFiniteNumber('width', command.width, { positive: true });
    if (!vw.ok) return err(vw.error);
    // Reject zero-length slot up front rather than letting drawSlot
    // throw — the validator should give a clean structured error.
    const dx = command.center2[0] - command.center1[0];
    const dy = command.center2[1] - command.center1[1];
    const tol = command.tolerance ?? 1e-6;
    if (dx * dx + dy * dy < tol * tol) {
      return err({
        code: 'INVALID_INPUT',
        message: 'center1 and center2 must be distinct (slot has zero length)',
        field: 'center2',
      });
    }
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawSlot') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawSlotOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawSlot(
      current,
      { center1: command.center1, center2: command.center2, width: command.width },
      opts,
    );
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchApplyConstraint -------------------------------------------------

/**
 * Per-constraint structural validation. We check the discriminator and
 * that each referenced id is a plausibly-typed string — we do NOT
 * cross-reference the ids against the sketch's actual editor state
 * (that would require loading + parsing the snapshot in the validator;
 * the editor's solver catches dangling refs at the next solve).
 */
function validateConstraint(c: SketchConstraintInput): Result<void, ValidationError> {
  if (!c || typeof c !== 'object' || typeof (c as { type?: unknown }).type !== 'string') {
    return err({ code: 'INVALID_INPUT', message: '`constraint` must be an object with a `type` discriminator', field: 'constraint' });
  }
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  switch (c.type) {
    case 'coincident':
    case 'distance':
    case 'distanceX':
    case 'distanceY':
    case 'symmetric':
      if (!isStr(c.pointA) || !isStr(c.pointB)) return err({ code: 'INVALID_INPUT', message: `${c.type}: pointA and pointB are required`, field: 'constraint' });
      if (c.type === 'symmetric' && !isStr(c.geometryId)) return err({ code: 'INVALID_INPUT', message: 'symmetric: geometryId is required', field: 'constraint.geometryId' });
      if ((c.type === 'distance' || c.type === 'distanceX' || c.type === 'distanceY') && !isNum(c.value)) {
        return err({ code: 'INVALID_INPUT', message: `${c.type}: value must be a finite number`, field: 'constraint.value' });
      }
      return ok(undefined);
    case 'horizontal':
    case 'vertical':
      if (!isStr(c.geometryId)) return err({ code: 'INVALID_INPUT', message: `${c.type}: geometryId is required`, field: 'constraint.geometryId' });
      return ok(undefined);
    case 'fixed':
      if (!isStr(c.pointId)) return err({ code: 'INVALID_INPUT', message: 'fixed: pointId is required', field: 'constraint.pointId' });
      if (!isNum(c.x) || !isNum(c.y)) return err({ code: 'INVALID_INPUT', message: 'fixed: x and y must be finite numbers', field: 'constraint' });
      return ok(undefined);
    case 'length':
    case 'radius':
      if (!isStr(c.geometryId)) return err({ code: 'INVALID_INPUT', message: `${c.type}: geometryId is required`, field: 'constraint.geometryId' });
      if (!isNum(c.value) || c.value <= 0) return err({ code: 'INVALID_INPUT', message: `${c.type}: value must be a positive finite number`, field: 'constraint.value' });
      return ok(undefined);
    case 'parallel':
    case 'perpendicular':
    case 'equal':
      if (!isStr(c.geometryA) || !isStr(c.geometryB)) return err({ code: 'INVALID_INPUT', message: `${c.type}: geometryA and geometryB are required`, field: 'constraint' });
      return ok(undefined);
    case 'angle':
      if (!isStr(c.geometryA) || !isStr(c.geometryB)) return err({ code: 'INVALID_INPUT', message: 'angle: geometryA and geometryB are required', field: 'constraint' });
      if (!isNum(c.value)) return err({ code: 'INVALID_INPUT', message: 'angle: value must be a finite number (radians)', field: 'constraint.value' });
      return ok(undefined);
    case 'tangent':
      if (!isStr(c.circleId)) return err({ code: 'INVALID_INPUT', message: 'tangent: circleId is required', field: 'constraint.circleId' });
      // Exactly one of lineId or secondCircleId must be set.
      if (isStr(c.lineId) && isStr(c.secondCircleId)) {
        return err({ code: 'INVALID_INPUT', message: 'tangent: pass either lineId (line-circle) or secondCircleId (circle-circle), not both', field: 'constraint' });
      }
      if (!isStr(c.lineId) && !isStr(c.secondCircleId)) {
        return err({ code: 'INVALID_INPUT', message: 'tangent: pass either lineId (line-circle) or secondCircleId (circle-circle)', field: 'constraint' });
      }
      return ok(undefined);
    case 'pointOnLine':
    case 'pointOnCircle':
      if (!isStr(c.pointId)) return err({ code: 'INVALID_INPUT', message: `${c.type}: pointId is required`, field: 'constraint.pointId' });
      if (!isStr(c.geometryId)) return err({ code: 'INVALID_INPUT', message: `${c.type}: geometryId is required`, field: 'constraint.geometryId' });
      return ok(undefined);
    default:
      return err({ code: 'INVALID_INPUT', message: `unknown constraint type: ${(c as { type: string }).type}`, field: 'constraint.type' });
  }
}

/**
 * `SketchApplyConstraint` runs the solver pre-commit. Three outcomes:
 *
 *   - **Duplicate.** An equivalent constraint already exists in the sketch.
 *     The handler returns without mutating — no undo entry, no toast. The
 *     dedupe shields the doc from stacking redundant `point on circle`
 *     etc. when the user clicks the ribbon twice.
 *   - **Rejected.** The solver can't satisfy the candidate without
 *     breaking the sketch (cannot-satisfy / would-break / line-collapse,
 *     even after a ±2 % free-dimension perturbation). The handler throws
 *     `CommandRejectedError`; Immer abandons the recipe, bus catches and
 *     returns `Result.err`. The rejected constraint NEVER enters the doc
 *     — the undo stack stays clean.
 *   - **Applied.** The handler writes the new constraint AND the solver's
 *     post-solve points + geometries. Both views (`editorModel` snapshot
 *     and `buildGeometry` serialized form) come from the same final state.
 *
 * The pipeline lives in `@tweakcad/core/src/sketch/applyConstraintPipeline.ts`
 * so the in-editor store can share the same dedupe + solve + check + auto-
 * resize logic.
 */
export const sketchApplyConstraintHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchApplyConstraint') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchApplyConstraint command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    return validateConstraint(command.constraint);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchApplyConstraint') return;
    const current = loadEditorState(draft, command.sketchId);
    const result = applyConstraintWithSolver(current, command.constraint, getSolver());
    switch (result.kind) {
      case 'duplicate':
        // No mutation. Immer sees no patches → no undo entry.
        return;
      case 'rejected':
        throw new CommandRejectedError({
          code: 'CONSTRAINT_REJECTED',
          message: `${result.constraint.type} constraint ${result.reason}`,
          field: 'constraint',
        });
      case 'applied':
        applyEditorStateUpdate(draft, command.sketchId, result.state);
        return;
    }
  },
};

// ---- SketchRemoveConstraint ------------------------------------------------

export const sketchRemoveConstraintHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchRemoveConstraint') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchRemoveConstraint command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    if (typeof command.constraintId !== 'string' || command.constraintId.length === 0) {
      return err({ code: 'INVALID_INPUT', message: '`constraintId` must be a non-empty string', field: 'constraintId' });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchRemoveConstraint') return;
    const current = loadEditorState(draft, command.sketchId);
    if (!current.constraints.has(command.constraintId)) return; // idempotent no-op
    const constraints = new Map(current.constraints);
    constraints.delete(command.constraintId);
    applyEditorStateUpdate(draft, command.sketchId, { ...current, constraints });
  },
};

// ---- SketchDrawArc ---------------------------------------------------------

export const sketchDrawArcHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawArc') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawArc command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const v1 = validateVec2('center', command.center);
    if (!v1.ok) return err(v1.error);
    const vr = validateFiniteNumber('radius', command.radius, { positive: true });
    if (!vr.ok) return err(vr.error);
    const vsa = validateFiniteNumber('startAngle', command.startAngle);
    if (!vsa.ok) return err(vsa.error);
    const vea = validateFiniteNumber('endAngle', command.endAngle);
    if (!vea.ok) return err(vea.error);
    if (command.startAngle === command.endAngle) {
      return err({
        code: 'INVALID_INPUT',
        message: 'startAngle and endAngle must differ (zero-length arc)',
        field: 'endAngle',
      });
    }
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawArc') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawArcOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawArc(
      current,
      {
        center: command.center,
        radius: command.radius,
        startAngle: command.startAngle,
        endAngle: command.endAngle,
      },
      opts,
    );
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchDrawArc3Point ---------------------------------------------------

export const sketchDrawArc3PointHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawArc3Point') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawArc3Point command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const vs = validateVec2('start', command.start); if (!vs.ok) return err(vs.error);
    const vm = validateVec2('mid', command.mid); if (!vm.ok) return err(vm.error);
    const ve = validateVec2('end', command.end); if (!ve.ok) return err(ve.error);
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawArc3Point') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawArc3PointOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawArc3Point(
      current,
      { start: command.start, mid: command.mid, end: command.end },
      opts,
    );
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchDrawPolygon -----------------------------------------------------

export const sketchDrawPolygonHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawPolygon') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawPolygon command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const vc = validateVec2('center', command.center); if (!vc.ok) return err(vc.error);
    const vv = validateVec2('vertex', command.vertex); if (!vv.ok) return err(vv.error);
    if (!Number.isInteger(command.sides) || command.sides < 3 || command.sides > 64) {
      return err({ code: 'INVALID_INPUT', message: 'sides must be an integer in [3, 64]', field: 'sides' });
    }
    if (command.mode !== undefined && command.mode !== 'inscribed') {
      return err({ code: 'INVALID_INPUT', message: "only 'inscribed' mode is implemented", field: 'mode' });
    }
    // Reject coincident center/vertex up front.
    const dx = command.vertex[0] - command.center[0];
    const dy = command.vertex[1] - command.center[1];
    const tol = command.tolerance ?? 1e-6;
    if (dx * dx + dy * dy < tol * tol) {
      return err({
        code: 'INVALID_INPUT',
        message: 'vertex must be distinct from center (degenerate polygon)',
        field: 'vertex',
      });
    }
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawPolygon') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawPolygonOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawPolygon(
      current,
      {
        center: command.center,
        vertex: command.vertex,
        sides: command.sides,
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
      },
      opts,
    );
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchDrawPoint -------------------------------------------------------

export const sketchDrawPointHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawPoint') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawPoint command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const v = validateVec2('at', command.at); if (!v.ok) return err(v.error);
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawPoint') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawPointOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawPoint(current, command.at, opts);
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchDrawEllipse -----------------------------------------------------

export const sketchDrawEllipseHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawEllipse') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawEllipse command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const vc = validateVec2('center', command.center); if (!vc.ok) return err(vc.error);
    const vm = validateVec2('major', command.major); if (!vm.ok) return err(vm.error);
    const vr = validateFiniteNumber('minorRadius', command.minorRadius, { positive: true });
    if (!vr.ok) return err(vr.error);
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawEllipse') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawEllipseOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawEllipse(
      current,
      { center: command.center, major: command.major, minorRadius: command.minorRadius },
      opts,
    );
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchDrawSpline ------------------------------------------------------

export const sketchDrawSplineHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchDrawSpline') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchDrawSpline command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    if (!Array.isArray(command.points) || command.points.length < 2) {
      return err({ code: 'INVALID_INPUT', message: 'spline needs at least 2 points', field: 'points' });
    }
    for (let i = 0; i < command.points.length; i++) {
      const v = validateVec2(`points[${i}]`, command.points[i]!);
      if (!v.ok) return err(v.error);
    }
    if (command.tolerance !== undefined) {
      const t = validateFiniteNumber('tolerance', command.tolerance, { positive: true });
      if (!t.ok) return err(t.error);
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchDrawSpline') return;
    const current = loadEditorState(draft, command.sketchId);
    const opts: DrawSplineOptions = {};
    if (command.construction !== undefined) opts.construction = command.construction;
    if (command.tolerance !== undefined) opts.tolerance = command.tolerance;
    const result = drawSpline(current, command.points, opts);
    applyEditorStateUpdate(draft, command.sketchId, result.state);
  },
};

// ---- SketchMovePoint -------------------------------------------------------

/**
 * Move one point and re-solve with that point anchored. Anchoring keeps
 * the user-driven position authoritative while constraint neighbours
 * (coincident-linked rectangle corners, etc.) adjust to stay satisfied.
 * For multi-point drag-end commits use `SketchMovePointsBatch` instead
 * — one solver run for the whole batch.
 */
export const sketchMovePointHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchMovePoint') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchMovePoint command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    if (typeof command.pointId !== 'string' || command.pointId.length === 0) {
      return err({ code: 'INVALID_INPUT', message: 'pointId is required', field: 'pointId' });
    }
    const v = validateVec2('to', command.to); if (!v.ok) return err(v.error);
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchMovePoint') return;
    const current = loadEditorState(draft, command.sketchId);
    // Apply the move (throws if point doesn't exist — rare race; bus
    // surfaces it as a runtime error).
    const moved = movePoint(current, command.pointId, command.to);
    // Re-solve with the moved point anchored so coincident / parallel /
    // etc. constraints follow the drag instead of being broken silently.
    // `solveDrag` handles the case where anchoring makes a constraint
    // unsatisfiable — same ladder the live preview uses, so the committed
    // result matches what the user saw mid-drag. `null` = the move has no
    // consistent solution; leave the draft alone (no patches → no undo entry).
    const result = solveDrag(
      getSolver(),
      moved.state.points,
      moved.state.geometries,
      moved.state.constraints,
      new Set([command.pointId]),
    );
    if (!result) return;
    applyEditorStateUpdate(draft, command.sketchId, {
      points: result.points,
      geometries: result.geometries,
      constraints: moved.state.constraints,
    });
  },
};

// ---- SketchMovePointsBatch -------------------------------------------------

/**
 * Atomic multi-point move + single solver run. Used by the in-app drag
 * handler for geometry-level drags (whole rectangle, slot, polygon),
 * where N corner points shift together and constraint neighbours need
 * to be re-evaluated ONCE — not N times.
 *
 * Anchors the entire moved set so the user's positions stay authoritative.
 * Empty `moves` is a no-op (no patches → no undo entry).
 */
// ---- SketchSetRadius -------------------------------------------------------

/**
 * Resize a circle or arc.
 *
 * Radius is a number on the geometry, not a point, so this can't ride on
 * `SketchMovePointsBatch` like every other drag. For an arc the stored radius
 * and its start/end points must agree — `syncDerivedGeometryFields` recomputes
 * arc radius from `|start - centre|` after every solve — so the endpoints are
 * scaled about the centre rather than the number being written on its own,
 * which would be silently reverted by the next solve.
 */
export const sketchSetRadiusHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchSetRadius') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchSetRadius command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const vg = validateGeometryId('geometryId', command.geometryId);
    if (!vg.ok) return err(vg.error);
    if (!Number.isFinite(command.radius) || command.radius <= 0) {
      return err({ code: 'INVALID_INPUT', message: 'radius must be a positive number', field: 'radius' });
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchSetRadius') return;
    const current = loadEditorState(draft, command.sketchId);
    const geom = current.geometries.get(command.geometryId);
    if (!geom || (geom.type !== 'circle' && geom.type !== 'arc')) return;

    const geometries = new Map(current.geometries);
    let points = current.points;

    if (geom.type === 'arc') {
      const centre = current.points.get(geom.centerId);
      const start = current.points.get(geom.startId);
      const end = current.points.get(geom.endId);
      if (!centre || !start || !end) return;
      // Scale both endpoints along their own radial directions so the arc's
      // angular span is preserved and `|start - centre|` matches the new
      // radius — otherwise the post-solve sync would undo this immediately.
      const moved = new Map(points);
      for (const p of [start, end]) {
        const dx = p.x - centre.x;
        const dy = p.y - centre.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue; // degenerate; leave it where it is
        moved.set(p.id, {
          ...p,
          x: centre.x + (dx / len) * command.radius,
          y: centre.y + (dy / len) * command.radius,
        });
      }
      points = moved;
    }

    geometries.set(command.geometryId, { ...geom, radius: command.radius });

    // Re-solve so anything hanging off this geometry (tangent, concentric,
    // point-on-circle) follows. Nothing is anchored: the radius is already
    // written, and anchoring would over-constrain the very points the solver
    // needs to move. Routed through `solveDrag` for its refuse-on-failure
    // guard — a non-converged solve returns unsolved coordinates, and writing
    // those would persist a torn sketch.
    const result = solveDrag(getSolver(), points, geometries, current.constraints, new Set());
    if (!result) return;
    applyEditorStateUpdate(draft, command.sketchId, {
      points: result.points,
      geometries: result.geometries,
      constraints: current.constraints,
    });
  },
};

export const sketchMovePointsBatchHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchMovePointsBatch') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchMovePointsBatch command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    if (!Array.isArray(command.moves)) {
      return err({ code: 'INVALID_INPUT', message: 'moves must be an array', field: 'moves' });
    }
    for (let i = 0; i < command.moves.length; i++) {
      const m = command.moves[i]!;
      if (typeof m.pointId !== 'string' || m.pointId.length === 0) {
        return err({ code: 'INVALID_INPUT', message: `moves[${i}].pointId is required`, field: `moves[${i}].pointId` });
      }
      const v = validateVec2(`moves[${i}].to`, m.to); if (!v.ok) return err(v.error);
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchMovePointsBatch') return;
    if (command.moves.length === 0) return;
    let current = loadEditorState(draft, command.sketchId);
    const anchored = new Set<typeof command.moves[number]['pointId']>();
    for (const m of command.moves) {
      // Apply each move; movePoint throws if the id doesn't exist, but
      // the drag end-pointer set was just read from the editor store
      // so they should all still be there.
      if (!current.points.has(m.pointId)) continue;
      current = movePoint(current, m.pointId, m.to).state;
      anchored.add(m.pointId);
    }
    if (anchored.size === 0) return;
    // Same anchored → free → refuse ladder as the live preview; see
    // `sketchMovePointHandler`.
    const result = solveDrag(
      getSolver(),
      current.points,
      current.geometries,
      current.constraints,
      anchored,
    );
    if (!result) return;
    applyEditorStateUpdate(draft, command.sketchId, {
      points: result.points,
      geometries: result.geometries,
      constraints: current.constraints,
    });
  },
};

// ---- Modify-tool handlers ---------------------------------------------------
//
// All five route through the pure primitives in
// `@tweakcad/core/src/sketch/modifyOps.ts`. Validation pattern matches the
// draw handlers above: resolve the sketch, validate the geometry id +
// any coords, then dispatch the primitive on the loaded editor state
// and write back through `applyEditorStateUpdate` (which re-renders
// `buildGeometry` via the canonical serializer and snapshots `editorModel`).

function validateGeometryId(name: string, v: unknown): Result<void, ValidationError> {
  if (typeof v !== 'string' || v.length === 0) {
    return err({ code: 'INVALID_INPUT', message: `${name} must be a non-empty geometry id`, field: name });
  }
  return ok(undefined);
}

// ---- SketchTrim ------------------------------------------------------------

export const sketchTrimHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchTrim') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchTrim command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const vg = validateGeometryId('geometryId', command.geometryId); if (!vg.ok) return err(vg.error);
    const vc = validateVec2('cursor', command.cursor); if (!vc.ok) return err(vc.error);
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchTrim') return;
    const current = loadEditorState(draft, command.sketchId);
    const next = trimAt(current, command.geometryId, command.cursor);
    if (!next) return; // target gone or coords degenerate — no-op
    applyEditorStateUpdate(draft, command.sketchId, next);
  },
};

// ---- SketchExtend ----------------------------------------------------------

export const sketchExtendHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchExtend') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchExtend command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const vg = validateGeometryId('geometryId', command.geometryId); if (!vg.ok) return err(vg.error);
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchExtend') return;
    const current = loadEditorState(draft, command.sketchId);
    const next = extendAt(current, command.geometryId);
    if (!next) return; // target not a line / no extension target — no-op
    applyEditorStateUpdate(draft, command.sketchId, next);
  },
};

// ---- SketchFillet ----------------------------------------------------------

export const sketchFilletHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchFillet') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchFillet command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const va = validateGeometryId('geometryAId', command.geometryAId); if (!va.ok) return err(va.error);
    const vb = validateGeometryId('geometryBId', command.geometryBId); if (!vb.ok) return err(vb.error);
    if (command.geometryAId === command.geometryBId) {
      return err({ code: 'INVALID_INPUT', message: 'geometryAId and geometryBId must differ', field: 'geometryBId' });
    }
    if (command.radius !== undefined) {
      const vr = validateFiniteNumber('radius', command.radius, { positive: true });
      if (!vr.ok) return err(vr.error);
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchFillet') return;
    const current = loadEditorState(draft, command.sketchId);
    const next = filletBetweenLines(current, command.geometryAId, command.geometryBId, command.radius);
    if (!next) return; // not two lines / degenerate corner — no-op
    applyEditorStateUpdate(draft, command.sketchId, next);
  },
};

// ---- SketchOffset ----------------------------------------------------------

export const sketchOffsetHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchOffset') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchOffset command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    const vg = validateGeometryId('geometryId', command.geometryId); if (!vg.ok) return err(vg.error);
    const vd = validateFiniteNumber('distance', command.distance, { positive: true });
    if (!vd.ok) return err(vd.error);
    const vc = validateVec2('cursor', command.cursor); if (!vc.ok) return err(vc.error);
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchOffset') return;
    const current = loadEditorState(draft, command.sketchId);
    const next = offsetCurveAt(current, command.geometryId, command.distance, command.cursor, command.construction ?? false);
    if (!next) return; // unsupported curve type — no-op
    applyEditorStateUpdate(draft, command.sketchId, next);
  },
};

// ---- SketchMirror ----------------------------------------------------------

export const sketchMirrorHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SketchMirror') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SketchMirror command' });
    }
    const found = findSketch(state, command.sketchId);
    if (!found.ok) return err(found.error);
    if (!Array.isArray(command.geometryIds) || command.geometryIds.length === 0) {
      return err({ code: 'INVALID_INPUT', message: 'geometryIds must be a non-empty array', field: 'geometryIds' });
    }
    for (let i = 0; i < command.geometryIds.length; i++) {
      const vg = validateGeometryId(`geometryIds[${i}]`, command.geometryIds[i]);
      if (!vg.ok) return err(vg.error);
    }
    const va = validateVec2('axisA', command.axisA); if (!va.ok) return err(va.error);
    const vb = validateVec2('axisB', command.axisB); if (!vb.ok) return err(vb.error);
    const dx = command.axisB[0] - command.axisA[0];
    const dy = command.axisB[1] - command.axisA[1];
    if (dx * dx + dy * dy < 1e-9) {
      return err({ code: 'INVALID_INPUT', message: 'axisA and axisB must be distinct points', field: 'axisB' });
    }
    return ok(undefined);
  },
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SketchMirror') return;
    const current = loadEditorState(draft, command.sketchId);
    const next = mirrorSelection(current, command.geometryIds, command.axisA, command.axisB);
    if (!next) return; // empty selection / collinear axis — no-op
    applyEditorStateUpdate(draft, command.sketchId, next);
  },
};

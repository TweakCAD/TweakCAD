/**
 * Command handlers for Feature operations (sketch, extrude, hole, etc.).
 */

import { isEmptyImportedData } from '../../document/importedData.ts';
import type { Result } from '../../result.ts';
import { ok, err } from '../../result.ts';
import type { CadProject, FeatureNode, SketchFeatureInputs } from '../../document/schema.ts';
import type { PartId, FeatureId } from '../../ids.ts';
import { generateId, featureId } from '../../ids.ts';
import type { CadCommand } from '../types.ts';
import type { CommandHandler, ValidationError } from '../bus.ts';
import { ORIGIN_POINT_ID, ORIGIN_CONSTRAINT_ID } from '../../sketch/types.ts';
import type { SketchGeometryId } from '../../sketch/types.ts';
import type { SketchEditorSnapshot } from '../../document/schema.ts';
import {
  fromSnapshot,
  toSnapshot,
  removeGeometry as removeGeometryOp,
  type EditorState,
} from '../../sketch/operations.ts';

/** Find a part or return a validation error */
function findPart(state: Readonly<CadProject>, id: PartId): Result<void, ValidationError> {
  if (!state.parts[id]) {
    return err({ code: 'NOT_FOUND', message: `Part not found: ${id}` });
  }
  return ok(undefined);
}

/**
 * Validate a {@link PlaneRef} discriminated-union payload. TypeScript
 * enforces the shape at compile time for in-process callers, but anything
 * coming through MCP / `dispatch_command` is raw JSON — a caller that
 * sends `plane: "XY"` (string) would silently reach the worker and fail
 * far from the dispatch site. Rejecting up-front here gives the caller a
 * clear, actionable error in the same response.
 *
 * Mirrors the `PlaneRef` union in `document/schema.ts`.
 */
function validatePlaneRef(value: unknown, field: string): Result<void, ValidationError> {
  if (value === null || typeof value !== 'object') {
    return err({
      code: 'INVALID_INPUT',
      message: `${field} must be a PlaneRef object, e.g. { type: 'defaultPlane', name: 'XY' }. Got: ${typeof value === 'string' ? `string "${value}"` : typeof value}.`,
      field,
    });
  }
  const ref = value as Record<string, unknown>;
  switch (ref.type) {
    case 'defaultPlane': {
      if (ref.name !== 'XY' && ref.name !== 'YZ' && ref.name !== 'XZ') {
        return err({
          code: 'INVALID_INPUT',
          message: `${field}.name must be one of 'XY' | 'YZ' | 'XZ'. Got: ${String(ref.name)}.`,
          field: `${field}.name`,
        });
      }
      return ok(undefined);
    }
    case 'constructionPlane': {
      if (typeof ref.planeId !== 'string' || ref.planeId.length === 0) {
        return err({
          code: 'INVALID_INPUT',
          message: `${field}.planeId must be a non-empty string.`,
          field: `${field}.planeId`,
        });
      }
      return ok(undefined);
    }
    case 'featureOutput': {
      if (typeof ref.featureId !== 'string' || ref.featureId.length === 0) {
        return err({
          code: 'INVALID_INPUT',
          message: `${field}.featureId must be a non-empty string.`,
          field: `${field}.featureId`,
        });
      }
      return ok(undefined);
    }
    case 'stableTopology': {
      if (ref.bodyRef === undefined || ref.stableFaceId === undefined) {
        return err({
          code: 'INVALID_INPUT',
          message: `${field} of type 'stableTopology' requires bodyRef and stableFaceId.`,
          field,
        });
      }
      return ok(undefined);
    }
    default:
      return err({
        code: 'INVALID_INPUT',
        message: `${field}.type must be one of 'defaultPlane' | 'constructionPlane' | 'featureOutput' | 'stableTopology'. Got: ${String(ref.type)}.`,
        field: `${field}.type`,
      });
  }
}

/** Find a feature in a part's timeline */
function findFeature(
  state: Readonly<CadProject>,
  partId: PartId,
  featureIdVal: FeatureId,
): Result<{ feature: FeatureNode; index: number }, ValidationError> {
  const part = state.parts[partId];
  if (!part) return err({ code: 'NOT_FOUND', message: `Part not found: ${partId}` });
  const index = part.timeline.findIndex(f => f.id === featureIdVal);
  if (index < 0) {
    return err({ code: 'NOT_FOUND', message: `Feature not found: ${featureIdVal}` });
  }
  const feature = part.timeline[index];
  if (!feature) return err({ code: 'NOT_FOUND', message: `Feature not found at index: ${index}` });
  return ok({ feature, index });
}

export const createSketchHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateSketch') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateSketch command' });
    }
    const partCheck = findPart(state, command.partId);
    if (!partCheck.ok) return partCheck;
    return validatePlaneRef(command.plane, 'plane');
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateSketch') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('sketch'));
    const now = new Date().toISOString();
    // Seed every new sketch with an origin point at
    // (0, 0), pinned by a `fixed` constraint. Without this, no sketch can
    // ever reach DOF = 0 — the entire sketch can still translate in X+Y
    // (and rotate, until any H/V constraint pins orientation against the
    // sketch plane's implicit axes). The "Fully defined" badge would
    // essentially never trigger. With the anchor, a fully-dimensioned
    // rectangle + 1 H + 1 V on its sides + 1 coincident on a corner with
    // the origin → DOF = 0.
    //
    // Well-known ids (`pt_origin` / `con_origin_fixed`) let the UI
    // special-case the origin: render it with the anchor glyph, block
    // deletion, hide it from the points list in the Browser. The
    // counter-id factory used in tests starts at `pt_1` / `con_1` so
    // there's no collision risk.
    const inputs: SketchFeatureInputs = {
      plane: command.plane,
      editorModel: {
        points: [{ id: ORIGIN_POINT_ID, x: 0, y: 0, fixed: true }],
        geometries: [],
        constraints: [{
          id: ORIGIN_CONSTRAINT_ID,
          type: 'fixed',
          pointId: ORIGIN_POINT_ID,
          x: 0,
          y: 0,
        }],
      },
    };

    const feature: FeatureNode = {
      id,
      type: 'sketch',
      name: `Sketch ${part.timeline.filter(f => f.type === 'sketch').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

/**
 * Create a sketch pre-populated from an imported `EditorState` snapshot
 * (DXF import). Mirrors `createSketchHandler` for the plane / feature
 * half, but seeds the supplied `editorState` instead of just the origin
 * and derives `inputs.buildGeometry` from it via the canonical serializer — so
 * the whole import is ONE undo entry.
 */
export const createSketchFromImportHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateSketchFromImport') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateSketchFromImport command' });
    }
    const partCheck = findPart(state, command.partId);
    if (!partCheck.ok) return partCheck;
    const planeCheck = validatePlaneRef(command.plane, 'plane');
    if (!planeCheck.ok) return planeCheck;
    const snap = command.editorState as unknown;
    if (
      !snap || typeof snap !== 'object' ||
      !Array.isArray((snap as { points?: unknown }).points) ||
      !Array.isArray((snap as { geometries?: unknown }).geometries) ||
      !Array.isArray((snap as { constraints?: unknown }).constraints)
    ) {
      return err({
        code: 'INVALID_INPUT',
        message: 'editorState must be a snapshot with points / geometries / constraints arrays',
        field: 'editorState',
      });
    }
    if ((snap as { geometries: unknown[] }).geometries.length === 0) {
      return err({
        code: 'INVALID_INPUT',
        message: 'editorState has no geometry — nothing to import',
        field: 'editorState',
      });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateSketchFromImport') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('sketch'));
    const now = new Date().toISOString();
    // Reconstitute the supplied snapshot into a working EditorState so we
    // can derive the canonical `buildGeometry` map from the SAME source — the
    // two views can't drift (same guarantee as the draw-command handlers).
    const editorState = fromSnapshot(command.editorState as unknown as {
      points?: readonly unknown[];
      geometries?: readonly unknown[];
      constraints?: readonly unknown[];
    });

    const inputs: SketchFeatureInputs = {
      plane: command.plane,
      editorModel: toSnapshot(editorState) as unknown as SketchEditorSnapshot,
    };

    const feature: FeatureNode = {
      id,
      type: 'sketch',
      name: command.name ?? `Sketch ${part.timeline.filter(f => f.type === 'sketch').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

// `addSketchEntityHandler` was retired with the buildGeometry collapse. It
// wrote a raw entity into the derived projection and never touched
// `editorModel`, so even before the field became derived the next `Sketch*`
// command regenerated the projection and discarded it. Nothing dispatched
// it. Use the per-primitive `Sketch*` draw handlers, which mutate the
// editor model everything else derives from.

// `replaceSketchEntitiesHandler` was retired during the sketch-commands
// unification. Its sole caller
// (Shell.tsx `syncSketchToDocument`) is gone; the per-primitive
// `Sketch*` handlers already rebuild `inputs.buildGeometry` and snapshot
// `editorModel` after every mutation, so a "replace all" command had
// nothing to add. See `ReplaceSketchEntitiesCommand`'s retirement note
// in commands/types.ts for the migration path if a future flow needs
// atomic sketch swap.

export const removeSketchEntityHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'RemoveSketchEntity') {
      return err({ code: 'WRONG_TYPE', message: 'Expected RemoveSketchEntity command' });
    }
    for (const part of Object.values(state.parts)) {
      const found = part.timeline.find(f => f.id === command.sketchId);
      if (found) {
        if (found.type !== 'sketch') {
          return err({ code: 'INVALID_FEATURE', message: 'Target feature is not a sketch' });
        }
        return ok(undefined);
      }
    }
    return err({ code: 'NOT_FOUND', message: `Sketch not found: ${command.sketchId}` });
  },

  /**
   * Remove the entity from the sketch's editor state and rebuild both
   * `inputs.buildGeometry` (the canonical dictionary) and `inputs.editorModel`
   * (snapshot the in-app editor hydrates from) from the resulting state.
   *
   * **Why this is the only correct shape.** The handler used to do just
   * `delete inputs.buildGeometry[command.entityId]` and leave `editorModel`
   * intact. That broke the editor's source-of-truth contract: the
   * hydration subscriber reads `editorModel`, so it never saw the
   * deletion, and the next dispatch that did touch `editorModel` (a
   * drag-end, a new circle, anything) rebuilt `buildGeometry` *from*
   * `editorModel` — putting the "deleted" entry back. Routing through
   * the shared `removeGeometry` op (operations.ts) keeps both fields
   * derived from the same `EditorState`, identical to how
   * `sketchRemoveConstraintHandler` already worked.
   *
   * `entityId` on this command is the geometry id (per
   * `editorModelToBuildGeometry`, which emits one entity per geometry with
   * matching ids). Non-existent ids are a silent no-op.
   */
  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'RemoveSketchEntity') return;
    for (const part of Object.values(draft.parts)) {
      const sketch = part.timeline.find(f => f.id === command.sketchId);
      if (!sketch || sketch.type !== 'sketch') continue;

      const inputs = sketch.inputs as unknown as SketchFeatureInputs;
      const current: EditorState = fromSnapshot(inputs.editorModel);
      const result = removeGeometryOp(current, command.entityId as unknown as SketchGeometryId);
      if (!result.removedGeometry) return; // idempotent no-op

      inputs.editorModel = toSnapshot(result.state) as unknown as SketchEditorSnapshot;
      const now = new Date().toISOString();
      sketch.updatedAt = now;
      draft.metadata.updatedAt = now;
      return;
    }
  },
};

export const createExtrudeHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateExtrude') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateExtrude command' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateExtrude') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('extrude'));
    const now = new Date().toISOString();

    // Determine dependencies from profile references
    const deps: FeatureId[] = [];
    const rawInputs = command.inputs as Record<string, unknown>;
    const profiles = (rawInputs.profiles as unknown[]) ?? [];
    const seenSketchIds = new Set<string>();
    for (const profile of profiles as { sketchId?: string }[]) {
      const sketchId = profile.sketchId;
      if (sketchId && !seenSketchIds.has(sketchId)) {
        seenSketchIds.add(sketchId);
        deps.push(sketchId as FeatureId);
      }
    }

    const feature: FeatureNode = {
      id,
      type: 'extrude',
      name: `Extrude ${part.timeline.filter(f => f.type === 'extrude').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createRevolveHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateRevolve') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateRevolve command' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateRevolve') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('revolve'));
    const now = new Date().toISOString();

    const sketchDep = command.inputs.profile?.sketchId;
    const deps: FeatureId[] = sketchDep ? [sketchDep as FeatureId] : [];

    const feature: FeatureNode = {
      id,
      type: 'revolve',
      name: `Revolve ${part.timeline.filter(f => f.type === 'revolve').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createFilletHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateFillet') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateFillet command' });
    }
    const edges = command.inputs.edges;
    if (!Array.isArray(edges) || edges.length === 0) {
      return err({ code: 'INVALID_INPUT', message: 'Fillet requires at least one edge' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateFillet') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('fillet'));
    const now = new Date().toISOString();

    // Dependency: every upstream feature whose body this fillet touches.
    // We derive that from the bodyRefs on the edge references. For now we
    // record per-bodyId; the rebuilder resolves bodyId → producing feature
    // via the bodyToFeature map. (A future iteration could thread the
    // feature ids straight through but this matches how mirror/pattern
    // already work in the schema.)
    const featureDeps = new Set<string>();
    if (command.inputs.targetBody) {
      // Could resolve via bodyToFeature here; for now leave deps empty and
      // let the rebuilder schedule on body-availability.
    }
    for (const ref of command.inputs.edges) {
      if (ref.type === 'stableTopology') {
        // Record bodyId — actual feature dep is added by the rebuilder.
        featureDeps.add(String(ref.bodyRef.bodyId));
      }
    }
    // No-op for now: dependsOn is the upstream FeatureNode ids, not body
    // ids, so leave empty. The rebuilder topological sort already runs
    // strictly in timeline order, which is sufficient for a fillet that
    // always touches whatever body was produced before it.
    const deps: FeatureId[] = [];

    const feature: FeatureNode = {
      id,
      type: 'fillet',
      name: `Fillet ${part.timeline.filter(f => f.type === 'fillet').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createChamferHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateChamfer') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateChamfer command' });
    }
    const edges = command.inputs.edges;
    if (!Array.isArray(edges) || edges.length === 0) {
      return err({ code: 'INVALID_INPUT', message: 'Chamfer requires at least one edge' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateChamfer') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('chamfer'));
    const now = new Date().toISOString();

    // Same dependency strategy as Fillet — leave dependsOn empty and
    // rely on timeline order. A future iteration can resolve bodyId →
    // producing feature via the rebuilder's bodyToFeature map, same
    // way it's planned for fillet.
    const deps: FeatureId[] = [];

    const feature: FeatureNode = {
      id,
      type: 'chamfer',
      name: `Chamfer ${part.timeline.filter(f => f.type === 'chamfer').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createLoftHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateLoft') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateLoft command' });
    }
    const profiles = command.inputs.profiles;
    if (!Array.isArray(profiles) || profiles.length < 2) {
      return err({ code: 'INVALID_INPUT', message: 'Loft requires at least 2 profiles' });
    }
    if (profiles.length > 16) {
      return err({ code: 'INVALID_INPUT', message: 'Loft supports at most 16 profiles' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateLoft') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('loft'));
    const now = new Date().toISOString();

    // Unique sketch dependencies — a loft may pull profiles from multiple sketches.
    const sketchIds = new Set<string>();
    for (const ref of command.inputs.profiles) {
      if (ref?.sketchId) sketchIds.add(String(ref.sketchId));
    }
    const deps: FeatureId[] = Array.from(sketchIds) as FeatureId[];

    const feature: FeatureNode = {
      id,
      type: 'loft',
      name: `Loft ${part.timeline.filter(f => f.type === 'loft').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

/**
 * `CreateComponent` handler.
 *
 * Atomic: upserts the embedded component under `embeddedComponents[hash]`
 * AND appends the `component` feature in one mutation, so undo
 * rolls back both halves at once.
 *
 * Validation:
 *   - the embedded `source` must have at least one part (it's a
 *     component, not an empty project).
 *   - `component.hash` non-empty (caller is responsible for the hash
 *     being a real content hash; we don't recompute here to keep this
 *     fast — the import pipeline already hashes once when picking the
 *     file).
 *   - the feature's `boolean` is one of newBody/cut/join.
 *
 * Idempotent on hash: inserting the same .cadcomponent twice reuses
 * the existing entry — no duplicate storage.
 */
export const createComponentHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateComponent') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateComponent command' });
    }
    const partCheck = findPart(state, command.partId);
    if (!partCheck.ok) return partCheck;
    const { component, inputs } = command;
    if (!component?.hash?.trim()) {
      return err({ code: 'INVALID_INPUT', message: 'component.hash is required', field: 'component.hash' });
    }
    if (!component.name?.trim()) {
      return err({ code: 'INVALID_INPUT', message: 'component.name is required', field: 'component.name' });
    }
    if (!component.source || typeof component.source !== 'object') {
      return err({ code: 'INVALID_INPUT', message: 'component.source must be a CadProject', field: 'component.source' });
    }
    const sourceParts = Object.keys(component.source.parts ?? {});
    if (sourceParts.length === 0) {
      return err({
        code: 'INVALID_COMPONENT',
        message: `Component "${component.name}" has no parts — nothing to instance`,
        field: 'component.source',
      });
    }
    if (inputs.boolean !== 'newBody' && inputs.boolean !== 'cut' && inputs.boolean !== 'join') {
      return err({ code: 'INVALID_INPUT', message: `Invalid boolean mode: ${String(inputs.boolean)}`, field: 'inputs.boolean' });
    }
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateComponent') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    // Upsert into embeddedComponents. Idempotent on hash: re-inserting
    // the same content (same hash) overwrites with the fresh embeddedAt
    // timestamp + origin — useful when the user re-imports the same
    // file from a new location.
    if (!draft.embeddedComponents) draft.embeddedComponents = {};
    draft.embeddedComponents[command.component.hash] = {
      ...command.component,
    };

    const id = featureId(generateId('component'));
    const now = new Date().toISOString();
    const count = part.timeline.filter(f => f.type === 'component').length;

    // Compose final inputs with the derived componentRef so the caller
    // can't pass a mismatched ref.
    const finalInputs = {
      componentRef: command.component.hash,
      transform: command.inputs.transform,
      parameterOverrides: { ...command.inputs.parameterOverrides },
      ...(command.inputs.configurationId !== undefined
        ? { configurationId: command.inputs.configurationId }
        : {}),
      boolean: command.inputs.boolean,
    };

    const feature: FeatureNode = {
      id,
      type: 'component',
      // "Bolt" for the first, "Bolt (2)" for the next — the component names
      // itself, since "Component 3" says nothing about which one it is.
      name: count === 0 ? command.component.name : `${command.component.name} (${count + 1})`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: finalInputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createHoleHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateHole') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateHole command' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateHole') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('hole'));
    const now = new Date().toISOString();

    const feature: FeatureNode = {
      id,
      type: 'hole',
      name: `Hole ${part.timeline.filter(f => f.type === 'hole').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

/**
 * Primitives are named for their shape ("Box 1", "Cylinder 2") rather than
 * the feature type, counted per shape. "Primitive 4" in the tree would say
 * nothing about which of the five it is.
 */
/**
 * `CreateMove` handler.
 *
 * Appended at the end of the timeline, which is the only place a move can go:
 * it repositions whatever the timeline has already produced, so running it
 * earlier would move a body that does not exist yet.
 *
 * `dependsOn` stays empty and timeline order does the work, matching Fillet /
 * Chamfer / Mirror — the rebuilder runs strictly in order, and a move always
 * follows the feature that made its target.
 */
export const createMoveHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateMove') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateMove command' });
    }
    if (!command.inputs.targetBodies?.length) {
      return err({ code: 'INVALID_INPUT', message: 'Move requires at least one target body', field: 'inputs.targetBodies' });
    }
    if (!command.inputs.transform) {
      return err({ code: 'INVALID_INPUT', message: 'Move requires a transform', field: 'inputs.transform' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateMove') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('move'));
    const now = new Date().toISOString();

    const feature: FeatureNode = {
      id,
      type: 'move',
      name: `Move ${part.timeline.filter(f => f.type === 'move').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createPrimitiveHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreatePrimitive') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreatePrimitive command' });
    }
    if (!command.inputs.shape?.kind) {
      return err({ code: 'INVALID_INPUT', message: 'Primitive requires a shape' });
    }
    if (!command.inputs.transform) {
      return err({ code: 'INVALID_INPUT', message: 'Primitive requires a transform' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreatePrimitive') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const kind = command.inputs.shape.kind;
    const id = featureId(generateId(kind));
    const now = new Date().toISOString();

    const sameKind = part.timeline.filter(
      f => f.type === 'primitive'
        && (f.inputs as { shape?: { kind?: string } }).shape?.kind === kind,
    ).length;

    const feature: FeatureNode = {
      id,
      type: 'primitive',
      name: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${sameKind + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createMirrorHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateMirror') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateMirror command' });
    }
    if (!command.inputs.sourceBody?.bodyId) {
      return err({ code: 'INVALID_INPUT', message: 'Mirror requires sourceBody' });
    }
    if (!command.inputs.plane) {
      return err({ code: 'INVALID_INPUT', message: 'Mirror requires a plane' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateMirror') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('mirror'));
    const now = new Date().toISOString();

    // Same dependency strategy as Fillet/Chamfer: leave dependsOn empty
    // and rely on timeline order. The rebuilder already runs strictly in
    // timeline order, sufficient since a Mirror always touches a body
    // that was produced earlier.
    const deps: FeatureId[] = [];

    const feature: FeatureNode = {
      id,
      type: 'mirror',
      name: `Mirror ${part.timeline.filter(f => f.type === 'mirror').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

/**
 * Pattern handler: dispatches Linear or Circular based on
 * `inputs.patternType`. The FeatureNode type follows
 * (`'linearPattern'` vs `'circularPattern'`), keeping the timeline
 * label distinct so the user sees "Linear Pattern 1" / "Circular
 * Pattern 1" rather than a generic "Pattern N".
 */
export const createPatternHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreatePattern') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreatePattern command' });
    }
    const inputs = command.inputs;
    if (inputs.patternType !== 'linear' && inputs.patternType !== 'circular') {
      return err({ code: 'INVALID_INPUT', message: `Unknown patternType: ${(inputs as { patternType?: string }).patternType}` });
    }
    if (!inputs.sourceBody?.bodyId) {
      return err({ code: 'INVALID_INPUT', message: 'Pattern requires sourceBody' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreatePattern') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const isLinear = command.inputs.patternType === 'linear';
    const slug = isLinear ? 'linpat' : 'circpat';
    const id = featureId(generateId(slug));
    const now = new Date().toISOString();

    // FeatureNode.type discriminates linear vs circular so the
    // rebuilder dispatch picks the right builder. dependsOn stays
    // empty — same rationale as Fillet/Chamfer/Mirror (timeline
    // order is sufficient because the pattern always references a
    // body produced earlier in the timeline).
    const featureType = isLinear ? 'linearPattern' : 'circularPattern';
    const label = isLinear ? 'Linear Pattern' : 'Circular Pattern';
    const existingCount = part.timeline.filter(f => f.type === featureType).length;

    const feature: FeatureNode = {
      id,
      type: featureType,
      name: `${label} ${existingCount + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createImportedGeometryHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateImportedGeometry') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateImportedGeometry command' });
    }
    if (!command.inputs.fileName?.trim()) {
      return err({ code: 'INVALID_INPUT', message: 'Imported geometry requires a fileName' });
    }
    if (command.inputs.format !== 'step' && command.inputs.format !== 'stl' && command.inputs.format !== 'brep') {
      return err({ code: 'INVALID_INPUT', message: `Unsupported format: ${command.inputs.format}` });
    }
    if (isEmptyImportedData(command.inputs.data)) {
      return err({ code: 'INVALID_INPUT', message: 'Imported geometry has empty data' });
    }
    // A `ref` must resolve: either the caller brings the asset, or the
    // document already holds one under that id. Accepting a dangling
    // reference would store a feature whose bytes exist nowhere, and the
    // failure would surface as an empty body at rebuild rather than here.
    if (command.inputs.data.kind === 'ref') {
      const id = String(command.inputs.data.referenceId);
      const brought = command.asset?.id !== undefined && String(command.asset.id) === id;
      if (!brought && !state.references[command.inputs.data.referenceId]) {
        return err({
          code: 'INVALID_INPUT',
          message: `Imported geometry references "${id}", which has no asset`,
          field: 'asset',
        });
      }
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateImportedGeometry') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('import'));
    const now = new Date().toISOString();

    // Register the asset in the same mutation that appends the feature, so
    // undo removes both and the document never holds a reference to bytes it
    // did not also store.
    if (command.asset) {
      draft.references[command.asset.id] = { ...command.asset };
    }

    // Imported geometry has no upstream feature dependency — it's a
    // root-level body source like a primitive. dependsOn stays empty.
    const feature: FeatureNode = {
      id,
      type: 'importedGeometry',
      // The feature label IS the file name (without path) so the
      // timeline reads naturally: "my-bracket.step" not "Import 1".
      name: command.inputs.fileName,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createSweepHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateSweep') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateSweep command' });
    }
    if (!command.inputs.profile?.sketchId) {
      return err({ code: 'INVALID_INPUT', message: 'Sweep requires a profile' });
    }
    if (!command.inputs.path?.sketchId) {
      return err({ code: 'INVALID_INPUT', message: 'Sweep requires a path' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateSweep') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('sweep'));
    const now = new Date().toISOString();

    // Dependency tracking: sweep depends on both the profile sketch
    // and the path sketch. If either is deleted/suppressed, the
    // sweep's build fails — recording dependsOn lets the rebuilder
    // flag the cascade. Matches Loft's multi-sketch dependency
    // collection.
    const deps = new Set<string>();
    if (command.inputs.profile?.sketchId) deps.add(String(command.inputs.profile.sketchId));
    if (command.inputs.path?.sketchId) deps.add(String(command.inputs.path.sketchId));

    const feature: FeatureNode = {
      id,
      type: 'sweep',
      name: `Sweep ${part.timeline.filter(f => f.type === 'sweep').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: Array.from(deps) as FeatureId[],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createShellHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateShell') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateShell command' });
    }
    if (!command.inputs.sourceBody?.bodyId) {
      return err({ code: 'INVALID_INPUT', message: 'Shell requires sourceBody' });
    }
    const faces = command.inputs.removedFaces;
    if (!Array.isArray(faces) || faces.length === 0) {
      return err({ code: 'INVALID_INPUT', message: 'Shell requires at least one face to remove' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateShell') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('shell'));
    const now = new Date().toISOString();

    // Same dependency strategy as Fillet/Chamfer/Mirror — timeline order
    // is sufficient since Shell always touches a body produced earlier.
    const deps: FeatureId[] = [];

    const feature: FeatureNode = {
      id,
      type: 'shell',
      name: `Shell ${part.timeline.filter(f => f.type === 'shell').length + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: deps,
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const createConstructionPlaneHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'CreateConstructionPlane') {
      return err({ code: 'WRONG_TYPE', message: 'Expected CreateConstructionPlane command' });
    }
    return findPart(state, command.partId);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'CreateConstructionPlane') return;
    const part = draft.parts[command.partId];
    if (!part) return;

    const id = featureId(generateId('cp'));
    const now = new Date().toISOString();

    const count = part.timeline.filter(f => f.type === 'constructionPlane').length;
    const feature: FeatureNode = {
      id,
      type: 'constructionPlane',
      name: `Plane ${count + 1}`,
      version: 1,
      enabled: true,
      visible: true,
      inputs: command.inputs as unknown as Record<string, unknown>,
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    };

    part.timeline.push(feature);
    draft.metadata.updatedAt = now;
  },
};

export const suppressFeatureHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SuppressFeature') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SuppressFeature command' });
    }
    const result = findFeature(state, command.partId, command.featureId);
    if (!result.ok) return err(result.error);
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SuppressFeature') return;
    const part = draft.parts[command.partId];
    if (!part) return;
    const feature = part.timeline.find(f => f.id === command.featureId);
    if (feature) {
      feature.enabled = command.enabled;
      feature.updatedAt = new Date().toISOString();
    }
  },
};

/**
 * `ReorderFeature` — move a feature to a new position in the timeline.
 *
 * The timeline is an ordered program: a fillet consumes the body an extrude
 * produced, so order *is* the dependency. Two ways a move breaks that, and
 * both are rejected rather than allowed to produce a broken rebuild:
 *
 *  - moving a feature **above** something it `dependsOn`, and
 *  - moving a feature **below** something that depends on *it*.
 *
 * Only the second needs a scan — the first is the same check read the other
 * way round, but a feature's own `dependsOn` is right there while its
 * dependents are not, so both directions are checked explicitly.
 *
 * `dependsOn` is not populated by every builder (Fillet, Chamfer and Mirror
 * deliberately leave it empty and rely on order alone), so this catches the
 * declared cases and the rebuild still reports the rest. Rejecting here is
 * worth it anyway: a declared dependency is one we can explain, and
 * "Fillet 1 must stay after Extrude 1" beats "Target body not in build
 * context" after the fact.
 *
 * Marking the rebuild dirty needs no code — splicing the array produces
 * patches under `parts/*\/timeline`, and `detectDirty` already takes the
 * lowest index it sees, which is exactly `min(oldIndex, newIndex)`.
 */
export const reorderFeatureHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'ReorderFeature') {
      return err({ code: 'WRONG_TYPE', message: 'Expected ReorderFeature command' });
    }
    const partCheck = findPart(state, command.partId);
    if (!partCheck.ok) return partCheck;

    const timeline = state.parts[command.partId]!.timeline;
    const oldIndex = timeline.findIndex(f => f.id === command.featureId);
    if (oldIndex === -1) {
      return err({
        code: 'NOT_FOUND',
        message: `Feature ${command.featureId} is not in this part`,
        field: 'featureId',
      });
    }
    if (!Number.isInteger(command.newIndex)
      || command.newIndex < 0
      || command.newIndex >= timeline.length) {
      return err({
        code: 'INVALID_INPUT',
        message: `newIndex must be between 0 and ${timeline.length - 1}`,
        field: 'newIndex',
      });
    }
    if (command.newIndex === oldIndex) return ok(undefined);

    const moved = timeline[oldIndex]!;
    // Where everything ends up once the move is applied.
    const after = [...timeline];
    after.splice(oldIndex, 1);
    after.splice(command.newIndex, 0, moved);
    const positionOf = new Map(after.map((f, i) => [String(f.id), i]));
    const movedPos = positionOf.get(String(moved.id))!;

    for (const depId of moved.dependsOn) {
      const depPos = positionOf.get(String(depId));
      if (depPos !== undefined && depPos > movedPos) {
        const dep = timeline.find(f => String(f.id) === String(depId));
        return err({
          code: 'INVALID_INPUT',
          message: `"${moved.name}" uses "${dep?.name ?? depId}", so it must stay after it`,
          field: 'newIndex',
        });
      }
    }

    for (const other of timeline) {
      if (String(other.id) === String(moved.id)) continue;
      if (!other.dependsOn.some(d => String(d) === String(moved.id))) continue;
      const otherPos = positionOf.get(String(other.id));
      if (otherPos !== undefined && otherPos < movedPos) {
        return err({
          code: 'INVALID_INPUT',
          message: `"${other.name}" uses "${moved.name}", so it must stay after it`,
          field: 'newIndex',
        });
      }
    }

    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'ReorderFeature') return;
    const part = draft.parts[command.partId];
    if (!part) return;
    const oldIndex = part.timeline.findIndex(f => f.id === command.featureId);
    if (oldIndex === -1 || oldIndex === command.newIndex) return;

    const [moved] = part.timeline.splice(oldIndex, 1);
    if (!moved) return;
    part.timeline.splice(command.newIndex, 0, moved);
    draft.metadata.updatedAt = new Date().toISOString();
  },
};

export const deleteFeatureHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'DeleteFeature') {
      return err({ code: 'WRONG_TYPE', message: 'Expected DeleteFeature command' });
    }
    const result = findFeature(state, command.partId, command.featureId);
    if (!result.ok) return err(result.error);
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'DeleteFeature') return;
    const part = draft.parts[command.partId];
    if (!part) return;
    const index = part.timeline.findIndex(f => f.id === command.featureId);
    if (index >= 0) {
      part.timeline.splice(index, 1);
      draft.metadata.updatedAt = new Date().toISOString();
    }
  },
};

export const updateFeatureInputHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'UpdateFeatureInput') {
      return err({ code: 'WRONG_TYPE', message: 'Expected UpdateFeatureInput command' });
    }
    const result = findFeature(state, command.partId, command.featureId);
    if (!result.ok) return err(result.error);
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'UpdateFeatureInput') return;
    const part = draft.parts[command.partId];
    if (!part) return;
    const feature = part.timeline.find(f => f.id === command.featureId);
    if (!feature) return;

    // Navigate the path and set the value
    let current: Record<string, unknown> = feature.inputs;
    const pathParts = command.path;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const key = pathParts[i]!;
      if (typeof current[key] !== 'object' || current[key] === null) return;
      current = current[key] as Record<string, unknown>;
    }
    const lastKey = pathParts[pathParts.length - 1];
    if (lastKey !== undefined) {
      current[lastKey] = command.value;
    }
    feature.updatedAt = new Date().toISOString();
  },
};

export const replaceFeatureInputsHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'ReplaceFeatureInputs') {
      return err({ code: 'WRONG_TYPE', message: 'Expected ReplaceFeatureInputs command' });
    }
    const result = findFeature(state, command.partId, command.featureId);
    if (!result.ok) return err(result.error);
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'ReplaceFeatureInputs') return;
    const part = draft.parts[command.partId];
    if (!part) return;
    const feature = part.timeline.find(f => f.id === command.featureId);
    if (!feature) return;

    feature.inputs = command.inputs;
    feature.updatedAt = new Date().toISOString();
  },
};

export const setFeatureVisibilityHandler: CommandHandler = {
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError> {
    if (command.type !== 'SetFeatureVisibility') {
      return err({ code: 'WRONG_TYPE', message: 'Expected SetFeatureVisibility command' });
    }
    const result = findFeature(state, command.partId, command.featureId);
    if (!result.ok) return err(result.error);
    return ok(undefined);
  },

  execute(draft: CadProject, command: CadCommand): void {
    if (command.type !== 'SetFeatureVisibility') return;
    const part = draft.parts[command.partId];
    if (!part) return;
    const feature = part.timeline.find(f => f.id === command.featureId);
    if (feature) {
      feature.visible = command.visible;
      // NOTE: intentionally NOT updating updatedAt here.
      // Visibility is display-only; changing updatedAt would trigger a rebuild.
    }
  },
};

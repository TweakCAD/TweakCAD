/**
 * Direct tests for the Immer patch contract behind the document store.
 *
 * `documentStore.ts` is the only place in the repo that uses Immer's patch
 * API (`produce` with a patch callback, `enablePatches`, `applyPatches`).
 * Undo/redo, transaction grouping and dirty detection all ride on the exact
 * shape of the patches Immer emits, so an Immer upgrade can break this file
 * without breaking anything else. These tests exercise the store itself —
 * no command bus, no handlers — so a failure points at the patch engine
 * rather than at a handler's business logic.
 *
 * What each area pins:
 *   - forward/inverse patch generation (via their observable effects:
 *     a recorded undo entry, dirty paths, and an exact undo→redo round-trip)
 *   - stacking: several mutations, several undos/redos, redo discarded by a
 *     new mutation
 *   - arrays and Record keys — insert/remove/reorder in the middle of the
 *     timeline and inside nested sketch arrays. The document model is plain
 *     JSON (Records and arrays; no Map or Set anywhere in `schema.ts`), and
 *     one of the tests below pins that the state stays JSON-round-trippable
 *     after undo/redo so no exotic collection sneaks in through the patch
 *     engine.
 *   - `detectDirty` patch-path classification
 *   - empty-stack behaviour at both ends
 */

import { sketchBuildGeometry } from '../sketch/derivedGeometry.ts';
import { describe, it, expect } from 'vitest';
import { DocumentStore } from './documentStore.ts';
import { createPart, newProjectWithPart } from '../document/factory.ts';
import { featureId, entityId } from '../ids.ts';
import type { PartId, FeatureId } from '../ids.ts';
import type {
  CadProject,
  FeatureNode,
  SketchFeatureInputs,
  ExtrudeFeatureInputs,
} from '../document/schema.ts';

// ---- Fixtures -------------------------------------------------------------

const T0 = '2024-01-01T00:00:00.000Z';

/**
 * A sketch feature with a populated `editorModel` — nested arrays of points,
 * geometries and constraints plus the derived `buildGeometry` record. This is
 * the deepest structure the document model has, and the one whose patches
 * matter most for undo.
 */
function sketchFeature(id: string, name: string): FeatureNode {
  const pA = entityId('line_a');
  const inputs: SketchFeatureInputs = {
    plane: { type: 'defaultPlane', name: 'XY' },
    buildGeometry: {
      [pA]: { id: pA, type: 'line', start: ['0', '0'], end: ['50', '0'] },
    },
    entityOrder: [pA],
    editorModel: {
      points: [
        { id: 'pt_origin', x: 0, y: 0, fixed: true },
        { id: 'pt_1', x: 50, y: 0, fixed: false },
      ],
      geometries: [{ id: 'geo_1', type: 'line', startId: 'pt_origin', endId: 'pt_1' }],
      constraints: [
        { id: 'con_origin_fixed', type: 'fixed', pointId: 'pt_origin', x: 0, y: 0 },
        { id: 'con_1', type: 'horizontal', geometryId: 'geo_1' },
      ],
    },
  };
  return {
    id: featureId(id),
    type: 'sketch',
    name,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

function extrudeFeature(id: string, name: string, sketchId: FeatureId): FeatureNode {
  const inputs: ExtrudeFeatureInputs = {
    profiles: [{ sketchId, wireEntityIds: [entityId('line_a')] }],
    operation: 'newBody',
    direction: { type: 'normal' },
    extent: { type: 'distance', value: '10' },
  };
  return {
    id: featureId(id),
    type: 'extrude',
    name,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [sketchId],
    createdAt: T0,
    updatedAt: T0,
  };
}

/** A store holding one part with a sketch + extrude timeline. */
function newStore(): { store: DocumentStore; partId: PartId } {
  const project = newProjectWithPart('Patch Contract', 'Part 1');
  const partId = Object.keys(project.parts)[0] as PartId;
  const part = project.parts[partId]!;
  part.timeline.push(sketchFeature('f_sketch', 'Sketch 1'));
  part.timeline.push(extrudeFeature('f_ext', 'Extrude 1', featureId('f_sketch')));
  part.parameters.values['thickness'] = {
    name: 'thickness',
    expression: '3',
    unit: 'mm',
  };
  project.parameters.values['global_scale'] = {
    name: 'global_scale',
    expression: '1',
    unit: 'none',
  };
  return { store: new DocumentStore(project), partId };
}

/** Deep structural snapshot, detached from the store's frozen state. */
function snapshot(state: Readonly<CadProject>): CadProject {
  return structuredClone(state) as CadProject;
}

/** Collect `(fromIndex, partId)` dirty notifications for one mutation. */
function recordDirty(
  store: DocumentStore,
  run: () => void,
): Array<{ fromIndex: number; partId: PartId }> {
  const seen: Array<{ fromIndex: number; partId: PartId }> = [];
  const off = store.onDirtyFeature((fromIndex, partId) => seen.push({ fromIndex, partId }));
  run();
  off();
  return seen;
}

function timelineNames(store: DocumentStore, partId: PartId): string[] {
  return store.getState().parts[partId]!.timeline.map(f => f.name);
}

// ---- Patch generation + round-trip ---------------------------------------

describe('DocumentStore — patch generation', () => {
  it('records an undo entry for a mutation that changes something', () => {
    const { store, partId } = newStore();

    store.mutate('Rename feature', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Renamed';
    });

    expect(store.canUndo()).toBe(true);
    expect(store.undoLabel()).toBe('Rename feature');
    expect(store.canRedo()).toBe(false);
    expect(store.getRevision()).toBe(1);
  });

  it('records nothing when the recipe produces no patches', () => {
    const { store, partId } = newStore();

    // Reading the draft without writing, and writing the identical value,
    // both leave Immer with an empty patch list — the store must not push a
    // ghost undo entry for either.
    store.mutate('No-op read', draft => {
      void draft.parts[partId]!.timeline.length;
    });
    store.mutate('Same value', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Sketch 1';
    });

    expect(store.canUndo()).toBe(false);
    expect(store.undoLabel()).toBeUndefined();
    // The revision still advances — subscribers are notified either way.
    expect(store.getRevision()).toBe(2);
  });

  it('skips undo recording when no label is given', () => {
    const { store, partId } = newStore();

    store.mutate(undefined, draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Silent';
    });

    expect(timelineNames(store, partId)[0]).toBe('Silent');
    expect(store.canUndo()).toBe(false);
  });

  it('undo then redo round-trips nested sketch state exactly', () => {
    const { store, partId } = newStore();
    const before = snapshot(store.getState());

    store.mutate('Edit sketch', draft => {
      const inputs = draft.parts[partId]!.timeline[0]!.inputs as unknown as SketchFeatureInputs;
      const pt = inputs.editorModel.points[1] as { x: number; y: number };
      pt.x = 75;
      inputs.editorModel.points.push({ id: 'pt_2', x: 75, y: 25, fixed: false });
      inputs.editorModel.constraints.push({ id: 'con_2', type: 'vertical', geometryId: 'geo_1' });
      sketchBuildGeometry(inputs)[entityId('line_b')] = {
        id: entityId('line_b'),
        type: 'line',
        start: ['75', '0'],
        end: ['75', '25'],
      };
      inputs.entityOrder!.push(entityId('line_b'));
    });
    const after = snapshot(store.getState());
    expect(after).not.toEqual(before);

    store.undo();
    expect(snapshot(store.getState())).toEqual(before);

    store.redo();
    expect(snapshot(store.getState())).toEqual(after);
  });

  it('leaves untouched branches reference-identical after undo and redo', () => {
    const { store, partId } = newStore();
    const extrudeBefore = store.getState().parts[partId]!.timeline[1];

    store.mutate('Edit sketch name', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Sketch A';
    });
    store.undo();
    expect(store.getState().parts[partId]!.timeline[1]).toBe(extrudeBefore);

    store.redo();
    expect(store.getState().parts[partId]!.timeline[1]).toBe(extrudeBefore);
  });

  it('keeps the document JSON-round-trippable after undo and redo', () => {
    // The document model is plain JSON — Records and arrays, no Map or Set.
    // Patch application must not introduce anything that fails to serialize,
    // or `.cadjson` persistence breaks downstream of undo.
    const { store, partId } = newStore();

    store.mutate('Add parameter', draft => {
      draft.parts[partId]!.parameters.values['height'] = {
        name: 'height',
        expression: '12',
        unit: 'mm',
      };
    });
    store.undo();
    store.redo();

    const state = store.getState();
    expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot(state));
  });
});

// ---- Undo/redo stacking ---------------------------------------------------

describe('DocumentStore — undo/redo stacking', () => {
  it('walks back and forward through several mutations in order', () => {
    const { store, partId } = newStore();
    const s0 = snapshot(store.getState());

    store.mutate('Rename 1', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'One';
    });
    const s1 = snapshot(store.getState());
    store.mutate('Rename 2', draft => {
      draft.parts[partId]!.timeline[1]!.name = 'Two';
    });
    const s2 = snapshot(store.getState());
    store.mutate('Disable', draft => {
      draft.parts[partId]!.timeline[1]!.enabled = false;
    });
    const s3 = snapshot(store.getState());

    expect(store.undoLabel()).toBe('Disable');

    store.undo();
    expect(snapshot(store.getState())).toEqual(s2);
    store.undo();
    expect(snapshot(store.getState())).toEqual(s1);
    store.undo();
    expect(snapshot(store.getState())).toEqual(s0);
    expect(store.canUndo()).toBe(false);
    expect(store.redoLabel()).toBe('Rename 1');

    store.redo();
    expect(snapshot(store.getState())).toEqual(s1);
    store.redo();
    expect(snapshot(store.getState())).toEqual(s2);
    store.redo();
    expect(snapshot(store.getState())).toEqual(s3);
    expect(store.canRedo()).toBe(false);
  });

  it('discards the redo stack when a new mutation lands after an undo', () => {
    const { store, partId } = newStore();

    store.mutate('Rename 1', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'One';
    });
    store.mutate('Rename 2', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Two';
    });
    store.undo();
    expect(store.canRedo()).toBe(true);

    store.mutate('Branch', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Branch';
    });

    expect(store.canRedo()).toBe(false);
    expect(store.redoLabel()).toBeUndefined();
    expect(timelineNames(store, partId)[0]).toBe('Branch');

    store.undo();
    expect(timelineNames(store, partId)[0]).toBe('One');
  });

  it('collapses a transaction into one undo step and unwinds it in reverse', () => {
    // Transaction grouping concatenates forward patches in order and
    // *prepends* each step's inverse patches, so the grouped inverse list
    // runs newest-first. Patch ordering is the fragile part here.
    const { store, partId } = newStore();
    const before = snapshot(store.getState());

    store.beginTransaction('Grouped edit');
    store.mutate('Step 1', draft => {
      draft.parts[partId]!.timeline.push(sketchFeature('f_s2', 'Sketch 2'));
    });
    store.mutate('Step 2', draft => {
      draft.parts[partId]!.timeline[2]!.name = 'Sketch 2 renamed';
    });
    store.mutate('Step 3', draft => {
      draft.parts[partId]!.timeline.push(sketchFeature('f_s3', 'Sketch 3'));
    });
    store.endTransaction();

    const after = snapshot(store.getState());
    expect(timelineNames(store, partId)).toEqual([
      'Sketch 1',
      'Extrude 1',
      'Sketch 2 renamed',
      'Sketch 3',
    ]);
    expect(store.undoLabel()).toBe('Grouped edit');

    store.undo();
    expect(snapshot(store.getState())).toEqual(before);
    expect(store.canUndo()).toBe(false);

    store.redo();
    expect(snapshot(store.getState())).toEqual(after);
  });

  it('notifies subscribers and bumps the revision on undo and redo', () => {
    const { store, partId } = newStore();
    const seen: string[] = [];
    store.subscribe(s => seen.push(s.parts[partId]!.timeline[0]!.name));

    store.mutate('Rename', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Renamed';
    });
    store.undo();
    store.redo();

    expect(seen).toEqual(['Renamed', 'Sketch 1', 'Renamed']);
    expect(store.getRevision()).toBe(3);
  });
});

// ---- Arrays and Record keys ----------------------------------------------

describe('DocumentStore — arrays and record keys', () => {
  it('round-trips an insert in the middle of the timeline', () => {
    const { store, partId } = newStore();
    const before = snapshot(store.getState());

    store.mutate('Insert feature', draft => {
      draft.parts[partId]!.timeline.splice(1, 0, sketchFeature('f_mid', 'Sketch Mid'));
    });
    expect(timelineNames(store, partId)).toEqual(['Sketch 1', 'Sketch Mid', 'Extrude 1']);

    store.undo();
    expect(snapshot(store.getState())).toEqual(before);
    expect(timelineNames(store, partId)).toEqual(['Sketch 1', 'Extrude 1']);

    store.redo();
    expect(timelineNames(store, partId)).toEqual(['Sketch 1', 'Sketch Mid', 'Extrude 1']);
  });

  it('round-trips a removal from the middle of the timeline', () => {
    const { store, partId } = newStore();
    store.mutate('Seed', draft => {
      draft.parts[partId]!.timeline.splice(1, 0, sketchFeature('f_mid', 'Sketch Mid'));
    });
    const before = snapshot(store.getState());

    store.mutate('Delete middle', draft => {
      draft.parts[partId]!.timeline.splice(1, 1);
    });
    expect(timelineNames(store, partId)).toEqual(['Sketch 1', 'Extrude 1']);

    store.undo();
    expect(snapshot(store.getState())).toEqual(before);

    store.redo();
    expect(timelineNames(store, partId)).toEqual(['Sketch 1', 'Extrude 1']);
  });

  it('round-trips a timeline reorder', () => {
    const { store, partId } = newStore();
    store.mutate('Seed', draft => {
      draft.parts[partId]!.timeline.push(sketchFeature('f_s2', 'Sketch 2'));
    });
    const before = snapshot(store.getState());

    store.mutate('Reorder', draft => {
      const timeline = draft.parts[partId]!.timeline;
      const [moved] = timeline.splice(2, 1);
      timeline.unshift(moved!);
    });
    expect(timelineNames(store, partId)).toEqual(['Sketch 2', 'Sketch 1', 'Extrude 1']);

    store.undo();
    expect(snapshot(store.getState())).toEqual(before);
    expect(timelineNames(store, partId)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2']);

    store.redo();
    expect(timelineNames(store, partId)).toEqual(['Sketch 2', 'Sketch 1', 'Extrude 1']);
  });

  it('round-trips array truncation and replacement inside a sketch', () => {
    const { store, partId } = newStore();
    const before = snapshot(store.getState());

    store.mutate('Rewrite editor model', draft => {
      const inputs = draft.parts[partId]!.timeline[0]!.inputs as unknown as SketchFeatureInputs;
      inputs.editorModel.points = [{ id: 'pt_origin', x: 0, y: 0, fixed: true }];
      inputs.editorModel.geometries = [];
      inputs.editorModel.constraints.splice(1, 1);
    });
    const after = snapshot(store.getState());

    store.undo();
    expect(snapshot(store.getState())).toEqual(before);

    store.redo();
    expect(snapshot(store.getState())).toEqual(after);
  });

  it('round-trips added and deleted record keys', () => {
    const { store, partId } = newStore();
    const before = snapshot(store.getState());

    store.mutate('Add and delete keys', draft => {
      const inputs = draft.parts[partId]!.timeline[0]!.inputs as unknown as SketchFeatureInputs;
      // Deleting a computed record key is precisely what this test exercises:
      // Immer emits a different patch op for key removal than for replacement.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete sketchBuildGeometry(inputs)[entityId('line_a')];
      sketchBuildGeometry(inputs)[entityId('circle_a')] = {
        id: entityId('circle_a'),
        type: 'circle',
        center: ['0', '0'],
        diameter: '10',
      };
      delete draft.parts[partId]!.parameters.values['thickness'];
      draft.parts[partId]!.parameters.values['depth'] = {
        name: 'depth',
        expression: '8',
        unit: 'mm',
      };
    });
    const after = snapshot(store.getState());
    expect(Object.keys(after.parts[partId]!.parameters.values)).toEqual(['depth']);

    store.undo();
    expect(snapshot(store.getState())).toEqual(before);
    expect(Object.keys(store.getState().parts[partId]!.parameters.values)).toEqual(['thickness']);

    store.redo();
    expect(snapshot(store.getState())).toEqual(after);
  });
});

// ---- detectDirty ----------------------------------------------------------

describe('DocumentStore — detectDirty patch classification', () => {
  it('marks the touched feature index dirty for a timeline edit', () => {
    const { store, partId } = newStore();

    const dirty = recordDirty(store, () => {
      store.mutate('Edit extrude', draft => {
        const inputs = draft.parts[partId]!.timeline[1]!.inputs as unknown as ExtrudeFeatureInputs;
        inputs.extent = { type: 'distance', value: '25' };
      });
    });

    expect(dirty).toEqual([{ fromIndex: 1, partId }]);
  });

  it('reports the lowest touched index once when a mutation spans features', () => {
    const { store, partId } = newStore();

    const dirty = recordDirty(store, () => {
      store.mutate('Rename both', draft => {
        draft.parts[partId]!.timeline[1]!.name = 'Extrude renamed';
        draft.parts[partId]!.timeline[0]!.name = 'Sketch renamed';
      });
    });

    expect(dirty).toEqual([{ fromIndex: 0, partId }]);
  });

  it('does not mark anything dirty for a visibility toggle', () => {
    const { store, partId } = newStore();

    const dirty = recordDirty(store, () => {
      store.mutate('Hide feature', draft => {
        draft.parts[partId]!.timeline[1]!.visible = false;
      });
    });

    expect(dirty).toEqual([]);
    expect(store.getState().parts[partId]!.timeline[1]!.visible).toBe(false);
  });

  it('marks every part dirty from index 0 for a project-level parameter change', () => {
    const { store, partId } = newStore();
    const second = createPart('Part 2');
    store.mutate('Add second part', draft => {
      draft.parts[second.id] = second;
    });

    const dirty = recordDirty(store, () => {
      store.mutate('Set global scale', draft => {
        draft.parameters.values['global_scale']!.expression = '2';
      });
    });

    expect(dirty).toEqual([
      { fromIndex: 0, partId },
      { fromIndex: 0, partId: second.id },
    ]);
  });

  it('marks only the owning part dirty for a part-scoped parameter change', () => {
    const { store, partId } = newStore();

    const dirty = recordDirty(store, () => {
      store.mutate('Set thickness', draft => {
        draft.parts[partId]!.parameters.values['thickness']!.expression = '5';
      });
    });

    expect(dirty).toEqual([{ fromIndex: 0, partId }]);
  });

  it('marks the part dirty when its configuration table changes', () => {
    const { store, partId } = newStore();
    store.mutate('Add configurations', draft => {
      draft.parts[partId]!.configurations = {
        active: null,
        rows: [{ id: 'cfg_1', name: 'M3', overrides: { thickness: '3' } }],
      };
    });

    const dirty = recordDirty(store, () => {
      store.mutate('Activate configuration', draft => {
        draft.parts[partId]!.configurations!.active = 'cfg_1';
      });
    });

    expect(dirty).toEqual([{ fromIndex: 0, partId }]);
  });

  it('does not mark anything dirty for a metadata-only change', () => {
    const { store } = newStore();

    const dirty = recordDirty(store, () => {
      store.mutate('Rename project', draft => {
        draft.metadata.name = 'Renamed project';
      });
    });

    expect(dirty).toEqual([]);
  });

  it('does not run dirty detection on undo or redo', () => {
    // Shipped behaviour: `undo()`/`redo()` apply patches and notify state
    // subscribers, but never call `detectDirty`, so the rebuild scheduler is
    // not woken by an undo. Pinned here so an Immer upgrade can't silently
    // change which side effects fire.
    const { store, partId } = newStore();
    store.mutate('Edit extrude', draft => {
      const inputs = draft.parts[partId]!.timeline[1]!.inputs as unknown as ExtrudeFeatureInputs;
      inputs.extent = { type: 'distance', value: '25' };
    });

    const dirty = recordDirty(store, () => {
      store.undo();
      store.redo();
    });

    expect(dirty).toEqual([]);
  });
});

// ---- Stack boundaries -----------------------------------------------------

describe('DocumentStore — stack boundaries', () => {
  it('undo with empty history is a no-op', () => {
    const { store } = newStore();
    const before = snapshot(store.getState());
    const seen: number[] = [];
    store.subscribe(() => seen.push(1));

    expect(store.canUndo()).toBe(false);
    expect(() => store.undo()).not.toThrow();

    expect(snapshot(store.getState())).toEqual(before);
    expect(store.getRevision()).toBe(0);
    expect(seen).toEqual([]);
  });

  it('redo with nothing to redo is a no-op', () => {
    const { store, partId } = newStore();
    store.mutate('Rename', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Renamed';
    });
    const after = snapshot(store.getState());

    expect(store.canRedo()).toBe(false);
    expect(() => store.redo()).not.toThrow();

    expect(snapshot(store.getState())).toEqual(after);
    expect(store.getRevision()).toBe(1);
  });

  it('stops at the bottom after over-undoing, and redo still replays forward', () => {
    const { store, partId } = newStore();
    const s0 = snapshot(store.getState());
    store.mutate('Rename 1', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'One';
    });
    store.mutate('Rename 2', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Two';
    });

    store.undo();
    store.undo();
    store.undo();
    store.undo();

    expect(snapshot(store.getState())).toEqual(s0);
    expect(store.canUndo()).toBe(false);

    store.redo();
    store.redo();
    store.redo();
    expect(timelineNames(store, partId)[0]).toBe('Two');
    expect(store.canRedo()).toBe(false);
  });

  it('clearHistory drops both stacks but keeps the current state', () => {
    const { store, partId } = newStore();
    store.mutate('Rename', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Renamed';
    });
    store.undo();
    const stateBefore = snapshot(store.getState());

    store.clearHistory();

    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(snapshot(store.getState())).toEqual(stateBefore);
  });

  it('replaceDocument clears history and marks every part dirty', () => {
    const { store, partId } = newStore();
    store.mutate('Rename', draft => {
      draft.parts[partId]!.timeline[0]!.name = 'Renamed';
    });

    const replacement = newProjectWithPart('Loaded', 'Loaded Part');
    const loadedPartId = Object.keys(replacement.parts)[0] as PartId;

    const dirty = recordDirty(store, () => {
      store.replaceDocument(replacement);
    });

    expect(dirty).toEqual([{ fromIndex: 0, partId: loadedPartId }]);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(store.getState().metadata.name).toBe('Loaded');
  });
});

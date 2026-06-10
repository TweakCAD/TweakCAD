/**
 * Integration test for the `CreateSketchFromImport` command handler.
 *
 * Proves the import lands as a single sketch feature with both views
 * (`editorModel` snapshot + derived `buildGeometry`) populated from the same
 * source, and that the whole import is ONE undo entry.
 */

import { describe, it, expect } from 'vitest';
import { CommandBus } from '../bus.ts';
import { DocumentStore } from '../../store/documentStore.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { createSketchFromImportHandler } from './featureCommands.ts';
import { dxfToEditorState } from '../../sketch/io/dxfImport.ts';
import { toSnapshot, makeCounterIdFactory } from '../../sketch/operations.ts';
import type { SketchFeatureInputs, SketchEditorSnapshot } from '../../document/schema.ts';
import type { PartId } from '../../ids.ts';

const DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '10', '0', '20', '0', '11', '10', '21', '0',
  '0', 'LINE', '10', '10', '20', '0', '11', '10', '21', '10',
  '0', 'CIRCLE', '10', '50', '20', '50', '40', '5',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

function harness() {
  const project = newProjectWithPart('Test');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketchFromImport', createSketchFromImportHandler);
  const partId = Object.keys(project.parts)[0] as PartId;
  return { bus, store, partId };
}

describe('CreateSketchFromImport', () => {
  it('creates one sketch feature with buildGeometry + editorModel from the import', () => {
    const { bus, store, partId } = harness();
    const { state } = dxfToEditorState(DXF, { idFactory: makeCounterIdFactory() });

    const result = bus.dispatch({
      type: 'CreateSketchFromImport',
      partId,
      plane: { type: 'defaultPlane', name: 'XY' },
      editorState: toSnapshot(state) as unknown as SketchEditorSnapshot,
      name: 'My Import',
    });
    expect(result.ok).toBe(true);

    const part = store.getState().parts[partId]!;
    const sketches = part.timeline.filter((f) => f.type === 'sketch');
    expect(sketches).toHaveLength(1);
    const sketch = sketches[0]!;
    expect(sketch.name).toBe('My Import');

    const inputs = sketch.inputs as unknown as SketchFeatureInputs;
    // 2 lines + 1 circle = 3 entities.
    expect(Object.keys(inputs.buildGeometry)).toHaveLength(3);
    expect(inputs.editorModel).toBeTruthy();
    expect(inputs.editorModel!.geometries).toHaveLength(3);
    // Distinct-endpoint junction model: 2 lines = 4 endpoints, plus the
    // circle's center = 5 points. The shared (10,0) junction is a coincident
    // constraint, not a fused point.
    expect(inputs.editorModel!.points).toHaveLength(5);
    const coincidents = (inputs.editorModel!.constraints as Array<{ type: string }>)
      .filter((c) => c.type === 'coincident');
    expect(coincidents).toHaveLength(1);
  });

  it('is a single undo entry', () => {
    const { bus, store, partId } = harness();
    const { state } = dxfToEditorState(DXF, { idFactory: makeCounterIdFactory() });

    bus.dispatch({
      type: 'CreateSketchFromImport',
      partId,
      plane: { type: 'defaultPlane', name: 'XY' },
      editorState: toSnapshot(state) as unknown as SketchEditorSnapshot,
    });
    expect(store.getState().parts[partId]!.timeline.filter((f) => f.type === 'sketch')).toHaveLength(1);

    expect(bus.canUndo()).toBe(true);
    bus.undo();
    expect(store.getState().parts[partId]!.timeline.filter((f) => f.type === 'sketch')).toHaveLength(0);
  });

  it('rejects an import with no geometry', () => {
    const { bus, partId } = harness();
    const result = bus.dispatch({
      type: 'CreateSketchFromImport',
      partId,
      plane: { type: 'defaultPlane', name: 'XY' },
      editorState: { points: [], geometries: [], constraints: [] },
    });
    expect(result.ok).toBe(false);
  });
});

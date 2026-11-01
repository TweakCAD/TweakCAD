import { describe, it, expect } from 'vitest';
import { CommandBus } from '../bus.ts';
import { DocumentStore } from '../../store/documentStore.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { createSketchHandler } from './featureCommands.ts';
import { sketchDrawRectangleHandler, sketchInsertPrimitivesHandler } from './sketchDrawCommands.ts';
import { commandLabel } from '../types.ts';
import type { DxfPrimitive } from '../../sketch/io/dxfImport.ts';
import type { SketchFeatureInputs } from '../../document/schema.ts';
import type { FeatureId, PartId } from '../../ids.ts';
import { sketchBuildGeometry } from '../../sketch/derivedGeometry.ts';
import { assignHoles, detectSketchRegions } from '../../sketch/profileRegions.ts';

function harness() {
  const project = newProjectWithPart('Test');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketch', createSketchHandler);
  bus.register('SketchDrawRectangle', sketchDrawRectangleHandler);
  bus.register('SketchInsertPrimitives', sketchInsertPrimitivesHandler);
  const partId = Object.keys(project.parts)[0] as PartId;
  bus.dispatch({ type: 'CreateSketch', partId, plane: { type: 'defaultPlane', name: 'XY' } });
  const sketchId = store.getState().parts[partId]!.timeline.find((f) => f.type === 'sketch')!.id as FeatureId;
  const inputs = () =>
    store.getState().parts[partId]!.timeline.find((f) => f.id === sketchId)!.inputs as unknown as SketchFeatureInputs;
  return { bus, sketchId, inputs };
}

/** Closed triangle (lines) with a bezier-capped triangular counter inside. */
const LETTER: DxfPrimitive[] = [
  { kind: 'line', start: [20, 0], end: [40, 0] },
  { kind: 'line', start: [40, 0], end: [30, 20] },
  { kind: 'line', start: [30, 20], end: [20, 0] },
  { kind: 'line', start: [27, 4], end: [33, 4] },
  { kind: 'bezier', start: [33, 4], cp1: [32, 7], cp2: [31, 9], end: [30, 10] },
  { kind: 'line', start: [30, 10], end: [27, 4] },
];

describe('SketchInsertPrimitives', () => {
  it('adds the primitives next to existing geometry with junction coincidents', () => {
    const { bus, sketchId, inputs } = harness();
    bus.dispatch({ type: 'SketchDrawRectangle', sketchId, corner: [-20, -5], width: 10, height: 10 });
    const before = inputs().editorModel!;
    const r = bus.dispatch({ type: 'SketchInsertPrimitives', sketchId, primitives: LETTER });
    expect(r.ok).toBe(true);
    const after = inputs().editorModel!;
    expect(after.geometries.length).toBe(before.geometries.length + LETTER.length);
    const coincidents = (m: typeof after) => m.constraints.filter((c) => (c as { type: string }).type === 'coincident').length;
    // Six junctions, one coincident each.
    expect(coincidents(after) - coincidents(before)).toBe(6);
    // Rectangle + letter ring + the counter's own disc.
    const regions = assignHoles(detectSketchRegions(sketchBuildGeometry(inputs())));
    expect(regions).toHaveLength(3);
    expect(regions.filter((g) => (g.holes?.length ?? 0) > 0)).toHaveLength(1);
  });

  it('is one undo entry', () => {
    const { bus, sketchId, inputs } = harness();
    const before = inputs().editorModel!.geometries.length;
    bus.dispatch({ type: 'SketchInsertPrimitives', sketchId, primitives: LETTER });
    bus.undo();
    expect(inputs().editorModel!.geometries.length).toBe(before);
  });

  it('rejects empty, malformed, and unknown primitives', () => {
    const { bus, sketchId } = harness();
    expect(bus.dispatch({ type: 'SketchInsertPrimitives', sketchId, primitives: [] }).ok).toBe(false);
    const nan = [{ kind: 'line', start: [0, 0], end: [Number.NaN, 1] }] as DxfPrimitive[];
    expect(bus.dispatch({ type: 'SketchInsertPrimitives', sketchId, primitives: nan }).ok).toBe(false);
    const odd = [{ kind: 'hyperbola' }] as unknown as DxfPrimitive[];
    expect(bus.dispatch({ type: 'SketchInsertPrimitives', sketchId, primitives: odd }).ok).toBe(false);
    const noCp = [{ kind: 'bezier', start: [0, 0], end: [1, 1] }] as unknown as DxfPrimitive[];
    expect(bus.dispatch({ type: 'SketchInsertPrimitives', sketchId, primitives: noCp }).ok).toBe(false);
  });

  it('labels the undo entry', () => {
    const sketchId = 'sk' as FeatureId;
    expect(commandLabel({ type: 'SketchInsertPrimitives', sketchId, primitives: LETTER, label: 'Text "A"' })).toBe('Text "A"');
    expect(commandLabel({ type: 'SketchInsertPrimitives', sketchId, primitives: LETTER })).toBe('Insert 6 curves');
  });
});

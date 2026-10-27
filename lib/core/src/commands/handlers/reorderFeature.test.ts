/**
 * `ReorderFeature` — moving a feature in the timeline.
 *
 * The timeline is an ordered program, so order *is* the dependency: a fillet
 * consumes the body an extrude produced. A move that breaks a declared
 * dependency is rejected rather than allowed to produce a rebuild failure,
 * because "Fillet 1 uses Extrude 1, so it must stay after it" is an
 * explanation and "Target body not in build context" is a symptom.
 */
import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../../store/documentStore.ts';
import { CommandBus } from '../bus.ts';
import { reorderFeatureHandler } from './featureCommands.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { featureId } from '../../ids.ts';
import type { FeatureId, PartId } from '../../ids.ts';
import type { FeatureNode } from '../../document/schema.ts';

function node(name: string, dependsOn: FeatureId[] = []): FeatureNode {
  return {
    id: featureId(name.toLowerCase()),
    type: 'extrude',
    name,
    version: 1,
    enabled: true,
    visible: true,
    inputs: {},
    dependsOn,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

/** A → B → C, where C declares a dependency on A. */
function wired(timeline: FeatureNode[]) {
  const project = newProjectWithPart('Host', 'Part 1');
  const partId = Object.keys(project.parts)[0]! as PartId;
  project.parts[partId]!.timeline = timeline;
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('ReorderFeature', reorderFeatureHandler);
  return { store, bus, partId };
}

function names(store: DocumentStore, partId: PartId): string[] {
  return store.getState().parts[partId]!.timeline.map(f => f.name);
}

describe('ReorderFeature — moving', () => {
  it('moves a feature later', () => {
    const { store, bus, partId } = wired([node('A'), node('B'), node('C')]);
    const r = bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('a'), newIndex: 2,
    });
    expect(r.ok).toBe(true);
    expect(names(store, partId)).toEqual(['B', 'C', 'A']);
  });

  it('moves a feature earlier', () => {
    const { store, bus, partId } = wired([node('A'), node('B'), node('C')]);
    bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('c'), newIndex: 0,
    });
    expect(names(store, partId)).toEqual(['C', 'A', 'B']);
  });

  it('is a no-op when the index does not change', () => {
    const { store, bus, partId } = wired([node('A'), node('B')]);
    bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('b'), newIndex: 1,
    });
    expect(names(store, partId)).toEqual(['A', 'B']);
    // No patch, so no undo entry to step through later.
    expect(store.canUndo()).toBe(false);
  });

  it('undo restores the original order', () => {
    const { store, bus, partId } = wired([node('A'), node('B'), node('C')]);
    bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('a'), newIndex: 2,
    });
    bus.undo();
    expect(names(store, partId)).toEqual(['A', 'B', 'C']);
  });
});

describe('ReorderFeature — dependency guards', () => {
  it('refuses to move a feature above something it uses', () => {
    const { store, bus, partId } = wired([
      node('Extrude 1'),
      node('Fillet 1', [featureId('extrude 1')]),
    ]);
    const r = bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('fillet 1'), newIndex: 0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/"Fillet 1" uses "Extrude 1"/);
    expect(names(store, partId)).toEqual(['Extrude 1', 'Fillet 1']);
  });

  it('refuses to move a feature below something that uses it', () => {
    // The same constraint read from the other end: dragging the extrude down
    // past its own fillet breaks it just as surely.
    const { bus, partId } = wired([
      node('Extrude 1'),
      node('Fillet 1', [featureId('extrude 1')]),
    ]);
    const r = bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('extrude 1'), newIndex: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/"Fillet 1" uses "Extrude 1"/);
  });

  it('allows a move that keeps the dependency satisfied', () => {
    // Sketch, Extrude(dep Sketch), Unrelated → moving Unrelated to the front
    // disturbs nothing.
    const { store, bus, partId } = wired([
      node('Sketch 1'),
      node('Extrude 1', [featureId('sketch 1')]),
      node('Box 1'),
    ]);
    const r = bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('box 1'), newIndex: 0,
    });
    expect(r.ok).toBe(true);
    expect(names(store, partId)).toEqual(['Box 1', 'Sketch 1', 'Extrude 1']);
  });
});

describe('ReorderFeature — bad input', () => {
  it('rejects an index outside the timeline', () => {
    const { bus, partId } = wired([node('A'), node('B')]);
    for (const newIndex of [-1, 2, 1.5]) {
      const r = bus.dispatch({
        type: 'ReorderFeature', partId, featureId: featureId('a'), newIndex,
      });
      expect(r.ok, `newIndex ${newIndex}`).toBe(false);
    }
  });

  it('rejects a feature that is not in this part', () => {
    const { bus, partId } = wired([node('A')]);
    const r = bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('nope'), newIndex: 0,
    });
    expect(r.ok).toBe(false);
  });
});

describe('ReorderFeature — rebuild invalidation', () => {
  it('dirties from the earliest position the move touched', () => {
    // The rebuild has to recompute everything from the lower of the two
    // indices; `detectDirty` derives that from the patch paths, so the
    // handler needs no special handling — this is the test that says so.
    const { store, bus, partId } = wired([node('A'), node('B'), node('C'), node('D')]);
    const seen: number[] = [];
    const off = store.onDirtyFeature((fromIndex) => seen.push(fromIndex));
    bus.dispatch({
      type: 'ReorderFeature', partId, featureId: featureId('d'), newIndex: 1,
    });
    off();
    expect(seen).toEqual([1]);
  });
});

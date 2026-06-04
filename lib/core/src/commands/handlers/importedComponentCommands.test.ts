/**
 * Tests for createImportedComponentHandler.
 *
 * Covers:
 *   - happy path embeds + appends feature with derived componentRef
 *   - idempotent upsert on hash (re-importing same content reuses entry)
 *   - validation rejects empty hash / name / source / sourceless project
 *   - validation rejects invalid boolean mode
 *   - dispatch creates a stable importedComponent FeatureNode
 *   - undo rolls back BOTH the embed and the feature append
 */
import { describe, expect, it } from 'vitest';
import { newProjectWithPart, emptyProject, createPart } from '../../document/factory.ts';
import type { CadProject, ComponentDefinition } from '../../document/schema.ts';
import type { Transform3D } from '../../math.ts';
import type { PartId } from '../../ids.ts';
import { partId } from '../../ids.ts';
import { DocumentStore } from '../../store/documentStore.ts';
import { CommandBus } from '../bus.ts';
import { createImportedComponentHandler } from './featureCommands.ts';

function firstPartId(project: CadProject): PartId {
  const ids = Object.keys(project.parts);
  if (ids.length === 0) throw new Error('test fixture has no parts');
  return ids[0] as PartId;
}

function identityTransform(): Transform3D {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
}

/**
 * A minimal but real component source — empty project + one part. The
 * tests don't exercise the rebuilder, so an empty timeline is fine; the
 * point here is the handler-level embed + feature creation contract.
 */
function makeComponentSource(name = 'Dowel Pin'): CadProject {
  const proj = emptyProject(name);
  const part = createPart(name);
  proj.parts[part.id] = part;
  return proj;
}

function makeComponentDef(hash: string, name: string): ComponentDefinition {
  return {
    hash,
    name,
    embeddedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    source: makeComponentSource(name),
  };
}

describe('createImportedComponentHandler.validate', () => {
  it('accepts a well-formed command', () => {
    const p = newProjectWithPart('Host');
    const r = createImportedComponentHandler.validate(
      {
        type: 'CreateImportedComponent',
        partId: firstPartId(p),
        component: makeComponentDef('abc123', 'Dowel Pin'),
        inputs: {
          transform: identityTransform(),
          parameterOverrides: {},
          boolean: 'newBody',
        },
      },
      p,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects empty hash', () => {
    const p = newProjectWithPart('Host');
    const r = createImportedComponentHandler.validate(
      {
        type: 'CreateImportedComponent',
        partId: firstPartId(p),
        component: { ...makeComponentDef('abc', 'X'), hash: '' },
        inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
      },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_INPUT');
  });

  it('rejects empty name', () => {
    const p = newProjectWithPart('Host');
    const r = createImportedComponentHandler.validate(
      {
        type: 'CreateImportedComponent',
        partId: firstPartId(p),
        component: { ...makeComponentDef('abc', 'X'), name: '' },
        inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
      },
      p,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects source with no parts', () => {
    const p = newProjectWithPart('Host');
    const def = makeComponentDef('abc', 'X');
    def.source.parts = {};
    const r = createImportedComponentHandler.validate(
      {
        type: 'CreateImportedComponent',
        partId: firstPartId(p),
        component: def,
        inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
      },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('INVALID_COMPONENT');
  });

  it('rejects invalid boolean mode', () => {
    const p = newProjectWithPart('Host');
    const r = createImportedComponentHandler.validate(
      {
        type: 'CreateImportedComponent',
        partId: firstPartId(p),
        component: makeComponentDef('abc', 'X'),
        inputs: {
          transform: identityTransform(),
          parameterOverrides: {},
          boolean: 'fubar' as 'newBody',
        },
      },
      p,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects unknown part', () => {
    const p = newProjectWithPart('Host');
    const r = createImportedComponentHandler.validate(
      {
        type: 'CreateImportedComponent',
        partId: partId('missing'),
        component: makeComponentDef('abc', 'X'),
        inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
      },
      p,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.code).toBe('NOT_FOUND');
  });
});

describe('createImportedComponentHandler.execute', () => {
  function makeBus(p: CadProject) {
    const store = new DocumentStore(p);
    const bus = new CommandBus(store);
    bus.register('CreateImportedComponent', createImportedComponentHandler);
    return { store, bus };
  }

  it('embeds the component AND appends the feature in one mutation', () => {
    const p = newProjectWithPart('Host');
    const { store, bus } = makeBus(p);
    const before = store.getState();
    expect(before.embeddedComponents).toBeUndefined();
    expect(before.parts[firstPartId(before)]!.timeline.length).toBe(0);

    const r = bus.dispatch({
      type: 'CreateImportedComponent',
      partId: firstPartId(p),
      component: makeComponentDef('hash-xyz', 'Dowel Pin'),
      inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
    });
    expect(r.ok).toBe(true);

    const after = store.getState();
    expect(after.embeddedComponents).toBeDefined();
    expect(after.embeddedComponents!['hash-xyz']!.name).toBe('Dowel Pin');

    const timeline = after.parts[firstPartId(after)]!.timeline;
    expect(timeline.length).toBe(1);
    const feat = timeline[0]!;
    expect(feat.type).toBe('importedComponent');
    expect(feat.name).toBe('Dowel Pin');
    const inputs = feat.inputs as { componentRef: string; boolean: string };
    expect(inputs.componentRef).toBe('hash-xyz');
    expect(inputs.boolean).toBe('newBody');
  });

  it('numbers subsequent instances "(2)", "(3)"', () => {
    const p = newProjectWithPart('Host');
    const { store, bus } = makeBus(p);
    const def = makeComponentDef('h1', 'Bolt');
    for (let i = 0; i < 3; i++) {
      bus.dispatch({
        type: 'CreateImportedComponent',
        partId: firstPartId(p),
        component: def,
        inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
      });
    }
    const timeline = store.getState().parts[firstPartId(p)]!.timeline;
    expect(timeline.map(f => f.name)).toEqual(['Bolt', 'Bolt (2)', 'Bolt (3)']);
  });

  it('idempotent on hash: re-importing same hash reuses the one entry', () => {
    const p = newProjectWithPart('Host');
    const { store, bus } = makeBus(p);
    bus.dispatch({
      type: 'CreateImportedComponent',
      partId: firstPartId(p),
      component: makeComponentDef('shared', 'A'),
      inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
    });
    bus.dispatch({
      type: 'CreateImportedComponent',
      partId: firstPartId(p),
      component: makeComponentDef('shared', 'A'),
      inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'cut' },
    });
    const after = store.getState();
    expect(Object.keys(after.embeddedComponents!).length).toBe(1);
    expect(after.parts[firstPartId(after)]!.timeline.length).toBe(2);
  });

  it('undo rolls back both the embed and the feature', () => {
    const p = newProjectWithPart('Host');
    const { store, bus } = makeBus(p);
    bus.dispatch({
      type: 'CreateImportedComponent',
      partId: firstPartId(p),
      component: makeComponentDef('h1', 'Bolt'),
      inputs: { transform: identityTransform(), parameterOverrides: {}, boolean: 'newBody' },
    });
    expect(store.getState().embeddedComponents!['h1']).toBeDefined();
    store.undo();
    const undone = store.getState();
    expect(undone.embeddedComponents?.['h1']).toBeUndefined();
    expect(undone.parts[firstPartId(undone)]!.timeline.length).toBe(0);
  });
});

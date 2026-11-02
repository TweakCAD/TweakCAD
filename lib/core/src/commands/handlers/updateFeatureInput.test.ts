/**
 * `UpdateFeatureInput` — setting one value inside a feature's inputs by key
 * path.
 *
 * The path arrives as raw JSON from `dispatch_command`, so the handler is the
 * only thing between a caller and the document's objects. A path that walks
 * into a prototype (`__proto__`, `constructor`, `prototype`) would write to
 * an object shared by the whole page, and a path that names nothing used to
 * report success while changing nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentStore } from '../../store/documentStore.ts';
import { CommandBus } from '../bus.ts';
import { updateFeatureInputHandler } from './featureCommands.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { featureId } from '../../ids.ts';
import type { PartId } from '../../ids.ts';
import type { FeatureNode } from '../../document/schema.ts';

const FEATURE = featureId('move_1');

function wired(initialInputs: Record<string, unknown>) {
  const project = newProjectWithPart('Host', 'Part 1');
  const partId = Object.keys(project.parts)[0]! as PartId;
  const node: FeatureNode = {
    id: FEATURE,
    type: 'move',
    name: 'Move 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: initialInputs,
    dependsOn: [],
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
  project.parts[partId]!.timeline = [node];
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('UpdateFeatureInput', updateFeatureInputHandler);
  const update = (path: unknown, value: unknown) =>
    bus.dispatch({ type: 'UpdateFeatureInput', partId, featureId: FEATURE, path, value } as never);
  const inputs = () => store.getState().parts[partId]!.timeline[0]!.inputs;
  return { store, update, inputs };
}

describe('UpdateFeatureInput — writes', () => {
  it('sets a top-level input', () => {
    const { store, update, inputs } = wired({ offset: '5' });
    expect(update(['offset'], '12').ok).toBe(true);
    expect(inputs()['offset']).toBe('12');
    expect(store.undoLabel()).toBeDefined();
  });

  it('adds a top-level input that was not there yet', () => {
    const { update, inputs } = wired({});
    expect(update(['transform'], { position: [1, 2, 3] }).ok).toBe(true);
    expect(inputs()['transform']).toEqual({ position: [1, 2, 3] });
  });

  it('sets a nested input inside an existing object', () => {
    const { update, inputs } = wired({ transform: { position: [0, 0, 0] } });
    expect(update(['transform', 'position'], [4, 5, 6]).ok).toBe(true);
    expect(inputs()['transform']).toEqual({ position: [4, 5, 6] });
  });
});

describe('UpdateFeatureInput — rejected paths', () => {
  afterEach(() => {
    // Clean up after a regression so one failure cannot leak into others.
    const proto = Object.prototype as { polluted?: unknown; hijacked?: unknown };
    delete proto.polluted;
    delete proto.hijacked;
  });

  it.each([
    [['__proto__', 'polluted']],
    [['constructor', 'prototype', 'polluted']],
    [['transform', '__proto__', 'polluted']],
    [['__proto__']],
    [['prototype']],
  ])('rejects %j without touching any prototype', (path) => {
    const { store, update } = wired({ transform: { position: [0, 0, 0] } });
    const before = store.getState();

    const r = update(path, 'yes');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(store.getState()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('does not follow an inherited property as an intermediate', () => {
    // `toString` is inherited by every input object; walking into it would
    // reach a function shared across the page.
    const { store, update } = wired({});
    const before = store.getState();
    const r = update(['toString', 'hijacked'], 'yes');
    expect(r.ok).toBe(false);
    expect(store.getState()).toBe(before);
  });

  it.each([
    ['an empty path', []],
    ['a non-array path', 'offset'],
    ['a non-string segment', ['transform', 0]],
    ['an empty segment', ['']],
  ])('rejects %s', (_label, path) => {
    const { store, update } = wired({ transform: { position: [0, 0, 0] } });
    const before = store.getState();
    const r = update(path, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('path');
    expect(store.getState()).toBe(before);
  });

  it('rejects a path whose intermediate does not exist, instead of reporting success', () => {
    const { store, update } = wired({ offset: '5' });
    const before = store.getState();
    const r = update(['transform', 'position'], [1, 2, 3]);
    expect(r.ok).toBe(false);
    expect(store.getState()).toBe(before);
  });

  it('rejects a path that walks through a non-object value', () => {
    const { store, update } = wired({ offset: '5' });
    const before = store.getState();
    const r = update(['offset', 'length'], 3);
    expect(r.ok).toBe(false);
    expect(store.getState()).toBe(before);
  });
});

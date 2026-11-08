import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import type { Picked, PickTarget } from '@tweakcad/worker/src/v2/service/types';
import { pickReference, regionReference, writePicked, type PickClient } from './picking';
import { clearSelection, createSelectionStore, followGeneration, isSelected, select, setHover } from './selection';
import { createDisplayStore } from './display/scheduler';
import type { Display } from '@tweakcad/worker/src/v2/service/types';

class FakeClient implements PickClient {
  readonly calls: { target: PickTarget; options?: { before?: string } }[] = [];
  constructor(private readonly answer: Picked | null) {}
  pick(target: PickTarget, options?: { before?: string }): Promise<Picked | null> {
    this.calls.push(options ? { target, options } : { target });
    return Promise.resolve(this.answer);
  }
}

/** A sketch of two rectangles, the second region not yet a row, and an extrude of the first. */
function twoRegions() {
  const d = new DocBuilder();
  const s = d.sketch('xy', (x) => {
    x.rect(0, 0, 10, 10);
    x.rect(20, 0, 10, 10);
  });
  const first = s.region([1, 1]);
  const second = s.rows.find((r) => JSON.stringify(s.refOf(r.id)) !== JSON.stringify(first));
  const extrude = d.extrude({ sketch: s.feature, profiles: [first] });
  const doc = d.document();
  const sketch = (doc.parts as Json[])[0]!.timeline as Json[];
  const inputs = sketch[0]!.inputs as Json;
  inputs.regions = (inputs.regions as Json[]).filter((r) => r.id !== second!.id);
  return { doc, sketch: s.feature, extrude, second: second! };
}

describe('pickReference', () => {
  it('asks the worker for a key, with the instance and the feature being edited', async () => {
    const client = new FakeClient({
      reference: { entity: { id: ['h'], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } as never },
      names: {},
    });
    const picked = await pickReference(
      client,
      { key: 7, instance: { assembly: 'asm_1', index: 2 } },
      { before: 'feat_1' },
    );
    expect(client.calls).toEqual([
      { target: { key: 7, instance: { assembly: 'asm_1', index: 2 } }, options: { before: 'feat_1' } },
    ]);
    expect(picked).toEqual({
      reference: { entity: { id: ['h'], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } },
      names: {},
    });
  });

  it('returns null when the worker no longer knows the key', async () => {
    expect(await pickReference(new FakeClient(null), { key: 3 })).toBeNull();
  });

  it('references standard planes and features without the worker', async () => {
    const client = new FakeClient(null);
    expect(await pickReference(client, { standard: 'xz' })).toEqual({
      reference: { standard: { name: 'xz' } },
      names: {},
    });
    expect(await pickReference(client, { feature: 'feat_9' })).toEqual({
      reference: { object: { feature: { id: 'feat_9' } } },
      names: {},
    });
    expect(await pickReference(client, { datum: 'z' })).toEqual({ reference: { standard: { name: 'z' } }, names: {} });
    expect(await pickReference(client, { datum: 'origin' })).toEqual({
      reference: { standard: { name: 'origin' } },
      names: {},
    });
    expect(client.calls).toEqual([]);
  });
});

describe('writePicked', () => {
  it('writes a picked region as a new row and a reference to it, in one undo step', async () => {
    const { doc, sketch, extrude, second } = twoRegions();
    const editor = new Editor(doc);
    const before = editor.save();
    const client = new FakeClient({ region: { sketch, loop: second.loop, holes: second.holes } });
    const picked = await pickReference(client, { key: 12 });
    expect(picked).not.toBeNull();
    const result = writePicked(editor, extrude, '/profiles', picked!);
    expect(result.ok).toBe(true);
    const after = editor.document;
    expect(readDocument(after).diagnostics.filter((d) => d.severity === 'refuse')).toEqual([]);
    const inputs = ((after.parts as Json[])[0]!.timeline as Json[])[0]!.inputs as Json;
    const rows = inputs.regions as Json[];
    expect(rows).toHaveLength(2);
    const added = rows.find((r) => JSON.stringify(r.loop) === JSON.stringify(second.loop))!;
    expect(added.origin).toEqual({ detected: {} });
    const profiles = (((after.parts as Json[])[0]!.timeline as Json[])[1]!.inputs as Json).profiles as { set: Json[] };
    expect(profiles.set).toHaveLength(2);
    expect(profiles.set).toContainEqual(regionReference(sketch, added.id as string).reference);
    expect(editor.undo()).toBe(true);
    expect(editor.save()).toBe(before);
  });

  it('writes an entity reference with its names', () => {
    const { doc, extrude } = twoRegions();
    const editor = new Editor(doc);
    const result = writePicked(editor, extrude, '/direction/normal/ref', {
      reference: { standard: { name: 'xy' } },
      names: {},
    });
    expect(result.ok).toBe(true);
  });

  it('changes nothing when the reference is refused', () => {
    const { doc, extrude } = twoRegions();
    const editor = new Editor(doc);
    const before = editor.save();
    const result = writePicked(editor, extrude, '/profiles', {
      region: { sketch: 'feat_nope', loop: [] as never, holes: { set: [] } as never },
    });
    expect(result.ok).toBe(false);
    expect(editor.save()).toBe(before);
    expect(editor.store.canUndo()).toBe(false);
  });
});

describe('selection', () => {
  const display = (generation: number): Display => ({
    generation,
    definitions: [],
    parts: {},
    assemblies: [],
    entities: [],
    pauses: [],
    stale: [],
    outOfDate: [],
    timing: { evaluate: 0, display: 0, resumed: 0 },
  });

  it('selects one item, or toggles items with additive', () => {
    const store = createSelectionStore();
    select(store, { key: 1 });
    select(store, { key: 2 });
    expect(store.getState().items).toEqual([{ key: 2 }]);
    select(store, { standard: 'xy' }, true);
    expect(isSelected(store.getState(), { standard: 'xy' })).toBe(true);
    select(store, { key: 2 }, true);
    expect(store.getState().items).toEqual([{ standard: 'xy' }]);
    select(store, { datum: 'x' }, true);
    expect(isSelected(store.getState(), { datum: 'x' })).toBe(true);
    expect(isSelected(store.getState(), { datum: 'y' })).toBe(false);
    select(store, { datum: 'x' }, true);
    expect(store.getState().items).toEqual([{ standard: 'xy' }]);
    clearSelection(store);
    expect(store.getState().items).toEqual([]);
  });

  it('tells instances apart', () => {
    const store = createSelectionStore();
    select(store, { key: 4, instance: { assembly: 'a', index: 0 } });
    expect(isSelected(store.getState(), { key: 4, instance: { assembly: 'a', index: 1 } })).toBe(false);
    expect(isSelected(store.getState(), { key: 4 })).toBe(false);
    expect(isSelected(store.getState(), { key: 4, instance: { assembly: 'a', index: 0 } })).toBe(true);
  });

  it('drops key items and a key hover when the display generation changes', () => {
    const displays = createDisplayStore();
    const store = createSelectionStore();
    followGeneration(store, displays);
    displays.setState({ display: display(1) });
    select(store, { key: 5 });
    select(store, { feature: 'feat_1' }, true);
    select(store, { standard: 'yz' }, true);
    setHover(store, { key: 6 });
    displays.setState({ evaluating: true });
    expect(store.getState().items).toHaveLength(3);
    displays.setState({ display: display(2) });
    expect(store.getState().items).toEqual([{ feature: 'feat_1' }, { standard: 'yz' }]);
    expect(store.getState().hover).toBeNull();
    expect(store.getState().generation).toBe(2);
  });

  it('keeps the key items a display that only shows the one before otherwise still shows', () => {
    const displays = createDisplayStore();
    const store = createSelectionStore();
    followGeneration(store, displays);
    const entity = (key: number, shown: boolean) => ({
      key,
      kind: 'face' as const,
      scope: { definition: 0 },
      body: null,
      feature: 'f',
      shown,
    });
    displays.setState({ display: display(1) });
    select(store, { key: 0 });
    select(store, { key: 1 }, true);
    displays.setState({ display: { ...display(2), entities: [entity(0, true), entity(1, false)], restyled: 1 } });
    expect(store.getState().items).toEqual([{ key: 0 }]);
    expect(store.getState().generation).toBe(2);
    // One that restyles a display the selection never followed drops them.
    displays.setState({ display: { ...display(4), restyled: 3 } });
    expect(store.getState().items).toEqual([]);
  });
});

/**
 * `CreateImportedGeometry` — the inline/ref split at the write end.
 *
 * An import is either embedded in the document (`inline`, portable, small) or
 * held in `project.references` (`ref`), which is what lets a large STEP be
 * stored once instead of copied into every revision of the document.
 *
 * The property that matters here is that a `ref` and its asset land together.
 * A document holding a reference to bytes it never stored rebuilds into an
 * empty body with a "not loaded" diagnostic — a failure that looks like the
 * import quietly stopped working, discovered long after the import itself.
 */
import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../../store/documentStore.ts';
import { CommandBus } from '../bus.ts';
import { createImportedGeometryHandler } from './featureCommands.ts';
import { newProjectWithPart } from '../../document/factory.ts';
import { makeImportedData } from '../../document/importedData.ts';
import { IMPORT_INLINE_MAX_BYTES } from '../../document/schema.ts';
import type { ImportedGeometryFeatureInputs, ReferenceAsset } from '../../document/schema.ts';
import { referenceId } from '../../ids.ts';
import type { PartId } from '../../ids.ts';

/** base64 that decodes to just over / under the inline threshold. */
const BIG = 'A'.repeat(IMPORT_INLINE_MAX_BYTES * 2);
const SMALL = 'A'.repeat(64);

function wired() {
  const project = newProjectWithPart('Host', 'Part 1');
  const partId = Object.keys(project.parts)[0]! as PartId;
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateImportedGeometry', createImportedGeometryHandler);
  return { store, bus, partId };
}

function importOf(base64: string) {
  return makeImportedData(base64, {
    name: 'bracket.step',
    type: 'step',
    hash: 'deadbeef',
    referenceId: referenceId('ref_1'),
  });
}

describe('CreateImportedGeometry — inline', () => {
  it('embeds a small file and registers no asset', () => {
    const { store, bus, partId } = wired();
    const { data, asset } = importOf(SMALL);
    expect(asset).toBeUndefined();

    const r = bus.dispatch({
      type: 'CreateImportedGeometry',
      partId,
      inputs: { fileName: 'bracket.step', format: 'step', data },
    });
    expect(r.ok).toBe(true);

    const state = store.getState();
    expect(Object.keys(state.references)).toHaveLength(0);
    const inputs = state.parts[partId]!.timeline[0]!
      .inputs as unknown as ImportedGeometryFeatureInputs;
    expect(inputs.data.kind).toBe('inline');
  });
});

describe('CreateImportedGeometry — ref', () => {
  it('registers the asset and the feature in one mutation', () => {
    const { store, bus, partId } = wired();
    const { data, asset } = importOf(BIG);
    expect(asset).toBeDefined();

    const r = bus.dispatch({
      type: 'CreateImportedGeometry',
      partId,
      inputs: { fileName: 'bracket.step', format: 'step', data },
      asset: asset!,
    });
    expect(r.ok).toBe(true);

    const state = store.getState();
    const inputs = state.parts[partId]!.timeline[0]!
      .inputs as unknown as ImportedGeometryFeatureInputs;
    expect(inputs.data.kind).toBe('ref');
    // The bytes are out of the feature and in the reference table — the whole
    // point, since a revision copies the document but can share the asset.
    expect(state.references.ref_1?.bytes).toBe(BIG);
    expect(state.references.ref_1?.hash).toBe('deadbeef');
  });

  it('undo rolls back the asset as well as the feature', () => {
    // Half-rolled-back would leave either an orphan asset (dead bytes) or a
    // feature pointing at nothing.
    const { store, bus, partId } = wired();
    const { data, asset } = importOf(BIG);
    bus.dispatch({
      type: 'CreateImportedGeometry',
      partId,
      inputs: { fileName: 'bracket.step', format: 'step', data },
      asset: asset!,
    });
    bus.undo();

    const state = store.getState();
    expect(state.parts[partId]!.timeline).toHaveLength(0);
    expect(Object.keys(state.references)).toHaveLength(0);
  });

  it('rejects a reference with no asset anywhere', () => {
    const { bus, partId } = wired();
    const { data } = importOf(BIG);
    const r = bus.dispatch({
      type: 'CreateImportedGeometry',
      partId,
      inputs: { fileName: 'bracket.step', format: 'step', data },
      // asset deliberately omitted
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/has no asset/);
  });

  it('accepts a reference to an asset the document already holds', () => {
    // Re-importing the same file, or a second feature sharing one asset —
    // the bytes are already stored, so requiring them again would duplicate
    // exactly what references exist to avoid.
    const { store, bus, partId } = wired();
    const { data, asset } = importOf(BIG);
    bus.dispatch({
      type: 'CreateImportedGeometry',
      partId,
      inputs: { fileName: 'bracket.step', format: 'step', data },
      asset: asset!,
    });

    const second = bus.dispatch({
      type: 'CreateImportedGeometry',
      partId,
      inputs: { fileName: 'bracket.step', format: 'step', data },
    });
    expect(second.ok).toBe(true);
    expect(Object.keys(store.getState().references)).toHaveLength(1);
    expect(store.getState().parts[partId]!.timeline).toHaveLength(2);
  });

  it('rejects a mismatched asset id', () => {
    // The asset is brought but under a different id, so the feature's
    // reference still dangles.
    const { bus, partId } = wired();
    const { data, asset } = importOf(BIG);
    const wrong: ReferenceAsset = { ...asset!, id: referenceId('ref_other') };
    const r = bus.dispatch({
      type: 'CreateImportedGeometry',
      partId,
      inputs: { fileName: 'bracket.step', format: 'step', data },
      asset: wrong,
    });
    expect(r.ok).toBe(false);
  });
});

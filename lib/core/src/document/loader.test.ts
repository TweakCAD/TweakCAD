/**
 * Tests for `loadCadDocument` — the single entry point for every `.cadjson`.
 *
 * The two properties worth guarding here are the ones that cost a user their
 * work if they regress:
 *
 *   1. **Unknown keys survive.** Zod strips by default. If the loader ever
 *      returns Zod's output instead of the original object, an older build
 *      opening a newer document drops every field it does not recognise and
 *      writes the truncated version back — data loss caused by validation.
 *   2. **One bad feature does not cost the document.** A timeline entry this
 *      build cannot read is reported and kept, not fatal.
 *
 * The fatal cases are tested too, but a wrong rejection is a visible
 * inconvenience, where the two above are silent.
 */

import { describe, expect, it } from 'vitest';
import { loadCadDocument, loadCadDocumentOrThrow } from './loader.ts';
import { CURRENT_SCHEMA_VERSION } from './version.ts';
import { emptyProject, createPart } from './factory.ts';
import type { CadProject } from './schema.ts';

/** A minimal valid document with one part and no features. */
function validDoc(): Record<string, unknown> {
  const project = emptyProject('Loader test') as unknown as Record<string, unknown>;
  const part = createPart('Part 1');
  project.parts = { [part.id]: part };
  return JSON.parse(JSON.stringify(project));
}

/** A well-formed sketch feature, used as the "known-good" timeline entry. */
function sketchFeature(id = 'sketch_1'): Record<string, unknown> {
  return {
    id,
    type: 'sketch',
    name: 'Sketch 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: {
      plane: { type: 'defaultPlane', name: 'XY' },
      buildGeometry: {},
      editorModel: { points: [], geometries: [], constraints: [] },
    },
    dependsOn: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function firstPart(doc: Record<string, unknown>): Record<string, unknown> {
  return Object.values(doc.parts as Record<string, Record<string, unknown>>)[0]!;
}

describe('loadCadDocument — happy path', () => {
  it('loads a freshly created project with no diagnostics', () => {
    const result = loadCadDocument(validDoc());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics).toEqual([]);
    expect(result.value.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('accepts a JSON string as well as an object', () => {
    const asText = JSON.stringify(validDoc());
    const result = loadCadDocument(asText);
    expect(result.ok).toBe(true);
  });

  it('loads a document carrying a valid sketch', () => {
    const doc = validDoc();
    firstPart(doc).timeline = [sketchFeature()];
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics).toEqual([]);
  });
});

describe('loadCadDocument — body colours', () => {
  it('keeps body colours, and loads a malformed one rather than refusing the file', () => {
    const doc = validDoc();
    firstPart(doc).bodyColors = { body_a: '#ff0000', body_b: 'not a colour' };
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const part = Object.values(result.value.project.parts)[0]!;
    expect(part.bodyColors).toEqual({ body_a: '#ff0000', body_b: 'not a colour' });
  });

  it('refuses a bodyColors that is not a map of strings', () => {
    const doc = validDoc();
    firstPart(doc).bodyColors = { body_a: 7 };
    expect(loadCadDocument(doc).ok).toBe(false);
  });
});

describe('loadCadDocument — forward compatibility', () => {
  it('preserves unknown top-level keys', () => {
    const doc = validDoc();
    doc.somethingFromTheFuture = { a: 1 };
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.project as unknown as Record<string, unknown>).somethingFromTheFuture)
      .toEqual({ a: 1 });
  });

  it('preserves unknown keys nested inside a feature', () => {
    const doc = validDoc();
    const feature = sketchFeature();
    feature.futureField = 'keep me';
    (feature.inputs as Record<string, unknown>).futureInput = [1, 2, 3];
    firstPart(doc).timeline = [feature];

    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = firstPart(result.value.project as unknown as Record<string, unknown>);
    const node = (loaded.timeline as Record<string, unknown>[])[0]!;
    expect(node.futureField).toBe('keep me');
    expect((node.inputs as Record<string, unknown>).futureInput).toEqual([1, 2, 3]);
  });

  it('survives a JSON round-trip without losing unknown keys', () => {
    // The real risk: load, then save. If the loader strips, the save writes
    // the truncated document and the data is gone for good.
    const doc = validDoc();
    doc.vendorExtension = { plugin: 'x', data: [1] };
    const loaded = loadCadDocumentOrThrow(doc);
    const reSaved = JSON.parse(JSON.stringify(loaded.project)) as Record<string, unknown>;
    expect(reSaved.vendorExtension).toEqual({ plugin: 'x', data: [1] });
  });

  it('applies the `visible` default without touching anything else', () => {
    const doc = validDoc();
    const feature = sketchFeature();
    delete feature.visible;
    firstPart(doc).timeline = [feature];

    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = firstPart(result.value.project as unknown as Record<string, unknown>);
    expect((loaded.timeline as Record<string, unknown>[])[0]!.visible).toBe(true);
  });
});

describe('loadCadDocument — degrades per feature', () => {
  it('keeps an unknown feature type and reports it', () => {
    const doc = validDoc();
    const alien = { ...sketchFeature('feat_alien'), type: 'quantumLoft' };
    firstPart(doc).timeline = [sketchFeature(), alien];

    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.diagnostics).toHaveLength(1);
    expect(result.value.diagnostics[0]!.code).toBe('unsupported-feature');
    expect(result.value.diagnostics[0]!.featureType).toBe('quantumLoft');

    // Kept, not dropped — the user's other work survives and so does this
    // entry, so saving does not silently delete it.
    const loaded = firstPart(result.value.project as unknown as Record<string, unknown>);
    expect(loaded.timeline).toHaveLength(2);
  });

  it('keeps a known feature whose inputs are wrong and reports it', () => {
    const doc = validDoc();
    const broken = sketchFeature('sketch_broken');
    broken.inputs = { plane: { type: 'defaultPlane', name: 'XY' } }; // no buildGeometry/editorModel
    firstPart(doc).timeline = [broken];

    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics).toHaveLength(1);
    expect(result.value.diagnostics[0]!.code).toBe('invalid-feature-inputs');
    expect(result.value.diagnostics[0]!.featureId).toBe('sketch_broken');
  });

  it('catches an extrude with a malformed extent', () => {
    // Per-type validation is the whole point: before it, `inputs` was
    // `z.record(z.unknown())` and this document loaded clean.
    const doc = validDoc();
    firstPart(doc).timeline = [{
      ...sketchFeature('extrude_bad'),
      type: 'extrude',
      inputs: {
        profiles: [],
        operation: 'newBody',
        direction: { type: 'normal' },
        extent: { type: 'nonsense' },
      },
    }];
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics[0]?.code).toBe('invalid-feature-inputs');
  });

  it('reports every bad feature, not just the first', () => {
    const doc = validDoc();
    firstPart(doc).timeline = [
      { ...sketchFeature('a'), type: 'unknownA' },
      sketchFeature('good'),
      { ...sketchFeature('b'), type: 'unknownB' },
    ];
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics.map(d => d.featureId)).toEqual(['a', 'b']);
  });
});

describe('loadCadDocument — fatal cases', () => {
  it('rejects text that is not JSON', () => {
    const result = loadCadDocument('{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-json');
  });

  it('rejects JSON that is not an object', () => {
    expect(loadCadDocument('[1,2,3]').ok).toBe(false);
    expect(loadCadDocument('"a string"').ok).toBe(false);
    expect(loadCadDocument('null').ok).toBe(false);
  });

  it('rejects a document with no usable schemaVersion', () => {
    const doc = validDoc();
    delete doc.schemaVersion;
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-a-document');
  });

  it('rejects the retired string schemaVersion rather than guessing', () => {
    const doc = validDoc();
    doc.schemaVersion = '0.1';
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-a-document');
  });

  it('refuses a document from a newer build', () => {
    const doc = validDoc();
    doc.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported-version');
    // The message has to tell the user what to do about it.
    expect(result.error.message).toMatch(/update/i);
  });

  it('rejects a broken envelope and says where', () => {
    const doc = validDoc();
    delete doc.metadata;
    const result = loadCadDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-envelope');
    expect(result.error.issues?.join(' ')).toMatch(/metadata/);
  });

  it('rejects a parts map that is not a map of parts', () => {
    const doc = validDoc();
    doc.parts = 'nope';
    expect(loadCadDocument(doc).ok).toBe(false);
  });
});

describe('loadCadDocumentOrThrow', () => {
  it('returns the document when valid', () => {
    const loaded = loadCadDocumentOrThrow(validDoc());
    expect(loaded.project.parts).toBeDefined();
  });

  it('throws with the envelope issues attached', () => {
    const doc = validDoc();
    delete doc.metadata;
    expect(() => loadCadDocumentOrThrow(doc)).toThrow(/metadata/);
  });
});

describe('round-trip with the real factory output', () => {
  it('loads what emptyProject writes', () => {
    const project: CadProject = emptyProject('Round trip');
    const result = loadCadDocument(JSON.stringify(project));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project.metadata.name).toBe('Round trip');
  });
});

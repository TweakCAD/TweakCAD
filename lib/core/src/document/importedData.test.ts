/**
 * Tests for the imported-geometry payload discriminator.
 *
 * The `ref` branch has no production caller yet — every import still writes
 * `inline`. That is exactly why it is tested: the discriminator exists now
 * because adding one to a bare string later would be a format break, and an
 * untested branch that sits dormant for months is one that does not work
 * when it is finally needed.
 *
 * The behaviour worth pinning is the failure shape. A `ref` that cannot be
 * resolved must say which reference and why; the alternative — returning
 * empty bytes — surfaces as an import that silently produces no geometry,
 * with nothing pointing at the cause.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveImportedBytes,
  makeImportedData,
  isEmptyImportedData,
} from './importedData.ts';
import { IMPORT_INLINE_MAX_BYTES } from './schema.ts';
import type { CadProject, ReferenceAsset } from './schema.ts';
import { referenceId } from '../ids.ts';

const REF = referenceId('ref_1');

function refs(...assets: ReferenceAsset[]): CadProject['references'] {
  return Object.fromEntries(assets.map(a => [a.id, a])) as CadProject['references'];
}

function asset(over: Partial<ReferenceAsset> = {}): ReferenceAsset {
  return {
    id: REF,
    name: 'bracket.step',
    type: 'step',
    sizeBytes: 1024,
    hash: 'abc123',
    bytes: 'QUJD',
    ...over,
  };
}

describe('resolveImportedBytes', () => {
  it('returns the bytes directly for an inline payload', () => {
    const r = resolveImportedBytes({ kind: 'inline', base64: 'QUJD', sizeBytes: 3 }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe('QUJD');
  });

  it('looks a ref up in the project references', () => {
    const r = resolveImportedBytes(
      { kind: 'ref', referenceId: REF, sizeBytes: 1024 },
      refs(asset()),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe('QUJD');
  });

  it('names the reference when the entry is missing entirely', () => {
    const r = resolveImportedBytes({ kind: 'ref', referenceId: REF, sizeBytes: 1 }, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('missing-reference');
    expect(r.error.message).toContain('ref_1');
  });

  it('distinguishes "not loaded" from "missing", and names the file', () => {
    // Different causes, different fixes: a missing entry means the document
    // is inconsistent, where an unloaded one means the bytes live elsewhere
    // and the user should re-link. Collapsing them would hide which.
    const r = resolveImportedBytes(
      { kind: 'ref', referenceId: REF, sizeBytes: 1024 },
      refs(asset({ bytes: undefined })),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('reference-not-loaded');
    expect(r.error.message).toContain('bracket.step');
    expect(r.error.message).toMatch(/re-link/i);
  });
});

describe('makeImportedData', () => {
  const meta = {
    name: 'part.step',
    type: 'step' as const,
    hash: 'deadbeef',
    referenceId: REF,
  };

  it('inlines a small file and registers no asset', () => {
    const small = 'A'.repeat(1000); // ~750 bytes
    const { data, asset: a } = makeImportedData(small, meta);
    expect(data.kind).toBe('inline');
    expect(a).toBeUndefined();
  });

  it('refs a large file and hands back the asset to register', () => {
    // 4 base64 chars per 3 bytes, so this clears the threshold.
    const large = 'A'.repeat(IMPORT_INLINE_MAX_BYTES * 2);
    const { data, asset: a } = makeImportedData(large, meta);
    expect(data.kind).toBe('ref');
    expect(a).toBeDefined();
    expect(a?.name).toBe('part.step');
    expect(a?.hash).toBe('deadbeef');
    // Bytes travel with the asset, so a local document stays self-contained;
    // a cloud project can drop them after uploading.
    expect(a?.bytes).toBe(large);
  });

  it('records a size that round-trips through the resolver', () => {
    const large = 'A'.repeat(IMPORT_INLINE_MAX_BYTES * 2);
    const { data, asset: a } = makeImportedData(large, meta);
    expect(data.sizeBytes).toBe(a?.sizeBytes);
    // Size is readable without decoding base64 or fetching a blob — the
    // point of carrying it on both variants.
    expect(data.sizeBytes).toBeGreaterThan(IMPORT_INLINE_MAX_BYTES);
  });

  it('decides on decoded bytes, not base64 length', () => {
    // base64 is 4/3 the size of its payload. A file just under the limit
    // has an encoded length well over it, so comparing the wrong one would
    // push perfectly inlineable imports out to references.
    const justUnder = 'A'.repeat(Math.floor((IMPORT_INLINE_MAX_BYTES * 4) / 3) - 8);
    expect(justUnder.length).toBeGreaterThan(IMPORT_INLINE_MAX_BYTES);
    expect(makeImportedData(justUnder, meta).data.kind).toBe('inline');
  });
});

describe('isEmptyImportedData', () => {
  it('treats absent, empty inline, and empty ref alike', () => {
    expect(isEmptyImportedData(undefined)).toBe(true);
    expect(isEmptyImportedData({ kind: 'inline', base64: '', sizeBytes: 0 })).toBe(true);
    expect(isEmptyImportedData({ kind: 'ref', referenceId: referenceId(''), sizeBytes: 0 })).toBe(true);
  });

  it('accepts a populated payload of either kind', () => {
    expect(isEmptyImportedData({ kind: 'inline', base64: 'QUJD', sizeBytes: 3 })).toBe(false);
    expect(isEmptyImportedData({ kind: 'ref', referenceId: REF, sizeBytes: 9 })).toBe(false);
  });
});

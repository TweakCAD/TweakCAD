/**
 * Resolving an {@link ImportedGeometryData} to its bytes.
 *
 * An import is either embedded in the document (`inline`) or held in
 * `CadProject.references` (`ref`). Every consumer goes through here so the
 * two cases are decided in one place, and so a `ref` whose asset is missing
 * produces a named diagnostic rather than an empty body — the failure mode
 * that would otherwise look like "the import silently stopped working".
 */

import type { Result } from '../result.ts';
import { ok, err } from '../result.ts';
import type {
  CadProject,
  ImportedGeometryData,
  ReferenceAsset,
} from './schema.ts';
import { IMPORT_INLINE_MAX_BYTES } from './schema.ts';
import type { ReferenceId } from '../ids.ts';

export type ImportResolveError =
  /** `ref` points at an id with no entry in `project.references`. */
  | { code: 'missing-reference'; referenceId: string; message: string }
  /** The entry exists but this reader does not hold its bytes. */
  | { code: 'reference-not-loaded'; referenceId: string; name: string; message: string };

/**
 * Base64 bytes for an import.
 *
 * @param data The feature's `inputs.data`.
 * @param references The owning project's `references` map. Only consulted
 *   for `kind: 'ref'`.
 */
export function resolveImportedBytes(
  data: ImportedGeometryData,
  references: CadProject['references'],
): Result<string, ImportResolveError> {
  if (data.kind === 'inline') return ok(data.base64);

  const asset = references[data.referenceId];
  if (!asset) {
    return err({
      code: 'missing-reference',
      referenceId: String(data.referenceId),
      message:
        `Imported geometry refers to "${String(data.referenceId)}", which is ` +
        `not in this document's references.`,
    });
  }
  if (asset.bytes === undefined) {
    return err({
      code: 'reference-not-loaded',
      referenceId: String(data.referenceId),
      name: asset.name,
      message:
        `"${asset.name}" is stored outside this document and was not loaded ` +
        `with it. Re-link the file to rebuild this import.`,
    });
  }
  return ok(asset.bytes);
}

/**
 * Build the `data` for a freshly imported file.
 *
 * Returns `inline` under {@link IMPORT_INLINE_MAX_BYTES} and `ref` above it,
 * alongside the asset to register. The caller decides what to do with the
 * asset — a local document stores it with `bytes` present, so a `ref` stays
 * self-contained; a cloud project can upload it and store the entry without
 * `bytes`. That difference is the whole reason `bytes` is optional.
 */
export function makeImportedData(
  base64: string,
  meta: { name: string; type: ReferenceAsset['type']; hash: string; referenceId: ReferenceId },
): { data: ImportedGeometryData; asset?: ReferenceAsset } {
  // base64 carries 3 bytes per 4 chars; padding makes this an upper bound,
  // which is the right side to err on for a size budget.
  const sizeBytes = Math.floor((base64.length * 3) / 4);

  if (sizeBytes <= IMPORT_INLINE_MAX_BYTES) {
    return { data: { kind: 'inline', base64, sizeBytes } };
  }
  return {
    data: { kind: 'ref', referenceId: meta.referenceId, sizeBytes },
    asset: {
      id: meta.referenceId,
      name: meta.name,
      type: meta.type,
      sizeBytes,
      hash: meta.hash,
      bytes: base64,
    },
  };
}

/** True when the payload carries no usable bytes either way. */
export function isEmptyImportedData(data: ImportedGeometryData | undefined): boolean {
  if (!data) return true;
  if (data.kind === 'inline') return data.base64.length === 0;
  return String(data.referenceId).length === 0;
}

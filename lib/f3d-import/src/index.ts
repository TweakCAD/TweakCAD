/**
 * @tweakcad/f3d-import: `.f3d` and `.f3z` files as version-2 documents.
 *
 * The parser decodes the archive and the design records into plain data;
 * `importF3d` converts that, and the result's `steps` (fillets and chamfers,
 * which name faces of the built model) and sketch constraints are finished on
 * the worker service by `complete`.
 */
import { convertDesign, type Conversion, type ConvertOptions } from './convert';
import { readDesign } from './parser/readDesign';

export type { BodyStep, Conversion, ConvertOptions, ImportNote, ImportReport, RoundStep, Step } from './convert';
export { complete, type F3dClient, type FinishProgress } from './complete';
export { readDesign } from './parser/readDesign';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Largest file accepted, so an oversized pick fails before any work starts. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Imports a `.f3d` or `.f3z` file's bytes. */
export function importF3d(bytes: Uint8Array, options: Omit<ConvertOptions, 'source'>): Result<Conversion> {
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: 'This file is too large to import.' };
  try {
    return { ok: true, value: convertDesign(readDesign(bytes), { ...options, source: bytes }) };
  } catch (e) {
    return { ok: false, error: `This .f3d file could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

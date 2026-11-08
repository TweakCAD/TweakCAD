/**
 * @tweakcad/fcstd-import: FreeCAD `.FCStd` files as version-2 documents.
 *
 * `importFcstd` reads the archive and converts it; the result's `steps`
 * (features that name entities of the shapes FreeCAD built, and the shapes
 * FreeCAD stored) are finished on the worker service by `complete`.
 */
import { readArchive } from './archive';
import { convertDocument, type Conversion, type ConvertOptions } from './convert';
import { parseDocument } from './document';
import type { Result } from './xml';

export type { BodyStyle, Check, Conversion, ConvertOptions, ImportNote, LocateStep, ShapeStep, Step } from './convert';
export { complete, type FinishProgress, type LocateClient, type Measured } from './complete';
export { parseDocument, type FcDocument, type FcObject } from './document';
export { readArchive } from './archive';
export { convertDocument } from './convert';

/** Imports a `.FCStd` file's bytes. */
export function importFcstd(bytes: Uint8Array, options: Omit<ConvertOptions, 'files' | 'source'>): Result<Conversion> {
  const archive = readArchive(bytes);
  if (!archive.ok) return archive;
  const doc = parseDocument(archive.value.documentXml);
  if (!doc.ok) return doc;
  return { ok: true, value: convertDocument(doc.value, { ...options, files: archive.value.files, source: bytes }) };
}

/** Imports a `Document.xml` on its own: no stored shapes, so fillets and chamfers are left out. */
export function importFcstdXml(xml: string, options: Omit<ConvertOptions, 'files' | 'source'>): Result<Conversion> {
  const doc = parseDocument(xml);
  if (!doc.ok) return doc;
  return { ok: true, value: convertDocument(doc.value, options) };
}

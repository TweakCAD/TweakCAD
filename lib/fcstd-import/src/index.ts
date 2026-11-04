/**
 * @tweakcad/fcstd-import — FreeCAD .fcstd → CadProject importer.
 *
 * Parser layer:
 *   - readFcstdArchive: unzip a .fcstd (Blob/ArrayBuffer/Uint8Array)
 *   - parseDocumentXml: parse the Document.xml string into typed FC structures
 *
 * Converter layer:
 *   - convertSketch / convertPad / convertPocket: per-feature mappings
 *   - convertDocument: full document → CadProject + Diagnostic[]
 *
 * The high-level entry point is importFcstd.
 */

import type { Result } from '@tweakcad/core/src/result.ts';
import { ok } from '@tweakcad/core/src/result.ts';
import type { CadProject, Diagnostic } from '@tweakcad/core/src/document/schema.ts';
import { readFcstdArchive } from './parser/fcstdArchive.ts';
import { parseDocumentXml } from './parser/documentParser.ts';
import { convertDocument } from './converter/projectConverter.ts';
import type { FcstdImportReport } from './converter/projectConverter.ts';

export type ImportFcstdOptions = {
  /** Optional override for the imported project's `metadata.name`. */
  name?: string;
  /** Optional ISO timestamp for `createdAt`/`updatedAt`. Defaults to "now". */
  createdAt?: string;
};

export type ImportFcstdSuccess = {
  project: CadProject;
  diagnostics: Diagnostic[];
  report: FcstdImportReport;
};

/**
 * Import a .fcstd file as a CadProject.
 *
 * @param input - The .fcstd file as a Blob, ArrayBuffer, or Uint8Array
 * @param options - Optional metadata overrides
 * @returns A Result containing the converted project plus diagnostics, or
 *   an error string when the file cannot be unzipped / parsed
 */
export async function importFcstd(
  input: Blob | ArrayBuffer | Uint8Array,
  options: ImportFcstdOptions = {},
): Promise<Result<ImportFcstdSuccess, string>> {
  const archive = await readFcstdArchive(input);
  if (!archive.ok) return archive;

  const parsed = parseDocumentXml(archive.value.documentXml);
  if (!parsed.ok) return parsed;

  const conversion = convertDocument(parsed.value, options);
  return ok(conversion);
}

/**
 * Lower-level entry point that skips ZIP extraction.
 *
 * Useful for tests or pipelines that already have the raw Document.xml text
 * (e.g. FreeCAD examples stored unzipped).
 *
 * @param documentXml - The Document.xml content as a string
 * @param options - Optional metadata overrides
 */
export function importFcstdFromXml(
  documentXml: string,
  options: ImportFcstdOptions = {},
): Result<ImportFcstdSuccess, string> {
  const parsed = parseDocumentXml(documentXml);
  if (!parsed.ok) return parsed;
  const conversion = convertDocument(parsed.value, options);
  return ok(conversion);
}

// --- Re-exports for advanced consumers ---

export { readFcstdArchive } from './parser/fcstdArchive.ts';
export { parseDocumentXml } from './parser/documentParser.ts';
export { parseGeometry, parseGeometryList } from './parser/geometryParser.ts';
export { convertSketch } from './converter/sketchConverter.ts';
export { convertPad, convertPocket } from './converter/extrudeConverter.ts';
export { convertDocument } from './converter/projectConverter.ts';

export type { FcstdImportReport };
export type {
  FcDocument,
  FcObject,
  FcBodyObject,
  FcSketchObject,
  FcPadObject,
  FcPocketObject,
  FcGeometry,
  FcGeomLineSegment,
  FcGeomCircle,
  FcGeomArcOfCircle,
  FcConstraint,
} from './types/fcstdTypes.ts';

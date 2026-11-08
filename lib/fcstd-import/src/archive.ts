/**
 * A `.FCStd` file is a ZIP archive: `Document.xml`, plus one file per stored
 * shape (`Pad.Shape.brp`) and view data the importer does not read.
 */
import { strFromU8, unzipSync } from 'fflate';
import type { Result } from './xml';

export interface FcstdArchive {
  documentXml: string;
  /** Every entry's bytes, by name. */
  files: ReadonlyMap<string, Uint8Array>;
}

/** The largest archive entry read, so a small file cannot expand without bound. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export function readArchive(bytes: Uint8Array): Result<FcstdArchive> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (f) => f.originalSize <= MAX_ENTRY_BYTES });
  } catch (e) {
    return {
      ok: false,
      error: `This is not a FreeCAD file (it is not a ZIP archive: ${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const doc = entries['Document.xml'];
  if (!doc) return { ok: false, error: 'This is not a FreeCAD file: it has no Document.xml' };
  return { ok: true, value: { documentXml: strFromU8(doc), files: new Map(Object.entries(entries)) } };
}

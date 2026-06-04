/**
 * Extract a .fcstd archive into an in-memory file map.
 *
 * .fcstd is a standard ZIP archive — fflate handles decompression. Only
 * Document.xml is required; other entries (BREP shapes, GuiDocument.xml)
 * are exposed for future use but never consulted by the importer.
 */

import { unzipSync, strFromU8 } from 'fflate';
import type { Result } from '@tweakcad/core/src/result.ts';
import { ok, err } from '@tweakcad/core/src/result.ts';

export type FcstdArchive = {
  /** Map of entry name → raw bytes. */
  files: Record<string, Uint8Array>;
  /** Decoded UTF-8 contents of Document.xml. */
  documentXml: string;
};

/**
 * Unzip a .fcstd buffer.
 *
 * @param input - The .fcstd file as a Blob or ArrayBuffer/Uint8Array
 * @returns Archive contents, or an error if the ZIP is malformed or missing
 *   Document.xml
 */
export async function readFcstdArchive(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<Result<FcstdArchive, string>> {
  let bytes: Uint8Array;
  try {
    bytes = await toBytes(input);
  } catch (e) {
    return err(`Failed to read .fcstd input: ${(e as Error).message}`);
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    return err(`Failed to unzip .fcstd archive: ${(e as Error).message}`);
  }

  const doc = files['Document.xml'];
  if (!doc) {
    return err('Archive does not contain Document.xml — not a valid .fcstd file');
  }

  return ok({ files, documentXml: strFromU8(doc) });
}

async function toBytes(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  // Blob (browser path or node 18+).
  const ab = await input.arrayBuffer();
  return new Uint8Array(ab);
}

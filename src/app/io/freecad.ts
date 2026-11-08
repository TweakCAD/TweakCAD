/**
 * A FreeCAD file as a new document: converted on the main thread, then its
 * fillets and chamfers finished against the worker's evaluation, since they
 * name edges of the shapes FreeCAD built. What could not be imported is
 * returned as notes for the console.
 */
import type { Doc, IdGenerator } from '@tweakcad/editor';
import { complete, importFcstd, type FinishProgress, type ImportNote, type LocateClient } from '@tweakcad/fcstd-import';
import { WRITER } from '../document';
import { baseName } from './geometry';
import type { PickedFile } from './files';
import { paint } from './paint';

export type FreeCadOutcome = { ok: true; document: Doc; notes: ImportNote[] } | { ok: false; message: string };

export async function importFreeCad(
  file: PickedFile,
  client: LocateClient,
  ids: IdGenerator,
  progress?: FinishProgress,
): Promise<FreeCadOutcome> {
  progress?.(`Converting ${file.name}`, 0, 0);
  await paint();
  const converted = importFcstd(file.bytes, {
    ids,
    writer: { ...WRITER },
    name: baseName(file.name) || 'FreeCAD model',
  });
  if (!converted.ok) return { ok: false, message: converted.error };
  const { document, steps, notes, checks, styles } = converted.value;
  try {
    notes.push(...(await complete(document, steps, client, checks, styles, progress)));
  } catch (e) {
    return {
      ok: false,
      message: `The FreeCAD model could not be finished: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { ok: true, document, notes };
}

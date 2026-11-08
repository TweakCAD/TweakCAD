/**
 * A `.f3d` or `.f3z` file as a new document: converted on the main thread,
 * then its sketches and fillets finished against the worker's evaluation. What
 * could not be imported is returned as notes for the console.
 */
import type { Doc, IdGenerator } from '@tweakcad/editor';
import { complete, importF3d, type F3dClient, type FinishProgress, type ImportNote } from '@tweakcad/f3d-import';
import { WRITER } from '../document';
import { baseName } from './geometry';
import type { PickedFile } from './files';
import { paint } from './paint';

export type F3dOutcome = { ok: true; document: Doc; notes: ImportNote[] } | { ok: false; message: string };

/** The toast of an import: why the timeline is short or empty, then how much the console lists; null when nothing is missing. */
export function f3dImportMessage(notes: readonly ImportNote[]): string | null {
  const warnings = notes.filter((n) => n.severity === 'warning');
  const why = warnings.find((n) => n.object === 'timeline')?.message;
  const left = warnings.filter((n) => n.object !== 'timeline').length;
  const rest =
    left > 0
      ? `${left} ${left === 1 ? 'other thing was' : 'other things were'} not imported; the console lists them.`
      : '';
  return [why, rest].filter(Boolean).join(' ') || null;
}

export async function importF3dFile(
  file: PickedFile,
  client: F3dClient,
  ids: IdGenerator,
  progress?: FinishProgress,
): Promise<F3dOutcome> {
  progress?.(`Converting ${file.name}`, 0, 0);
  await paint();
  const converted = importF3d(file.bytes, {
    ids,
    writer: { ...WRITER },
    name: baseName(file.name) || 'Imported design',
  });
  if (!converted.ok) return { ok: false, message: converted.error };
  const { document, steps, notes } = converted.value;
  try {
    notes.push(...(await complete(document, steps, client, progress)));
  } catch (e) {
    return {
      ok: false,
      message: `The .f3d model could not be finished: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { ok: true, document, notes };
}

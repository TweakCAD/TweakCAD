/**
 * STEP, STL and BREP files into the part the window works on, as `core.import` (13.3): the
 * worker reads the file once into a stored shape, and the feature keeps the
 * file and that shape as assets by content hash, so the import replays the
 * same on any later kernel. One undo step.
 */
import type { Editor } from '@tweakcad/editor';
import type { ImportFormat, ImportedShape } from '@tweakcad/worker/src/v2/service/client';
import { partOf } from '../features';
import { featureRow, insertionPoint, literal, nextFeatureName } from '../modeling/common';
import type { FileKind, PickedFile } from './files';
import { ImportCancelled } from './importJobs';

export const GEOMETRY_FILES: Record<ImportFormat, FileKind> = {
  step: { description: 'STEP file (.step, .stp)', extensions: ['.step', '.stp'], mediaType: 'model/step' },
  stl: { description: 'STL mesh (.stl)', extensions: ['.stl'], mediaType: 'model/stl' },
  brep: { description: 'BREP file (.brep, .brp)', extensions: ['.brep', '.brp'], mediaType: 'model/x-brep' },
};

/** The worker's side of an import. */
export interface GeometryClient {
  importFile(bytes: Uint8Array, format: ImportFormat, name: string): Promise<ImportedShape>;
}

export type ImportOutcome =
  | { ok: true; feature: string; name: string; bodies: number; skipped: number }
  | { ok: false; message: string }
  /** Cancelled, or its document closed while the file was read: nothing to warn about. */
  | { ok: false; dropped: true; message: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The file's name without its extension. */
export function baseName(file: string): string {
  return file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
}

/**
 * Reads `file` as `format` and adds it to `part` (the part the window works
 * on when the import started) at the rollback marker, named after the file.
 */
export async function importGeometry(
  editor: Editor,
  client: GeometryClient,
  file: PickedFile,
  format: ImportFormat,
  part: string | null,
): Promise<ImportOutcome> {
  if (!part || !partOf(editor.document, part))
    return { ok: false, message: 'Files are imported into a part. Open a part, then import again.' };
  const feature = editor.newId('feat');
  let shape: ImportedShape;
  try {
    shape = await client.importFile(file.bytes, format, file.name);
  } catch (e) {
    if (e instanceof ImportCancelled) return { ok: false, dropped: true, message: e.message };
    return { ok: false, message: messageOf(e) };
  }
  const doc = editor.document;
  // The part went while the file was read: another document opened, or the part was deleted.
  if (!partOf(doc, part)) return { ok: false, dropped: true, message: 'The part the file was imported into is gone' };
  const name = baseName(file.name) || nextFeatureName(doc, part, 'Import');
  const row = featureRow(editor, feature, 'core.import', name, {
    source: { file: { asset: shape.source } },
    stored: shape.stored,
    importer: { format, version: '1' },
    // OCCT reads STEP into millimetres; STL and BREP carry no unit and are taken as millimetres. The file's axes are kept.
    units: literal(editor, '"mm"'),
    upAxis: literal(editor, '"y"'),
  });
  const before = insertionPoint(doc, part);
  const result = editor.dispatch({
    type: 'addFeature',
    container: part,
    feature: row,
    assets: shape.assets,
    ...(before ? { before } : {}),
  });
  if (!result.ok) return { ok: false, message: result.error.message };
  return { ok: true, feature, name, bodies: shape.bodies, skipped: shape.skipped };
}

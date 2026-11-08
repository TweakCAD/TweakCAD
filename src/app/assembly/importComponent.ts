/**
 * Import Component: a version-2 document from disk embedded as a library
 * `document` entry (source local) and inserted with its own values: as an
 * instance in the shown assembly, or derived into the active part. Its parameters are set
 * afterwards with Edit Component.
 */
import { loadDocument, type Doc, type Json } from '@tweakcad/editor';
import type { AppServices } from '../services';
import type { FileKind, PickedFile } from '../io/files';
import { candidateOf, commitSolved } from './commit';
import { activePartOf, shownAssembly } from './focus';
import { embedDocument, insertComponentCommands, type InsertTarget } from './library';

export const COMPONENT_FILE: FileKind = {
  description: 'TweakCAD component (.cadjson)',
  extensions: ['.cadjson', '.cadcomponent'],
  mediaType: 'application/json',
};

export type ImportedComponent = { ok: true; name: string; into: 'assembly' | 'part' } | { ok: false; message: string };

/** Where an imported component goes: the shown assembly, or else the part the window works on. */
export function importTarget(services: AppServices): InsertTarget | null {
  const doc = services.editor.document;
  const focus = services.app.getState().focus;
  const assembly = shownAssembly(doc, focus);
  if (assembly !== null) return { assembly };
  const part = activePartOf(doc, focus);
  return part ? { part } : null;
}

/** The name a component takes: its document's name, or the file's without its extension. */
export function componentName(doc: Doc, file: string): string {
  const named = (doc.metadata as Json | undefined)?.name;
  if (typeof named === 'string' && named.trim() !== '') return named.trim();
  return file.replace(/\.(cadcomponent|cadjson)$/i, '') || 'Component';
}

export async function importComponent(services: AppServices, file: PickedFile): Promise<ImportedComponent> {
  const target = importTarget(services);
  if (!target) return { ok: false, message: 'Open a part or an assembly to insert the component into' };
  const loaded = loadDocument(new TextDecoder().decode(file.bytes));
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const { editor } = services;
  const name = componentName(loaded.document, file.name);
  const embedded = embedDocument(loaded.document, name, editor.newId('lib'), { local: {} });
  const commands = insertComponentCommands(editor, embedded, target, []);
  const checked = candidateOf(editor.document, commands);
  if (!checked.ok) return checked;
  const written = await commitSolved(services, `Insert ${name}`, commands);
  return written.ok ? { ok: true, name, into: 'assembly' in target ? 'assembly' : 'part' } : written;
}

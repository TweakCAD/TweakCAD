/**
 * Freezing a feature (7.2): its whole effect is stored as it last built, so
 * edits upstream no longer change it. The feature keeps its place in the
 * timeline and its inputs; unfreezing makes it build from them again.
 *
 * The stored effect comes from the worker, which builds the document as it
 * stands apart from the shown evaluation; writing it is one undo step.
 */
import { isPlainObject } from '@tweakcad/format';
import type { CommandResult, Editor, Json } from '@tweakcad/editor';
import { findFeature } from '../features';
import type { AppServices } from '../services';
import type { Outcome } from './commands';

/** Feature types that are never frozen (7.2): sketches, measures and assembly features. */
export function freezable(type: string): boolean {
  return type !== 'core.sketch' && type !== 'core.measure' && !type.startsWith('core.asm.');
}

/** Whether a feature row holds a frozen effect. */
export function isFrozen(row: Json | undefined): boolean {
  return isPlainObject(row?.frozen) && 'frozen' in row.frozen;
}

/**
 * Freezes `feature` as the document now builds it. When the document
 * changes while the worker builds, it is built again from the newer one.
 */
export async function freezeFeature(services: AppServices, feature: string): Promise<Outcome> {
  const { editor, client } = services;
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = editor.document;
    const row = findFeature(doc, feature);
    if (!row) return { ok: false, message: 'There is no such feature' };
    if (isFrozen(row)) return { ok: true };
    if (!freezable(String(row.type))) return { ok: false, message: `${String(row.name)} cannot be frozen` };
    if (!client.freeze) return { ok: false, message: 'Freezing needs the worker' };
    const made = await client.freeze(doc, feature);
    if (!made.ok) return { ok: false, message: `${String(row.name)} cannot be frozen: ${made.message}` };
    if (editor.document !== doc) continue;
    const r = editor.dispatch({
      type: 'setFrozen',
      feature,
      frozen: made.frozen as Json,
      assets: made.assets as Json,
      names: made.names as unknown as Json,
    });
    return r.ok ? { ok: true } : { ok: false, message: r.error.message };
  }
  return { ok: false, message: 'The document kept changing; freeze it again' };
}

/** Makes a frozen feature build from its inputs again. */
export function unfreezeFeature(editor: Editor, feature: string): CommandResult {
  return editor.dispatch({ type: 'setFrozen', feature });
}

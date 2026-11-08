/**
 * A new sketch: a `core.sketch` feature on a picked plane (a standard
 * plane, a construction plane or a planar face), attached in the `plane`
 * mode with no offset and no flip (7.3), its tables empty.
 */
import { CommandError, type Editor, type Json } from '@tweakcad/editor';
import type { PickedReference } from '../picking';
import { featureRow, insertionPoint, literal, nextFeatureName } from './common';

/** The placement value of no offset. */
export const ZERO_PLACEMENT = 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))';

export type AddResult = { ok: true; feature: string } | { ok: false; message: string };

/**
 * Adds a sketch to `part` on `support`, named as the part's next sketch,
 * at the rollback marker. The feature and its support reference (with the
 * name-table entries a face record needs) are one undo step.
 */
export function addSketch(editor: Editor, part: string, support: PickedReference): AddResult {
  const doc = editor.document;
  const id = editor.newId('feat');
  const name = nextFeatureName(doc, part, 'Sketch');
  const inputs: Json = {
    frame: {
      attach: {
        support: [],
        mode: literal(editor, '"plane"'),
        offset: literal(editor, ZERO_PLACEMENT),
        flip: literal(editor, 'false'),
      },
    },
    points: [],
    curves: [],
    constraints: [],
    regions: [],
    retired: [],
    text: [],
  };
  const before = insertionPoint(doc, part);
  try {
    editor.transaction(`Add ${name}`, () => {
      const added = editor.dispatch({
        type: 'addFeature',
        container: part,
        feature: featureRow(editor, id, 'core.sketch', name, inputs),
        ...(before ? { before } : {}),
      });
      if (!added.ok) throw new CommandError(added.error.code, added.error.message);
      const written = editor.dispatch({
        type: 'writeReference',
        feature: id,
        pointer: '/frame/attach/support/-',
        reference: support.reference,
        names: support.names,
      });
      if (!written.ok) throw new CommandError(written.error.code, written.error.message);
    });
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, message: e.message };
    throw e;
  }
  return { ok: true, feature: id };
}

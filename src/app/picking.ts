/**
 * Turning a selection item into what a feature input stores, and writing it.
 *
 * An entity picked by key goes through the worker's `pick`, which writes the
 * record against the shown state (or, with `before`, against the part just
 * before a feature being edited). A standard plane, axis or origin and a whole feature are
 * plain references that need no worker. A detected region that no region row
 * holds yet comes back as the region itself: writing it adds the row and
 * then references it, as one undo step.
 */
import { NameTable, idItem, ladderOf } from '@tweakcad/format';
import { CommandError, type CommandResult, type Editor, type Json } from '@tweakcad/editor';
import type { Picked, PickedRegion, PickOptions, PickTarget } from '@tweakcad/worker/src/v2/service/types';
import type { SelectionItem } from './selection';

/** A reference ready to write, with the name-table entries it needs. */
export interface PickedReference {
  reference: Json;
  names: Json;
}

export type PickResult = PickedReference | PickedRegion;

/** The part of the worker service picking uses. */
export interface PickClient {
  pick(target: PickTarget, options?: PickOptions): Promise<Picked | null>;
}

export function isPickedRegion(p: PickResult): p is PickedRegion {
  return 'region' in p;
}

/**
 * What a command needs to reference `item`, or null when the worker no
 * longer knows its key. `before` writes the record against the part just
 * before that feature, for a feature being edited; `frameOf` writes a pick
 * through an instance in the frame of the part at that instance path.
 */
export async function pickReference(
  client: PickClient,
  item: SelectionItem,
  options: PickOptions = {},
): Promise<PickResult | null> {
  if ('standard' in item) return { reference: { standard: { name: item.standard } }, names: {} };
  if ('datum' in item) return { reference: { standard: { name: item.datum } }, names: {} };
  if ('feature' in item) return { reference: { object: { feature: { id: item.feature } } }, names: {} };
  const target: PickTarget = item.instance ? { key: item.key, instance: item.instance } : { key: item.key };
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as PickOptions;
  const picked = await client.pick(target, Object.keys(given).length > 0 ? given : undefined);
  if (!picked) return null;
  if ('region' in picked) return picked;
  return { reference: picked.reference as unknown as Json, names: picked.names as unknown as Json };
}

/** The reference to a sketch's region row, with its names (as the editor writes a pick of it). */
export function regionReference(sketch: string, region: string): PickedReference {
  const names = new NameTable();
  const id = ladderOf({ kind: 'region', chain: [], feature: sketch, role: 'region', src: [idItem(region)] }, names);
  return {
    reference: { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } },
    names: names.toJson() as unknown as Json,
  };
}

/**
 * Writes `picked` into `feature`'s inputs at `pointer` (spec 7.3 pointer).
 * A detected region gets its row first, in the same undo step.
 */
export function writePicked(editor: Editor, feature: string, pointer: string, picked: PickResult): CommandResult {
  if (!isPickedRegion(picked)) {
    return editor.dispatch({
      type: 'writeReference',
      feature,
      pointer,
      reference: picked.reference,
      names: picked.names,
    });
  }
  const { sketch, loop, holes } = picked.region;
  try {
    return editor.transaction('Pick region', () => {
      const region = editor.newId('reg');
      const row = editor.dispatch({
        type: 'pickRegion',
        sketch,
        region: { id: region, loop, holes } as unknown as Json,
      });
      if (!row.ok) throw new CommandError(row.error.code, row.error.message);
      const ref = regionReference(sketch, region);
      const written = editor.dispatch({
        type: 'writeReference',
        feature,
        pointer,
        reference: ref.reference,
        names: ref.names,
      });
      if (!written.ok) throw new CommandError(written.error.code, written.error.message);
      return written;
    });
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, error: e.toFailure() };
    throw e;
  }
}

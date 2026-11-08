import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { FLAG, LENGTH, TEXT, choice, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** A thread's hand: right, as a thread with no `hand` is, or left. */
export const HAND = choice('right', 'left');

/**
 * `core.thread` (appendix A), typeVersion 1. `length` is `{"full": {}}` (the
 * whole face) or `{"distance": {"d", "from"}}`: `d` along the faces' axis from
 * `from`, a circular edge of a threaded face where the thread starts.
 * `hand`, optional, is `right` or `left`; a thread without it is right-handed.
 */
export function readThreadInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['faces', 'standard', 'designation', 'class', 'modelled', 'length'],
    optional: ['hand'],
  });
  if (!o) return;
  const facesPath = child(path, 'faces');
  const faces = r.set(o.faces, facesPath);
  if (faces?.length === 0) r.diagnostics.refuse('bad-value', facesPath, 'a thread has at least one face');
  faces?.forEach((m, i) => readReference(r, m, child(child(facesPath, 'set'), i)));
  value(c, o.standard, child(path, 'standard'), TEXT);
  value(c, o.designation, child(path, 'designation'), TEXT);
  value(c, o.class, child(path, 'class'), TEXT);
  value(c, o.modelled, child(path, 'modelled'), FLAG);
  if (o.hand !== undefined) value(c, o.hand, child(path, 'hand'), HAND);
  const length = r.union(o.length, child(path, 'length'), ['full', 'distance']);
  if (length?.tag === 'full') r.object(length.payload, length.path, { required: [] });
  else if (length?.tag === 'distance') {
    const d = r.object(length.payload, length.path, { required: ['d', 'from'] });
    if (d) {
      value(c, d.d, child(length.path, 'd'), LENGTH);
      readReference(r, d.from, child(length.path, 'from'));
    }
  }
}

registerFeatureType('core.thread', { versions: [1], readInputs: readThreadInputs });

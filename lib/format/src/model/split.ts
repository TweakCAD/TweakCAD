import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { choice, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** `core.split` (appendix A), typeVersion 1. */
export function readSplitInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['targets', 'tool', 'keep'] });
  if (!o) return;
  const targets = child(path, 'targets');
  const members = r.set(o.targets, targets);
  if (members?.length === 0) r.diagnostics.refuse('bad-value', targets, 'a split has at least one target');
  members?.forEach((m, i) => readReference(r, m, child(child(targets, 'set'), i)));
  readReference(r, o.tool, child(path, 'tool'));
  const keep = r.union(o.keep, child(path, 'keep'), ['both', 'side']);
  if (!keep) return;
  if (keep.tag === 'side') {
    const side = r.object(keep.payload, keep.path, { required: ['sign'] });
    if (side) value(c, side.sign, child(keep.path, 'sign'), choice('positive', 'negative'));
  } else r.object(keep.payload, keep.path, { required: [] });
}

registerFeatureType('core.split', { versions: [1], readInputs: readSplitInputs });

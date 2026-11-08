import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { FLAG, choice, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** Body set (7.3), here never empty. */
function readBodies(r: Reader, v: unknown, path: string): void {
  const members = r.set(v, path);
  if (members?.length === 0) r.diagnostics.refuse('bad-value', path, 'a body set is not empty here');
  members?.forEach((m, i) => readReference(r, m, child(child(path, 'set'), i)));
}

/** `core.boolean` (appendix A), typeVersion 1. */
function readBooleanInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['target', 'tools', 'op', 'keepTools'] });
  if (!o) return;
  readReference(r, o.target, child(path, 'target'));
  readBodies(r, o.tools, child(path, 'tools'));
  value(c, o.op, child(path, 'op'), choice('join', 'cut', 'intersect'));
  value(c, o.keepTools, child(path, 'keepTools'), FLAG);
}

/** `core.removeBody` (appendix A), typeVersion 1. */
function readRemoveBodyInputs(r: Reader, _values: ValueIndex, inputs: Json, path: string): void {
  const o = r.object(inputs, path, { required: ['bodies'] });
  if (o) readBodies(r, o.bodies, child(path, 'bodies'));
}

registerFeatureType('core.boolean', { versions: [1], readInputs: readBooleanInputs });
registerFeatureType('core.removeBody', { versions: [1], readInputs: readRemoveBodyInputs });

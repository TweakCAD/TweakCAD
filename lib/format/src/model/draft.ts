import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { ANGLE, readDirection, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** `core.draft` (appendix A), typeVersion 1. */
export function readDraftInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['faces', 'neutral', 'pull', 'angle'] });
  if (!o) return;
  const faces = child(path, 'faces');
  const members = r.set(o.faces, faces);
  if (members?.length === 0) r.diagnostics.refuse('bad-value', faces, 'a draft has at least one face');
  members?.forEach((m, i) => readReference(r, m, child(child(faces, 'set'), i)));
  readReference(r, o.neutral, child(path, 'neutral'));
  readDirection(c, o.pull, child(path, 'pull'));
  value(c, o.angle, child(path, 'angle'), ANGLE);
}

registerFeatureType('core.draft', { versions: [1], readInputs: readDraftInputs });

import { child } from './diagnostics';
import { readOperation } from './extrude';
import { registerFeatureType } from './features';
import { readCopied } from './pattern';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import type { InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** `core.mirror` (appendix A), typeVersion 1. */
export function readMirrorInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['of', 'plane', 'operation'] });
  if (!o) return;
  readCopied(c, o.of, child(path, 'of'), ['bodies', 'features', 'faces']);
  readReference(r, o.plane, child(path, 'plane'));
  readOperation(c, o.operation, child(path, 'operation'));
}

registerFeatureType('core.mirror', { versions: [1], readInputs: readMirrorInputs });

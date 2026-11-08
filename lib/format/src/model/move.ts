import { isPlainObject } from '../collections';
import { child } from './diagnostics';
import { registerFeatureType } from './features';
import { readCopied } from './pattern';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { FLAG, PLACEMENT, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** `core.move` (appendix A), typeVersion 1. */
export function readMoveInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['of', 'transform', 'copy'] });
  if (!o) return;
  readCopied(c, o.of, child(path, 'of'), ['bodies', 'faces']);
  const transform = child(path, 'transform');
  if (isPlainObject(o.transform) && 'align' in o.transform) {
    const alignPath = child(transform, 'align');
    const align = r.object(o.transform.align, alignPath, { required: ['from', 'to'] });
    if (align) {
      readReference(r, align.from, child(alignPath, 'from'));
      readReference(r, align.to, child(alignPath, 'to'));
    }
  } else value(c, o.transform, transform, PLACEMENT);
  value(c, o.copy, child(path, 'copy'), FLAG);
}

registerFeatureType('core.move', { versions: [1], readInputs: readMoveInputs });

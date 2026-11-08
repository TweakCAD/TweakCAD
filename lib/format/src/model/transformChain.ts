import { child } from './diagnostics';
import { registerFeatureType } from './features';
import { readCopied, readLayout } from './pattern';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import type { InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** One step of a chain: a pattern layout, a mirror or a scale. */
function readStep(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  if (v !== null && typeof v === 'object' && 'mirror' in v) {
    const at = child(path, 'mirror');
    const o = r.object((v as Json).mirror, at, { required: ['plane'] });
    if (o) readReference(r, o.plane, child(at, 'plane'));
    return;
  }
  if (v !== null && typeof v === 'object' && 'scale' in v) {
    r.diagnostics.pause('unknown-variant', child(path, 'scale'), 'a scale in a transform chain is not specified yet');
    return;
  }
  readLayout(c, v, path);
}

/** `core.transformChain` (appendix A), typeVersion 1. */
export function readTransformChainInputs(
  r: Reader,
  values: ValueIndex,
  inputs: Json,
  path: string,
  scope: Scope,
): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['of', 'steps'] });
  if (!o) return;
  readCopied(c, o.of, child(path, 'of'), ['bodies', 'features', 'faces']);
  const steps = child(path, 'steps');
  if (!r.list(o.steps, steps)) return;
  if (o.steps.length === 0) r.diagnostics.refuse('bad-value', steps, 'a transform chain has at least one step');
  o.steps.forEach((row, i) => {
    const at = child(steps, i);
    const s = r.object(row, at, { required: ['id', 'step'] });
    if (!s) return;
    r.define(s.id, child(at, 'id'), 'stp');
    readStep(c, s.step, child(at, 'step'));
  });
}

registerFeatureType('core.transformChain', { versions: [1], readInputs: readTransformChainInputs });

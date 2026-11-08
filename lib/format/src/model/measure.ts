import type { ValueTarget } from '../expr';
import { isPlainObject } from '../collections';
import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { ANGLE, LENGTH } from './shapes';
import { readValue, type Scope, type ValueIndex } from './values';

/** What each measure kind (6.3) yields. */
export const MEASURE_TARGETS: Record<string, ValueTarget> = {
  distance: LENGTH,
  length: LENGTH,
  area: { type: 'number', quantity: 'area' },
  volume: { type: 'number', quantity: 'volume' },
  angle: ANGLE,
  radius: LENGTH,
};

/** `core.measure` (appendix A), typeVersion 1: a table of named measured values. */
function readMeasureInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const o = r.object(inputs, path, { required: ['values'] });
  const vp = child(path, 'values');
  if (!o || !r.list(o.values, vp)) return;
  o.values.forEach((row, i) => {
    const at = child(vp, i);
    const def = isPlainObject(row) && isPlainObject(row.def) ? row.def : undefined;
    const measure = def && isPlainObject(def.measure) ? def.measure : undefined;
    if (isPlainObject(row) && row.name === undefined)
      r.diagnostics.refuse('missing-field', child(at, 'name'), 'a measured value has a name');
    if (def && !measure) r.diagnostics.refuse('bad-value', child(at, 'def'), 'a core.measure value is measured');
    const target = typeof measure?.kind === 'string' ? MEASURE_TARGETS[measure.kind] : undefined;
    readValue(r, values, row, at, scope, target);
  });
}

registerFeatureType('core.measure', { versions: [1], readInputs: readMeasureInputs });

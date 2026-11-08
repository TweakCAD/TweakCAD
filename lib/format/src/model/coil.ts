import { child } from './diagnostics';
import { readOperation, readProfiles } from './extrude';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { LENGTH, choice, readAxis, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** `core.coil` (appendix A), typeVersion 1. */
export function readCoilInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['axis', 'advance', 'height', 'section', 'operation'],
    optional: ['diameter', 'handedness'],
  });
  if (!o) return;
  readAxis(c, o.axis, child(path, 'axis'));
  if (o.diameter !== undefined) value(c, o.diameter, child(path, 'diameter'), LENGTH);
  const advance = r.union(o.advance, child(path, 'advance'), ['pitch', 'turns']);
  if (advance?.tag === 'pitch') {
    const p = r.object(advance.payload, advance.path, { required: ['p'] });
    if (p) value(c, p.p, child(advance.path, 'p'), LENGTH);
  } else if (advance) r.diagnostics.pause('unknown-variant', advance.path, 'a coil by turns is not built yet');
  value(c, o.height, child(path, 'height'), LENGTH);
  if (o.handedness !== undefined) value(c, o.handedness, child(path, 'handedness'), choice('right', 'left'));
  const section = r.union(o.section, child(path, 'section'), ['profiles', 'shape']);
  if (section?.tag === 'profiles') readProfiles(c, section.payload, section.path);
  else if (section) r.diagnostics.pause('unknown-variant', section.path, 'a coil of a section shape is not built yet');
  readOperation(c, o.operation, child(path, 'operation'));
}

registerFeatureType('core.coil', { versions: [1], readInputs: readCoilInputs });

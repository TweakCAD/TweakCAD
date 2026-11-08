import { child } from './diagnostics';
import { readOperation, readProfiles, readThin } from './extrude';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { ANGLE, choice, readAxis, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** Angle extent: one side of a revolve. */
function readAngleExtent(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['angle', 'symmetric', 'full']);
  if (!u) return;
  switch (u.tag) {
    case 'angle': {
      const o = c.r.object(u.payload, u.path, { required: ['a'] });
      if (o) value(c, o.a, child(u.path, 'a'), ANGLE);
      return;
    }
    case 'symmetric': {
      const o = c.r.object(u.payload, u.path, { required: ['a', 'measure'] });
      if (!o) return;
      value(c, o.a, child(u.path, 'a'), ANGLE);
      value(c, o.measure, child(u.path, 'measure'), choice('total', 'half'));
      return;
    }
    default:
      c.r.object(u.payload, u.path, { required: [] });
  }
}

/** `core.revolve` (appendix A), typeVersion 1. */
export function readRevolveInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['profiles', 'axis', 'sides', 'thin', 'operation'] });
  if (!o) return;
  readProfiles(c, o.profiles, child(path, 'profiles'));
  readAxis(c, o.axis, child(path, 'axis'));
  if (r.list(o.sides, child(path, 'sides'))) {
    if (o.sides.length < 1 || o.sides.length > 2) {
      r.diagnostics.refuse('bad-value', child(path, 'sides'), 'a revolve has one or two sides');
    }
    o.sides.forEach((s, i) => readAngleExtent(c, s, child(child(path, 'sides'), i)));
  }
  readThin(c, o.thin, child(path, 'thin'));
  readOperation(c, o.operation, child(path, 'operation'));
}

registerFeatureType('core.revolve', { versions: [1], readInputs: readRevolveInputs, positional: ['/sides'] });

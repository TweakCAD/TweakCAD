import { child } from './diagnostics';
import { registerFeatureType } from './features';
import { readTargets } from './fillet';
import type { Json, Reader } from './reader';
import { ANGLE, FLAG, LENGTH, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

function readSize(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  const u = r.union(v, path, ['distance', 'twoDistances', 'distanceAngle']);
  if (!u) return;
  switch (u.tag) {
    case 'distance': {
      const o = r.object(u.payload, u.path, { required: ['d'] });
      if (o) value(c, o.d, child(u.path, 'd'), LENGTH);
      return;
    }
    case 'twoDistances': {
      const o = r.object(u.payload, u.path, { required: ['d1', 'd2'] });
      if (!o) return;
      value(c, o.d1, child(u.path, 'd1'), LENGTH);
      value(c, o.d2, child(u.path, 'd2'), LENGTH);
      return;
    }
    default: {
      // `flipped` is optional: absent, `d` lies on the reference face.
      const o = r.object(u.payload, u.path, { required: ['d', 'angle'], optional: ['flipped'] });
      if (!o) return;
      value(c, o.d, child(u.path, 'd'), LENGTH);
      value(c, o.angle, child(u.path, 'angle'), ANGLE);
      if (o.flipped !== undefined) value(c, o.flipped, child(u.path, 'flipped'), FLAG);
    }
  }
}

/** `core.chamfer` (appendix A), typeVersion 1. */
export function readChamferInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['sets'] });
  const sets = child(path, 'sets');
  if (!o || !r.list(o.sets, sets)) return;
  if (o.sets.length === 0) r.diagnostics.refuse('bad-value', sets, 'a chamfer has at least one set');
  o.sets.forEach((set, i) => {
    const at = child(sets, i);
    const s = r.object(set, at, { required: ['targets', 'size'] });
    if (!s) return;
    readTargets(c, s.targets, child(at, 'targets'));
    readSize(c, s.size, child(at, 'size'));
  });
}

registerFeatureType('core.chamfer', { versions: [1], readInputs: readChamferInputs });

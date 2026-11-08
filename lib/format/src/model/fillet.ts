import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { LENGTH, RATIO, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** Target set (7.3): a set of edge and face references. */
export function readTargets(c: InputContext, v: unknown, path: string): void {
  const members = c.r.set(v, path);
  if (members?.length === 0) c.r.diagnostics.refuse('bad-value', path, 'a target set is not empty');
  members?.forEach((m, i) => readReference(c.r, m, child(child(path, 'set'), i)));
}

function readRadius(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  const u = r.union(v, path, ['constant', 'variable', 'chord']);
  if (!u) return;
  if (u.tag === 'variable') {
    const o = r.object(u.payload, u.path, { required: ['points'] });
    const points = o && child(u.path, 'points');
    if (!o || !points || !r.list(o.points, points)) return;
    o.points.forEach((point, i) => {
      const at = child(points, i);
      const p = r.object(point, at, { required: ['at', 'radius'] });
      if (!p) return;
      value(c, p.at, child(at, 'at'), RATIO);
      value(c, p.radius, child(at, 'radius'), LENGTH);
    });
    return;
  }
  const o = r.object(u.payload, u.path, { required: ['s'] });
  if (o) value(c, o.s, child(u.path, 's'), LENGTH);
}

/** `core.fillet` (appendix A), typeVersion 1. */
export function readFilletInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['sets'] });
  const sets = child(path, 'sets');
  if (!o || !r.list(o.sets, sets)) return;
  if (o.sets.length === 0) r.diagnostics.refuse('bad-value', sets, 'a fillet has at least one set');
  o.sets.forEach((set, i) => {
    const at = child(sets, i);
    const s = r.object(set, at, { required: ['targets', 'radius', 'setback'] });
    if (!s) return;
    readTargets(c, s.targets, child(at, 'targets'));
    readRadius(c, s.radius, child(at, 'radius'));
    value(c, s.setback, child(at, 'setback'), LENGTH);
  });
}

registerFeatureType('core.fillet', { versions: [1], readInputs: readFilletInputs });

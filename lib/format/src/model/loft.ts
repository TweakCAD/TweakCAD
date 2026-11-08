import { child } from './diagnostics';
import { readOperation, readProfiles } from './extrude';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { FLAG, choice, readPoint, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** A curve chain (7.3): an ordered list of curve references. */
export function readChain(c: InputContext, v: unknown, path: string): void {
  if (c.r.list(v, path)) v.forEach((ref, i) => readReference(c.r, ref, child(path, i)));
}

/** One section of a loft. */
function readSection(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['profiles', 'face', 'point']);
  if (u?.tag === 'profiles') readProfiles(c, u.payload, u.path);
  else if (u?.tag === 'face') readReference(c.r, u.payload, u.path);
  else if (u?.tag === 'point') readPoint(c, u.payload, u.path);
}

/** `core.loft` (appendix A), typeVersion 1. */
export function readLoftInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['sections', 'rails', 'ruled', 'closed', 'operation'],
    optional: ['centerline', 'endTangency'],
  });
  if (!o) return;
  const sections = child(path, 'sections');
  if (r.list(o.sections, sections)) {
    if (o.sections.length < 2) r.diagnostics.refuse('bad-value', sections, 'a loft has at least two sections');
    o.sections.forEach((row, i) => {
      const at = child(sections, i);
      const s = r.object(row, at, { required: ['id', 'section'] });
      if (!s) return;
      r.define(s.id, child(at, 'id'), 'sec');
      readSection(c, s.section, child(at, 'section'));
    });
  }
  const rails = child(path, 'rails');
  if (r.list(o.rails, rails)) o.rails.forEach((rail, i) => readChain(c, rail, child(rails, i)));
  if (o.centerline !== undefined) readChain(c, o.centerline, child(path, 'centerline'));
  if (o.endTangency !== undefined) {
    const at = child(path, 'endTangency');
    const t = r.object(o.endTangency, at, { required: ['start', 'end'] });
    if (t) {
      value(c, t.start, child(at, 'start'), choice('free', 'normal'));
      value(c, t.end, child(at, 'end'), choice('free', 'normal'));
    }
  }
  value(c, o.ruled, child(path, 'ruled'), FLAG);
  value(c, o.closed, child(path, 'closed'), FLAG);
  readOperation(c, o.operation, child(path, 'operation'));
}

registerFeatureType('core.loft', { versions: [1], readInputs: readLoftInputs });

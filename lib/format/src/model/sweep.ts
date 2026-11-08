import { child } from './diagnostics';
import { readOperation, readProfiles } from './extrude';
import { registerFeatureType } from './features';
import { readChain } from './loft';
import type { Json, Reader } from './reader';
import { ANGLE, LENGTH, RATIO, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** One section of a sweep. */
function readSection(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['profiles', 'circle']);
  if (u?.tag === 'profiles') readProfiles(c, u.payload, u.path);
  else if (u?.tag === 'circle') {
    const o = c.r.object(u.payload, u.path, { required: ['diameter', 'hollow'] });
    if (!o) return;
    value(c, o.diameter, child(u.path, 'diameter'), LENGTH);
    value(c, o.hollow, child(u.path, 'hollow'), LENGTH);
  }
}

function readOrientation(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['fixed', 'followPath', 'guide']);
  if (u?.tag === 'guide') {
    const o = c.r.object(u.payload, u.path, { required: ['chain'] });
    if (o) readChain(c, o.chain, child(u.path, 'chain'));
  } else if (u) c.r.object(u.payload, u.path, { required: [] });
}

/** `core.sweep` (appendix A), typeVersion 1. */
export function readSweepInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['sections', 'path', 'orientation', 'operation'],
    optional: ['twist', 'scale'],
  });
  if (!o) return;
  const sections = child(path, 'sections');
  if (r.list(o.sections, sections)) {
    if (o.sections.length === 0) r.diagnostics.refuse('bad-value', sections, 'a sweep has at least one section');
    o.sections.forEach((row, i) => {
      const at = child(sections, i);
      const s = r.object(row, at, { required: ['id', 'section'] });
      if (!s) return;
      r.define(s.id, child(at, 'id'), 'sec');
      readSection(c, s.section, child(at, 'section'));
    });
  }
  const chain = child(path, 'path');
  readChain(c, o.path, chain);
  if (Array.isArray(o.path) && o.path.length === 0) r.diagnostics.refuse('bad-value', chain, 'a sweep has a path');
  readOrientation(c, o.orientation, child(path, 'orientation'));
  if (o.twist !== undefined) value(c, o.twist, child(path, 'twist'), ANGLE);
  if (o.scale !== undefined) value(c, o.scale, child(path, 'scale'), RATIO);
  readOperation(c, o.operation, child(path, 'operation'));
}

registerFeatureType('core.sweep', { versions: [1], readInputs: readSweepInputs });

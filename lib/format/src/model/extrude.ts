import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { ANGLE, FLAG, LENGTH, choice, readDirection, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** Shared feature input shapes of 7.3 that several feature types use. */

/** Extent (7.3). */
export function readExtent(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  const u = r.union(v, path, ['distance', 'symmetric', 'toFace', 'toBody', 'upToNext', 'upToLast', 'throughAll']);
  if (!u) return;
  switch (u.tag) {
    case 'distance': {
      const o = r.object(u.payload, u.path, { required: ['d'] });
      if (o) value(c, o.d, child(u.path, 'd'), LENGTH);
      return;
    }
    case 'symmetric': {
      const o = r.object(u.payload, u.path, { required: ['d', 'measure'] });
      if (!o) return;
      value(c, o.d, child(u.path, 'd'), LENGTH);
      value(c, o.measure, child(u.path, 'measure'), choice('total', 'half'));
      return;
    }
    case 'toFace': {
      const o = r.object(u.payload, u.path, { required: ['face', 'offset'] });
      if (!o) return;
      readReference(r, o.face, child(u.path, 'face'));
      value(c, o.offset, child(u.path, 'offset'), LENGTH);
      return;
    }
    case 'toBody': {
      const o = r.object(u.payload, u.path, { required: ['body'] });
      if (o) readReference(r, o.body, child(u.path, 'body'));
      return;
    }
    default:
      r.object(u.payload, u.path, { required: [] });
  }
}

/** Side (7.3): an extent and a taper. */
export function readSide(c: InputContext, v: unknown, path: string): void {
  const o = c.r.object(v, path, { required: ['extent', 'taper'] });
  if (!o) return;
  readExtent(c, o.extent, child(path, 'extent'));
  value(c, o.taper, child(path, 'taper'), ANGLE);
}

/** Operation (7.3). */
export function readOperation(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  const o = r.object(v, path, { required: ['op', 'targets', 'keepTools'] });
  if (!o) return;
  value(c, o.op, child(path, 'op'), choice('new', 'join', 'cut', 'intersect'));
  const t = r.union(o.targets, child(path, 'targets'), ['all', 'bodies']);
  if (t?.tag === 'all') r.object(t.payload, t.path, { required: [] });
  else if (t?.tag === 'bodies') {
    const members = r.set(t.payload, t.path);
    members?.forEach((m, i) => readReference(r, m, child(child(t.path, 'set'), i)));
  }
  value(c, o.keepTools, child(path, 'keepTools'), FLAG);
}

/** Profile set (7.3): a set of region and face references. */
export function readProfiles(c: InputContext, v: unknown, path: string): void {
  const members = c.r.set(v, path);
  if (members?.length === 0) c.r.diagnostics.refuse('bad-value', path, 'a profile set is not empty');
  members?.forEach((m, i) => readReference(c.r, m, child(child(path, 'set'), i)));
}

/** `thin` of a swept feature (appendix A): solid, or a wall of a thickness. */
export function readThin(c: InputContext, v: unknown, path: string): void {
  const thin = c.r.union(v, path, ['solid', 'thin']);
  if (thin?.tag === 'solid') c.r.object(thin.payload, thin.path, { required: [] });
  else if (thin?.tag === 'thin') {
    const t = c.r.object(thin.payload, thin.path, { required: ['thickness', 'placement'] });
    if (t) {
      value(c, t.thickness, child(thin.path, 'thickness'), LENGTH);
      value(c, t.placement, child(thin.path, 'placement'), choice('inside', 'outside', 'center'));
    }
  }
}

/** `start` of `core.extrude` (appendix A): the profile plane, an offset from it, or a face or plane the profile is projected onto. */
export function readExtrudeStart(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  const u = r.union(v, path, ['profilePlane', 'offset', 'object']);
  if (!u) return;
  switch (u.tag) {
    case 'offset': {
      const o = r.object(u.payload, u.path, { required: ['d'] });
      if (o) value(c, o.d, child(u.path, 'd'), LENGTH);
      return;
    }
    case 'object': {
      const o = r.object(u.payload, u.path, { required: ['face', 'offset'] });
      if (!o) return;
      readReference(r, o.face, child(u.path, 'face'));
      value(c, o.offset, child(u.path, 'offset'), LENGTH);
      return;
    }
    default:
      r.object(u.payload, u.path, { required: [] });
  }
}

/** `core.extrude` (appendix A), typeVersion 1. `start` is optional: absent, the extrude starts on the sketch plane. */
export function readExtrudeInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['profiles', 'sides', 'direction', 'thin', 'operation'],
    optional: ['start'],
  });
  if (!o) return;
  readProfiles(c, o.profiles, child(path, 'profiles'));
  if (r.list(o.sides, child(path, 'sides'))) {
    if (o.sides.length < 1 || o.sides.length > 2) {
      r.diagnostics.refuse('bad-value', child(path, 'sides'), 'an extrude has one or two sides');
    }
    o.sides.forEach((s, i) => readSide(c, s, child(child(path, 'sides'), i)));
  }
  readDirection(c, o.direction, child(path, 'direction'));
  readThin(c, o.thin, child(path, 'thin'));
  readOperation(c, o.operation, child(path, 'operation'));
  if (o.start !== undefined) readExtrudeStart(c, o.start, child(path, 'start'));
}

registerFeatureType('core.extrude', { versions: [1], readInputs: readExtrudeInputs, positional: ['/sides'] });

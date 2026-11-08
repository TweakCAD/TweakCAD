import type { ValueTarget } from '../expr';
import { child } from './diagnostics';
import type { Reader } from './reader';
import { readReference } from './references';
import { readValue, type Scope, type ValueIndex } from './values';

/** The shared input shapes of 7.3, and typed value objects, for feature-type readers. */
export interface InputContext {
  r: Reader;
  values: ValueIndex;
  scope: Scope;
}

export const LENGTH: ValueTarget = { type: 'number', quantity: 'length' };
export const ANGLE: ValueTarget = { type: 'number', quantity: 'angle' };
export const RATIO: ValueTarget = { type: 'number', quantity: 'ratio' };
export const LEAD: ValueTarget = { type: 'number', quantity: 'lead' };
export const FLAG: ValueTarget = { type: 'boolean' };
export const TEXT: ValueTarget = { type: 'text' };
export const INTEGER: ValueTarget = { type: 'integer' };
export const PLACEMENT: ValueTarget = { type: 'placement' };
export const LIBRARY: ValueTarget = { type: 'library' };
export const LENGTH_VECTOR: ValueTarget = { type: 'vector', quantity: 'length' };
export const choice = (...options: string[]): ValueTarget => ({ type: 'choice', options });

/** A value object that must evaluate to `target`. */
export function value(c: InputContext, v: unknown, path: string, target: ValueTarget): void {
  readValue(c.r, c.values, v, path, c.scope, target);
}

/** An ordered list of value objects of one target type. */
export function valueList(c: InputContext, v: unknown, path: string, target: ValueTarget): void {
  if (!c.r.list(v, path)) return;
  v.forEach((item, i) => value(c, item, child(path, i), target));
}

/** Direction (7.3). */
export function readDirection(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['axis', 'vector', 'along', 'normal']);
  if (!u) return;
  switch (u.tag) {
    case 'axis': {
      const o = c.r.object(u.payload, u.path, { required: ['axis', 'reversed'] });
      if (!o) return;
      value(c, o.axis, child(u.path, 'axis'), choice('x', 'y', 'z'));
      value(c, o.reversed, child(u.path, 'reversed'), FLAG);
      return;
    }
    case 'vector': {
      const o = c.r.object(u.payload, u.path, { required: ['v', 'reversed'] });
      if (!o) return;
      value(c, o.v, child(u.path, 'v'), LENGTH_VECTOR);
      value(c, o.reversed, child(u.path, 'reversed'), FLAG);
      return;
    }
    default: {
      const o = c.r.object(u.payload, u.path, { required: ['ref', 'reversed'] });
      if (!o) return;
      readReference(c.r, o.ref, child(u.path, 'ref'));
      value(c, o.reversed, child(u.path, 'reversed'), FLAG);
    }
  }
}

/** Point (7.3). */
export function readPoint(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['at', 'of']);
  if (!u) return;
  if (u.tag === 'at') {
    const o = c.r.object(u.payload, u.path, { required: ['v'] });
    if (o) value(c, o.v, child(u.path, 'v'), LENGTH_VECTOR);
    return;
  }
  const o = c.r.object(u.payload, u.path, { required: ['ref'] });
  if (o) readReference(c.r, o.ref, child(u.path, 'ref'));
}

/** Axis (7.3): along a straight reference, or through a point in a direction. */
export function readAxis(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['along', 'through']);
  if (!u) return;
  if (u.tag === 'along') {
    const o = c.r.object(u.payload, u.path, { required: ['ref', 'reversed'] });
    if (!o) return;
    readReference(c.r, o.ref, child(u.path, 'ref'));
    value(c, o.reversed, child(u.path, 'reversed'), FLAG);
    return;
  }
  const o = c.r.object(u.payload, u.path, { required: ['point', 'direction'] });
  if (!o) return;
  readPoint(c, o.point, child(u.path, 'point'));
  readDirection(c, o.direction, child(u.path, 'direction'));
}

/** The attachment-mode registry (7.3). */
export const ATTACHMENT_MODES = [
  'plane',
  'planeAtPoint',
  'threePoints',
  'twoPoints',
  'point',
  'alongLine',
  'midplane',
  'faceAxis',
  'center',
];

/** Attached frame (7.3). */
export function readAttachedFrame(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['fixed', 'attach']);
  if (!u) return;
  if (u.tag === 'fixed') {
    const o = c.r.object(u.payload, u.path, { required: ['placement'] });
    if (o) value(c, o.placement, child(u.path, 'placement'), PLACEMENT);
    return;
  }
  const o = c.r.object(u.payload, u.path, {
    required: ['support', 'mode', 'offset', 'flip'],
    optional: ['xAxis'],
  });
  if (!o) return;
  if (c.r.list(o.support, child(u.path, 'support'))) {
    o.support.forEach((ref, i) => readReference(c.r, ref, child(child(u.path, 'support'), i)));
  }
  value(c, o.mode, child(u.path, 'mode'), choice(...ATTACHMENT_MODES));
  value(c, o.offset, child(u.path, 'offset'), PLACEMENT);
  value(c, o.flip, child(u.path, 'flip'), FLAG);
  if (o.xAxis !== undefined) readDirection(c, o.xAxis, child(u.path, 'xAxis'));
}

/** `[x, y]` in the sketch frame. */
export function readPoint2(r: Reader, v: unknown, path: string): void {
  if (!r.list(v, path)) return;
  if (v.length !== 2) r.diagnostics.refuse('wrong-type', path, 'expected [x, y]');
  v.forEach((n, i) => r.number(n, child(path, i)));
}

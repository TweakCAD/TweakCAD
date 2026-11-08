import { child } from './diagnostics';
import { readExtent } from './extrude';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { HAND } from './thread';
import { ANGLE, FLAG, LENGTH, TEXT, choice, readAttachedFrame, readPoint, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/**
 * `core.hole` (appendix A), typeVersion 1. A position's optional `from`
 * lists one or two straight edges of the hole's face, each `{edge, d}`:
 * the position lies `d` from the edge's line, on the face's side of it.
 */
export function readHoleInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['placement', 'positions', 'kind', 'diameter', 'depth', 'tip', 'thread'],
    optional: ['counterbore', 'countersink'],
  });
  if (!o) return;

  const placement = r.union(o.placement, child(path, 'placement'), ['frame', 'face']);
  if (placement?.tag === 'frame') readAttachedFrame(c, placement.payload, placement.path);
  else if (placement?.tag === 'face') readReference(r, placement.payload, placement.path);

  const positions = child(path, 'positions');
  if (r.list(o.positions, positions)) {
    if (o.positions.length === 0) r.diagnostics.refuse('bad-value', positions, 'a hole has at least one position');
    o.positions.forEach((row, i) => {
      const at = child(positions, i);
      const p = r.object(row, at, { required: ['id', 'at'], optional: ['from'] });
      if (!p) return;
      r.define(p.id, child(at, 'id'), 'hp');
      readPoint(c, p.at, child(at, 'at'));
      // `from`: one or two edges of the hole's face, each with the position's distance from it.
      const fromPath = child(at, 'from');
      if (p.from !== undefined && r.list(p.from, fromPath)) {
        if (p.from.length === 0 || p.from.length > 2)
          r.diagnostics.refuse('bad-value', fromPath, 'a position is measured from one or two edges');
        p.from.forEach((item, j) => {
          const e = r.object(item, child(fromPath, j), { required: ['edge', 'd'] });
          if (!e) return;
          readReference(r, e.edge, child(child(fromPath, j), 'edge'));
          value(c, e.d, child(child(fromPath, j), 'd'), LENGTH);
        });
      }
    });
  }

  value(c, o.kind, child(path, 'kind'), choice('simple', 'counterbore', 'countersink'));
  value(c, o.diameter, child(path, 'diameter'), LENGTH);
  readExtent(c, o.depth, child(path, 'depth'));

  const tip = r.union(o.tip, child(path, 'tip'), ['angle', 'flat']);
  if (tip?.tag === 'angle') {
    const t = r.object(tip.payload, tip.path, { required: ['a'] });
    if (t) value(c, t.a, child(tip.path, 'a'), ANGLE);
  } else if (tip?.tag === 'flat') r.object(tip.payload, tip.path, { required: [] });

  if (o.counterbore !== undefined) {
    const at = child(path, 'counterbore');
    const b = r.object(o.counterbore, at, { required: ['diameter', 'depth'] });
    if (b) {
      value(c, b.diameter, child(at, 'diameter'), LENGTH);
      value(c, b.depth, child(at, 'depth'), LENGTH);
    }
  }
  if (o.countersink !== undefined) {
    const at = child(path, 'countersink');
    const s = r.object(o.countersink, at, { required: ['diameter', 'angle'] });
    if (s) {
      value(c, s.diameter, child(at, 'diameter'), LENGTH);
      value(c, s.angle, child(at, 'angle'), ANGLE);
    }
  }

  const thread = r.union(o.thread, child(path, 'thread'), ['none', 'thread']);
  if (thread?.tag === 'none') r.object(thread.payload, thread.path, { required: [] });
  else if (thread?.tag === 'thread') {
    const t = r.object(thread.payload, thread.path, {
      required: ['standard', 'designation', 'class', 'modelled'],
      optional: ['hand'],
    });
    if (t) {
      value(c, t.standard, child(thread.path, 'standard'), TEXT);
      value(c, t.designation, child(thread.path, 'designation'), TEXT);
      value(c, t.class, child(thread.path, 'class'), TEXT);
      value(c, t.modelled, child(thread.path, 'modelled'), FLAG);
      if (t.hand !== undefined) value(c, t.hand, child(thread.path, 'hand'), HAND);
    }
  }
}

registerFeatureType('core.hole', { versions: [1], readInputs: readHoleInputs });

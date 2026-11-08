import { child } from './diagnostics';
import { registerFeatureType } from './features';
import { readLayout } from './pattern';
import type { Json, Reader } from './reader';
import { readInstancePath, readReference } from './references';
import { readAttachedFrame, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** What an assembly feature copies: a set of instance paths, not empty. */
function readInstances(r: Reader, v: unknown, path: string): void {
  const members = r.set(v, path);
  if (members?.length === 0) r.diagnostics.refuse('bad-value', path, 'what is copied is not empty');
  members?.forEach((m, i) => readInstancePath(r, m, child(child(path, 'set'), i)));
}

function readSlots(r: Reader, v: unknown, path: string): void {
  r.set(v, path)?.forEach((key, i) => {
    const kp = child(child(path, 'set'), i);
    const u = r.union(key, kp, ['slot']);
    if (!u) return;
    const o = r.object(u.payload, u.path, { required: ['i', 'j'] });
    if (!o) return;
    r.integer(o.i, child(u.path, 'i'));
    r.integer(o.j, child(u.path, 'j'));
  });
}

/** `core.asm.pattern` (12.1), typeVersion 1: copies of instances by a pattern layout, each a `slot` copy step. */
function readAsmPatternInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['of', 'layout', 'skip'] });
  if (!o) return;
  readInstances(r, o.of, child(path, 'of'));
  readLayout(c, o.layout, child(path, 'layout'));
  readSlots(r, o.skip, child(path, 'skip'));
}

/**
 * `core.asm.mirror` (12.1), typeVersion 1. `hand` is `{"same": {}}` (each copy
 * is its seed's definition, turned so it faces the mirror) or `{"opposite":
 * {"parts": ordered list of {instance: instance path, part: {"id"}}}}`, the
 * part holding each seed's opposite-hand derive.
 */
function readAsmMirrorInputs(r: Reader, _values: ValueIndex, inputs: Json, path: string): void {
  const o = r.object(inputs, path, { required: ['of', 'plane', 'hand'] });
  if (!o) return;
  readInstances(r, o.of, child(path, 'of'));
  readReference(r, o.plane, child(path, 'plane'));
  const hand = r.union(o.hand, child(path, 'hand'), ['same', 'opposite']);
  if (hand?.tag === 'same') r.object(hand.payload, hand.path, { required: [] });
  else if (hand?.tag === 'opposite') {
    const h = r.object(hand.payload, hand.path, { required: ['parts'] });
    const lp = child(hand.path, 'parts');
    if (!h || !r.list(h.parts, lp)) return;
    h.parts.forEach((row, i) => {
      const rp = child(lp, i);
      const ro = r.object(row, rp, { required: ['instance', 'part'] });
      if (!ro) return;
      readInstancePath(r, ro.instance, child(rp, 'instance'));
      r.idRef(ro.part, child(rp, 'part'), 'part');
    });
  }
}

/**
 * `core.asm.replicate` (12.1), typeVersion 1: a copy of the seed instances at
 * each target frame, standing to it as the seeds stand to `seed`. The copy at
 * target k (from 0) has the copy key `{"slot": {"i": k + 1, "j": 0}}`.
 */
function readAsmReplicateInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['of', 'seed', 'targets'] });
  if (!o) return;
  readInstances(r, o.of, child(path, 'of'));
  readAttachedFrame(c, o.seed, child(path, 'seed'));
  const tp = child(path, 'targets');
  if (!r.list(o.targets, tp)) return;
  if (o.targets.length === 0) r.diagnostics.refuse('bad-value', tp, 'a replicate has a target');
  o.targets.forEach((t, i) => readAttachedFrame(c, t, child(tp, i)));
}

registerFeatureType('core.asm.pattern', { versions: [1], readInputs: readAsmPatternInputs });
registerFeatureType('core.asm.mirror', { versions: [1], readInputs: readAsmMirrorInputs });
registerFeatureType('core.asm.replicate', { versions: [1], readInputs: readAsmReplicateInputs });

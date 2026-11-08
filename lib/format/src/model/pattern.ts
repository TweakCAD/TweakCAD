import { child } from './diagnostics';
import { readOperation } from './extrude';
import { readOverride, registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { ANGLE, FLAG, INTEGER, LENGTH, readAxis, readDirection, value, valueList, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** What a pattern, mirror or move copies: a non-empty set of references of one kind. */
export function readCopied(c: InputContext, v: unknown, path: string, kinds: readonly string[]): void {
  const u = c.r.union(v, path, [...kinds]);
  if (!u) return;
  const members = c.r.set(u.payload, u.path);
  if (members?.length === 0) c.r.diagnostics.refuse('bad-value', u.path, 'what is copied is not empty');
  members?.forEach((m, i) => readReference(c.r, m, child(child(u.path, 'set'), i)));
}

function readSpacing(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['equal', 'list']);
  if (u?.tag === 'equal') {
    const o = c.r.object(u.payload, u.path, { required: ['s'] });
    if (o) value(c, o.s, child(u.path, 's'), LENGTH);
  } else if (u?.tag === 'list') {
    const o = c.r.object(u.payload, u.path, { required: ['values'] });
    if (o) valueList(c, o.values, child(u.path, 'values'), LENGTH);
  }
}

/**
 * A pattern layout (appendix A). A linear direction's `symmetric` (absent:
 * false) places its copies on both sides of the seed: `count`, the seed among
 * them, spread both ways, those after it at slots 1 … ⌈(count − 1) / 2⌉ and
 * those against the direction at −1 … −⌊(count − 1) / 2⌋.
 */
export function readLayout(c: InputContext, v: unknown, path: string): void {
  const { r } = c;
  const u = r.union(v, path, ['linear', 'circular', 'path']);
  if (u?.tag === 'linear') {
    const o = r.object(u.payload, u.path, { required: ['directions'] });
    const listPath = child(u.path, 'directions');
    if (!o || !r.list(o.directions, listPath)) return;
    if (o.directions.length < 1 || o.directions.length > 2) {
      r.diagnostics.refuse('bad-value', listPath, 'a linear layout has one or two directions');
    }
    o.directions.forEach((d, i) => {
      const dp = child(listPath, i);
      const row = r.object(d, dp, { required: ['direction', 'count', 'spacing'], optional: ['symmetric'] });
      if (!row) return;
      readDirection(c, row.direction, child(dp, 'direction'));
      value(c, row.count, child(dp, 'count'), INTEGER);
      readSpacing(c, row.spacing, child(dp, 'spacing'));
      if (row.symmetric !== undefined) value(c, row.symmetric, child(dp, 'symmetric'), FLAG);
    });
  } else if (u?.tag === 'circular') {
    const o = r.object(u.payload, u.path, { required: ['axis', 'count', 'angle', 'symmetric'] });
    if (!o) return;
    readAxis(c, o.axis, child(u.path, 'axis'));
    value(c, o.count, child(u.path, 'count'), INTEGER);
    value(c, o.angle, child(u.path, 'angle'), ANGLE);
    value(c, o.symmetric, child(u.path, 'symmetric'), FLAG);
  } else if (u?.tag === 'path') {
    const o = r.object(u.payload, u.path, { required: ['chain', 'count', 'spacing'] });
    if (!o) return;
    const chainPath = child(u.path, 'chain');
    if (r.list(o.chain, chainPath)) o.chain.forEach((ref, i) => readReference(r, ref, child(chainPath, i)));
    value(c, o.count, child(u.path, 'count'), INTEGER);
    readSpacing(c, o.spacing, child(u.path, 'spacing'));
  }
}

/** A skipped copy: only a `slot` key (9.5) names a place in a layout. */
function readSkip(c: InputContext, v: unknown, path: string): void {
  const u = c.r.union(v, path, ['slot']);
  if (!u) return;
  const o = c.r.object(u.payload, u.path, { required: ['i', 'j'] });
  if (!o) return;
  c.r.integer(o.i, child(u.path, 'i'));
  c.r.integer(o.j, child(u.path, 'j'));
}

/** `core.pattern` (appendix A), typeVersion 1. */
export function readPatternInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['of', 'layout', 'skip', 'vary', 'operation'] });
  if (!o) return;
  readCopied(c, o.of, child(path, 'of'), ['bodies', 'features', 'faces']);
  readLayout(c, o.layout, child(path, 'layout'));
  r.set(o.skip, child(path, 'skip'))?.forEach((key, i) =>
    readSkip(c, key, child(child(child(path, 'skip'), 'set'), i)),
  );
  const varyPath = child(path, 'vary');
  if (r.list(o.vary, varyPath)) {
    o.vary.forEach((ov, i) =>
      readOverride(r, values, ov, child(varyPath, i), scope.owner, scope.feature ?? scope.owner, -1, false, true),
    );
  }
  readOperation(c, o.operation, child(path, 'operation'));
}

registerFeatureType('core.pattern', { versions: [1], readInputs: readPatternInputs });

import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { LENGTH, choice, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

function readReferenceSet(r: Reader, v: unknown, path: string): unknown[] | null {
  const members = r.set(v, path);
  members?.forEach((m, i) => readReference(r, m, child(child(path, 'set'), i)));
  return members;
}

/**
 * `core.shell` (appendix A), typeVersion 1. `outsideThickness` is optional:
 * it is the outside wall of a shell on both sides, `thickness` the inside one.
 */
export function readShellInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['bodies', 'remove', 'thickness', 'direction'],
    optional: ['outsideThickness'],
  });
  if (!o) return;
  const bodies = readReferenceSet(r, o.bodies, child(path, 'bodies'));
  if (bodies?.length === 0) r.diagnostics.refuse('bad-value', child(path, 'bodies'), 'a shell has at least one body');
  readReferenceSet(r, o.remove, child(path, 'remove'));
  value(c, o.thickness, child(path, 'thickness'), LENGTH);
  if (o.outsideThickness !== undefined) value(c, o.outsideThickness, child(path, 'outsideThickness'), LENGTH);
  value(c, o.direction, child(path, 'direction'), choice('inside', 'outside', 'both'));
}

registerFeatureType('core.shell', { versions: [1], readInputs: readShellInputs });

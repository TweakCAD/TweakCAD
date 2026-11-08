import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readAttachedFrame } from './shapes';
import type { Scope, ValueIndex } from './values';

/** `core.constructionPlane`, `Axis`, `Point` and `Frame` (appendix A, chapter 15), typeVersion 1. */
function readConstructionInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const o = r.object(inputs, path, { required: ['frame'] });
  if (o) readAttachedFrame({ r, values, scope }, o.frame, child(path, 'frame'));
}

for (const type of [
  'core.constructionPlane',
  'core.constructionAxis',
  'core.constructionPoint',
  'core.constructionFrame',
]) {
  registerFeatureType(type, { versions: [1], readInputs: readConstructionInputs });
}

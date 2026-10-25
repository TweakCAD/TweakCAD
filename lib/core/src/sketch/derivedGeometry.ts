/**
 * Derive a sketch's flat per-curve geometry from its editor model, on demand.
 *
 * ## Why this replaced a stored field
 *
 * A sketch used to persist both forms: `editorModel` (points, curves held by
 * point-reference, constraints — what the editor and solver work on) and
 * `buildGeometry` (flat records with coordinates baked in as strings). The
 * second is a pure function of the first, and six separate write sites each
 * had to remember to recompute it after every mutation.
 *
 * Storing a derived value cost three times over. It doubled the sketch's size
 * in every saved document and every autosave. It created a drift class
 * guarded only by discipline. And it round-tripped through strings for no
 * reader in between — the serializer stringified coordinates, then
 * `buildSketch` parsed them straight back to numbers.
 *
 * ## What took long enough to settle
 *
 * The projection was not purely redundant: its coordinates were `Expression`,
 * not `number`, and that was the only place a parameter could reach sketch
 * geometry. Deleting it would have made imported components non-parametric.
 *
 * That is now handled properly — dimension constraints carry an `expression`,
 * the worker resolves it against the project parameters and re-solves, so the
 * parameter drives a dimension the solver enforces rather than a coordinate
 * it is free to move. `parametricComponent.test.ts` pins the parity.
 *
 * ## The cache
 *
 * Keyed on `editorModel` object identity in a `WeakMap`. The document is
 * immutable, so immer hands out a fresh object on every edit: a changed
 * sketch misses by construction and the superseded entry becomes collectable.
 * No invalidation to call and none to forget.
 *
 * That matters because the readers include render paths — `SketchViewer`
 * re-derives whenever it redraws, and `detectSketchRegions` runs over the
 * result. Both conversions underneath are linear in entity count: cheap, but
 * not free at 60fps.
 */

import type { SketchFeatureInputs, SketchEntity } from '../document/schema.ts';
import type { EntityId } from '../ids.ts';
import { fromSnapshot } from './operations.ts';
import { editorModelToBuildGeometry } from './serialization.ts';

type BuildGeometry = Record<EntityId, SketchEntity>;

const cache = new WeakMap<object, BuildGeometry>();

const EMPTY: BuildGeometry = Object.freeze({});

/**
 * The flat per-curve entity map for a sketch.
 *
 * Safe in a render loop: repeated calls for an unchanged sketch return the
 * same object, so downstream identity checks hold.
 *
 * @param inputs A sketch feature's `inputs`. A missing `editorModel` yields
 *   an empty map rather than throwing — a feature that failed to load should
 *   render as empty, not take the viewport down with it.
 */
export function sketchBuildGeometry(
  inputs: Pick<SketchFeatureInputs, 'editorModel'> | undefined,
): BuildGeometry {
  const model = inputs?.editorModel as unknown as object | undefined;
  if (!model) return EMPTY;

  const hit = cache.get(model);
  if (hit) return hit;

  const derived = editorModelToBuildGeometry(fromSnapshot(inputs?.editorModel));
  cache.set(model, derived);
  return derived;
}

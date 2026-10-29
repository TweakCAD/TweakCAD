/**
 * Feature lookup across parts.
 *
 * A `FeatureId` is unique in the document, but every mutating command is
 * addressed `{ partId, featureId }` — so any UI holding only a feature id
 * (a tree row, a context menu, a selection) has to resolve its owner part
 * before it can dispatch. With one part that resolution was skipped and
 * the first part was passed instead; with two, that silently edits the
 * wrong part's timeline, or fails validation if the id isn't in it.
 *
 * Linear over the timelines. The callers are UI event handlers running
 * on a document with tens of features, not a hot loop.
 */

import type { CadProject, FeatureNode } from './schema.ts';
import type { FeatureId, PartId } from '../ids.ts';

/**
 * The part that owns `featureId`, and the feature itself.
 * `null` when no part's timeline holds it — which a caller should treat
 * as "the document moved under me" (an undo walked past the feature)
 * rather than an error.
 */
export function findFeature(
  project: Readonly<CadProject>,
  featureId: FeatureId | string,
): { partId: PartId; feature: FeatureNode } | null {
  for (const part of Object.values(project.parts)) {
    const feature = part.timeline.find((f) => f.id === featureId);
    if (feature) return { partId: part.id, feature };
  }
  return null;
}

/** Just the owner part's id — the common case at a dispatch site. */
export function findFeaturePartId(
  project: Readonly<CadProject>,
  featureId: FeatureId | string,
): PartId | null {
  return findFeature(project, featureId)?.partId ?? null;
}

/**
 * Resolve the part a command should act on, given the user's active part.
 *
 * Returns `activePartId` when it still names a part, else the first part
 * in insertion order, else `null` for a project with no parts. The
 * fallback is what keeps a single-part document behaving exactly as it
 * did before parts could be switched, and covers the active part going
 * away under an undo of `CreatePart`.
 */
export function resolveActivePartId(
  project: Readonly<CadProject>,
  activePartId: PartId | null | undefined,
): PartId | null {
  if (activePartId && project.parts[activePartId]) return activePartId;
  const first = (Object.keys(project.parts) as PartId[])[0];
  return first ?? null;
}

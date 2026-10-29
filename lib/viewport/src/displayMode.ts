/**
 * Feature display mode computation.
 *
 * Each feature's visual representation is derived from:
 * - feature.enabled (suppress)
 * - feature.visible (show/hide)
 * - DisplayContext (what the user is currently doing)
 *
 * This module computes the display mode for bodies and sketches,
 * which the MeshRegistry and sketch components use for rendering.
 */

import type { CadProject, FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import type { BodyId, FeatureId, PartId } from '@tweakcad/core/src/ids.ts';
import type { DisplayContext } from '@tweakcad/core/src/store/displayContextStore.ts';

/**
 * Display modes for features in the viewport.
 *
 * - hidden: not rendered at all
 * - normal: full opacity, standard materials
 * - ghosted: ~25% opacity, non-interactive (context reference)
 * - readonlySketch: sketch lines visible, regions pickable, no editing affordances
 * - editingSketch: full editor: grid, tools, palette, pointer capture
 */
export type FeatureDisplayMode =
  | 'hidden'
  | 'normal'
  | 'ghosted'
  | 'readonlySketch'
  | 'editingSketch';

/**
 * Compute the display mode for a body-producing feature (extrude, hole, etc.).
 * @param feature - The feature node from the document
 * @param context - The current display context
 * @returns The display mode to apply to this feature's body meshes
 */
export function computeBodyDisplayMode(
  feature: FeatureNode,
  context: DisplayContext,
): FeatureDisplayMode {
  if (!feature.enabled) return 'hidden';
  if (!feature.visible) return 'hidden';

  switch (context.mode) {
    case 'viewing':
      return 'normal';
    case 'editingSketch':
      return 'ghosted';
    case 'selectingProfile':
      return 'ghosted';
    case 'selectingFace':
      return 'normal';
    case 'selectingEdge':
      return 'normal';
  }
}

/**
 * Inputs for the centralized whole-scene body display-mode pass.
 * Bundled into one shape so the function call site doesn't grow
 * positional-arg sprawl as the rules add inputs (e.g. activePartId
 * for non-active-component ghosting in multi-part documents).
 */
export type AllBodyModesInputs = {
  /** All rendered bodies (the mesh list the viewport currently knows about). */
  bodyIds: readonly BodyId[];
  /** The project — used to look up feature.enabled / feature.visible. */
  project: Readonly<CadProject>;
  /** Map from body id to the feature that produced it. From the rebuild artifact. */
  bodyToFeatureMap: Readonly<Record<string, FeatureId>>;
  /**
   * Per-body manual hide set, written by the eye icon next to each body
   * in the Bodies tree section. Independent of feature.visible — a body
   * is hidden if EITHER its producing feature is hidden OR it's in this
   * set.
   */
  hiddenBodies: ReadonlySet<string>;
  /** What the user is currently doing — drives the global ghost trigger. */
  context: DisplayContext;
  /**
   * The part the user is working in. Bodies belonging to any other part
   * render `'ghosted'` in viewing mode too — the "non-active component
   * is dim" convention. Shell passes it only when the document has more
   * than one part, since with one part every body is in it anyway.
   */
  activePartId?: PartId;
};

/**
 * The ONE function that decides what each body in the scene should
 * look like. Single source of truth: collapses (feature visibility,
 * per-body hide, sketch-edit context, active-part scoping)
 * into a single mode per body. Pure — same inputs always produce the
 * same map; safe to call inside a useEffect / useMemo.
 *
 * Priority (first match wins):
 *   1. `hidden`   — feature suppressed/hidden, or body in hiddenBodies
 *   2. `ghosted`  — sketch edit context OR body not in the active part
 *   3. `normal`   — default
 *
 * Why centralized: before this existed, ghost mode was driven by TWO
 * paths that fought each other:
 *   - a viewport-wide `setGhostMode(sketchActive)` that slammed every
 *     body's opacity unconditionally
 *   - a per-body `applyDisplayModes` that consulted feature.visible
 *     but NOT hiddenBodies
 * The eye-icon handler then wrote its own one-body 'normal'/'hidden'
 * update with no awareness of sketch context, so unhiding a body
 * mid-sketch left it at full opacity instead of ghosted.
 *
 * Three things need this function and ONLY this function to be the
 * source of truth: the sketch-mode-enter effect, document/viewport-
 * store change effects, and the eye-icon toggle.
 */
export function computeAllBodyDisplayModes(
  inputs: AllBodyModesInputs,
): Map<BodyId, FeatureDisplayMode> {
  const { bodyIds, project, bodyToFeatureMap, hiddenBodies, context, activePartId } = inputs;

  // Index features by id once so the per-body loop stays O(N) over bodies.
  const featureById = new Map<FeatureId, { feature: FeatureNode; partId: PartId }>();
  for (const part of Object.values(project.parts)) {
    for (const feature of part.timeline) {
      featureById.set(feature.id, { feature, partId: part.id });
    }
  }

  const isGhostContext =
    context.mode === 'editingSketch' || context.mode === 'selectingProfile';

  const out = new Map<BodyId, FeatureDisplayMode>();
  for (const bodyId of bodyIds) {
    const featureId = bodyToFeatureMap[bodyId as unknown as string];
    const entry = featureId !== undefined ? featureById.get(featureId) : undefined;
    const feature = entry?.feature;
    const partId = entry?.partId;

    // 1. Hidden: explicit per-body OR upstream feature gone/hidden.
    //    Orphan bodies (no producing feature found — e.g. mid-rebuild
    //    inconsistency) are kept visible-normal to avoid blinking out
    //    entire bodies during a rebuild swap; the next pass corrects.
    if (
      hiddenBodies.has(bodyId as unknown as string)
      || (feature && (!feature.enabled || !feature.visible))
    ) {
      out.set(bodyId, 'hidden');
      continue;
    }

    // 2. Ghosted: sketch context applies to everything; the multi-part
    //    "non-active component" ghosting kicks in only when an active
    //    part is set AND the body belongs to a different part. Note
    //    ghosted bodies stay pickable — which is why the features built
    //    from a pick resolve their part from the body, not from here.
    if (
      isGhostContext
      || (activePartId !== undefined && partId !== undefined && partId !== activePartId)
    ) {
      out.set(bodyId, 'ghosted');
      continue;
    }

    // 3. Default.
    out.set(bodyId, 'normal');
  }
  return out;
}

/**
 * Compute the display mode for a sketch feature.
 * @param feature - The sketch feature node from the document
 * @param context - The current display context
 * @returns The display mode for this sketch
 */
export function computeSketchDisplayMode(
  feature: FeatureNode,
  context: DisplayContext,
): FeatureDisplayMode {
  if (!feature.enabled) return 'hidden';

  switch (context.mode) {
    case 'viewing':
      // In normal viewing, sketches only show if user explicitly toggled visibility on
      return feature.visible ? 'readonlySketch' : 'hidden';
    case 'editingSketch':
      // The active sketch gets full editing mode; others hidden
      return feature.id === context.sketchId ? 'editingSketch' : 'hidden';
    case 'selectingProfile':
      // The target sketch shows as readonly with region picking; others hidden
      return feature.id === context.sketchId ? 'readonlySketch' : 'hidden';
    case 'selectingFace':
    case 'selectingEdge':
      return 'hidden';
  }
}

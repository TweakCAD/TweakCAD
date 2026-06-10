/**
 * Document → editor hydration subscriber.
 *
 * **Why this exists.** The in-app sketch tools do not
 * write to `SketchEditorStore` directly — they dispatch CadCommands
 * that mutate the *document's* `editorModel` snapshot. Without a
 * subscriber the editor store would still hold its pre-dispatch state
 * and the user would see no change. This module bridges that gap:
 *
 *   1. Subscribe to `documentStore` while a sketch is open.
 *   2. On every doc change, read the active sketch's `editorModel`.
 *   3. If it differs from the snapshot we last applied, call
 *      `SketchEditorStore.hydrateFromDocument` (replaces the geometry
 *      slice but preserves UI state — selection, hover, active tool,
 *      preview).
 *
 * **Loop avoidance.** The hydration call goes through `set(...)` in the
 * editor store; it does NOT write back to the document. So a dispatch
 * triggers one doc change → one hydration → done. No oscillation.
 *
 * **Identity-based deduping.** We track the last applied snapshot by
 * reference (`lastSnapshot`). Immer freezes new state on every change,
 * so the reference changes iff the snapshot actually changed. If nothing
 * touched the active sketch's editor state, we skip.
 *
 * **Lifecycle.** `subscribeSketchHydration(sketchId)` returns the
 * unsubscribe function. `SketchEditor.tsx` mounts it inside the
 * `isActive` effect and tears it down on exit / sketch change.
 */

import { getAppState } from '../appInit.ts';
import { useSketchEditorStore } from './SketchEditorStore.ts';
import type { CadProject, SketchFeatureInputs, SketchEditorSnapshot } from '@tweakcad/core/src/document/schema.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';
import type {
  SketchConstraint,
  SketchGeometry,
  SketchPoint,
} from '@tweakcad/core/src/sketch/types.ts';

/**
 * Walk every part's timeline to find the target sketch feature.
 * Returns null if the id isn't a sketch in the current document.
 */
function findSketchInputs(
  state: Readonly<CadProject>,
  sketchId: FeatureId,
): SketchFeatureInputs | null {
  for (const part of Object.values(state.parts)) {
    const f = part.timeline.find((feat) => feat.id === sketchId);
    if (!f || f.type !== 'sketch') continue;
    return f.inputs as unknown as SketchFeatureInputs;
  }
  return null;
}

/**
 * Wire a document → editor hydration subscription for the given
 * sketch. Returns an `unsubscribe` function — caller is responsible
 * for invoking it on unmount / sketch change.
 *
 * Runs an initial hydration pass synchronously so the store is in
 * sync with the doc the moment the subscription is created (covers
 * the case of entering a sketch that was just loaded from disk).
 *
 * `onSketchRemoved` fires when the subscriber notices the active
 * sketch feature is no longer in the document (e.g. an undo walked
 * past `CreateSketch`). The caller should tear down sketch mode in
 * response — without it the editor would be left showing stale
 * geometry that no longer has a backing feature.
 */
export function subscribeSketchHydration(
  sketchId: FeatureId,
  onSketchRemoved?: () => void,
): () => void {
  const { documentStore } = getAppState();
  let lastSnapshot: SketchEditorSnapshot | undefined = undefined;
  let removedFired = false;

  const sync = (): void => {
    const inputs = findSketchInputs(documentStore.getState(), sketchId);
    if (!inputs) {
      // Sketch feature is gone (undo, delete, etc.). Notify once so
      // Shell can exit sketch mode. Subsequent dispatches won't reach
      // here because the unsubscribe handler clears this subscription.
      if (!removedFired && onSketchRemoved) {
        removedFired = true;
        onSketchRemoved();
      }
      return;
    }
    const snap = inputs.editorModel;
    if (!snap) return;
    // Reference equality is enough — Immer hands us a fresh frozen
    // object on every mutation, so a stable reference means no change.
    if (snap === lastSnapshot) return;
    lastSnapshot = snap;
    useSketchEditorStore.getState().hydrateFromDocument(
      (snap.points ?? []) as SketchPoint[],
      (snap.geometries ?? []) as SketchGeometry[],
      (snap.constraints ?? []) as SketchConstraint[],
    );
  };

  sync(); // Initial pull so we don't wait for the next dispatch.
  return documentStore.subscribe(sync);
}

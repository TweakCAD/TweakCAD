/**
 * DisplayContextStore - tracks what the user is currently doing.
 *
 * This single store replaces scattered mode flags:
 * - SketchStore.isActive
 * - SketchEditorStore.selectionIntent
 * - Shell.tsx local extrudeState.visible
 *
 * Every feature's display mode is derived from this context
 * plus the feature's own visible/enabled flags.
 */

import { createStore } from 'zustand/vanilla';
import type { FeatureId } from '../ids.ts';

/**
 * The current display context — what the user is doing right now.
 * Drives how every feature renders in the viewport.
 */
export type DisplayContext =
  | { mode: 'viewing' }
  | { mode: 'editingSketch'; sketchId: FeatureId }
  | { mode: 'selectingProfile'; sketchId: FeatureId; forFeatureId: FeatureId | null }
  | { mode: 'selectingFace'; forFeatureId: FeatureId }
  | { mode: 'selectingEdge'; forFeatureId: FeatureId };

export type DisplayContextState = {
  /** Current display context */
  context: DisplayContext;

  /** Transition to normal 3D viewing */
  setViewing: () => void;

  /** Transition to sketch editing mode */
  setEditingSketch: (sketchId: FeatureId) => void;

  /** Transition to profile selection mode (for extrude, revolve, etc.) */
  setSelectingProfile: (sketchId: FeatureId, forFeatureId: FeatureId | null) => void;

  /** Transition to face selection mode (for hole, fillet, etc.) */
  setSelectingFace: (forFeatureId: FeatureId) => void;

  /** Transition to edge selection mode (for chamfer, fillet, etc.) */
  setSelectingEdge: (forFeatureId: FeatureId) => void;
};

export function createDisplayContextStore() {
  return createStore<DisplayContextState>(set => ({
    context: { mode: 'viewing' },

    setViewing: () =>
      set({ context: { mode: 'viewing' } }),

    setEditingSketch: (sketchId: FeatureId) =>
      set({ context: { mode: 'editingSketch', sketchId } }),

    setSelectingProfile: (sketchId: FeatureId, forFeatureId: FeatureId | null) =>
      set({ context: { mode: 'selectingProfile', sketchId, forFeatureId } }),

    setSelectingFace: (forFeatureId: FeatureId) =>
      set({ context: { mode: 'selectingFace', forFeatureId } }),

    setSelectingEdge: (forFeatureId: FeatureId) =>
      set({ context: { mode: 'selectingEdge', forFeatureId } }),
  }));
}

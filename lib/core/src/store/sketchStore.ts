/**
 * SketchStore - manages sketch mode ephemeral state.
 *
 * This store holds the transient UI state for sketch mode:
 * - Whether sketch mode is active
 * - Which plane/sketch is being edited
 * - Active drawing tool
 * - Preview entities (rubber-band during drawing)
 * - Camera state before entering sketch (for restore)
 *
 * Document-level sketch data (entities, constraints) lives in DocumentStore.
 * This store is for UI interaction state only.
 */

import { createStore } from 'zustand/vanilla';
import type { FeatureId } from '../ids.ts';
import type { PlaneRef } from '../document/schema.ts';
import type { Vec2 } from '../math.ts';

// ---- Types ----

export type SketchToolId = 'select' | 'rectangle' | 'circle' | 'line' | 'slot' | null;

/** Resolved 2D shape for rendering on the Canvas2D overlay */
export type SketchPreview =
  | { type: 'rectangle'; p1: Vec2; p2: Vec2 }
  | { type: 'circle'; center: Vec2; radius: number }
  | { type: 'line'; start: Vec2; end: Vec2 }
  | null;

/** Resolved 2D entity for Canvas2D rendering (already evaluated from expressions) */
export type ResolvedSketchEntity2D =
  | { id: string; type: 'rectangle'; center: Vec2; width: number; height: number; construction: boolean }
  | { id: string; type: 'circle'; center: Vec2; radius: number; construction: boolean }
  | { id: string; type: 'line'; start: Vec2; end: Vec2; construction: boolean };

/** Saved camera state for restore when exiting sketch */
export type SavedCameraState = {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  isOrthographic: boolean;
};

// ---- Store State ----

export type SketchState = {
  /** Whether sketch mode is currently active */
  isActive: boolean;

  /** The sketch feature being edited (null when not in sketch mode) */
  activeSketchId: FeatureId | null;

  /** Which plane we're sketching on */
  sketchPlane: PlaneRef | null;

  /** Currently active drawing tool */
  activeTool: SketchToolId;

  /** Rubber-band preview during drawing */
  preview: SketchPreview;

  /** Resolved 2D entities for Canvas2D rendering */
  resolvedEntities: ResolvedSketchEntity2D[];

  /** Cursor position in sketch-plane 2D coordinates */
  cursorPosition: Vec2 | null;

  /** Snap target (grid or entity snap) */
  snapTarget: Vec2 | null;

  /** Camera state saved when entering sketch (for restore) */
  savedCamera: SavedCameraState | null;

  /** Grid spacing in sketch plane units (mm) */
  gridSpacing: number;

  /** Whether grid snap is enabled */
  gridSnapEnabled: boolean;

  // ---- Actions ----

  /** Enter sketch mode for a specific sketch on a given plane */
  enterSketch: (sketchId: FeatureId, plane: PlaneRef, cameraState: SavedCameraState) => void;

  /** Exit sketch mode and restore camera */
  exitSketch: () => void;

  /** Set the active drawing tool */
  setActiveTool: (tool: SketchToolId) => void;

  /** Update the rubber-band preview */
  setPreview: (preview: SketchPreview) => void;

  /** Update cursor position in sketch coordinates */
  setCursorPosition: (pos: Vec2 | null) => void;

  /** Update snap target */
  setSnapTarget: (snap: Vec2 | null) => void;

  /** Update resolved entities (called after document changes) */
  setResolvedEntities: (entities: ResolvedSketchEntity2D[]) => void;

  /** Toggle grid snap */
  setGridSnap: (enabled: boolean) => void;
};

// ---- Factory ----

export function createSketchStore() {
  return createStore<SketchState>(set => ({
    isActive: false,
    activeSketchId: null,
    sketchPlane: null,
    activeTool: null,
    preview: null,
    resolvedEntities: [],
    cursorPosition: null,
    snapTarget: null,
    savedCamera: null,
    gridSpacing: 10, // 10mm grid
    gridSnapEnabled: true,

    enterSketch: (sketchId, plane, cameraState) =>
      set({
        isActive: true,
        activeSketchId: sketchId,
        sketchPlane: plane,
        activeTool: 'select',
        preview: null,
        cursorPosition: null,
        snapTarget: null,
        savedCamera: cameraState,
      }),

    exitSketch: () =>
      set({
        isActive: false,
        activeSketchId: null,
        sketchPlane: null,
        activeTool: null,
        preview: null,
        resolvedEntities: [],
        cursorPosition: null,
        snapTarget: null,
        // savedCamera is preserved so caller can read it for camera restore
      }),

    setActiveTool: tool => set({ activeTool: tool, preview: null }),
    setPreview: preview => set({ preview }),
    setCursorPosition: pos => set({ cursorPosition: pos }),
    setSnapTarget: snap => set({ snapTarget: snap }),
    setResolvedEntities: entities => set({ resolvedEntities: entities }),
    setGridSnap: enabled => set({ gridSnapEnabled: enabled }),
  }));
}

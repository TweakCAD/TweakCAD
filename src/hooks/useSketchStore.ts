/**
 * React hooks for accessing SketchStore state.
 * Uses useSyncExternalStore with primitive subscriptions to avoid
 * infinite re-render loops (same pattern as useViewportStore).
 */

import { useSyncExternalStore } from 'react';
import type { SketchToolId, SketchPreview, ResolvedSketchEntity2D } from '@tweakcad/core/src/store/sketchStore.ts';
import type { Vec2 } from '@tweakcad/core/src/math.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';
import type { PlaneRef } from '@tweakcad/core/src/document/schema.ts';

// ---- Store reference ----

let storeRef: ReturnType<typeof import('@tweakcad/core/src/store/sketchStore.ts').createSketchStore> | null = null;

/** Set the store reference (called once during app init) */
export function setSketchStoreRef(
  store: ReturnType<typeof import('@tweakcad/core/src/store/sketchStore.ts').createSketchStore>,
): void {
  storeRef = store;
}

function getStore() {
  if (!storeRef) throw new Error('SketchStore not initialized');
  return storeRef;
}

// ---- Primitive hooks ----

export function useSketchActive(): boolean {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().isActive,
  );
}

export function useSketchTool(): SketchToolId {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().activeTool,
  );
}

export function useSketchPreview(): SketchPreview {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().preview,
  );
}

export function useSketchEntities(): ResolvedSketchEntity2D[] {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().resolvedEntities,
  );
}

export function useSketchCursor(): Vec2 | null {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().cursorPosition,
  );
}

export function useSketchGridSpacing(): number {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().gridSpacing,
  );
}

export function useSketchGridSnap(): boolean {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().gridSnapEnabled,
  );
}

export function useSketchPlane(): PlaneRef | null {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().sketchPlane,
  );
}

export function useActiveSketchId(): FeatureId | null {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().activeSketchId,
  );
}

// ---- Action hooks ----

// Built once per process — Zustand actions are stable across renders,
// so the wrapper object can be too. Returning a fresh object literal on
// every call (which the old code did) gave consumers an unstable
// reference: any useCallback that depended on `sketchActions` got a
// new identity each render, which in turn caused dependent useEffects
// (notably the subscribeSketchHydration mount in SketchEditor) to
// tear down + remount on every parent render. That remount re-ran
// the hydration's initial sync, overwriting any in-flight editor
// mutations (e.g. a drag) with the last-saved document state — the
// "drag doesn't move anything after reopen" bug.
let cachedActions: ReturnType<typeof buildActions> | null = null;
function buildActions() {
  const state = getStore().getState();
  return {
    enterSketch: state.enterSketch,
    exitSketch: state.exitSketch,
    setActiveTool: state.setActiveTool,
    setPreview: state.setPreview,
    setCursorPosition: state.setCursorPosition,
    setResolvedEntities: state.setResolvedEntities,
    setGridSnap: state.setGridSnap,
  };
}
export function useSketchActions() {
  if (cachedActions === null) cachedActions = buildActions();
  return cachedActions;
}

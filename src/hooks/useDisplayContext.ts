/**
 * React hooks for accessing DisplayContextStore state.
 * Uses useSyncExternalStore for safe React integration.
 */

import { useSyncExternalStore } from 'react';
import type { DisplayContext } from '@tweakcad/core/src/store/displayContextStore.ts';

// ---- Store reference ----

let storeRef: ReturnType<typeof import('@tweakcad/core/src/store/displayContextStore.ts').createDisplayContextStore> | null = null;

/** Set the store reference (called once during app init) */
export function setDisplayContextStoreRef(
  store: ReturnType<typeof import('@tweakcad/core/src/store/displayContextStore.ts').createDisplayContextStore>,
): void {
  storeRef = store;
}

function getStore() {
  if (!storeRef) throw new Error('DisplayContextStore not initialized');
  return storeRef;
}

// ---- Context hooks ----

/** Get the current display context */
export function useDisplayContext(): DisplayContext {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().context,
  );
}

/** Get just the current mode string */
export function useDisplayMode(): DisplayContext['mode'] {
  const store = getStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().context.mode,
  );
}

// ---- Action hooks ----

/** Get the display context actions (stable references from the store) */
export function useDisplayContextActions() {
  const store = getStore();
  const state = store.getState();
  return {
    setViewing: state.setViewing,
    setEditingSketch: state.setEditingSketch,
    setSelectingProfile: state.setSelectingProfile,
    setSelectingFace: state.setSelectingFace,
    setSelectingEdge: state.setSelectingEdge,
  };
}

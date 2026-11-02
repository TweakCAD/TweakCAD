/**
 * React hooks for subscribing to the DocumentStore.
 * Provides reactive access to the CadProject state.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';
import { getAppState } from '../appInit.ts';

/**
 * Subscribe to the full document state.
 * Re-renders when any part of the document changes.
 * @returns The current CadProject state
 */
export function useDocumentState(): Readonly<CadProject> {
  const { documentStore } = getAppState();

  return useSyncExternalStore(
    useCallback(
      (callback: () => void) => documentStore.subscribe(callback),
      [documentStore],
    ),
    useCallback(() => documentStore.getState(), [documentStore]),
  );
}

/**
 * Get the CommandBus for dispatching commands.
 * Does not cause re-renders.
 * @returns The CommandBus instance
 */
export function useCommandBus() {
  return getAppState().commandBus;
}

/**
 * Get undo/redo controls.
 * @returns Object with undo/redo functions and availability flags
 */
export function useUndoRedo() {
  const { documentStore } = getAppState();

  // Availability changes with the document, and also when a transaction
  // opens or closes (undo is refused while one is open), which is not a
  // document change.
  const subscribe = useCallback(
    (callback: () => void) => {
      const offState = documentStore.subscribe(callback);
      const offHistory = documentStore.subscribeHistory(callback);
      return () => {
        offState();
        offHistory();
      };
    },
    [documentStore],
  );

  const canUndo = useSyncExternalStore(
    subscribe,
    useCallback(() => documentStore.canUndo(), [documentStore]),
  );

  const canRedo = useSyncExternalStore(
    subscribe,
    useCallback(() => documentStore.canRedo(), [documentStore]),
  );

  const undoLabel = useSyncExternalStore(
    subscribe,
    useCallback(() => documentStore.undoLabel(), [documentStore]),
  );

  const redoLabel = useSyncExternalStore(
    subscribe,
    useCallback(() => documentStore.redoLabel(), [documentStore]),
  );

  return {
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    undo: useCallback(() => documentStore.undo(), [documentStore]),
    redo: useCallback(() => documentStore.redo(), [documentStore]),
  };
}

/** React hooks over the editor and the app's stores, by subscription. */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { Doc, Editor } from '@tweakcad/editor';

/** The editor's document; re-renders on every change. */
export function useDocument(editor: Editor): Doc {
  const subscribe = useCallback((notify: () => void) => editor.store.subscribe(notify), [editor]);
  const get = () => editor.document;
  // The same snapshot when rendered to static markup.
  return useSyncExternalStore(subscribe, get, get);
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
}

function historyOf(editor: Editor): HistoryState {
  const s = editor.store;
  return { canUndo: s.canUndo(), canRedo: s.canRedo(), undoLabel: s.undoLabel(), redoLabel: s.redoLabel() };
}

const sameHistory = (a: HistoryState, b: HistoryState) =>
  a.canUndo === b.canUndo && a.canRedo === b.canRedo && a.undoLabel === b.undoLabel && a.redoLabel === b.redoLabel;

/** What undo and redo would do now; follows document changes and transactions opening or closing. */
export function useHistory(editor: Editor): HistoryState {
  const cache = useRef<HistoryState | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      const a = editor.store.subscribe(notify);
      const b = editor.store.subscribeHistory(notify);
      return () => {
        a();
        b();
      };
    },
    [editor],
  );
  const snapshot = () => {
    const next = historyOf(editor);
    if (cache.current && sameHistory(cache.current, next)) return cache.current;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A slice of a vanilla store. */
export function useSlice<S, T>(store: StoreApi<S>, select: (s: S) => T): T {
  return useStore(store, select);
}

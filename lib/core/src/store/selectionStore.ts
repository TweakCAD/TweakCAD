/**
 * SelectionStore - ephemeral state for the currently selected entity.
 * Uses Zustand. Not persisted, not undoable.
 */

import { createStore } from 'zustand/vanilla';
import type { Selection } from '../document/schema.ts';

export type SelectionState = {
  /** Current primary selection */
  selection: Selection | null;
  /** Current hover/preselection */
  preselection: Selection | null;
  /** Multi-selection set (for future) */
  multiSelection: Selection[];

  /** Set the primary selection */
  select: (sel: Selection | null) => void;
  /** Set the hover preselection */
  preselect: (sel: Selection | null) => void;
  /** Toggle an item in multi-selection */
  toggleMultiSelect: (sel: Selection) => void;
  /** Clear all selections */
  clearAll: () => void;
};

export function createSelectionStore() {
  return createStore<SelectionState>(set => ({
    selection: null,
    preselection: null,
    multiSelection: [],

    select: (sel: Selection | null) => set({ selection: sel }),

    preselect: (sel: Selection | null) => set({ preselection: sel }),

    toggleMultiSelect: (sel: Selection) =>
      set(state => {
        const exists = state.multiSelection.findIndex(
          s => JSON.stringify(s) === JSON.stringify(sel),
        );
        if (exists >= 0) {
          return {
            multiSelection: state.multiSelection.filter((_, i) => i !== exists),
          };
        }
        return { multiSelection: [...state.multiSelection, sel] };
      }),

    clearAll: () => set({ selection: null, preselection: null, multiSelection: [] }),
  }));
}

/**
 * Which browser nodes are open, shared by the part rows and the assembly
 * rows so Expand all and Collapse all reach both. It is window state, not
 * the document's: every node starts collapsed but the document's own row,
 * so a large design opens as its top-level list.
 */
import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';

interface TreeOpen {
  /** Expand all was the last of the two pressed: nodes start open. */
  allOpen: boolean;
  /** Nodes toggled away from how they start. */
  toggled: ReadonlySet<string>;
}

/** The document's row: open while nodes start collapsed, so the top level shows. */
export const DOCUMENT_NODE = 'doc';

export const treeOpen = createStore<TreeOpen>(() => ({ allOpen: false, toggled: new Set() }));

/** Whether node `id` is open in `state`. */
export function isOpenIn(state: TreeOpen, id: string): boolean {
  const start = state.allOpen || id === DOCUMENT_NODE;
  return state.toggled.has(id) !== start;
}

export function toggleNode(id: string): void {
  treeOpen.setState(({ toggled }) => {
    const next = new Set(toggled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { toggled: next };
  });
}

/** Opens every node, or closes every node but the document's. */
export function setAllOpen(allOpen: boolean): void {
  treeOpen.setState({ allOpen, toggled: new Set() });
}

/** Whether a node is open, for a tree's rows: renders again when the open nodes change. */
export function useTreeOpen(): (id: string) => boolean {
  // The current state on a server render too, not the store's initial one.
  const state = useSyncExternalStore(treeOpen.subscribe, treeOpen.getState, treeOpen.getState);
  return (id) => isOpenIn(state, id);
}

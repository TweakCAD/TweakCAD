/**
 * What the user has selected and what the pointer is over. An item names an
 * entity of the shown evaluation by key (with the instance it was picked
 * through, in an assembly), a standard plane, axis or the origin point by
 * name, or a feature by id.
 *
 * Keys mean nothing once another evaluation is shown, so key items are
 * dropped when the display's generation changes, unless the new display
 * only shows the one before otherwise (it keeps its keys); standard
 * references and features keep their selection.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Display, Key } from '@tweakcad/worker/src/v2/service/types';
import type { DisplayStore } from './display/scheduler';

export type StandardPlane = 'xy' | 'xz' | 'yz';

export const STANDARD_PLANES: readonly StandardPlane[] = ['xy', 'xz', 'yz'];

/** The standard axes and the origin point (9.1). */
export type StandardDatum = 'x' | 'y' | 'z' | 'origin';

export const STANDARD_DATUMS: readonly StandardDatum[] = ['x', 'y', 'z', 'origin'];

/** An instance of an assembly's display, by its index in `instances`. */
export interface InstanceRef {
  assembly: string;
  index: number;
}

export type SelectionItem =
  { key: Key; instance?: InstanceRef } | { standard: StandardPlane } | { datum: StandardDatum } | { feature: string };

export interface SelectionState {
  items: SelectionItem[];
  hover: SelectionItem | null;
  /** The display generation the key items belong to. */
  generation: number | null;
}

export type SelectionStore = StoreApi<SelectionState>;

export function createSelectionStore(): SelectionStore {
  return createStore<SelectionState>(() => ({ items: [], hover: null, generation: null }));
}

export function sameItem(a: SelectionItem | null | undefined, b: SelectionItem | null | undefined): boolean {
  if (!a || !b) return a === b;
  if ('key' in a) {
    if (!('key' in b) || a.key !== b.key) return false;
    return a.instance?.assembly === b.instance?.assembly && a.instance?.index === b.instance?.index;
  }
  if ('standard' in a) return 'standard' in b && a.standard === b.standard;
  if ('datum' in a) return 'datum' in b && a.datum === b.datum;
  return 'feature' in b && a.feature === b.feature;
}

export function isSelected(state: SelectionState, item: SelectionItem): boolean {
  return state.items.some((i) => sameItem(i, item));
}

/** Selects `item` alone, or with `additive` toggles it in the selection. */
export function select(store: SelectionStore, item: SelectionItem, additive = false): void {
  const { items } = store.getState();
  if (!additive) {
    store.setState({ items: [item] });
    return;
  }
  const present = items.some((i) => sameItem(i, item));
  store.setState({ items: present ? items.filter((i) => !sameItem(i, item)) : [...items, item] });
}

export function clearSelection(store: SelectionStore): void {
  if (store.getState().items.length > 0) store.setState({ items: [] });
}

export function setHover(store: SelectionStore, item: SelectionItem | null): void {
  if (!sameItem(store.getState().hover, item)) store.setState({ hover: item });
}

/** Drops key items whenever a display of another generation is published. */
export function followGeneration(selection: SelectionStore, display: DisplayStore): () => void {
  const sync = (shown: Display | null) => {
    const generation = shown?.generation ?? null;
    const state = selection.getState();
    if (state.generation === generation) return;
    // A display that only shows the one before otherwise keeps the keys it still shows.
    if (shown?.restyled !== undefined && shown.restyled === state.generation) {
      const showing = (i: SelectionItem) => !('key' in i) || shown.entities[i.key]?.shown === true;
      const hover = state.hover && !showing(state.hover) ? null : state.hover;
      selection.setState(
        state.items.every(showing) ? { generation, hover } : { generation, items: state.items.filter(showing), hover },
      );
      return;
    }
    const hover = state.hover && 'key' in state.hover ? null : state.hover;
    selection.setState({ generation, items: state.items.filter((i) => !('key' in i)), hover });
  };
  sync(display.getState().display);
  return display.subscribe((s) => sync(s.display));
}

/** The feature ids the selection names directly. */
export function selectedFeatures(state: SelectionState): string[] {
  return state.items.flatMap((i) => ('feature' in i ? [i.feature] : []));
}

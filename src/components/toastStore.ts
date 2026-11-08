/**
 * Toast notification store.
 *
 * Global single-toast queue (latest replaces previous). Any module — store,
 * hook, command handler — can call `enqueueToast(...)` without taking a
 * dependency on React state. App.tsx subscribes via `useToastStore` and
 * renders the current toast through the existing [[Toast]] component.
 *
 * Why a Zustand store rather than React Context: trigger sites include
 * non-React modules (e.g. SketchEditorStore.addConstraint emits rejection
 * toasts from inside its setter). Context can't reach those.
 *
 * Why "single toast (latest wins)": matches the existing Toast UX. If we
 * later want a stack, the store can grow into an array without changing
 * the call sites.
 */

import { create } from 'zustand';
import type { ToastTone } from './Toast.tsx';

export interface ToastPayload {
  /** Stable identity — incrementing nonce so repeated identical toasts re-show. */
  nonce: number;
  title?: string;
  message: string;
  tone?: ToastTone;
  durationMs?: number;
  /** A button on the toast; clicking it dismisses the toast too. */
  action?: { label: string; onClick: () => void };
}

interface ToastStoreState {
  current: ToastPayload | null;
  enqueue(toast: Omit<ToastPayload, 'nonce'>): void;
  dismiss(): void;
}

let nonceCounter = 0;

export const useToastStore = create<ToastStoreState>((set) => ({
  current: null,
  enqueue: (toast) =>
    set({
      current: { ...toast, nonce: ++nonceCounter },
    }),
  dismiss: () => set({ current: null }),
}));

/** Non-hook accessor — call from anywhere (stores, command handlers, etc). */
export function enqueueToast(toast: Omit<ToastPayload, 'nonce'>): void {
  useToastStore.getState().enqueue(toast);
}

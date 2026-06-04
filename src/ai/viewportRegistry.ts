/**
 * Process-wide handle to the live `ViewportController`.
 *
 * Multiple consumer paths need access to the same controller:
 *   - In-app chat panel  → runChatTurn  → browserToolHost
 *   - MCP bridge         → mcpBridgeClient handlers (responding to
 *                          requests from external MCP clients)
 *
 * Both run inside the same browser tab and there is ALWAYS exactly
 * one canvas / one controller per tab. Passing the controller down
 * through prop trees (or worse, building a second one) is friction
 * with no upside — a module-scope ref is the honest model.
 *
 * The active controller is registered by Shell when the canvas mounts
 * and cleared on dispose, so consumers reading via `getActiveViewport`
 * always see the latest live instance and `null` between mounts.
 *
 * Lifecycle:
 *   Shell mount    → setActiveViewport(ctrl)
 *   Shell unmount  → setActiveViewport(null)
 *   HMR replace    → setActiveViewport(newCtrl) (replaces transparently)
 */

import type { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';

let active: ViewportController | null = null;
const listeners = new Set<(vc: ViewportController | null) => void>();

/** Replace the registered controller. Pass `null` on dispose. */
export function setActiveViewport(vc: ViewportController | null): void {
  if (active === vc) return;
  active = vc;
  for (const fn of listeners) fn(vc);
}

/** Read the current controller. Returns `null` when no canvas is mounted. */
export function getActiveViewport(): ViewportController | null {
  return active;
}

/**
 * Subscribe to changes. Useful if a consumer wants to react to
 * mount/unmount (e.g. close a chat turn that depended on viewport
 * access). Returns an unsubscribe function.
 */
export function subscribeActiveViewport(
  fn: (vc: ViewportController | null) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

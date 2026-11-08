/**
 * Connection status for the local MCP bridge WebSocket.
 *
 * State machine the dot in the title bar reads from + the bridge client
 * writes to.
 *
 *   disabled     — settings.bridgeEnabled === false. Dot hidden.
 *   connecting   — settings flipped on; trying ws://host:port. Yellow dot.
 *   connected    — WebSocket open + handshake done. Green dot.
 *   error        — last attempt failed or socket closed unexpectedly. Red dot
 *                  with hover tooltip carrying the error message.
 *
 * No networking lives here; that is `bridgeClient.ts`. This
 * module is a tiny pub/sub so the React tree can render the status
 * without prop-drilling.
 */

export type BridgeStatus =
  | { state: 'disabled' }
  | { state: 'connecting'; url: string }
  | { state: 'connected'; url: string }
  | { state: 'error'; url: string; message: string };

let current: BridgeStatus = { state: 'disabled' };
const listeners = new Set<(s: BridgeStatus) => void>();

export function getBridgeStatus(): BridgeStatus {
  return current;
}

export function setBridgeStatus(next: BridgeStatus): void {
  current = next;
  for (const fn of listeners) fn(next);
}

export function subscribeBridgeStatus(fn: (s: BridgeStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

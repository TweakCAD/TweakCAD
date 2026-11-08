/**
 * React subscription to the MCP bridge connection status.
 */
import { useSyncExternalStore } from 'react';
import { getBridgeStatus, subscribeBridgeStatus, type BridgeStatus } from '../ai/bridgeStatusStore.ts';

export function useBridgeStatus(): BridgeStatus {
  return useSyncExternalStore(subscribeBridgeStatus, getBridgeStatus, getBridgeStatus);
}

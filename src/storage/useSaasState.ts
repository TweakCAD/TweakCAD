/**
 * React hook for SaaS availability state.
 * Subscribes to the saasState module; triggers re-render on state change.
 */
import { useEffect, useState } from 'react';
import { getSaasState, onSaasStateChange, type SaasState } from './saasState.ts';

export function useSaasState(): SaasState {
  const [state, setState] = useState<SaasState>(getSaasState);
  useEffect(() => onSaasStateChange(setState), []);
  return state;
}

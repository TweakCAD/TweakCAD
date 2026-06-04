/**
 * React subscription to the app-settings store. Mirrors useSaasState's
 * useSyncExternalStore pattern so components automatically re-render
 * when settings change (from any tab — SettingsDialog writes propagate
 * to e.g. the AI bridge status indicator without prop drilling).
 */
import { useSyncExternalStore } from 'react';
import {
  getAppSettings,
  subscribeAppSettings,
  type AppSettings,
} from '../storage/appSettings.ts';

export function useAppSettings(): Readonly<AppSettings> {
  return useSyncExternalStore(subscribeAppSettings, getAppSettings, getAppSettings);
}

/**
 * The console's log: rebuild results, pauses and file operations, newest
 * last. A repeat of the last entry within a second is dropped; an error
 * opens the panel.
 */
import { createStore } from 'zustand/vanilla';
import type { ConsoleEntry, LogLevel } from '../components/ConsolePanel.tsx';

export interface ConsoleState {
  entries: ConsoleEntry[];
  collapsed: boolean;
}

export const consoleStore = createStore<ConsoleState>(() => ({ entries: [], collapsed: true }));

let counter = 0;

export function consoleLog(level: LogLevel, message: string, source?: string): void {
  const state = consoleStore.getState();
  const now = Date.now();
  const last = state.entries[state.entries.length - 1];
  const collapsed = level === 'error' ? false : state.collapsed;
  if (
    last &&
    last.level === level &&
    last.message === message &&
    last.source === source &&
    now - last.timestamp < 1000
  ) {
    consoleStore.setState({ collapsed });
    return;
  }
  consoleStore.setState({
    entries: [...state.entries, { id: `log_${++counter}`, level, message, timestamp: now, source }],
    collapsed,
  });
}

export function clearConsole(): void {
  consoleStore.setState({ entries: [] });
}

export function toggleConsole(): void {
  consoleStore.setState({ collapsed: !consoleStore.getState().collapsed });
}

/** The console line for a finished rebuild: its time, and how many features it reused unchanged. */
export function rebuildMessage(ms: number, reused: number): string {
  if (reused <= 0) return `Rebuilt in ${Math.round(ms)} ms`;
  return `Rebuilt in ${Math.round(ms)} ms (${reused} ${reused === 1 ? 'feature' : 'features'} reused)`;
}

/**
 * ConsoleStore - global console logging state for the CAD application.
 *
 * Provides a zustand store for console entries and a convenience
 * function for logging from anywhere in the codebase.
 */

import { create } from 'zustand';

// ---- Types ----

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface ConsoleEntry {
  id: string;
  level: LogLevel;
  message: string;
  timestamp: number;
  source: string | undefined;
}

interface ConsoleStore {
  entries: ConsoleEntry[];
  collapsed: boolean;
  addEntry: (level: LogLevel, message: string, source?: string) => void;
  clear: () => void;
  toggle: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

// ---- Store ----

let entryCounter = 0;

export const useConsoleStore = create<ConsoleStore>((set) => ({
  entries: [],
  collapsed: true,
  addEntry: (level: LogLevel, message: string, source?: string) => set((state: ConsoleStore) => {
    const now = Date.now();
    const last = state.entries[state.entries.length - 1];
    if (
      last &&
      last.level === level &&
      last.message === message &&
      last.source === source &&
      now - last.timestamp < 1000
    ) {
      return { collapsed: level === 'error' ? false : state.collapsed };
    }

    return {
      entries: [
        ...state.entries,
        {
          id: `log_${++entryCounter}`,
          level,
          message,
          timestamp: now,
          source,
        } satisfies ConsoleEntry,
      ],
      collapsed: level === 'error' ? false : state.collapsed,
    };
  }),
  clear: () => set({ entries: [] }),
  toggle: () => set((state: ConsoleStore) => ({ collapsed: !state.collapsed })),
  setCollapsed: (collapsed: boolean) => set({ collapsed }),
}));

/**
 * Global console log function - can be called from anywhere.
 * Usage: consoleLog('info', 'Rebuild completed in 42ms', 'kernel');
 */
export function consoleLog(level: LogLevel, message: string, source?: string) {
  useConsoleStore.getState().addEntry(level, message, source);
}

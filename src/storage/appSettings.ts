/**
 * Persistent app-level user preferences.
 *
 * NOT a document concern — these settings are per-machine, not part of
 * a `.cadjson`. Persisted to localStorage so they survive reloads.
 *
 * v1 only carries the AI bridge config (toggle + host/port). Designed
 * to grow more sections (display preferences, autosave intervals, etc.)
 * by adding more fields to `AppSettings` and more tabs in the
 * SettingsDialog.
 *
 * Multiple consumers read this:
 *  - `SettingsDialog` (mutates via inputs)
 *  - The future MCP bridge WebSocket client (decides whether to connect
 *    and where)
 *  - The future chat panel (might want a "use local bridge" preference
 *    later, e.g. when the user is signed in but prefers their own key)
 */

export type AppSettings = {
  ai: {
    /** When true, the web app attempts to connect to the local MCP bridge over WS. */
    bridgeEnabled: boolean;
    /** WebSocket host the bridge listens on. Default 'localhost'. */
    bridgeHost: string;
    /** WebSocket port the bridge listens on. Default 7788 (matches the bridge CLI default). */
    bridgePort: number;
  };
};

const DEFAULTS: AppSettings = {
  ai: {
    bridgeEnabled: false,
    bridgeHost: 'localhost',
    bridgePort: 7788,
  },
};

const STORAGE_KEY = 'tweakcad-settings/v1';

let cached: AppSettings | null = null;
const listeners = new Set<(s: AppSettings) => void>();

/**
 * Read the current settings. Returns a frozen object so callers can't
 * accidentally mutate the cache.
 */
export function getAppSettings(): Readonly<AppSettings> {
  if (cached) return cached;
  cached = loadFromStorage();
  return cached;
}

/**
 * Patch one or more sections. Pass a partial; missing keys are unchanged.
 * Triggers all subscribers and writes to localStorage.
 *
 * Patch is deep-merged at the section level (one level deep) so
 * `setAppSettings({ ai: { bridgePort: 9000 } })` doesn't clobber
 * `ai.bridgeHost`. Future sections follow the same convention.
 */
export function setAppSettings(patch: DeepPartial<AppSettings>): void {
  const current = getAppSettings();
  const next: AppSettings = {
    ai: { ...current.ai, ...(patch.ai ?? {}) },
  };
  cached = next;
  saveToStorage(next);
  for (const fn of listeners) fn(next);
}

/**
 * Subscribe to settings changes. Returns an unsubscribe function.
 * Safe to call from useSyncExternalStore.
 */
export function subscribeAppSettings(fn: (s: AppSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --- internals -----------------------------------------------------------

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function loadFromStorage(): AppSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Shallow-merge defaults so missing fields on disk fall back. Keeps
    // us schema-tolerant across version bumps without forcing a
    // migration on every settings change.
    return {
      ai: { ...DEFAULTS.ai, ...(parsed.ai ?? {}) },
    };
  } catch {
    // Storage unavailable or JSON corrupt — use defaults; don't crash.
    return structuredClone(DEFAULTS);
  }
}

function saveToStorage(s: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota exceeded or storage disabled — silently ignore. The
    // in-memory cache still holds the value for this session.
  }
}

/**
 * Where the current document is anchored — local-only or cloud-backed.
 */
export type ProjectContext =
  | { kind: 'local-fresh' }                              // unsaved, no ID yet
  | { kind: 'local-stored'; localId: string }            // saved in IndexedDB only
  | { kind: 'cloud'; cloudProjectId: string; localId: string }; // synced to cloud (with local mirror)

export function projectIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('project');
}

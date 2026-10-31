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

/**
 * The local document this window is editing, from `?local=<id>`.
 *
 * Local documents used to have no identity outside IndexedDB, which meant
 * every window with no `?project=` shared one record keyed `unsaved` and
 * they overwrote each other. It also meant a reload — or the full page load
 * at the end of a social sign-in — had nothing to go back to, so boot fell
 * back to "most recent record", which could belong to another window.
 *
 * The id in the URL is the fix for both: the window's document is whatever
 * its URL names, every time.
 */
export function localIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('local');
}

/** A fresh local-document id. Opaque; only ever compared for equality. */
export function newLocalId(): string {
  return `doc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Put `?local=<id>` in the address bar without a navigation.
 *
 * `replaceState`, not `pushState`: naming the document you are already
 * editing is not a history entry, and Back should leave the editor rather
 * than step through its own bookkeeping.
 */
/**
 * Make the address bar name the document `context` now points at.
 *
 * Called whenever a file operation re-anchors the window (New, Open, Save
 * As). The URL is what boot reads on reload, so a window that opened a file
 * or saved as a new cloud project must stop naming the project it started
 * on — otherwise a reload opens that one instead. Exactly one of
 * `?project=` / `?local=` survives; `local-fresh` keeps neither, and
 * autosave adds `?local=` on its first write.
 */
export function nameDocumentInUrl(context: ProjectContext): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    const before = url.toString();
    url.searchParams.delete('project');
    url.searchParams.delete('local');
    if (context.kind === 'cloud') url.searchParams.set('project', context.cloudProjectId);
    if (context.kind === 'local-stored') url.searchParams.set('local', context.localId);
    if (url.toString() === before) return;
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Same trade as rememberLocalIdInUrl: losing the reload identity is not
    // worth failing the file operation over.
  }
}

export function rememberLocalIdInUrl(localId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('local') === localId) return;
    url.searchParams.set('local', localId);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // A URL we can't rewrite (exotic scheme, blocked history API) costs the
    // window its reload identity, not its document. Not worth throwing over.
  }
}

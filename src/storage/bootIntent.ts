/**
 * What a window should do at boot, before any storage is touched.
 *
 * Split out from `boot.ts` because this is the rule that was wrong, and it
 * is a pure decision: everything it needs is the URL, whether the backend
 * answered, and whether this tab already chose to stay offline. `boot.ts`
 * does the IndexedDB and network work that follows from the answer.
 *
 * The bug it exists to prevent: a window with no document named in its URL
 * used to call `localStore.mostRecent()` and adopt whatever record was
 * touched last — *including another window's cloud project mirror*. Three
 * windows ended up editing one cloud document, two of them without its id
 * in their URL, each running its own autosave loop against it.
 *
 * "Restore what I had open" is only a sound guess when there is nowhere
 * else the document could have come from. That is true in standalone, and
 * for a tab that has chosen to work offline. It is not true the moment an
 * account exists, because then the honest answer to "which document?" is
 * "the one you pick".
 */

export type BootMode = 'standalone' | 'offline' | 'cloud';

export type BootIntent =
  /** Open the document the URL names, or recover the last one. */
  | { kind: 'document'; mode: BootMode }
  /** Signed in, no document named: offer New / Open rather than guess. */
  | { kind: 'choose'; mode: 'cloud' }
  /** Backend is up, nobody is signed in, no document named: ask first. */
  | { kind: 'gate'; mode: 'offline' };

export type BootSignals = {
  /** `?project=` — a cloud document is named. */
  hasProjectId: boolean;
  /** `?local=` — a local document is named. */
  hasLocalId: boolean;
  /** Did the backend answer, and is someone signed in? */
  saas: { reachable: boolean; signedIn: boolean };
  /** Has this tab already answered the gate with "continue offline"? */
  offlineChosen: boolean;
};

export function decideBoot(s: BootSignals): BootIntent {
  const mode: BootMode = !s.saas.reachable
    ? 'standalone'
    : s.saas.signedIn
      ? 'cloud'
      : 'offline';

  // A named document wins in every mode. This is the first principle: a
  // window's document is whatever its URL says, and nothing else gets a
  // vote. Whether that document can actually be loaded — cloud project
  // while signed out, say — is `boot.ts`'s problem, not this one's.
  if (s.hasProjectId || s.hasLocalId) return { kind: 'document', mode };

  // Nothing named.
  if (mode === 'standalone') return { kind: 'document', mode };
  if (mode === 'cloud') return { kind: 'choose', mode };
  return s.offlineChosen ? { kind: 'document', mode } : { kind: 'gate', mode };
}

/**
 * Does this intent permit recovering the most recent local record?
 *
 * The single question the adoption bug turned on. Only ever true when the
 * window has no other way to know what it should be showing *and* no
 * account is involved — so a recovered document can only be this user's
 * own local work, never another window's cloud project.
 */
export function mayRecoverMostRecent(intent: BootIntent, hasNamedDocument: boolean): boolean {
  if (hasNamedDocument) return false;
  if (intent.kind !== 'document') return false;
  return intent.mode === 'standalone' || intent.mode === 'offline';
}

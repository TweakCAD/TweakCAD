/**
 * SaaS availability probe.
 *
 * The CAD app must run standalone (no backend) AND as part of the SaaS layer
 * (signed-in cloud sync). This module probes /api/v1/auth/get-session at boot
 * to decide which mode we're in. The probe distinguishes three states:
 *
 *   unknown      — probe hasn't run yet
 *   unavailable  — request failed (ECONNREFUSED / 404 / non-JSON / timeout)
 *                  → standalone mode: disk-only file ops, no cloud features
 *   available    — SaaS responded; either signed-in or signed-out
 *
 * Probe is single-shot per session; re-fire on explicit auth events
 * (sign-in completes, sign-out clicked).
 */
import { BetterAuthIdentityProvider, type SessionResponse } from '@tweakcad/cloud-providers';

export type SaasUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
};

export type SaasState =
  | { kind: 'unknown' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'available'; signedIn: false }
  | { kind: 'available'; signedIn: true; user: SaasUser };

const PROBE_TIMEOUT_MS = 2_000;

let cachedProvider: BetterAuthIdentityProvider | null = null;
function provider(): BetterAuthIdentityProvider {
  if (cachedProvider) return cachedProvider;
  // Same-origin in prod; Vite proxy forwards to the SaaS API server in dev.
  cachedProvider = new BetterAuthIdentityProvider({ baseUrl: '' });
  return cachedProvider;
}

let cachedState: SaasState = { kind: 'unknown' };
let probePromise: Promise<SaasState> | null = null;
const listeners = new Set<(s: SaasState) => void>();

function notify(state: SaasState): void {
  cachedState = state;
  for (const fn of listeners) fn(state);
}

/**
 * Probe SaaS availability. Cached after first run — call `refreshSaasState`
 * to re-probe (e.g. after sign-in).
 */
export async function probeSaas(): Promise<SaasState> {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    try {
      const session = await withTimeout(provider().getSession(), PROBE_TIMEOUT_MS);
      const state = sessionToState(session);
      notify(state);
      return state;
    } catch (err) {
      const state: SaasState = {
        kind: 'unavailable',
        reason: (err as Error).message || 'probe failed',
      };
      notify(state);
      return state;
    } finally {
      // Clear the in-flight promise so refreshSaasState() can re-fire.
      probePromise = null;
    }
  })();
  return probePromise;
}

/** Force a re-probe (call after sign-in or sign-out succeeds). */
export async function refreshSaasState(): Promise<SaasState> {
  probePromise = null;
  return probeSaas();
}

/** Synchronous snapshot of the current state. */
export function getSaasState(): SaasState {
  return cachedState;
}

/** Subscribe to state changes. Fires immediately with the current state. */
export function onSaasStateChange(fn: (s: SaasState) => void): () => void {
  listeners.add(fn);
  fn(cachedState);
  return () => listeners.delete(fn);
}

function sessionToState(session: SessionResponse): SaasState {
  if (!session?.user) return { kind: 'available', signedIn: false };
  return {
    kind: 'available',
    signedIn: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timeout (${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// --- Convenience predicates ---

/**
 * Whether a backend is reachable — the gate for every SaaS-only surface.
 *
 * Standalone builds must not merely *fail* at SaaS features, they must not
 * offer them: a button that only ever produces a network error is worse than
 * no button. Behind this today are the components catalog (panel + Ctrl+I),
 * the AI assistant, and the account chip.
 *
 * `available` rather than `signedIn` on purpose for the catalog: the published
 * component list is public, so browsing and inserting work signed-out. Features
 * that genuinely need an account use {@link isSignedIn} instead.
 *
 * Accepts `undefined` because the UI holds the state before the probe
 * resolves; the alternative is every call site writing
 * `saas && isSaasAvailable(saas)`, which is how the inline checks this
 * replaces got there in the first place.
 */
export function isSaasAvailable(s: SaasState | undefined): boolean {
  return s?.kind === 'available';
}
export function isSignedIn(s: SaasState): s is { kind: 'available'; signedIn: true; user: SaasUser } {
  return s.kind === 'available' && s.signedIn;
}

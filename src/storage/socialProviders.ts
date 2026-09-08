/**
 * Social sign-in provider list for the CAD app.
 *
 * Kept deliberately separate from `saasState.ts` rather than folded into the
 * boot probe. The reasoning:
 *
 * The provider list is only meaningful in ONE of `SaasState`'s four states —
 * `available` + `signedIn: false`, the only state in which the sign-in modal
 * ever opens. In `unavailable` (standalone, no backend) there is no login at
 * all; when signed in the modal never opens; `unknown` renders nothing. So
 * fetching it at boot alongside the session probe would add a second failure
 * mode with nothing to gain — you'd have to invent an "available but providers
 * unknown" state to describe a session probe that succeeded while the provider
 * fetch timed out.
 *
 * Instead the fetch is TRIGGERED BY the probe's result (see `App.tsx`): it
 * fires only once the probe lands on signed-out-and-available. Consequences:
 *
 *   - Standalone builds never issue the request at all, which is the whole
 *     point of having an availability probe.
 *   - A failed fetch degrades to "no social buttons" — the pre-existing
 *     email/password modal — instead of becoming a new error state.
 *   - `SaasState` stays a clean four-state union.
 *
 * Timing works out because the user has to notice the toolbar and open the
 * modal before the list is needed, which is far longer than the request takes.
 */
import { BetterAuthIdentityProvider, type SocialProvider } from '@tweakcad/cloud-providers';

export type { SocialProvider };

let cachedProvider: BetterAuthIdentityProvider | null = null;
function provider(): BetterAuthIdentityProvider {
  if (cachedProvider) return cachedProvider;
  // Same-origin in prod; the Vite proxy forwards /api/v1 in dev.
  cachedProvider = new BetterAuthIdentityProvider({ baseUrl: '' });
  return cachedProvider;
}

let cached: SocialProvider[] = [];
let inFlight: Promise<SocialProvider[]> | null = null;
const listeners = new Set<(p: SocialProvider[]) => void>();

/**
 * Fetch the provider list once and cache it. Safe to call repeatedly —
 * concurrent calls share the in-flight request, and a completed fetch is not
 * re-issued. Never rejects; see `listSocialProviders`.
 */
export async function loadSocialProviders(): Promise<SocialProvider[]> {
  if (cached.length > 0) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const items = await provider().listSocialProviders();
      cached = items;
      for (const fn of listeners) fn(items);
      return items;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Synchronous snapshot — empty until `loadSocialProviders()` resolves. */
export function getSocialProviders(): SocialProvider[] {
  return cached;
}

/** Subscribe to the list arriving. Fires immediately with the current value. */
export function onSocialProvidersChange(fn: (p: SocialProvider[]) => void): () => void {
  listeners.add(fn);
  fn(cached);
  return () => listeners.delete(fn);
}

/** Drop the cache so the next `loadSocialProviders()` re-fetches. */
export function resetSocialProviders(): void {
  cached = [];
  inFlight = null;
  for (const fn of listeners) fn(cached);
}

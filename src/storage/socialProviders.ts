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
import { BetterAuthIdentityProvider, type SocialCaptcha, type SocialProvider } from '@tweakcad/cloud-providers';

export type { SocialCaptcha, SocialProvider };

let cachedProvider: BetterAuthIdentityProvider | null = null;
function provider(): BetterAuthIdentityProvider {
  if (cachedProvider) return cachedProvider;
  // Same-origin in prod; the Vite proxy forwards /api/v1 in dev.
  cachedProvider = new BetterAuthIdentityProvider({ baseUrl: '' });
  return cachedProvider;
}

const NO_CAPTCHA: SocialCaptcha = { required: false, siteKey: '' };

let cached: SocialProvider[] = [];
let cachedCaptcha: SocialCaptcha = NO_CAPTCHA;
let inFlight: Promise<SocialProvider[]> | null = null;
const listeners = new Set<(p: SocialProvider[]) => void>();

/**
 * Fetch the provider list and cache it. Safe to call repeatedly —
 * concurrent calls share the in-flight request, and a completed fetch is not
 * re-issued unless `force` is set. Never rejects; see `getAuthConfig`.
 *
 * The captcha requirement rides along on the same response and is refreshed
 * on every actual fetch, including the forced ones — see `refreshAuthConfig`
 * for why that matters.
 */
export async function loadSocialProviders(force = false): Promise<SocialProvider[]> {
  if (!force && cached.length > 0) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { providers, captcha } = await provider().getAuthConfig();
      cached = providers;
      cachedCaptcha = captcha;
      for (const fn of listeners) fn(providers);
      return providers;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Re-read the config, ignoring the cache.
 *
 * Called when the sign-in modal opens. The provider list is effectively
 * static, but the captcha switch is an admin setting that can be flipped
 * while an editor tab sits open for hours — and a tab holding a stale "not
 * required" posts a sign-in with no token and gets a refusal the user can do
 * nothing about. One small request per modal open is the cheaper side of
 * that trade.
 */
export async function refreshAuthConfig(): Promise<void> {
  await loadSocialProviders(true);
}

/** Synchronous snapshot — empty until `loadSocialProviders()` resolves. */
export function getSocialProviders(): SocialProvider[] {
  return cached;
}

/** Synchronous snapshot of the captcha requirement. */
export function getSocialCaptcha(): SocialCaptcha {
  return cachedCaptcha;
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
  cachedCaptcha = NO_CAPTCHA;
  inFlight = null;
  for (const fn of listeners) fn(cached);
}

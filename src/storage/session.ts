/**
 * Reads the current Better Auth session via the SaaS API.
 *
 * Uses BetterAuthIdentityProvider from @tweakcad/cloud-providers so the
 * concrete identity backend stays swappable.
 */
import { BetterAuthIdentityProvider, type SessionResponse } from '@tweakcad/cloud-providers';

let cachedProvider: BetterAuthIdentityProvider | null = null;

function provider(): BetterAuthIdentityProvider {
  if (cachedProvider) return cachedProvider;
  // Same-origin in prod; Vite proxy forwards to the API server in dev.
  cachedProvider = new BetterAuthIdentityProvider({ baseUrl: '' });
  return cachedProvider;
}

export async function getCurrentSession(): Promise<SessionResponse> {
  try {
    return await provider().getSession();
  } catch (err) {
    // Network errors / API down — treat as signed-out for boot purposes.
    console.warn('[session] failed to read session, treating as signed-out', err);
    return null;
  }
}

export type { SessionResponse };

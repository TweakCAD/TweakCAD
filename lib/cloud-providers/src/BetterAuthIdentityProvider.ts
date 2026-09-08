/**
 * Thin client wrapper that reads the current Better Auth session from the
 * SaaS API. The CAD app uses this to know whether to register the
 * CloudStorageProvider — it is NOT a full IdentityProvider with sign-in flows
 * (those flows live on the SaaS site at /login, /signup, /account).
 *
 * Sign-in from the CAD app opens the SaaS login modal in the parent window /
 * a new tab; this client just observes the resulting session.
 */
import { ApiClient } from '@tweakcad/api-client';
import { z } from 'zod';

const SessionResponse = z
  .object({
    session: z
      .object({
        id: z.string(),
        userId: z.string(),
        expiresAt: z.string(),
      })
      .nullable()
      .optional(),
    user: z
      .object({
        id: z.string(),
        email: z.string(),
        emailVerified: z.boolean(),
        name: z.string(),
        image: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .nullable();
export type SessionResponse = z.infer<typeof SessionResponse>;

/** One entry from `/api/v1/auth-providers` — id + display label, no secrets. */
const SocialProvider = z.object({
  id: z.string(),
  label: z.string(),
});
const SocialProviderList = z.array(SocialProvider);
export type SocialProvider = z.infer<typeof SocialProvider>;

export type IdentityConfig = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export class BetterAuthIdentityProvider {
  readonly id = 'better-auth' as const;
  readonly label = 'Better Auth';
  private api: ApiClient;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(config: IdentityConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.fetchImpl = config.fetch ?? fetch.bind(globalThis);
    this.api = new ApiClient({
      baseUrl: config.baseUrl,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  /** Returns the current session or null when signed out. */
  async getSession(): Promise<SessionResponse> {
    const res = await this.api.request(
      'GET',
      '/api/v1/auth/get-session',
      SessionResponse,
    );
    if (!res.ok) {
      if (res.error.code === 'unauthenticated') return null;
      throw new Error(`${res.error.code}: ${res.error.message}`);
    }
    return res.value;
  }

  async signOut(): Promise<void> {
    // Better Auth's sign-out endpoint requires Content-Type: application/json
    // AND a non-empty body — `{}` is the minimum. The api-client wrapper
    // doesn't send a body when none is supplied, so we hit the endpoint
    // directly here to keep the contract straightforward.
    await this.fetchImpl(`${this.baseUrl}/api/v1/auth/sign-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'include',
    });
  }

  /**
   * Sign in with email + password against Better Auth.
   *
   * Bypasses the typed `api.request` wrapper because Better Auth's error
   * shape doesn't match our `ApiError` schema — its responses use
   * `{ message, code }` directly on failure. Doing this as a raw fetch
   * keeps the surface small and lets us shape the result cleanly for the
   * caller.
   */
  async signInEmail(input: {
    email: string;
    password: string;
  }): Promise<{ ok: true } | { ok: false; message: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v1/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        credentials: 'include',
      });
    } catch (err) {
      return { ok: false, message: (err as Error).message || 'Network error' };
    }
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as
      | { message?: string }
      | null;
    return {
      ok: false,
      message: body?.message ?? `Sign-in failed (${res.status})`,
    };
  }

  /**
   * Which social providers the SaaS deployment has credentials for.
   *
   * The CAD app is a static bundle with no server env, so it can't read
   * `GOOGLE_CLIENT_ID` the way the site's server components do — it has to
   * ask. Served by `/api/v1/auth-providers` (deliberately outside Better
   * Auth's `/api/v1/auth/` catch-all namespace).
   *
   * Returns `[]` rather than throwing when the request fails: an empty list
   * means "offer no social buttons", which is exactly the right degradation.
   * Callers must not treat this as an availability signal — that's
   * `probeSaas()`'s job.
   */
  async listSocialProviders(): Promise<SocialProvider[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/v1/auth-providers`, {
        credentials: 'include',
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { items?: unknown };
      const parsed = SocialProviderList.safeParse(body.items);
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  /**
   * Begin a social sign-in. Asks Better Auth for the provider's authorization
   * URL and navigates there; the browser comes back to `callbackURL` with a
   * session cookie set.
   *
   * This NAVIGATES THE PAGE AWAY, so the caller must flush any pending work
   * first — the editor's autosave is debounced, not per-action.
   *
   * The result is a discriminated union rather than a message string the
   * caller pattern-matches on: navigation is asynchronous, so this still
   * resolves after `location.href` is set, and the caller has to tell "the
   * redirect is under way, keep the spinner" from "it failed, show the
   * error". Encoding that as a sentinel message couples the two files
   * through prose — one reworded string and the modal starts rendering
   * "Redirecting" as an error.
   */
  async signInSocial(input: {
    provider: string;
    callbackURL: string;
  }): Promise<{ redirected: true } | { redirected: false; message: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/v1/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        credentials: 'include',
      });
    } catch (err) {
      return {
        redirected: false,
        message: (err as Error).message || 'Network error',
      };
    }
    const body = (await res.json().catch(() => null)) as
      | { url?: string; message?: string }
      | null;
    if (res.ok && body?.url) {
      window.location.href = body.url;
      return { redirected: true };
    }
    return {
      redirected: false,
      message: body?.message ?? `Sign-in failed (${res.status})`,
    };
  }
}

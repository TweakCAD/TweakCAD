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
}

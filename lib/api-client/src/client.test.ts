import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiClient } from './client.ts';

/** A client whose every request gets this one answer. */
function answering(body: string, init: ResponseInit): ApiClient {
  return new ApiClient({ baseUrl: 'http://host', fetch: () => Promise.resolve(new Response(body, init)) });
}

const Session = z.object({ user: z.object({ id: z.string() }).nullable() }).nullable();

describe('answers that are not the API', () => {
  it('refuses a page served in place of the API, though its status is 200', async () => {
    const page = answering('<!doctype html><title>App</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const result = await page.request('GET', '/api/v1/auth/get-session', Session);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe('Not an API response');
  });

  it('reads JSON null as the answer it is', async () => {
    const api = answering('null', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await api.request('GET', '/api/v1/auth/get-session', Session)).toEqual({ ok: true, value: null });
  });

  it('takes an empty 204 as success', async () => {
    const api = new ApiClient({
      baseUrl: 'http://host',
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    const result = await api.request('DELETE', '/api/v1/projects/p', z.null());
    expect(result.ok).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiClient } from './client.ts';

/** A client whose every request gets this one answer. */
function answering(body: string, init: ResponseInit): ApiClient {
  return new ApiClient({ baseUrl: 'http://host', fetch: () => Promise.resolve(new Response(body, init)) });
}

const Session = z.object({ user: z.object({ id: z.string() }).nullable() }).nullable();

describe('request bodies', () => {
  /** A client that records what one request sent. */
  function recording() {
    const seen: { body?: Uint8Array; contentType?: string | null } = {};
    const api = new ApiClient({
      baseUrl: 'http://host',
      fetch: async (_url, init) => {
        const request = new Request('http://host/', {
          method: 'PUT',
          body: init?.body ?? null,
          headers: init?.headers,
        });
        seen.body = new Uint8Array(await request.arrayBuffer());
        seen.contentType = request.headers.get('content-type');
        return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    return { api, seen };
  }
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 123, 125]);

  it('sends a blob as its bytes, with its type', async () => {
    const { api, seen } = recording();
    await api.request('PUT', '/x', z.null(), new Blob([bytes], { type: 'model/stl' }));
    expect(seen.body).toEqual(bytes);
    expect(seen.contentType).toBe('model/stl');
  });

  it('sends typed arrays and array buffers as their bytes', async () => {
    for (const body of [bytes, bytes.buffer]) {
      const { api, seen } = recording();
      await api.request('PUT', '/x', z.null(), body);
      expect(seen.body).toEqual(bytes);
      expect(seen.contentType).toBe('application/octet-stream');
    }
  });

  it('sends anything else as JSON', async () => {
    const { api, seen } = recording();
    await api.request('PUT', '/x', z.null(), { name: 'a' });
    expect(new TextDecoder().decode(seen.body)).toBe('{"name":"a"}');
    expect(seen.contentType).toBe('application/json');
  });
});

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

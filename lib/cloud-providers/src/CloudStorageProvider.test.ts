import { describe, expect, it } from 'vitest';
import { CloudStorageProvider } from './CloudStorageProvider.ts';

describe('putReference', () => {
  it('sends the imported file as its bytes', async () => {
    let sent: { body: Uint8Array; contentType: string | null } | undefined;
    const provider = new CloudStorageProvider({
      baseUrl: 'http://host',
      fetch: async (_url, init) => {
        const request = new Request('http://host/', {
          method: 'PUT',
          body: init?.body ?? null,
          headers: init?.headers,
        });
        sent = { body: new Uint8Array(await request.arrayBuffer()), contentType: request.headers.get('content-type') };
        return new Response(JSON.stringify({ stored: true, bytes: sent.body.byteLength }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 123, 125]);
    await provider.putReference('proj_a', 'hash', bytes);
    expect(sent?.body).toEqual(bytes);
    expect(sent?.contentType).toBe('application/octet-stream');
  });
});

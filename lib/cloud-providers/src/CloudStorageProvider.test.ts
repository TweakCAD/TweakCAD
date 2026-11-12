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

describe('private reads', () => {
  /** A provider whose site answers every request with `respond`, recording what was asked. */
  function siteAnswering(respond: () => Response) {
    const asked: { url: string; credentials: RequestCredentials | undefined }[] = [];
    const provider = new CloudStorageProvider({
      baseUrl: 'http://site',
      fetch: (url, init) => {
        asked.push({ url: String(url), credentials: init?.credentials });
        return Promise.resolve(respond());
      },
    });
    return { provider, asked };
  }

  it('reads a stored file through the site, signed in', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const { provider, asked } = siteAnswering(() => new Response(bytes, { status: 200 }));
    expect(await provider.loadReference('proj_a', 'abc')).toEqual(bytes);
    expect(asked).toEqual([{ url: 'http://site/api/v1/projects/proj_a/references/abc', credentials: 'include' }]);
  });

  it('reads a revision through the site, signed in', async () => {
    const { provider, asked } = siteAnswering(() => new Response('{"format":"x"}', { status: 200 }));
    expect(await provider.loadRevision('proj_a', 'rev_1')).toBe('{"format":"x"}');
    expect(asked).toEqual([{ url: 'http://site/api/v1/projects/proj_a/revisions/rev_1', credentials: 'include' }]);
  });

  it("passes on the site's refusal", async () => {
    const { provider } = siteAnswering(
      () =>
        new Response(
          JSON.stringify({ code: 'not_found', message: 'Reference not found.', retryable: false, requestId: 'req_1' }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    await expect(provider.loadReference('proj_a', 'abc')).rejects.toThrow('Reference not found.');
  });
});

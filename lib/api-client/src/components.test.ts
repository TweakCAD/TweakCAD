/**
 * Unit tests for the component catalog DAL helpers.
 * Mocks fetch to verify URL composition + response parsing.
 */

import { describe, expect, it } from 'vitest';
import { ApiClient } from './client.ts';
import { listComponents, getComponentBySlug } from './components.ts';

type MockResponse = {
  status?: number;
  json: unknown;
  headers?: Record<string, string>;
};

function mockFetch(byUrl: Record<string, MockResponse>): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, init });
    const match = byUrl[urlStr];
    if (!match) {
      throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
    }
    const headers = new Headers({
      'content-type': 'application/json',
      ...(match.headers ?? {}),
    });
    const status = match.status ?? 200;
    return new Response(JSON.stringify(match.json), { status, headers });
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

const baseSummary = {
  id: 'proj_1',
  slug: 'iso-4017-hex-bolt-m3',
  name: 'M3 hex bolt — ISO 4017',
  description: 'Hex bolt',
  tags: ['bolt'],
  categoryId: null,
  categoryName: null,
  thumbnailUrl: null,
  ownerUsername: null,
  ownerDisplayName: null,
  ownerAvatarUrl: null,
  likeCount: 0,
  viewCount: 0,
  updatedAt: '2026-05-01T00:00:00.000Z',
  standard: 'ISO 4017',
};

describe('listComponents', () => {
  it('hits /api/v1/components with no params by default', async () => {
    const { fetch, calls } = mockFetch({
      'https://api.example.com/api/v1/components': {
        json: { items: [], nextCursor: null },
      },
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.com', fetch });

    const result = await listComponents(client);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/components');
    expect(calls[0]!.init?.method).toBe('GET');
  });

  it('encodes search and limit into the query string', async () => {
    const url = 'https://api.example.com/api/v1/components?limit=10&q=M5';
    const { fetch, calls } = mockFetch({
      [url]: { json: { items: [baseSummary], nextCursor: null } },
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.com', fetch });

    const result = await listComponents(client, { search: 'M5', limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items[0]!.slug).toBe('iso-4017-hex-bolt-m3');
    }
    expect(calls[0]!.url).toBe(url);
  });

  it('passes cursor and category through', async () => {
    const url =
      'https://api.example.com/api/v1/components?cursor=2026-05-01T00%3A00%3A00.000Z&category=cat_fasteners';
    const { fetch } = mockFetch({
      [url]: { json: { items: [], nextCursor: null } },
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.com', fetch });

    const result = await listComponents(client, {
      cursor: '2026-05-01T00:00:00.000Z',
      categoryId: 'cat_fasteners',
    });

    expect(result.ok).toBe(true);
  });

  it('surfaces schema mismatches as a structured error', async () => {
    const { fetch } = mockFetch({
      'https://api.example.com/api/v1/components': {
        json: { items: 'not-an-array' },
      },
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.com', fetch });

    const result = await listComponents(client);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
    }
  });
});

describe('getComponentBySlug', () => {
  it('GETs /api/v1/components/[slug] and parses the detail response', async () => {
    const detail = {
      ...baseSummary,
      status: 'published',
      manifest: {
        schemaVersion: 1,
        standard: 'ISO 4017',
        parameters: [
          { name: 'length', label: 'Length', type: 'number', default: 20, range: [6, 120] },
        ],
        installHint: 'Snaps head-down onto a face.',
      },
      reviewedAt: null,
      createdAt: '2026-04-01T00:00:00.000Z',
    };
    const { fetch, calls } = mockFetch({
      'https://api.example.com/api/v1/components/iso-4017-hex-bolt-m3': { json: detail },
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.com', fetch });

    const result = await getComponentBySlug(client, 'iso-4017-hex-bolt-m3');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.parameters[0]!.name).toBe('length');
      expect(result.value.manifest.installHint).toBe('Snaps head-down onto a face.');
    }
    expect(calls[0]!.url).toBe(
      'https://api.example.com/api/v1/components/iso-4017-hex-bolt-m3',
    );
  });

  it('URL-encodes slugs that contain special characters', async () => {
    const { fetch, calls } = mockFetch({
      'https://api.example.com/api/v1/components/m3%20bolt': {
        json: {
          ...baseSummary,
          status: 'published',
          manifest: { schemaVersion: 1, parameters: [] },
          reviewedAt: null,
          createdAt: '2026-04-01T00:00:00.000Z',
        },
      },
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.com', fetch });

    await getComponentBySlug(client, 'm3 bolt');

    expect(calls[0]!.url).toBe('https://api.example.com/api/v1/components/m3%20bolt');
  });

  it('returns not_found for a 404 response', async () => {
    const { fetch } = mockFetch({
      'https://api.example.com/api/v1/components/missing': {
        status: 404,
        json: {
          code: 'not_found',
          message: 'Component not found.',
          retryable: false,
          requestId: 'req_1',
        },
      },
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.com', fetch });

    const result = await getComponentBySlug(client, 'missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });
});

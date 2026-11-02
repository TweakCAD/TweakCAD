import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAvailableModels, pickModelId, type AvailableModel } from './chatClient.ts';

const sonnet: AvailableModel = {
  id: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
  costTier: 'standard',
  supportsTools: true,
  isDefault: true,
};
const opus: AvailableModel = { ...sonnet, id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', costTier: 'premium', isDefault: false };

function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listAvailableModels', () => {
  it('returns the models the site reports', async () => {
    stubFetch(async () => Response.json({ models: [sonnet, opus] }));
    expect(await listAvailableModels()).toEqual([sonnet, opus]);
  });

  it('is empty when the site reports no models', async () => {
    stubFetch(async () => Response.json({ models: [] }));
    expect(await listAvailableModels()).toEqual([]);
  });

  it('is empty when the site cannot be reached', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await listAvailableModels()).toEqual([]);
  });

  it('is empty on an error status or a non-JSON body', async () => {
    stubFetch(async () => new Response('Not found', { status: 404 }));
    expect(await listAvailableModels()).toEqual([]);
    stubFetch(async () => new Response('<html></html>', { status: 200 }));
    expect(await listAvailableModels()).toEqual([]);
  });

  it('drops entries that are not models', async () => {
    stubFetch(async () => Response.json({ models: [sonnet, { id: 'x' }, null, 'gpt'] }));
    expect(await listAvailableModels()).toEqual([sonnet]);
  });
});

describe('pickModelId', () => {
  it('keeps the saved pick while the site still offers it', () => {
    expect(pickModelId([sonnet, opus], 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('falls back to the default when the saved pick is gone', () => {
    expect(pickModelId([opus, sonnet], 'claude-sonnet-4-7')).toBe('claude-sonnet-5-5');
    expect(pickModelId([opus, sonnet], null)).toBe('claude-sonnet-5-5');
  });

  it('falls back to the first model when none is flagged default', () => {
    expect(pickModelId([{ ...opus }, { ...sonnet, isDefault: false }], null)).toBe('claude-opus-5-5');
  });

  it('is null with no models', () => {
    expect(pickModelId([], 'claude-opus-5-5')).toBeNull();
  });
});

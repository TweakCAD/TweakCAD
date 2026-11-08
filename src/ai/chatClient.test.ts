import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listAvailableModels,
  pickModelId,
  streamChat,
  streamEvent,
  type AvailableModel,
  type ChatStreamEvent,
} from './chatClient.ts';

const sonnet: AvailableModel = {
  id: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
  costTier: 'standard',
  supportsTools: true,
  isDefault: true,
};
const opus: AvailableModel = {
  ...sonnet,
  id: 'claude-opus-5-5',
  displayName: 'Claude Opus 5.5',
  costTier: 'premium',
  isDefault: false,
};

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

describe('streamChat', () => {
  /** A response whose body arrives in `chunks`. */
  function streamed(chunks: string[]): Response {
    const bytes = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of chunks) c.enqueue(bytes.encode(chunk));
          c.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  async function events(chunks: string[]): Promise<ChatStreamEvent[]> {
    stubFetch(async () => streamed(chunks));
    const out: ChatStreamEvent[] = [];
    for await (const e of streamChat({ messages: [] })) out.push(e);
    return out;
  }

  const text = { type: 'text', delta: 'Hi' };
  const done = { type: 'done', stopReason: 'end_turn' };

  it('reads events ended by LF, CRLF or CR line ends', async () => {
    for (const nl of ['\n', '\r\n', '\r']) {
      expect(await events([`data: ${JSON.stringify(text)}${nl}${nl}data: ${JSON.stringify(done)}${nl}${nl}`])).toEqual([
        text,
        done,
      ]);
    }
  });

  it('reads a CRLF split across chunks, data on several lines, and a last event with no blank line', async () => {
    const body = `: comment\r\nevent: x\r\ndata: ${JSON.stringify(text)}\r\n\r\ndata: {"type":\r\ndata: "done", "stopReason": "end_turn"}`;
    const blank = body.indexOf('\r\n\r\n');
    const chunks = [
      body.slice(0, blank + 1),
      body.slice(blank + 1, blank + 3),
      body.slice(blank + 3, body.length - 4),
      body.slice(body.length - 4),
    ];
    expect(chunks.join('')).toBe(body);
    expect(await events(chunks)).toEqual([text, done]);
  });
});

describe('stream events', () => {
  it('keeps an event of a known shape', () => {
    expect(streamEvent('{"type":"text","delta":"hi"}')).toEqual({ type: 'text', delta: 'hi' });
    expect(streamEvent('{"type":"done","stopReason":"end_turn"}')).toEqual({ type: 'done', stopReason: 'end_turn' });
  });

  it('drops what is not JSON or not the shape of an event', () => {
    const bad = [
      '<html>',
      '{"type":"text"}',
      '{"type":"text","delta":5}',
      '{"type":"nope"}',
      'null',
      '[]',
      '{"type":"done","stopReason":"later"}',
    ];
    for (const raw of bad) expect(streamEvent(raw), raw).toBeNull();
  });
});

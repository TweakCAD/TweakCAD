import { describe, expect, it } from 'vitest';
import { runAgentTurn, type ChatTurnEvent } from './agentTurn';
import type { ChatRequest, ChatStreamEvent, NormalizedMessage } from './chatClient';
import type { AiContext } from './context';

/** A stream that answers each round with the next script, recording the conversation it was sent. */
function scripted(rounds: ChatStreamEvent[][]) {
  const sent: NormalizedMessage[][] = [];
  const stream = async function* (req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    sent.push(structuredClone(req.messages));
    for (const e of rounds[sent.length - 1] ?? [{ type: 'done', stopReason: 'end_turn' }]) yield e;
  };
  return { stream, sent };
}

function log() {
  const entries: string[] = [];
  return {
    entries,
    transactions: { begin: (l: string) => entries.push(`begin ${l}`), end: () => entries.push('end') },
  };
}

const ctx = {} as AiContext;

async function collect(events: AsyncIterable<ChatTurnEvent>): Promise<ChatTurnEvent[]> {
  const out: ChatTurnEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('a chat turn', () => {
  it('runs the tools a round asks for and sends their results in the next round', async () => {
    const { stream, sent } = scripted([
      [
        { type: 'meta', source: 'platform', model: 'm' },
        { type: 'text', delta: 'Reading the guide.' },
        { type: 'tool_call', id: 't1', name: 'cad_help', input: {} },
        { type: 'tool_call', id: 't2', name: 'begin_transaction', input: { label: 'Inner' } },
        { type: 'tool_call', id: 't3', name: 'no_such_tool', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'Done.' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const t = log();
    const events = await collect(
      runAgentTurn({
        text: 'Make a plate',
        history: [],
        modelId: null,
        signal: new AbortController().signal,
        ctx,
        stream,
        transactions: t.transactions,
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'tool_result',
      'text_delta',
      'done',
    ]);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([
      true,
      true,
      false,
    ]);

    // The second round carries the assistant's tool calls and a user message of results.
    const second = sent[1] as NormalizedMessage[];
    expect(second.at(-2)?.role).toBe('assistant');
    expect(second.at(-2)?.content.map((c) => c.type)).toEqual(['text', 'tool_use', 'tool_use', 'tool_use']);
    const results = second.at(-1)?.content as { type: string; content: unknown; isError?: boolean }[];
    expect(results.map((r) => r.type)).toEqual(['tool_result', 'tool_result', 'tool_result']);
    expect(String(results[0]?.content)).toContain('TweakCAD tools');
    expect(results[2]?.isError).toBe(true);

    // The model's group left open is closed first, then the turn's own.
    expect(t.entries).toEqual(['begin AI: Make a plate', 'begin Inner', 'end', 'end']);
  });

  it('ends on a provider error with nothing left open', async () => {
    const { stream } = scripted([
      [
        { type: 'meta', source: 'user', model: 'm' },
        { type: 'done', stopReason: 'error', error: { message: 'quota' } },
      ],
    ]);
    const t = log();
    const events = await collect(
      runAgentTurn({
        text: 'x',
        history: [],
        modelId: 'm',
        signal: new AbortController().signal,
        ctx,
        stream,
        transactions: t.transactions,
      }),
    );
    expect(events).toEqual([{ type: 'done', error: 'quota' }]);
    expect(t.entries).toEqual(['begin AI: x', 'end']);
  });

  it('stops when cancelled between rounds', async () => {
    const ac = new AbortController();
    const { stream } = scripted([
      [
        { type: 'meta', source: 'user', model: 'm' },
        { type: 'tool_call', id: 'a', name: 'cad_help', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
    ]);
    const t = log();
    const events: ChatTurnEvent[] = [];
    for await (const e of runAgentTurn({
      text: 'x',
      history: [],
      modelId: null,
      signal: ac.signal,
      ctx,
      stream,
      transactions: t.transactions,
    })) {
      events.push(e);
      if (e.type === 'tool_call') ac.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'done', error: 'Cancelled.' });
    expect(t.entries).toEqual(['begin AI: x', 'end']);
  });
});

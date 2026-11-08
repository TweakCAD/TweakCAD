import { describe, expect, it } from 'vitest';
import { CAD_TOOLS } from '@tweakcad/cad-tools';
import { runAgentTurn } from './agentTurn';
import type { ChatRequest, ChatStreamEvent } from './chatClient';
import { startSend, toolLine, type ChatMessage } from './ChatPanel';
import type { AiContext } from './context';

describe('the chat panel', () => {
  it('shows a screenshot as a captured view, and any other tool by name', () => {
    expect(CAD_TOOLS.map((t) => t.name)).toContain('view_screenshot');
    expect(toolLine('view_screenshot')).toBe('\n📷 captured view');
    expect(toolLine('measure')).toBe('\n· measure');
  });
});

describe('a send from the chat panel', () => {
  it('shows the new message and sends it to the model once', async () => {
    const message = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
      id,
      role,
      text,
      createdAt: 0,
    });
    const earlier = [message('1', 'user', 'Hello'), message('2', 'assistant', 'Hi')];
    const user = message('3', 'user', 'Add one box');
    const send = startSend(earlier, user, message('4', 'assistant', ''));
    expect(send.shown.map((m) => m.id)).toEqual(['1', '2', '3', '4']);

    let sent: ChatRequest['messages'] = [];
    const stream = async function* (req: ChatRequest): AsyncIterable<ChatStreamEvent> {
      sent = structuredClone(req.messages);
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const transactions = { begin: () => undefined, end: () => undefined };
    const turn = runAgentTurn({
      text: user.text,
      history: send.history,
      modelId: null,
      signal: new AbortController().signal,
      ctx: {} as AiContext,
      stream,
      transactions,
    });
    for await (const event of turn) expect(event.type).toBe('done');
    expect(sent.map((m) => [m.role, (m.content[0] as { text: string }).text])).toEqual([
      ['user', 'Hello'],
      ['assistant', 'Hi'],
      ['user', 'Add one box'],
    ]);
  });
});

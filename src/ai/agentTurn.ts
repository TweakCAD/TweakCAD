/**
 * One chat turn: possibly many model rounds, with the tools run here in
 * between.
 *
 * 1. The turn opens an undo group named after the user's request, so the
 *    whole reply is one undo step.
 * 2. Each round posts the conversation to the site's chat endpoint and reads
 *    the stream: text goes to the panel at once, tool calls are collected.
 * 3. When the round ends asking for tools, each call runs through the
 *    executor; the round's assistant message (its text and tool calls) and
 *    a user message of tool results extend the conversation, and the next
 *    round starts.
 * 4. When the model ends its turn, or on an error, a cancel or the round
 *    limit, the groups the model left open close, then the turn's own.
 */
import {
  streamChat,
  type ChatStreamEvent,
  type NormalizedContent,
  type NormalizedMessage,
  type ToolResultBlock,
} from './chatClient';
import type { AiContext } from './context';
import { storeTransactions, type Transactions } from './document';
import { executeTool } from './executor';
import { createTransactionBalance } from './transactions';
import { isToolImageValue } from './view';

/** Rounds one turn may take before it stops. */
export const MAX_ROUNDS = 20;

/** One transcript entry of the chat panel. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

/** What a turn tells the panel as it goes. */
export type ChatTurnEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; message?: string }
  | { type: 'done'; error?: string };

export interface AgentTurnArgs {
  text: string;
  /** The conversation before `text`; the turn sends `text` after it. */
  history: readonly ChatMessage[];
  modelId: string | null;
  signal: AbortSignal;
  ctx: AiContext;
  /** The stream of one round; the site's endpoint by default. */
  stream?: typeof streamChat;
  /** Where undo groups go; the editor's store by default. */
  transactions?: Transactions;
}

type StopReason = Extract<ChatStreamEvent, { type: 'done' }>['stopReason'];

export async function* runAgentTurn(args: AgentTurnArgs): AsyncIterable<ChatTurnEvent> {
  const stream = args.stream ?? streamChat;
  const transactions = args.transactions ?? storeTransactions(args.ctx);
  const label = `AI: ${args.text.slice(0, 60)}${args.text.length > 60 ? '…' : ''}`;
  let open = false;
  const balance = createTransactionBalance(transactions);
  const run = { ctx: args.ctx, transactions: balance.transactions };

  try {
    const messages: NormalizedMessage[] = args.history.map((m) => ({
      role: m.role,
      content: [{ type: 'text', text: m.text }],
    }));
    messages.push({ role: 'user', content: [{ type: 'text', text: args.text }] });

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const calls: { id: string; name: string; input: unknown }[] = [];
      const blocks: NormalizedContent[] = [];
      let text = '';
      let stop: StopReason = 'end_turn';
      let error: string | null = null;

      for await (const event of stream({ messages, modelId: args.modelId ?? undefined, signal: args.signal })) {
        if (event.type === 'meta') {
          // Opened on the first answer, so a refused request leaves no group behind.
          if (!open) {
            transactions.begin(label);
            open = true;
          }
        } else if (event.type === 'text') {
          text += event.delta;
          yield { type: 'text_delta', delta: event.delta };
        } else if (event.type === 'tool_call') {
          if (text.length > 0) {
            blocks.push({ type: 'text', text });
            text = '';
          }
          blocks.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input });
          calls.push({ id: event.id, name: event.name, input: event.input });
          yield { type: 'tool_call', id: event.id, name: event.name, input: event.input };
        } else if (event.type === 'done') {
          stop = event.stopReason;
          if (event.stopReason === 'error') error = event.error?.message ?? 'The model provider returned an error.';
          break;
        }
      }
      if (text.length > 0) blocks.push({ type: 'text', text });

      if (error !== null) {
        yield { type: 'done', error };
        return;
      }
      if (calls.length === 0 || stop === 'end_turn') {
        yield { type: 'done' };
        return;
      }

      messages.push({ role: 'assistant', content: blocks });
      const results: NormalizedContent[] = [];
      for (const call of calls) {
        if (args.signal.aborted) break;
        if (!open) {
          transactions.begin(label);
          open = true;
        }
        const result = await executeTool(call.name, call.input, run);
        if (result.ok) {
          results.push({ type: 'tool_result', toolUseId: call.id, content: contentOf(result.value) });
          yield { type: 'tool_result', id: call.id, ok: true };
        } else {
          const message = `${result.error.code}: ${result.error.message}`;
          results.push({ type: 'tool_result', toolUseId: call.id, content: message, isError: true });
          yield { type: 'tool_result', id: call.id, ok: false, message };
        }
      }
      if (args.signal.aborted) {
        yield { type: 'done', error: 'Cancelled.' };
        return;
      }
      messages.push({ role: 'user', content: results });
    }
    yield {
      type: 'done',
      error: `The assistant took more than ${MAX_ROUNDS} rounds without finishing; try a narrower request.`,
    };
  } catch (e) {
    yield { type: 'done', error: args.signal.aborted ? 'Cancelled.' : e instanceof Error ? e.message : String(e) };
  } finally {
    // The model's leftover groups first, so the turn's own close is the one that commits.
    balance.closeOpen();
    if (open) transactions.end();
  }
}

/** A tool's value as tool-result content: images as image blocks, text as is, the rest as JSON. */
export function contentOf(value: unknown): string | ToolResultBlock[] {
  if (isToolImageValue(value)) return [{ type: 'image', mimeType: value.mimeType, data: value.data }];
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

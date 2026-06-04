/**
 * Browser-side request loop for the chat panel.
 *
 * One human turn = potentially many model rounds. Pattern:
 *
 *   1. Open a CommandBus transaction labeled with the user's prompt so
 *      the entire turn collapses into ONE Ctrl-Z step.
 *   2. POST to /api/v1/ai/chat, stream events:
 *        - text deltas → yield to UI immediately
 *        - tool_calls   → buffer for this round
 *   3. On done.stopReason='tool_use':
 *        - execute each buffered tool_call via executeTool(host)
 *        - extend the conversation with one assistant message of
 *          tool_use blocks (the same the server emitted) + one user
 *          message of tool_result blocks
 *        - go back to step 2
 *   4. On done.stopReason='end_turn' (or error / max rounds):
 *        - close the transaction
 *        - emit a terminal `done` to the UI
 *
 * Safety bounds:
 *   - MAX_ROUNDS caps run-away loops.
 *   - The user can cancel; we abort the in-flight fetch + still close
 *     the transaction (we'd rather end up with an incomplete-but-undo'able
 *     turn than a leaked open transaction).
 */

import {
  executeTool,
  isToolImageValue,
  type ToolHost,
} from '@tweakcad/core/src/ai/toolExecutor.ts';
import {
  streamChat,
  type ChatStreamEvent,
  type NormalizedContent,
  type NormalizedMessage,
  type ToolResultBlock,
} from './chatClient.ts';
import type { ChatMessage, ChatTurnEvent } from '../components/ChatPanel.tsx';

/** Hard cap on rounds-per-human-turn. Beyond this we error out. */
const MAX_ROUNDS = 8;

export interface AgentTurnArgs {
  text: string;
  history: readonly ChatMessage[];
  modelId: string | null;
  signal: AbortSignal;
  host: ToolHost;
}

export async function* runAgentTurn(
  args: AgentTurnArgs,
): AsyncIterable<ChatTurnEvent> {
  const transactionLabel = `AI: ${args.text.slice(0, 60)}${args.text.length > 60 ? '…' : ''}`;
  let transactionOpen = false;

  try {
    // Build the conversation from the panel's flat history + the new
    // user message. Prior assistant turns carry only text — once the
    // panel persists tool_use/tool_result blocks per message (future
    // work) the conversion here becomes richer.
    const messages: NormalizedMessage[] = [];
    for (const m of args.history) {
      messages.push({ role: m.role, content: [{ type: 'text', text: m.text }] });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: args.text }] });

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Buffer the tool_calls emitted in this round. We collect them all
      // before executing because they're treated as one batch — text and
      // tool_call events can interleave but the execution order is
      // round-level, not interleaved.
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      let stopReason: ChatStreamEvent extends { type: 'done'; stopReason: infer R } ? R : never =
        'end_turn' as never;
      let errorMessage: string | null = null;
      const assistantBlocks: NormalizedContent[] = [];
      let pendingText = '';

      for await (const event of streamChat({
        messages,
        modelId: args.modelId ?? undefined,
        signal: args.signal,
      })) {
        if (event.type === 'meta') {
          // Open the transaction lazily on the first event of the first
          // round — we don't want to leak an open transaction if the
          // POST fails with a 401 before any work happens.
          if (!transactionOpen) {
            await args.host.beginTransaction(transactionLabel);
            transactionOpen = true;
          }
          continue;
        }
        if (event.type === 'text') {
          pendingText += event.delta;
          yield { type: 'text_delta', delta: event.delta };
        } else if (event.type === 'tool_call') {
          // Flush any accumulated text into the assistant message
          // first — tool_use blocks must come after their preceding
          // text in the message order.
          if (pendingText.length > 0) {
            assistantBlocks.push({ type: 'text', text: pendingText });
            pendingText = '';
          }
          assistantBlocks.push({
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          });
          toolCalls.push({ id: event.id, name: event.name, input: event.input });
          yield { type: 'tool_call', id: event.id, name: event.name, input: event.input };
        } else if (event.type === 'done') {
          stopReason = event.stopReason as typeof stopReason;
          if (event.stopReason === 'error') {
            errorMessage = event.error?.message ?? 'Provider returned an error.';
          }
          // Capture any trailing text from this round.
          if (pendingText.length > 0) {
            assistantBlocks.push({ type: 'text', text: pendingText });
            pendingText = '';
          }
          break;
        }
      }

      if (errorMessage !== null) {
        yield { type: 'done', error: errorMessage };
        return;
      }

      // No tool calls? The model is done — exit the loop.
      if (toolCalls.length === 0 || (stopReason as string) === 'end_turn') {
        yield { type: 'done' };
        return;
      }

      // Execute the tools. Collect their results into a user message
      // of tool_result blocks; the wire normalizer handles the
      // per-provider translation.
      messages.push({ role: 'assistant', content: assistantBlocks });

      const toolResults: NormalizedContent[] = [];
      for (const call of toolCalls) {
        if (args.signal.aborted) break;
        const result = await executeTool(call.name, call.input, args.host);
        if (result.ok) {
          toolResults.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: serializeToolValue(result.value),
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: `${result.error.code}: ${result.error.message}`,
            isError: true,
          });
        }
      }

      if (args.signal.aborted) {
        // User cancelled mid-turn. Don't post again; just close out.
        yield { type: 'done', error: 'Cancelled.' };
        return;
      }

      messages.push({ role: 'user', content: toolResults });

      if ((stopReason as string) === 'max_tokens') {
        // The model hit its output cap. Give it one more round to wrap
        // up — but don't carry on if it keeps hitting the cap.
        // Loop continues.
      }
    }

    // Hit the round cap. Treat as a soft error so the user sees what
    // happened without a leaked transaction.
    yield {
      type: 'done',
      error: `Agent loop exceeded ${MAX_ROUNDS} rounds without finishing. The assistant may be stuck — try a more focused prompt.`,
    };
  } catch (e) {
    if (args.signal.aborted) {
      // Cancellation propagates as a fetch abort error; surface the
      // canonical cancellation message rather than the raw cause.
      yield { type: 'done', error: 'Cancelled.' };
    } else {
      yield {
        type: 'done',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } finally {
    if (transactionOpen) {
      try {
        await args.host.endTransaction();
      } catch {
        // Closing a non-existent transaction is fatal at the
        // documentStore layer; swallow because we're already terminating.
      }
    }
  }
}

/**
 * Convert a tool's return value into the `tool_result.content` shape
 * the wire format expects. Most tools return JSON-ish objects which we
 * stringify; `view_screenshot` returns a `ToolImageValue` which we
 * forward as an image block so the model receives it as multi-modal
 * content. The per-provider translation (native image block vs. a
 * re-wrapped follow-up user message) happens at the provider boundary.
 */
function serializeToolValue(value: unknown): string | ToolResultBlock[] {
  if (isToolImageValue(value)) {
    return [
      { type: 'image', mimeType: value.mimeType, data: value.data },
    ];
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

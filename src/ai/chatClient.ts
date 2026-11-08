/**
 * Browser-side SSE client for the SaaS chat endpoint.
 *
 *   POST /api/v1/ai/chat  →  text/event-stream of provider events
 *
 * The server emits one event per line in the standard SSE shape:
 *   data: {"type":"text","delta":"..."}
 *
 * We parse the stream into typed `ChatStreamEvent`s so the chat panel
 * can render partial text as it arrives. Tool-call events are surfaced
 * too so the panel can show which tool was requested.
 *
 * Cancellation: each call takes an AbortSignal. Aborting fires the
 * underlying fetch's abort, which on the server side cancels the
 * provider stream (no further token spend).
 *
 * The SSE parsing here is intentionally inline (no `eventsource-parser`
 * dep) — the format is simple enough for a 30-line state machine.
 */
import { z } from 'zod';

// ---- Wire types — must match the SSE event shapes emitted by the
//      server's provider layer. Duplicated here so the web app doesn't
//      take a runtime dep on the server package. ----

export type ChatStreamEvent =
  | { type: 'meta'; source: 'user' | 'org' | 'platform' | 'env'; model: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'done';
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
      error?: { message: string; code?: string };
    };

/** The shape every stream event must have; an event that does not is dropped. */
const ChatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), source: z.enum(['user', 'org', 'platform', 'env']), model: z.string() }),
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('done'),
    stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'error']),
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadInputTokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
      })
      .optional(),
    error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
  }),
]);

/** A stream event's data, or null when it is not JSON or not the shape of an event. */
export function streamEvent(raw: string): ChatStreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ChatStreamEventSchema.safeParse(value);
  return parsed.success ? (parsed.data as ChatStreamEvent) : null;
}

export type ToolResultBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };

export type NormalizedContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      /**
       * String for JSON-shaped results; array of typed blocks when an
       * image is included (canonical case: `view_screenshot`).
       */
      content: string | ToolResultBlock[];
      isError?: boolean;
    };

export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: NormalizedContent[];
}

export interface ChatRequest {
  messages: NormalizedMessage[];
  /** Omit to let the server use the configured default model. */
  modelId?: string | undefined;
  maxOutputTokens?: number | undefined;
  /** Optional cancellation. Closing the panel mid-stream should abort. */
  signal?: AbortSignal;
}

/**
 * Stream chat events from the SaaS endpoint. Yields events until the
 * server emits `done` (or the fetch errors). Throws on non-2xx HTTP.
 */
export async function* streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
  const body: Record<string, unknown> = { messages: req.messages };
  if (req.modelId !== undefined) body['modelId'] = req.modelId;
  if (req.maxOutputTokens !== undefined) body['maxOutputTokens'] = req.maxOutputTokens;

  const fetchInit: RequestInit = {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    ...(req.signal ? { signal: req.signal } : {}),
  };

  const res = await fetch('/api/v1/ai/chat', fetchInit);

  if (!res.ok) {
    // Surface server errors with the same shape as a 'done' error event
    // so the caller has one code path.
    let message = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { message?: string };
      if (json.message) message = json.message;
    } catch {
      /* ignore */
    }
    yield {
      type: 'done',
      stopReason: 'error',
      error: { message, code: String(res.status) },
    };
    return;
  }

  if (!res.body) {
    yield {
      type: 'done',
      stopReason: 'error',
      error: { message: 'No response body; the SSE stream is empty.' },
    };
    return;
  }

  yield* parseSSEStream(res.body);
}

// ---- SSE parser ----

/**
 * Parse a Response body as Server-Sent Events. Yields the parsed
 * JSON payload of every event's `data:` lines as a `ChatStreamEvent`.
 *
 * Lines end in `\r\n`, `\n` or `\r`, and an empty line ends an event;
 * a `\r\n` split across two chunks is one line end. Fields other than
 * `data` (`event:`, `id:`, `retry:`, comments) are not used.
 */
async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SSEParser();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.finish(decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

/** The SSE line state machine: text in, the events it completes out. */
export class SSEParser {
  private buffer = '';
  private data: string[] = [];

  /** The events `text` completes. */
  push(text: string): ChatStreamEvent[] {
    this.buffer += text;
    const out: ChatStreamEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== '\n' && c !== '\r') continue;
      // A `\r` that ends the text may be the first half of `\r\n`: wait for the next chunk.
      if (c === '\r' && i === this.buffer.length - 1) break;
      this.line(this.buffer.slice(start, i), out);
      if (c === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** The events the end of the stream completes: a last event without a blank line after it. */
  finish(text = ''): ChatStreamEvent[] {
    const out = this.push(text);
    if (this.buffer.length > 0) this.line(this.buffer.replace(/\r$/, ''), out);
    this.buffer = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: ChatStreamEvent[]): void {
    if (line === '') {
      if (this.data.length === 0) return;
      const raw = this.data.join('\n');
      this.data = [];
      const event = streamEvent(raw);
      if (event) out.push(event);
      return;
    }
    // The spec allows one space after the colon.
    if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
  }
}

// ---- Helpers ----

export interface AvailableModel {
  id: string;
  displayName: string;
  costTier: 'cheap' | 'standard' | 'premium';
  supportsTools: boolean;
  isDefault: boolean;
}

/**
 * The models the site lets this caller chat with. An empty list means
 * no AI: the site has no provider key for the caller, or it can't be
 * reached. Never throws.
 */
export async function listAvailableModels(signal?: AbortSignal): Promise<AvailableModel[]> {
  try {
    const res = await fetch('/api/v1/ai/models', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: unknown };
    return Array.isArray(json.models) ? json.models.filter(isAvailableModel) : [];
  } catch {
    return [];
  }
}

function isAvailableModel(v: unknown): v is AvailableModel {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<AvailableModel>;
  return (
    typeof o.id === 'string' &&
    typeof o.displayName === 'string' &&
    (o.costTier === 'cheap' || o.costTier === 'standard' || o.costTier === 'premium') &&
    typeof o.supportsTools === 'boolean' &&
    typeof o.isDefault === 'boolean'
  );
}

/**
 * The model a chat turn runs on: the user's saved pick while the site
 * still offers it, otherwise the site's default, otherwise the first
 * listed model. null only when the list is empty.
 */
export function pickModelId(
  models: readonly Pick<AvailableModel, 'id' | 'isDefault'>[],
  preferredId: string | null,
): string | null {
  if (preferredId !== null && models.some((m) => m.id === preferredId)) return preferredId;
  return models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null;
}

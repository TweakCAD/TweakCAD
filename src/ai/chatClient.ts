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

export type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

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
 * JSON payload of every `data:` line as a `ChatStreamEvent`.
 *
 * The format is simple — lines separated by `\n`, events by `\n\n`,
 * `data:` prefix on each data line. We tolerate `\r\n` line endings
 * just in case a proxy normalizes them.
 */
async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete events: separated by a blank line (\n\n).
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const event = parseEventBlock(block);
        if (event) yield event;
      }
    }

    // Flush any trailing event without a final blank line.
    if (buffer.trim().length > 0) {
      const event = parseEventBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): ChatStreamEvent | null {
  const lines = block.split(/\r?\n/);
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // Spec allows a single space after the colon — strip it.
      dataParts.push(line.slice(5).replace(/^ /, ''));
    }
    // Ignore `event:`, `id:`, `retry:`, and comments — we don't use them.
  }
  if (dataParts.length === 0) return null;
  const raw = dataParts.join('\n');
  try {
    return JSON.parse(raw) as ChatStreamEvent;
  } catch {
    return null;
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

export async function listAvailableModels(): Promise<AvailableModel[]> {
  const res = await fetch('/api/v1/ai/models', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { models?: AvailableModel[] };
  return json.models ?? [];
}

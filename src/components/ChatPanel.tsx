/**
 * Right-side chat panel.
 *
 * Mirrors the ComponentsPanel layout so the two right-side drawers
 * feel like siblings rather than ad-hoc widgets:
 *
 *   ┌── header ── (Sparkles) AI assistant   [Clear] [×] ──┐
 *   │ transcript                                          │
 *   │   • user bubble                                     │
 *   │   • assistant bubble                                │
 *   │   …                                                 │
 *   ├── footer: <textarea> [Send]                         │
 *   └─────────────────────────────────────────────────────┘
 *
 * Gating (note: the panel is only rendered by Shell when SaaS is
 * actually available, so the unknown / unavailable branches are
 * defensive fallbacks — the wand button that toggles this panel is
 * hidden from MainAppBar in those states):
 *   - SaaS available + signed-out → Sign-in CTA in the body
 *   - SaaS available + signed-in  → full chat
 *
 * Persistence: messages are stored in localStorage under
 *   `tweakcad-chat/v1/<projectId>` so the conversation survives
 *   page reloads and tab restarts (per-project, so switching projects
 *   doesn't bleed history). "Clear chat" wipes that bucket.
 *
 * Streaming: `onSendMessage` is an async generator. The panel renders
 * an assistant bubble immediately and appends text deltas as they
 * arrive. Tool-call events are caught but not yet executed; the
 * tool loop wiring lands in a later milestone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wand2, X, Trash2, Send, ChevronDown } from 'lucide-react';
import type { SaasState } from '../storage/index.ts';

/**
 * One transcript entry. Kept JSON-clean so localStorage round-trips
 * without a custom serializer. `id` is a monotonic-ish UUID we
 * generate client-side — purely for React keys, not durable.
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** ms since epoch — shown in the bubble tooltip; not displayed inline. */
  createdAt: number;
}

/** Event yielded by the streaming `onSendMessage` generator. */
export type ChatTurnEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'done'; error?: string };

/** A model in the model dropdown. Shape matches the /api/v1/ai/models payload. */
export interface ChatModelOption {
  id: string;
  displayName: string;
  costTier: 'cheap' | 'standard' | 'premium';
  isDefault: boolean;
}

interface ChatPanelProps {
  /** Close handler — wires to the wand button toggle in MainAppBar. */
  onClose: () => void;
  /** SaaS availability — drives the gated views. */
  saas: SaasState | undefined;
  /** Open the sign-in modal when the signed-out CTA is clicked. */
  onRequestSignIn?: (() => void) | undefined;
  /**
   * Stable key used to scope persisted chat history. Pass the current
   * project's stable id (cloud project id or local doc id). When the
   * key changes the panel reloads history from the new bucket.
   */
  projectKey: string;
  /**
   * Streaming send. The returned async iterable yields text deltas as
   * they arrive from the model + a terminal `done` (with optional
   * error). Implementations should propagate the AbortSignal — closing
   * the panel mid-stream should cancel the upstream request.
   */
  onSendMessage: (
    text: string,
    history: readonly ChatMessage[],
    opts: { modelId: string | null; signal: AbortSignal },
  ) => AsyncIterable<ChatTurnEvent>;
  /**
   * Available models for the dropdown. Empty list = no dropdown shown
   * (the server picks its default). The panel persists the user's
   * choice in localStorage keyed by projectKey.
   */
  availableModels?: readonly ChatModelOption[] | undefined;
}

// ---- Persistence ----

const STORAGE_PREFIX = 'tweakcad-chat/v1/';
const MAX_PERSISTED_MESSAGES = 200;

function storageKeyFor(projectKey: string): string {
  return `${STORAGE_PREFIX}${projectKey}`;
}

function loadHistory(projectKey: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKeyFor(projectKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Be lenient — drop entries that don't look like messages rather
    // than nuking the whole transcript on a single bad row.
    return parsed.filter(isChatMessage);
  } catch {
    return [];
  }
}

function saveHistory(projectKey: string, messages: readonly ChatMessage[]): void {
  try {
    // Cap the persisted size — chats can grow unbounded; we never want
    // to blow the localStorage 5MB quota with a single conversation.
    const trimmed = messages.slice(-MAX_PERSISTED_MESSAGES);
    localStorage.setItem(storageKeyFor(projectKey), JSON.stringify(trimmed));
  } catch {
    // Quota exceeded or storage disabled — swallow; the in-memory state
    // is still authoritative for the current session.
  }
}

function isChatMessage(v: unknown): v is ChatMessage {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<ChatMessage>;
  return (
    typeof o.id === 'string' &&
    (o.role === 'user' || o.role === 'assistant') &&
    typeof o.text === 'string' &&
    typeof o.createdAt === 'number'
  );
}

function newId(): string {
  // crypto.randomUUID is widely available; fall back to a short random
  // string for ancient browsers / test envs without crypto.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `msg-${Math.random().toString(36).slice(2, 10)}`;
}

// ---- Component ----

/**
 * Where the user's preferred model picks gets stored. Per-project so
 * different projects can use different models (handy when a user has
 * a free-tier project they don't want to spend opus tokens on).
 */
const MODEL_PREF_STORAGE_PREFIX = 'tweakcad-chat-model/v1/';

function loadModelPref(projectKey: string): string | null {
  try {
    return localStorage.getItem(MODEL_PREF_STORAGE_PREFIX + projectKey);
  } catch {
    return null;
  }
}

function saveModelPref(projectKey: string, modelId: string | null): void {
  try {
    if (modelId === null) localStorage.removeItem(MODEL_PREF_STORAGE_PREFIX + projectKey);
    else localStorage.setItem(MODEL_PREF_STORAGE_PREFIX + projectKey, modelId);
  } catch {
    /* ignore quota */
  }
}

export function ChatPanel({
  onClose,
  saas,
  onRequestSignIn,
  projectKey,
  onSendMessage,
  availableModels,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory(projectKey));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(() => loadModelPref(projectKey));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reload from storage when the project changes (e.g. user opens a
  // different file). Avoids cross-project transcript bleed.
  useEffect(() => {
    setMessages(loadHistory(projectKey));
    setSelectedModelId(loadModelPref(projectKey));
    setError(null);
  }, [projectKey]);

  // Persist on any change.
  useEffect(() => {
    saveHistory(projectKey, messages);
  }, [projectKey, messages]);

  // Auto-scroll to the newest message whenever the transcript grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Cancel any in-flight request when the panel unmounts (user closes it).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const canChat = useMemo(() => {
    if (!saas) return false;
    if (saas.kind !== 'available') return false;
    return saas.signedIn === true;
  }, [saas]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !canChat) return;
    setError(null);

    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      text,
      createdAt: Date.now(),
    };
    const assistantMsgId = newId();
    // Create the assistant bubble immediately as an empty placeholder
    // so deltas can append into it during streaming.
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
    };

    const historySnapshot = [...messages, userMsg];
    setMessages([...historySnapshot, assistantMsg]);
    setInput('');
    setSending(true);

    const ac = new AbortController();
    abortRef.current = ac;

    let accumulated = '';
    let receivedAnyText = false;
    try {
      for await (const event of onSendMessage(text, historySnapshot, {
        modelId: selectedModelId,
        signal: ac.signal,
      })) {
        if (event.type === 'text_delta') {
          accumulated += event.delta;
          receivedAnyText = true;
          // Append the delta into the assistant message in-place.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, text: m.text + event.delta } : m,
            ),
          );
        } else if (event.type === 'tool_call') {
          // Show what the model just did, on its own line, so the user
          // sees its actions without being buried in tool I/O.
          // Compact: "· dispatch_command" rather than full args (args
          // can be long; the actual mutation is visible in the
          // viewport + undo stack anyway). Screenshot calls get a
          // little camera glyph for transparency — makes it obvious
          // when the model is "looking" at the viewport.
          const badge =
            event.name === 'view_screenshot'
              ? '\n📷 captured view'
              : `\n· ${event.name}`;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, text: m.text + badge } : m,
            ),
          );
        } else if (event.type === 'done') {
          if (event.error) setError(event.error);
          // If the stream ended without any text AND no error, surface
          // a benign hint so the bubble isn't empty.
          if (!receivedAnyText && !event.error) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, text: '(no response — try a more specific prompt)' }
                  : m,
              ),
            );
          }
          break;
        }
      }
    } catch (e) {
      if (ac.signal.aborted) {
        // User cancelled — drop the (potentially empty) placeholder.
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
    // Touch unused vars so eslint doesn't yell — `accumulated` is the
    // running total in case future code wants it for token counting.
    void accumulated;
  }, [canChat, input, messages, onSendMessage, selectedModelId, sending]);

  const handleClear = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  const handleModelChange = useCallback(
    (next: string | null) => {
      setSelectedModelId(next);
      saveModelPref(projectKey, next);
    },
    [projectKey],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline. Matches the
      // convention every chat UI on the planet uses.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>
          <Wand2 size={12} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          AI assistant
        </span>
        <div style={styles.headerActions}>
          <button
            type="button"
            style={styles.headerBtn}
            title="Clear chat history for this project"
            disabled={messages.length === 0}
            onClick={handleClear}
          >
            <Trash2 size={12} />
          </button>
          <button
            type="button"
            style={styles.headerBtn}
            title="Close AI assistant"
            onClick={onClose}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Body switches on SaaS gating; the chat transcript is mounted
          only when the user is signed-in so we don't render an input
          they can't use. The unknown / unavailable branches normally
          can't be reached because the wand toggle that opens this
          panel is hidden in those states — but render a benign
          placeholder anyway if something does get us here. */}
      {!saas || saas.kind !== 'available' ? (
        <div style={styles.statePlaceholder}>AI assistant unavailable.</div>
      ) : !saas.signedIn ? (
        <div style={styles.statePlaceholder}>
          <p style={styles.statePlaceholderTitle}>Sign in to use the AI assistant</p>
          <p style={styles.statePlaceholderBody}>
            The in-app assistant runs against your account's model quota. Local
            users with their own API key can use the MCP bridge from{' '}
            <strong>Settings → AI</strong> instead.
          </p>
          <button
            type="button"
            style={styles.signInBtn}
            onClick={() => onRequestSignIn?.()}
          >
            Sign in
          </button>
        </div>
      ) : (
        <>
          {availableModels && availableModels.length > 1 && (
            <ModelPicker
              models={availableModels}
              selectedId={selectedModelId}
              onChange={handleModelChange}
              disabled={sending}
            />
          )}
          <div ref={scrollRef} style={styles.transcript}>
            {messages.length === 0 ? (
              <div style={styles.emptyHint}>
                Ask the assistant to add a feature, change a parameter, or
                describe a part. Replies show up here.
              </div>
            ) : (
              messages.map((m) => <Bubble key={m.id} message={m} />)
            )}
            {sending && (
              <div style={styles.typingBubble} aria-live="polite">
                <span style={styles.typingDot} />
                <span style={styles.typingDot} />
                <span style={styles.typingDot} />
              </div>
            )}
            {error && (
              <div style={styles.errorBubble} role="alert">
                Couldn't send: {error}
              </div>
            )}
          </div>

          <div style={styles.composer}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the assistant…"
              rows={2}
              style={styles.input}
              disabled={sending}
            />
            <button
              type="button"
              style={{
                ...styles.sendBtn,
                opacity: sending || !input.trim() ? 0.5 : 1,
                cursor: sending || !input.trim() ? 'not-allowed' : 'pointer',
              }}
              disabled={sending || !input.trim()}
              onClick={() => void handleSend()}
              title="Send (Enter)"
            >
              <Send size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- ModelPicker ----

function ModelPicker({
  models,
  selectedId,
  onChange,
  disabled,
}: {
  models: readonly ChatModelOption[];
  /** null = use the server's default. */
  selectedId: string | null;
  onChange: (next: string | null) => void;
  disabled: boolean;
}) {
  // Default to the API-flagged default if the user hasn't picked one.
  const effectiveId = selectedId ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? '';

  return (
    <div style={styles.modelRow}>
      <label style={styles.modelLabel} htmlFor="chat-model-picker">
        Model
      </label>
      <div style={styles.modelSelectWrap}>
        <select
          id="chat-model-picker"
          value={effectiveId}
          disabled={disabled}
          onChange={(e) => {
            // Empty string means "use API default" — stored as null.
            onChange(e.target.value || null);
          }}
          style={styles.modelSelect}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
              {m.costTier === 'premium' ? ' · premium' : ''}
              {m.isDefault ? ' · default' : ''}
            </option>
          ))}
        </select>
        <ChevronDown size={12} style={styles.modelSelectChevron} aria-hidden="true" />
      </div>
    </div>
  );
}

// ---- Bubble ----

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div style={isUser ? styles.userRow : styles.assistantRow}>
      <div
        style={{
          ...styles.bubble,
          ...(isUser ? styles.userBubble : styles.assistantBubble),
        }}
        title={new Date(message.createdAt).toLocaleString()}
      >
        {message.text}
      </div>
    </div>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 320,
    minWidth: 260,
    background: '#fafafa',
    borderLeft: '1px solid #d8d8d8',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'inherit',
  },
  header: {
    padding: '8px 12px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: '#888',
    borderBottom: '1px solid #d8d8d8',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    display: 'inline-flex',
    alignItems: 'center',
  },
  headerActions: {
    display: 'flex',
    gap: 4,
  },
  headerBtn: {
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 3,
    color: '#777',
    cursor: 'pointer',
    padding: 0,
  },
  statePlaceholder: {
    padding: '20px 16px',
    color: '#666',
    fontSize: 12,
    lineHeight: 1.5,
  },
  statePlaceholderTitle: {
    fontSize: 13,
    fontWeight: 600,
    margin: '0 0 8px 0',
    color: '#222',
  },
  statePlaceholderBody: {
    margin: '0 0 12px 0',
  },
  signInBtn: {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 500,
    background: '#1a6fd1',
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  modelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    background: '#ffffff',
    borderBottom: '1px solid #e5e5e5',
    fontSize: 11,
  },
  modelLabel: {
    color: '#666',
    fontWeight: 500,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    fontSize: 10,
  },
  modelSelectWrap: {
    position: 'relative',
    flex: 1,
  },
  modelSelect: {
    width: '100%',
    appearance: 'none',
    border: '1px solid #d8d8d8',
    background: '#ffffff',
    color: '#222',
    fontSize: 12,
    fontFamily: 'inherit',
    padding: '4px 22px 4px 8px',
    borderRadius: 4,
    outline: 'none',
    cursor: 'pointer',
  },
  modelSelectChevron: {
    position: 'absolute',
    right: 6,
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#888',
    pointerEvents: 'none',
  },
  transcript: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  emptyHint: {
    color: '#999',
    fontSize: 12,
    lineHeight: 1.5,
    padding: '12px 4px',
    fontStyle: 'italic',
  },
  userRow: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  assistantRow: {
    display: 'flex',
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    padding: '8px 10px',
    borderRadius: 10,
    fontSize: 12,
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  userBubble: {
    background: '#1a6fd1',
    color: '#fff',
    borderBottomRightRadius: 2,
  },
  assistantBubble: {
    background: '#ffffff',
    color: '#222',
    border: '1px solid #e5e5e5',
    borderBottomLeftRadius: 2,
  },
  typingBubble: {
    alignSelf: 'flex-start',
    background: '#ffffff',
    border: '1px solid #e5e5e5',
    borderRadius: 10,
    padding: '6px 10px',
    display: 'inline-flex',
    gap: 4,
    alignItems: 'center',
  },
  typingDot: {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: '#aaa',
    display: 'inline-block',
  },
  errorBubble: {
    background: '#fee2e2',
    color: '#b91c1c',
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '6px 10px',
    fontSize: 12,
  },
  composer: {
    display: 'flex',
    gap: 6,
    padding: 8,
    borderTop: '1px solid #e5e5e5',
    background: '#ffffff',
  },
  input: {
    flex: 1,
    border: '1px solid #d8d8d8',
    borderRadius: 6,
    padding: '6px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    resize: 'none',
    outline: 'none',
    color: '#222',
    background: '#ffffff',
    minHeight: 36,
    maxHeight: 160,
  },
  sendBtn: {
    width: 32,
    height: 32,
    alignSelf: 'flex-end',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 6,
    background: '#1a6fd1',
    color: '#fff',
    padding: 0,
    transition: 'opacity 0.1s',
  },
};

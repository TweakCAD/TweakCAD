/**
 * Browser-side MCP bridge WebSocket client (pure relay).
 *
 * Talks to the local `tweakcad-mcp` bridge process (run via
 * `npx @tweakcad/mcp-bridge`). The bridge is a dumb transport: it forwards
 * each MCP tool call here, and THIS tab runs it against the live editor and
 * replies. On connect we advertise the tool catalogue so the bridge can
 * answer the MCP client's ListTools.
 *
 *   MCP client --(MCP stdio)--> bridge --(WebSocket)--> THIS CLIENT
 *                                        <-- result / hello --
 *
 * This is the SAME execution path the in-app chat uses (`agentLoop` →
 * `executeTool` → `createBrowserToolHost`); the bridge just supplies the
 * tool name + input from an external MCP client instead of the chat panel.
 *
 * Wire protocol matches the bridge's own protocol definition. We inline the
 * minimal shapes here rather than depend on that package — the bridge is an
 * optional tool the user installs separately, not a runtime dep of the app.
 *
 * Status state machine lives in `bridgeStatusStore.ts`. Activation:
 * `startBridgeClient(deps)` watches `appSettings` and opens/closes the WS as
 * `bridgeEnabled` / host / port change. Returns a `stop()` unsub.
 */

import type { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import type { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import type { StoreApi } from 'zustand/vanilla';
import type { ViewportState } from '@tweakcad/core/src/store/viewportStore.ts';
import { executeTool } from '@tweakcad/core/src/ai/toolExecutor.ts';
import { CAD_TOOLS } from '@tweakcad/cad-tools';
import {
  getAppSettings,
  subscribeAppSettings,
} from '../storage/appSettings.ts';
import { setBridgeStatus } from './bridgeStatusStore.ts';
import { getActiveViewport } from './viewportRegistry.ts';
import { createBrowserToolHost } from './browserToolHost.ts';
import { createTransactionBalance, type TransactionBalance } from './transactionBalance.ts';

// ---- Wire types (subset of the bridge's protocol definition) ----

/** Inbound: the bridge asks us to run a tool. */
type ExecuteToolRequest = { id: string; type: 'executeTool'; name: string; input: unknown };

/** Outbound: our reply with the tool result. */
type ToolResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string; field?: string } };

/** Outbound: advertise the tool catalogue on connect. */
type HelloEvent = {
  type: 'hello';
  tools: { name: string; description: string; inputSchema: unknown }[];
};

function isExecuteToolRequest(v: unknown): v is ExecuteToolRequest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { id?: unknown; type?: unknown; name?: unknown };
  return o.type === 'executeTool' && typeof o.id === 'string' && typeof o.name === 'string';
}

// ---- Reconnect backoff ----

/** Reconnect delays in ms. Caps at 30s after repeated failures. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

// ---- Client ----

export interface BridgeClientDeps {
  documentStore: DocumentStore;
  commandBus: CommandBus;
  /** Viewport store — source of truth for per-feature build results + meshes. */
  viewportStore: StoreApi<ViewportState>;
}

/**
 * Start watching settings + opening/closing the WS as the user toggles the
 * bridge. Returns a stop function for tests and HMR teardown. Idempotent.
 */
export function startBridgeClient(deps: BridgeClientDeps): () => void {
  let socket: WebSocket | null = null;
  /**
   * The undo transactions the external client opened over `socket`. Unlike a
   * chat turn, a bridge session has no end the client is guaranteed to reach:
   * it can open a transaction and then crash, be closed, or simply never send
   * `end_transaction`. Whatever it left open is closed when its connection
   * goes, so the editor's undo is not left disabled for the rest of the
   * session.
   */
  let socketBalance: TransactionBalance | null = null;

  function closeConnectionTransactions(balance: TransactionBalance): void {
    void balance.closeOpen(() => deps.commandBus.endTransaction());
  }
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  // The host+port we're CURRENTLY connecting to. If settings change to a
  // different URL we tear down and reopen.
  let currentUrl: string | null = null;

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function teardown(): void {
    clearReconnect();
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
    }
    if (socketBalance) {
      closeConnectionTransactions(socketBalance);
      socketBalance = null;
    }
    currentUrl = null;
  }

  /** The tool catalogue we advertise to the bridge (→ MCP ListTools). */
  function helloFrame(): HelloEvent {
    return {
      type: 'hello',
      tools: CAD_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  /** Open a new WS to (host, port). Sets up handlers + status updates. */
  function open(host: string, port: number): void {
    const url = `ws://${host}:${port}`;
    currentUrl = url;
    setBridgeStatus({ state: 'connecting', url });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setBridgeStatus({ state: 'error', url, message });
      scheduleReconnect();
      return;
    }
    socket = ws;
    const balance = createTransactionBalance();
    socketBalance = balance;

    ws.onopen = () => {
      reconnectAttempt = 0;
      setBridgeStatus({ state: 'connected', url });
      // Advertise the catalogue so the bridge can answer ListTools and
      // notify the MCP client (tools/list_changed).
      try { ws.send(JSON.stringify(helloFrame())); } catch { /* dying socket */ }
    };

    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
      handleFrame(data, ws, balance);
    };

    ws.onerror = () => {
      setBridgeStatus({ state: 'error', url, message: 'WebSocket error' });
    };

    ws.onclose = () => {
      socket = null;
      if (socketBalance === balance) socketBalance = null;
      // The client is gone; nothing will close what it opened.
      closeConnectionTransactions(balance);
      if (!stopped && currentUrl === url) scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delayIdx = Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[delayIdx]!;
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const settings = getAppSettings();
      if (settings.ai.bridgeEnabled) {
        open(settings.ai.bridgeHost, settings.ai.bridgePort);
      }
    }, delay);
  }

  function handleFrame(text: string, ws: WebSocket, balance: TransactionBalance): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // drop bad frames silently
    }
    if (!isExecuteToolRequest(parsed)) return;
    const req = parsed;
    runTool(req, balance)
      .then((response) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
      })
      .catch((e) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            id: req.id,
            ok: false,
            error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) },
          } satisfies ToolResponse));
        }
      });
  }

  /**
   * Run one tool against the live editor. Builds a fresh ToolHost per call
   * so it always sees the current viewport controller (which may mount after
   * the bridge connects).
   */
  async function runTool(req: ExecuteToolRequest, balance: TransactionBalance): Promise<ToolResponse> {
    const host = createBrowserToolHost({
      documentStore: deps.documentStore,
      commandBus: deps.commandBus,
      viewportStore: deps.viewportStore,
      viewportController: getActiveViewport(),
    });
    const result = await executeTool(req.name, req.input, balance.wrap(host));
    if (result.ok) {
      return { id: req.id, ok: true, result: result.value };
    }
    return {
      id: req.id,
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    };
  }

  // --- Settings watcher ---
  function applySettings(): void {
    if (stopped) return;
    const settings = getAppSettings();
    if (!settings.ai.bridgeEnabled) {
      if (socket || reconnectTimer !== null) teardown();
      setBridgeStatus({ state: 'disabled' });
      return;
    }
    const desiredUrl = `ws://${settings.ai.bridgeHost}:${settings.ai.bridgePort}`;
    if (currentUrl === desiredUrl && socket !== null) return; // already on it
    teardown();
    reconnectAttempt = 0;
    open(settings.ai.bridgeHost, settings.ai.bridgePort);
  }

  applySettings();
  const unsubSettings = subscribeAppSettings(applySettings);

  return function stop() {
    stopped = true;
    unsubSettings();
    teardown();
    setBridgeStatus({ state: 'disabled' });
  };
}

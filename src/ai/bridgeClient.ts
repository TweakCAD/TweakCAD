/**
 * The app's side of the local MCP bridge (`tweakcad-mcp`): a WebSocket to
 * the bridge, which relays MCP tool calls from an MCP client to this tab.
 * The tab runs each call through the same executor the in-app chat uses and
 * answers; on connect it advertises the catalogue, so the bridge can list the
 * tools to its client.
 *
 *   MCP client --(MCP stdio)--> bridge --(WebSocket)--> this tab
 *                                       <-- hello, results --
 *
 * The frames are the bridge's protocol; their shapes are written here, as
 * the bridge is a tool the user runs, not a dependency of the app. The
 * socket opens and closes as Settings, AI turns the bridge on and off or
 * changes its address, and reconnects with a backoff.
 */
import { CAD_TOOLS, CAD_TOOLS_CONTRACT } from '@tweakcad/cad-tools';
import { getAppSettings, subscribeAppSettings, type AppSettings } from '../storage/appSettings';
import { setBridgeStatus } from './bridgeStatusStore';
import type { AiContext } from './context';
import { storeTransactions } from './document';
import { executeTool } from './executor';
import { createTransactionBalance, type TransactionBalance } from './transactions';

/** Bridge to tab: run a tool. */
type ExecuteToolRequest = { id: string; type: 'executeTool'; name: string; input: unknown };

/** Tab to bridge: the result of a call. */
export type ToolResponse =
  { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };

/** Tab to bridge, on connect: the catalogue and its contract version. */
export type HelloEvent = {
  type: 'hello';
  contract: number;
  tools: { name: string; description: string; inputSchema: unknown }[];
};

function isExecuteToolRequest(v: unknown): v is ExecuteToolRequest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { id?: unknown; type?: unknown; name?: unknown };
  return o.type === 'executeTool' && typeof o.id === 'string' && typeof o.name === 'string';
}

export function helloFrame(): HelloEvent {
  return {
    type: 'hello',
    contract: CAD_TOOLS_CONTRACT,
    tools: CAD_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

/** Reconnect delays in milliseconds, the last repeated. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** The part of a WebSocket the client uses. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

const OPEN = 1;

export interface BridgeClientOptions {
  ctx: AiContext;
  /** Opens a socket; `WebSocket` by default. */
  connect?: (url: string) => BridgeSocket;
  settings?: { get: () => Readonly<AppSettings>; subscribe: (fn: (s: AppSettings) => void) => () => void };
}

/** One connection to the bridge: the undo groups its client has open, and whether it has closed. */
interface Connection {
  balance: TransactionBalance;
  closed: boolean;
}

/** Ends a connection: its calls still waiting are dropped and the undo groups its client left open are closed. */
function end(c: Connection): void {
  c.closed = true;
  c.balance.closeOpen();
}

/** Follows the settings and keeps the socket open while the bridge is on. Returns the stop function. */
export function startBridgeClient(o: BridgeClientOptions): () => void {
  const connect = o.connect ?? ((url: string) => new WebSocket(url) as unknown as BridgeSocket);
  const settings = o.settings ?? { get: getAppSettings, subscribe: subscribeAppSettings };
  let socket: BridgeSocket | null = null;
  // The open connection: the undo groups its client opened (it may disconnect without closing them, and they are closed then).
  let connection: Connection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;
  let currentUrl: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const clearReconnect = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const teardown = () => {
    clearReconnect();
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      socket = null;
    }
    if (connection) end(connection);
    connection = null;
    currentUrl = null;
  };

  const open = (host: string, port: number) => {
    const url = `ws://${host}:${port}`;
    currentUrl = url;
    setBridgeStatus({ state: 'connecting', url });
    let ws: BridgeSocket;
    try {
      ws = connect(url);
    } catch (e) {
      setBridgeStatus({ state: 'error', url, message: e instanceof Error ? e.message : String(e) });
      scheduleReconnect();
      return;
    }
    socket = ws;
    const mine: Connection = { balance: createTransactionBalance(storeTransactions(o.ctx)), closed: false };
    connection = mine;
    ws.onopen = () => {
      attempt = 0;
      setBridgeStatus({ state: 'connected', url });
      try {
        ws.send(JSON.stringify(helloFrame()));
      } catch {
        // The socket is closing; onclose follows.
      }
    };
    ws.onmessage = (ev) => handleFrame(typeof ev.data === 'string' ? ev.data : String(ev.data), ws, mine);
    ws.onerror = () => setBridgeStatus({ state: 'error', url, message: 'WebSocket error' });
    ws.onclose = () => {
      socket = null;
      if (connection === mine) connection = null;
      end(mine);
      if (!stopped && currentUrl === url) scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] as number;
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const s = settings.get();
      if (s.ai.bridgeEnabled) open(s.ai.bridgeHost, s.ai.bridgePort);
    }, delay);
  };

  const handleFrame = (text: string, ws: BridgeSocket, mine: Connection) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!isExecuteToolRequest(parsed)) return;
    const req = parsed;
    // One call at a time, in the order they came: a call that edits waits for the one before it.
    // A call still waiting when its connection closes is dropped; one running then has its undo groups closed when it ends.
    queue = queue
      .then(async () => {
        if (mine.closed) return;
        const result = await executeTool(req.name, req.input, { ctx: o.ctx, transactions: mine.balance.transactions });
        if (mine.closed) {
          mine.balance.closeOpen();
          return;
        }
        const response: ToolResponse = result.ok
          ? { id: req.id, ok: true, result: result.value }
          : { id: req.id, ok: false, error: result.error };
        if (ws.readyState === OPEN) ws.send(JSON.stringify(response));
      })
      .catch(() => {
        // A result that cannot be sent (the socket closing, a value JSON cannot hold) is lost; the calls after it still run.
      });
  };

  const apply = () => {
    if (stopped) return;
    const s = settings.get();
    if (!s.ai.bridgeEnabled) {
      if (socket || reconnectTimer !== null) teardown();
      setBridgeStatus({ state: 'disabled' });
      return;
    }
    const url = `ws://${s.ai.bridgeHost}:${s.ai.bridgePort}`;
    if (currentUrl === url && socket !== null) return;
    teardown();
    attempt = 0;
    open(s.ai.bridgeHost, s.ai.bridgePort);
  };

  apply();
  const unsubscribe = settings.subscribe(apply);
  return () => {
    stopped = true;
    unsubscribe();
    teardown();
    setBridgeStatus({ state: 'disabled' });
  };
}

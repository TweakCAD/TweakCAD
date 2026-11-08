import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAD_TOOLS, CAD_TOOLS_CONTRACT } from '@tweakcad/cad-tools';
import type { AppSettings } from '../storage/appSettings';
import { getBridgeStatus } from './bridgeStatusStore';
import { startBridgeClient, type BridgeSocket } from './bridgeClient';
import type { AiContext } from './context';

class FakeSocket implements BridgeSocket {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function settings(on: boolean) {
  let current: AppSettings = { ai: { bridgeEnabled: on, bridgeHost: 'localhost', bridgePort: 7788 } };
  const listeners = new Set<(s: AppSettings) => void>();
  return {
    get: () => current,
    subscribe: (fn: (s: AppSettings) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next: Partial<AppSettings['ai']>) {
      current = { ai: { ...current.ai, ...next } };
      for (const fn of listeners) fn(current);
    },
  };
}

/** A context whose store records the undo groups the bridge's caller opens. */
function context() {
  const groups: string[] = [];
  let depth = 0;
  const store = {
    beginTransaction: (label: string) => {
      depth++;
      groups.push(`begin ${label}`);
    },
    endTransaction: () => {
      depth--;
      groups.push('end');
    },
    get inTransaction() {
      return depth > 0;
    },
  };
  return { groups, ctx: { services: { editor: { store } } } as unknown as AiContext };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe('the MCP bridge client', () => {
  it('advertises the catalogue on connect and answers tool calls', async () => {
    const sockets: FakeSocket[] = [];
    const s = settings(true);
    const { ctx } = context();
    const stop = startBridgeClient({
      ctx,
      settings: s,
      connect: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1) as FakeSocket),
    });
    const ws = sockets[0] as FakeSocket;
    expect(ws.url).toBe('ws://localhost:7788');
    expect(getBridgeStatus()).toEqual({ state: 'connecting', url: 'ws://localhost:7788' });
    ws.open();
    expect(getBridgeStatus().state).toBe('connected');
    const hello = ws.sent[0] as { type: string; contract: number; tools: { name: string }[] };
    expect(hello.type).toBe('hello');
    expect(hello.contract).toBe(CAD_TOOLS_CONTRACT);
    expect(hello.tools.map((t) => t.name)).toEqual(CAD_TOOLS.map((t) => t.name));

    ws.receive({ id: 'r1', type: 'executeTool', name: 'cad_help', input: {} });
    ws.receive({ id: 'r2', type: 'executeTool', name: 'nope', input: {} });
    ws.receive('not a frame');
    await flush();
    expect(ws.sent[1]).toMatchObject({ id: 'r1', ok: true });
    expect(ws.sent[2]).toMatchObject({ id: 'r2', ok: false, error: { code: 'UNKNOWN_TOOL' } });
    stop();
    expect(ws.closed).toBe(true);
    expect(getBridgeStatus()).toEqual({ state: 'disabled' });
  });

  it('closes the undo groups a client left open when it goes, and reconnects', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const s = settings(true);
    const { ctx, groups } = context();
    const stop = startBridgeClient({
      ctx,
      settings: s,
      connect: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1) as FakeSocket),
    });
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.receive({ id: 'a', type: 'executeTool', name: 'begin_transaction', input: { label: 'Client work' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(groups).toEqual(['begin Client work']);
    ws.onclose?.({});
    expect(groups).toEqual(['begin Client work', 'end']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    // Turned off in Settings: closed, and no further attempts.
    s.set({ bridgeEnabled: false });
    expect(sockets[1]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    stop();
  });
  it('drops the calls still waiting when the connection goes, so none reopens an undo group', async () => {
    const sockets: FakeSocket[] = [];
    const { ctx, groups } = context();
    const stop = startBridgeClient({
      ctx,
      settings: settings(true),
      connect: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1) as FakeSocket),
    });
    const ws = sockets[0] as FakeSocket;
    ws.open();
    ws.receive({ id: 'a', type: 'executeTool', name: 'begin_transaction', input: { label: 'Late' } });
    ws.receive({ id: 'b', type: 'executeTool', name: 'cad_help', input: {} });
    stop();
    await flush();
    expect(groups).toEqual([]);
    expect(ctx.services.editor.store.inTransaction).toBe(false);
    expect(ws.sent).toHaveLength(1);
  });

  it('runs the next call after a result that could not be sent', async () => {
    const sockets: FakeSocket[] = [];
    const { ctx, groups } = context();
    const stop = startBridgeClient({
      ctx,
      settings: settings(true),
      connect: (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1) as FakeSocket),
    });
    const ws = sockets[0] as FakeSocket;
    ws.open();
    const send = ws.send.bind(ws);
    let fail = true;
    ws.send = (data: string) => {
      if (fail) {
        fail = false;
        throw new Error('send failed');
      }
      send(data);
    };
    ws.receive({ id: 'a', type: 'executeTool', name: 'cad_help', input: {} });
    ws.receive({ id: 'b', type: 'executeTool', name: 'begin_transaction', input: { label: 'After' } });
    await flush();
    expect(groups).toEqual(['begin After']);
    expect(ws.sent.at(-1)).toMatchObject({ id: 'b', ok: true });
    stop();
    expect(groups).toEqual(['begin After', 'end']);
  });
});

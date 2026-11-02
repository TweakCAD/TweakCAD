/**
 * Undo balance across an MCP bridge connection.
 *
 * An external MCP client drives the editor through the bridge one tool call
 * at a time, with no turn boundary the client is guaranteed to reach. It can
 * open an undo transaction and then crash, be closed, or never send
 * `end_transaction`. Whatever it left open must close when its connection
 * goes; otherwise undo stays refused (a transaction is open) for the rest of
 * the session. And a client must never be able to close a transaction it did
 * not open.
 *
 * The real bridge client runs against a real DocumentStore and CommandBus;
 * only the WebSocket is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import { createViewportStore } from '@tweakcad/core/src/store/viewportStore.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';

vi.mock('../storage/appSettings.ts', () => ({
  getAppSettings: () => ({ ai: { bridgeEnabled: true, bridgeHost: '127.0.0.1', bridgePort: 7788 } }),
  subscribeAppSettings: () => () => {},
}));

/** A WebSocket the test drives by hand. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  /** Bring the connection up. */
  connect(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The other side went away. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Run a tool call the way the bridge would, and wait for its reply. */
  async call(id: string, name: string, input: unknown = {}): Promise<{ ok: boolean }> {
    this.onmessage?.({ data: JSON.stringify({ id, type: 'executeTool', name, input }) });
    await vi.waitFor(() => expect(this.sent.some((m) => (m as { id?: string }).id === id)).toBe(true));
    return this.sent.find((m) => (m as { id?: string }).id === id) as { ok: boolean };
  }
}

const { startBridgeClient } = await import('./mcpBridgeClient.ts');

function setup() {
  const documentStore = new DocumentStore(newProjectWithPart());
  const commandBus = new CommandBus(documentStore);
  const stop = startBridgeClient({ documentStore, commandBus, viewportStore: createViewportStore() });
  const socket = FakeSocket.instances.at(-1)!;
  socket.connect();
  return { documentStore, stop, socket };
}

function addFeature(store: DocumentStore, id: string): void {
  store.mutate(`Add ${id}`, (draft) => {
    Object.values(draft.parts)[0]!.timeline.push(
      { id, type: 'sketch', name: id, inputs: {}, dependsOn: [], enabled: true, visible: true } as never,
    );
  });
}

describe('MCP bridge — transaction balance per connection', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('closes a transaction the client left open when its connection drops', async () => {
    const { documentStore, stop, socket } = setup();
    await socket.call('1', 'begin_transaction', { label: 'Plate' });
    addFeature(documentStore, 'f_plate');
    expect(documentStore.isTransactionOpen()).toBe(true);

    socket.drop();
    await vi.waitFor(() => expect(documentStore.isTransactionOpen()).toBe(false));

    expect(documentStore.undoLabel()).toBe('Plate');
    addFeature(documentStore, 'f_user');
    expect(documentStore.undoLabel()).toBe('Add f_user');
    stop();
  });

  it('closes them when the bridge is turned off', async () => {
    const { documentStore, stop, socket } = setup();
    await socket.call('1', 'begin_transaction', { label: 'A' });
    await socket.call('2', 'begin_transaction', { label: 'B' });

    stop();
    await vi.waitFor(() => expect(documentStore.isTransactionOpen()).toBe(false));
  });

  it('ignores an end_transaction the client did not open', async () => {
    const { documentStore, stop, socket } = setup();
    // Something else in the editor has a transaction open.
    documentStore.beginTransaction('Apply parameters');

    const reply = await socket.call('1', 'end_transaction');

    expect(reply.ok).toBe(true);
    expect(documentStore.isTransactionOpen()).toBe(true);
    documentStore.endTransaction();
    stop();
  });

  it('leaves a balanced client transaction as one undo step', async () => {
    const { documentStore, stop, socket } = setup();
    await socket.call('1', 'begin_transaction', { label: 'Plate' });
    addFeature(documentStore, 'f_a');
    addFeature(documentStore, 'f_b');
    await socket.call('2', 'end_transaction');

    socket.drop();
    expect(documentStore.isTransactionOpen()).toBe(false);
    expect(documentStore.undoLabel()).toBe('Plate');
    documentStore.undo();
    expect(documentStore.canUndo()).toBe(false);
    stop();
  });
});

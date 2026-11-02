/**
 * Undo balance across an AI turn.
 *
 * The turn opens one transaction so the whole turn is one undo step, and the
 * model can open its own with `begin_transaction` inside it. Whatever the
 * model does with those — forgets to close one, closes one too many, or the
 * turn is cancelled — the document must come out of the turn with no
 * transaction open and the turn as a single undo entry. A level left open
 * swallows every later edit into a transaction that never commits, so
 * nothing in the session can be undone again.
 *
 * The real loop runs against a real DocumentStore; only the model stream is
 * scripted.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatStreamEvent } from './chatClient.ts';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import type { ToolHost } from '@tweakcad/core/src/ai/toolExecutor.ts';

/** One scripted model round per entry; each is the events that round streams. */
const script = vi.hoisted(() => ({ rounds: [] as ChatStreamEvent[][], calls: 0 }));

vi.mock('./chatClient.ts', () => ({
  async *streamChat() {
    const round = script.rounds[script.calls++] ?? [{ type: 'done', stopReason: 'end_turn' }];
    for (const event of round) yield event;
  },
}));

const { runAgentTurn, withBalancedTransactions } = await import('./agentLoop.ts');

const meta: ChatStreamEvent = { type: 'meta', source: 'platform', model: 'test' };
const call = (id: string, name: string, input: unknown = {}): ChatStreamEvent =>
  ({ type: 'tool_call', id, name, input });
const toolUse: ChatStreamEvent = { type: 'done', stopReason: 'tool_use' };
const endTurn: ChatStreamEvent = { type: 'done', stopReason: 'end_turn' };

function addFeature(store: DocumentStore, id: string): void {
  store.mutate(`Add ${id}`, (draft) => {
    Object.values(draft.parts)[0]!.timeline.push(
      { id, type: 'sketch', name: id, inputs: {}, dependsOn: [], enabled: true, visible: true } as never,
    );
  });
}

function timelineIds(store: DocumentStore): string[] {
  return Object.values(store.getState().parts)[0]!.timeline.map((f) => String(f.id));
}

/** A host whose `dispatch_command` appends a feature named by `command.id`. */
function hostFor(store: DocumentStore): ToolHost {
  return {
    getDocument: () => store.getState(),
    getDiagnostics: () => [],
    dispatchCommand: async (command) => {
      addFeature(store, (command as { id: string }).id);
      return store.getState();
    },
    beginTransaction: async (label) => store.beginTransaction(label),
    endTransaction: async () => store.endTransaction(),
  };
}

async function runTurn(store: DocumentStore, signal = new AbortController().signal): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of runAgentTurn({
    text: 'make a plate',
    history: [],
    modelId: null,
    signal,
    host: hostFor(store),
  })) {
    events.push(event);
  }
  return events;
}

const dispatch = (id: string, featureIdValue: string) =>
  call(id, 'dispatch_command', { command: { type: 'Test', id: featureIdValue } });

describe('AI turn — transaction balance', () => {
  beforeEach(() => {
    script.rounds = [];
    script.calls = 0;
  });

  it('closes a transaction the model opened and never closed', async () => {
    const store = new DocumentStore(newProjectWithPart());
    script.rounds = [
      [meta, call('1', 'begin_transaction', { label: 'Plate' }), dispatch('2', 'f_plate'), toolUse],
      [meta, endTurn], // the model stops without end_transaction
    ];

    await runTurn(store);

    expect(store.isTransactionOpen()).toBe(false);
    expect(store.undoLabel()).toBe('AI: make a plate');
    // Later edits are undoable on their own again.
    addFeature(store, 'f_user');
    expect(store.undoLabel()).toBe('Add f_user');
    store.undo();
    expect(timelineIds(store)).toEqual(['f_plate']);
  });

  it('closes the model\'s levels when the turn is cancelled mid-way', async () => {
    const store = new DocumentStore(newProjectWithPart());
    const controller = new AbortController();
    script.rounds = [
      [meta, call('1', 'begin_transaction', { label: 'Plate' }), call('2', 'begin_transaction', { label: 'Holes' }), dispatch('3', 'f_plate'), toolUse],
      [meta, endTurn],
    ];
    // The user presses stop while the model's tools are running, with two
    // of its transactions open.
    const host = hostFor(store);
    const dispatchCommand = host.dispatchCommand;
    host.dispatchCommand = async (command) => {
      const result = await dispatchCommand(command);
      controller.abort();
      return result;
    };
    const events = [];
    for await (const event of runAgentTurn({
      text: 'make a plate', history: [], modelId: null, signal: controller.signal, host,
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({ type: 'done', error: 'Cancelled.' });

    expect(store.isTransactionOpen()).toBe(false);
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(timelineIds(store)).toEqual([]);
  });

  it('ignores an end_transaction the model did not open, keeping the turn one undo step', async () => {
    const store = new DocumentStore(newProjectWithPart());
    script.rounds = [
      [meta, call('1', 'end_transaction'), dispatch('2', 'f_a'), dispatch('3', 'f_b'), toolUse],
      [meta, endTurn],
    ];

    await runTurn(store);

    expect(store.isTransactionOpen()).toBe(false);
    expect(store.undoLabel()).toBe('AI: make a plate');
    store.undo();
    expect(timelineIds(store)).toEqual([]);
    expect(store.canUndo()).toBe(false);
  });

  it('a balanced model transaction still lands as one undo step for the turn', async () => {
    const store = new DocumentStore(newProjectWithPart());
    script.rounds = [
      [meta, call('1', 'begin_transaction', { label: 'Plate' }), dispatch('2', 'f_a'), call('3', 'end_transaction'), dispatch('4', 'f_b'), toolUse],
      [meta, endTurn],
    ];

    await runTurn(store);

    expect(store.isTransactionOpen()).toBe(false);
    expect(store.undoLabel()).toBe('AI: make a plate');
    store.undo();
    expect(timelineIds(store)).toEqual([]);
  });
});

describe('withBalancedTransactions', () => {
  it('passes every other host method through', async () => {
    const store = new DocumentStore(newProjectWithPart());
    const host = hostFor(store);
    host.viewFitAll = vi.fn(async () => {});
    const { host: wrapped } = withBalancedTransactions(host);
    expect(wrapped.getDocument()).toBe(store.getState());
    await wrapped.viewFitAll?.();
    expect(host.viewFitAll).toHaveBeenCalledOnce();
  });
});

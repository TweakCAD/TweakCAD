import { describe, expect, it } from 'vitest';
import { CommandError } from './errors';
import { History } from './history';
import type { Json } from './rows';
import { DocumentStore, type StoreChange } from './store';
import { standardDocument } from './testDocs';

type Patch = { op: 'replace'; path: string[]; value: unknown };
const patch = (value: number): Patch => ({ op: 'replace', path: ['n'], value });

function rename(store: DocumentStore, name: string, label = `Rename ${name}`): void {
  store.edit(label, (draft) => {
    (draft.metadata as Json).name = name;
  });
}

const nameOf = (store: DocumentStore): unknown => (store.document.metadata as Json).name;

describe('History', () => {
  it('folds nested transactions into one step under the outermost label', () => {
    const h = new History();
    h.begin('Outer');
    h.record('a', [patch(1)], [patch(0)]);
    h.begin('Inner');
    h.record('b', [patch(2)], [patch(1)]);
    h.end();
    expect(h.canUndo()).toBe(false);
    h.end();
    expect(h.undoLabel()).toBe('Outer');
    const entry = h.undo();
    expect(entry?.patches).toEqual([patch(1), patch(2)]);
    expect(entry?.inverse).toEqual([patch(1), patch(0)]);
    expect(h.redoLabel()).toBe('Outer');
  });

  it('aborts the innermost transaction only', () => {
    const h = new History();
    h.begin('Outer');
    h.record('a', [patch(1)], [patch(0)]);
    h.begin('Inner');
    h.record('b', [patch(2)], [patch(1)]);
    expect(h.abort()).toEqual([patch(1)]);
    h.end();
    expect(h.undo()?.patches).toEqual([patch(1)]);
  });

  it('records nothing for an empty transaction, and caps its depth', () => {
    const h = new History(2);
    h.begin('Empty');
    h.end();
    expect(h.canUndo()).toBe(false);
    for (const n of [1, 2, 3]) h.record(`e${n}`, [patch(n)], [patch(n - 1)]);
    expect(h.undo()?.label).toBe('e3');
    expect(h.undo()?.label).toBe('e2');
    expect(h.undo()).toBeUndefined();
  });

  it('clears the redo stack on a new step, and refuses unbalanced or mid-transaction calls', () => {
    const h = new History();
    h.record('a', [patch(1)], [patch(0)]);
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.record('b', [patch(2)], [patch(1)]);
    expect(h.canRedo()).toBe(false);
    expect(() => h.end()).toThrow();
    expect(() => h.abort()).toThrow();
    h.begin('T');
    expect(h.undo()).toBeUndefined();
    expect(() => h.clear()).toThrow();
  });
});

describe('DocumentStore', () => {
  it('holds a frozen copy of the document', () => {
    const { doc } = standardDocument();
    const store = new DocumentStore(doc);
    expect(Object.isFrozen(store.document)).toBe(true);
    expect(Object.isFrozen(doc)).toBe(false);
    expect(store.document).toEqual(doc);
  });

  it('refuses a document the format refuses', () => {
    const { doc } = standardDocument();
    expect(() => new DocumentStore({ ...doc, id: 'nonsense' })).toThrow(CommandError);
  });

  it('undoes and redoes edits, and notifies each change', () => {
    const store = new DocumentStore(standardDocument().doc);
    const changes: Pick<StoreChange, 'cause' | 'label' | 'revision'>[] = [];
    store.subscribe(({ cause, label, revision }) => changes.push({ cause, label, revision }));
    rename(store, 'A');
    rename(store, 'B');
    expect(store.undoLabel()).toBe('Rename B');
    store.undo();
    expect(nameOf(store)).toBe('A');
    store.redo();
    expect(nameOf(store)).toBe('B');
    store.undo();
    store.undo();
    expect(nameOf(store)).toBe('Test');
    expect(store.undo()).toBe(false);
    expect(changes.map((c) => c.cause)).toEqual(['edit', 'edit', 'undo', 'redo', 'undo', 'undo']);
    expect(changes.map((c) => c.revision)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('records no step for an edit that changes nothing', () => {
    const store = new DocumentStore(standardDocument().doc);
    const patches = store.edit('Nothing', (draft) => {
      (draft.metadata as Json).name = 'Test';
    });
    expect(patches).toEqual([]);
    expect(store.canUndo()).toBe(false);
    expect(store.revision).toBe(0);
  });

  it('rejects an edit the format would refuse and keeps the document', () => {
    const store = new DocumentStore(standardDocument().doc);
    const before = store.document;
    expect(() =>
      store.edit('Break', (draft) => {
        draft.id = 'doc_broken';
      }),
    ).toThrow(/malformed id/);
    expect(store.document).toBe(before);
    expect(store.revision).toBe(0);
    expect(store.canUndo()).toBe(false);
  });

  it('runs a nested transaction as one undo step, and reverts one that throws', () => {
    const store = new DocumentStore(standardDocument().doc);
    const history: boolean[] = [];
    store.subscribeHistory(() => history.push(store.inTransaction));
    store.transaction('Both', () => {
      rename(store, 'A');
      store.transaction('Inner', () => rename(store, 'B'));
      expect(store.canUndo()).toBe(false);
    });
    expect(history).toEqual([true, false]);
    expect(store.undoLabel()).toBe('Both');
    store.undo();
    expect(nameOf(store)).toBe('Test');
    store.redo();
    expect(nameOf(store)).toBe('B');

    expect(() =>
      store.transaction('Outer', () => {
        rename(store, 'C');
        expect(() =>
          store.transaction('Fails', () => {
            rename(store, 'D');
            throw new Error('no');
          }),
        ).toThrow('no');
        expect(nameOf(store)).toBe('C');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(nameOf(store)).toBe('B');
    expect(store.undoLabel()).toBe('Both');
  });

  it('requests a rebuild on every document change, undo and redo included', () => {
    const store = new DocumentStore(standardDocument().doc);
    const revisions: number[] = [];
    store.onRebuild((_doc, revision) => revisions.push(revision));
    rename(store, 'A');
    store.undo();
    store.redo();
    store.replace(standardDocument().doc);
    expect(revisions).toEqual([1, 2, 3, 4]);
    expect(store.canUndo()).toBe(false);
  });

  it('takes a custom validator', () => {
    const store = new DocumentStore(standardDocument().doc, {
      validate: (doc) =>
        (doc.metadata as Json).name === 'forbidden'
          ? [{ severity: 'refuse', code: 'bad-value', path: '/metadata/name', message: 'that name is taken' }]
          : [],
    });
    expect(() => rename(store, 'forbidden')).toThrow('that name is taken (at /metadata/name)');
    rename(store, 'fine');
    expect(nameOf(store)).toBe('fine');
  });
});

describe('a document shown read-only', () => {
  function shown() {
    const store = new DocumentStore(standardDocument().doc);
    rename(store, 'A');
    rename(store, 'B');
    store.undo();
    const live = store.document;
    const base = standardDocument().doc;
    const other = { ...base, metadata: { ...(base.metadata as Json), name: 'Old' } };
    return { store, live, other };
  }

  it('holds the live document and its undo history, and refuses edits, undo and redo', () => {
    const { store, live, other } = shown();
    const changes: StoreChange['cause'][] = [];
    store.subscribe((c) => changes.push(c.cause));
    store.showReadOnly(other);
    expect(store.readOnly).toBe(true);
    expect(nameOf(store)).toBe('Old');
    expect(store.liveDocument).toBe(live);
    let refusal: unknown;
    try {
      rename(store, 'C');
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(CommandError);
    expect((refusal as CommandError).code).toBe('read-only');
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
    expect(store.undoLabel()).toBeUndefined();
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(false);
    expect(nameOf(store)).toBe('Old');
    store.endReadOnly();
    expect(store.readOnly).toBe(false);
    expect(store.document).toBe(live);
    expect(store.undoLabel()).toBe('Rename A');
    expect(store.redoLabel()).toBe('Rename B');
    expect(changes).toEqual(['readOnly', 'live']);
    expect(store.redo()).toBe(true);
    expect(nameOf(store)).toBe('B');
  });

  it('takes another read-only document in place of the shown one, keeping the live one held', () => {
    const { store, live, other } = shown();
    store.showReadOnly(other);
    store.showReadOnly({ ...other, metadata: { ...(other.metadata as Json), name: 'Older' } });
    expect(nameOf(store)).toBe('Older');
    store.endReadOnly();
    expect(store.document).toBe(live);
    store.endReadOnly();
    expect(store.document).toBe(live);
  });

  it('ends with a load, which drops the held document', () => {
    const { store, other } = shown();
    store.showReadOnly(other);
    store.replace(standardDocument().doc);
    expect(store.readOnly).toBe(false);
    expect(nameOf(store)).toBe('Test');
    expect(store.canUndo()).toBe(false);
  });

  it('is refused inside a transaction over the live document; one opened while it shows records nothing', () => {
    const { store, live, other } = shown();
    store.beginTransaction('Turn');
    expect(() => store.showReadOnly(other)).toThrow(/transaction/);
    store.endTransaction();
    store.showReadOnly(other);
    store.beginTransaction('Turn');
    expect(() => rename(store, 'C')).toThrow(CommandError);
    store.endReadOnly();
    store.endTransaction();
    expect(store.document).toBe(live);
    expect(store.undoLabel()).toBe('Rename A');
  });
});

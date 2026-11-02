/**
 * Direct tests for `UndoManager` — the stack and transaction bookkeeping
 * behind undo/redo.
 *
 * Distinct from `documentStore.test.ts`, which pins the *Immer patch
 * contract* (what `produce` emits and what `applyPatches` does with it) and
 * reaches UndoManager only indirectly through the store. This file never
 * touches Immer: `Patch` is a type-only import here, and UndoManager treats
 * patches as opaque payloads it shuttles between two arrays. So the patches
 * below are hand-built literals, and a failure here points at stack or
 * transaction logic rather than at the patch engine.
 *
 * What it pins:
 *   - LIFO ordering of undo, forward ordering of redo, and the labels
 *   - which operations clear the redo stack, and when
 *   - transaction grouping: N records collapse to one entry, forward patches
 *     concatenated in order, inverse patches accumulated newest-first
 *   - `MAX_UNDO_DEPTH` trimming
 *   - two hazards that are current shipped behaviour, marked as such
 */

import { describe, it, expect, vi } from 'vitest';
import type { Patch } from 'immer';
import { UndoManager, type UndoEntry } from './undoManager.ts';

/** The cap in `undoManager.ts`. Not exported; mirrored here deliberately so
 *  a change to the constant breaks these tests rather than sliding through. */
const MAX_UNDO_DEPTH = 200;

function patch(path: string, value: unknown): Patch {
  return { op: 'replace', path: [path], value } as Patch;
}

/** An entry whose forward and inverse patches are distinguishable, so tests
 *  can assert which of the two got applied. */
function entry(label: string, n = 1): UndoEntry {
  return {
    label,
    patches: Array.from({ length: n }, (_, i) => patch(`${label}.fwd${i}`, i)),
    inversePatches: Array.from({ length: n }, (_, i) => patch(`${label}.inv${i}`, i)),
    timestamp: Date.now(),
  };
}

/** Collect the `path[0]` of every patch handed to `apply`, in call order. */
function recorder(): { apply: (p: Patch[]) => void; seen: string[][] } {
  const seen: string[][] = [];
  return {
    apply: (p: Patch[]) => seen.push(p.map(x => String(x.path[0]))),
    seen,
  };
}

describe('UndoManager — basic stack', () => {
  it('starts empty and reports nothing to undo or redo', () => {
    const m = new UndoManager();
    expect(m.canUndo()).toBe(false);
    expect(m.canRedo()).toBe(false);
    expect(m.undoLabel()).toBeUndefined();
    expect(m.redoLabel()).toBeUndefined();
  });

  it('undo applies the inverse patches; redo applies the forward ones', () => {
    const m = new UndoManager();
    m.record(entry('a'));

    const r = recorder();
    m.undo(r.apply);
    expect(r.seen).toEqual([['a.inv0']]);
    expect(m.canUndo()).toBe(false);
    expect(m.canRedo()).toBe(true);

    m.redo(r.apply);
    expect(r.seen).toEqual([['a.inv0'], ['a.fwd0']]);
    expect(m.canUndo()).toBe(true);
    expect(m.canRedo()).toBe(false);
  });

  it('surfaces the labels of the next undoable and redoable actions', () => {
    const m = new UndoManager();
    m.record(entry('first'));
    m.record(entry('second'));
    expect(m.undoLabel()).toBe('second');
    expect(m.redoLabel()).toBeUndefined();

    m.undo(() => {});
    expect(m.undoLabel()).toBe('first');
    expect(m.redoLabel()).toBe('second');
  });

  it('undoes newest-first and redoes oldest-first', () => {
    const m = new UndoManager();
    m.record(entry('a'));
    m.record(entry('b'));
    m.record(entry('c'));

    const r = recorder();
    m.undo(r.apply);
    m.undo(r.apply);
    m.undo(r.apply);
    expect(r.seen).toEqual([['c.inv0'], ['b.inv0'], ['a.inv0']]);

    r.seen.length = 0;
    m.redo(r.apply);
    m.redo(r.apply);
    m.redo(r.apply);
    expect(r.seen).toEqual([['a.fwd0'], ['b.fwd0'], ['c.fwd0']]);
  });

  it('undo and redo on empty stacks never call apply', () => {
    const m = new UndoManager();
    const apply = vi.fn();
    m.undo(apply);
    m.redo(apply);
    expect(apply).not.toHaveBeenCalled();
  });

  it('a new record discards the redo stack', () => {
    const m = new UndoManager();
    m.record(entry('a'));
    m.undo(() => {});
    expect(m.canRedo()).toBe(true);

    m.record(entry('b'));
    expect(m.canRedo()).toBe(false);
    expect(m.undoLabel()).toBe('b');
  });

  it('clear drops both stacks', () => {
    const m = new UndoManager();
    m.record(entry('a'));
    m.undo(() => {});
    m.clear();
    expect(m.canUndo()).toBe(false);
    expect(m.canRedo()).toBe(false);
  });
});

describe('UndoManager — transactions', () => {
  it('collapses several records into one undo entry', () => {
    const m = new UndoManager();
    m.beginTransaction('Drag three points');
    m.record(entry('a'));
    m.record(entry('b'));
    m.record(entry('c'));
    expect(m.canUndo()).toBe(false); // nothing lands until endTransaction
    m.endTransaction();

    expect(m.canUndo()).toBe(true);
    expect(m.undoLabel()).toBe('Drag three points');

    const r = recorder();
    m.undo(r.apply);
    expect(r.seen).toHaveLength(1); // ONE apply call, not three
    expect(m.canUndo()).toBe(false);
  });

  it('concatenates forward patches in order and inverse patches newest-first', () => {
    const m = new UndoManager();
    m.beginTransaction('Batch');
    m.record(entry('a', 2));
    m.record(entry('b', 2));
    m.endTransaction();

    const r = recorder();
    m.undo(r.apply);
    // Undo must unwind b before a, while each entry's own patches keep
    // their relative order — that is what `unshift(...inverse)` buys.
    expect(r.seen[0]).toEqual(['b.inv0', 'b.inv1', 'a.inv0', 'a.inv1']);

    r.seen.length = 0;
    m.redo(r.apply);
    expect(r.seen[0]).toEqual(['a.fwd0', 'a.fwd1', 'b.fwd0', 'b.fwd1']);
  });

  it('records nothing when a transaction produced no patches', () => {
    const m = new UndoManager();
    m.beginTransaction('Empty');
    m.endTransaction();
    expect(m.canUndo()).toBe(false);
    expect(m.undoLabel()).toBeUndefined();
  });

  it('endTransaction without an open transaction is a no-op', () => {
    const m = new UndoManager();
    m.record(entry('a'));
    m.endTransaction();
    expect(m.canUndo()).toBe(true);
    expect(m.undoLabel()).toBe('a');
  });

  it('keeps the redo stack alive until the transaction actually closes', () => {
    // `record` returns early inside a transaction, so its `future = []` never
    // runs; the discard happens in `endTransaction`. Pinning the boundary
    // because an in-flight transaction that is never closed must not silently
    // strand a redo stack. Redo itself is refused while the transaction is
    // open, but the entry is still there.
    const m = new UndoManager();
    m.record(entry('a'));
    m.undo(() => {});
    expect(m.canRedo()).toBe(true);

    m.beginTransaction('Batch');
    m.record(entry('b'));
    expect(m.redoLabel()).toBe('a');
    expect(m.canRedo()).toBe(false);

    m.endTransaction();
    expect(m.redoLabel()).toBeUndefined();
    expect(m.canRedo()).toBe(false);
  });

  it('clear abandons an open transaction', () => {
    const m = new UndoManager();
    m.beginTransaction('Batch');
    m.record(entry('a'));
    m.clear();
    m.endTransaction();
    expect(m.canUndo()).toBe(false);
  });
});

describe('UndoManager — depth cap', () => {
  it(`record trims the stack to ${MAX_UNDO_DEPTH} entries`, () => {
    const m = new UndoManager();
    for (let i = 0; i < MAX_UNDO_DEPTH + 50; i++) m.record(entry(`e${i}`));

    let depth = 0;
    while (m.canUndo()) {
      m.undo(() => {});
      depth++;
    }
    expect(depth).toBe(MAX_UNDO_DEPTH);
  });

  it('drops the OLDEST entries, keeping the most recent work', () => {
    const m = new UndoManager();
    for (let i = 0; i < MAX_UNDO_DEPTH + 10; i++) m.record(entry(`e${i}`));
    expect(m.undoLabel()).toBe(`e${MAX_UNDO_DEPTH + 9}`); // newest survives

    const labels: string[] = [];
    while (m.canUndo()) {
      labels.push(m.undoLabel()!);
      m.undo(() => {});
    }
    expect(labels.at(-1)).toBe(`e${10}`); // e0..e9 were trimmed
  });

  it('endTransaction honours MAX_UNDO_DEPTH the way record does', () => {
    // `record` always trimmed; `endTransaction` pushed straight onto `past`
    // with no trim, so any flow that batched — every multi-point sketch drag
    // — grew the stack without bound, each entry holding its patch arrays.
    const m = new UndoManager();
    for (let i = 0; i < MAX_UNDO_DEPTH + 50; i++) {
      m.beginTransaction(`t${i}`);
      m.record(entry(`e${i}`));
      m.endTransaction();
    }

    let depth = 0;
    while (m.canUndo()) {
      m.undo(() => {});
      depth++;
    }
    expect(depth).toBe(MAX_UNDO_DEPTH);
  });
});

describe('UndoManager — nesting', () => {
  it('keeps the outer transaction open until its own end', () => {
    // A nested begin used to overwrite `activeTransaction` outright, so
    // everything recorded into the outer one vanished. Now the inner end
    // only decrements — the group stays open, and nothing commits early.
    const m = new UndoManager();
    m.beginTransaction('outer');
    m.record(entry('a'));
    m.beginTransaction('inner');
    m.record(entry('b'));
    m.endTransaction(); // closes `inner` only

    expect(m.canUndo()).toBe(false);

    m.endTransaction(); // closes `outer` — now it commits
    expect(m.canUndo()).toBe(true);
  });

  it('collapses the whole nest into ONE entry holding every patch', () => {
    const m = new UndoManager();
    m.beginTransaction('outer');
    m.record(entry('a'));
    m.beginTransaction('inner');
    m.record(entry('b'));
    m.endTransaction();
    m.endTransaction();

    const r = recorder();
    m.undo(r.apply);
    expect(r.seen).toHaveLength(1);
    // Both survive — the regression was `a` disappearing.
    expect(r.seen[0]).toContain('a.inv0');
    expect(r.seen[0]).toContain('b.inv0');
    expect(m.canUndo()).toBe(false);
  });

  it('labels the entry with the OUTER transaction', () => {
    // The user asked for the outer operation; the inner ones are how it was
    // implemented, not what they did.
    const m = new UndoManager();
    m.beginTransaction('Paste template');
    m.beginTransaction('Draw line');
    m.record(entry('a'));
    m.endTransaction();
    m.endTransaction();
    expect(m.undoLabel()).toBe('Paste template');
  });

  it('nests arbitrarily deep', () => {
    const m = new UndoManager();
    for (let i = 0; i < 5; i++) m.beginTransaction(`level${i}`);
    m.record(entry('a'));
    for (let i = 0; i < 4; i++) {
      m.endTransaction();
      expect(m.canUndo()).toBe(false);
    }
    m.endTransaction();
    expect(m.canUndo()).toBe(true);
    expect(m.undoLabel()).toBe('level0');
  });

  it('warns on an unbalanced end rather than committing something', () => {
    // Nesting deliberately swallows a stray `begin`, so a stray `end` is the
    // remaining way to notice an unbalanced caller — worth surfacing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = new UndoManager();
    m.endTransaction();
    expect(warn).toHaveBeenCalledOnce();
    expect(m.canUndo()).toBe(false);
    warn.mockRestore();
  });

  it('clear resets the depth so a later transaction still commits', () => {
    // Clearing mid-transaction used to leave the count non-zero, and every
    // later end decremented toward a close that never came.
    const m = new UndoManager();
    m.beginTransaction('abandoned');
    m.beginTransaction('also abandoned');
    m.record(entry('a'));
    m.clear();

    m.beginTransaction('fresh');
    m.record(entry('b'));
    m.endTransaction();
    expect(m.canUndo()).toBe(true);
    expect(m.undoLabel()).toBe('fresh');
  });

  it('an unclosed transaction swallows every record until it is closed', () => {
    // Not a bug on its own — it is how drag gestures batch — but it means a
    // caller that throws between begin and end leaves the manager wedged:
    // subsequent records vanish into the orphaned transaction. Pinned so the
    // behaviour is deliberate rather than discovered.
    const m = new UndoManager();
    m.beginTransaction('never closed');
    m.record(entry('a'));
    m.record(entry('b'));
    expect(m.canUndo()).toBe(false);
  });
});

describe('UndoManager — undo and redo while a transaction is open', () => {
  // The open transaction's patches were recorded against the current state.
  // Undoing an older entry underneath them changes what they describe, so
  // the transaction's own undo would later replay against a document it was
  // never recorded on.
  it('refuses undo, and reports nothing to undo, until the transaction closes', () => {
    const m = new UndoManager();
    m.record(entry('before'));
    m.beginTransaction('open');
    const { apply, seen } = recorder();

    expect(m.isTransactionOpen()).toBe(true);
    expect(m.canUndo()).toBe(false);
    m.undo(apply);
    expect(seen).toEqual([]);

    m.endTransaction();
    expect(m.isTransactionOpen()).toBe(false);
    expect(m.canUndo()).toBe(true);
    expect(m.undoLabel()).toBe('before');
  });

  it('refuses redo until the transaction closes', () => {
    const m = new UndoManager();
    m.record(entry('a'));
    m.undo(() => {});
    m.beginTransaction('open');
    const { apply, seen } = recorder();

    expect(m.canRedo()).toBe(false);
    m.redo(apply);
    expect(seen).toEqual([]);

    m.endTransaction(); // no patches: nothing committed, redo survives
    expect(m.canRedo()).toBe(true);
    m.redo(apply);
    expect(seen).toEqual([['a.fwd0']]);
  });

  it('stays refused through nested levels until the outermost closes', () => {
    const m = new UndoManager();
    m.record(entry('before'));
    m.beginTransaction('outer');
    m.beginTransaction('inner');
    m.endTransaction();
    expect(m.canUndo()).toBe(false);
    m.endTransaction();
    expect(m.canUndo()).toBe(true);
  });
});

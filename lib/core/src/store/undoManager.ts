/**
 * Undo/Redo manager using Immer patches.
 * Supports transaction grouping for multi-command operations.
 */

import type { Patch } from 'immer';

/** Maximum number of undo entries to retain */
const MAX_UNDO_DEPTH = 200;

/** Single undo/redo entry */
export type UndoEntry = {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  timestamp: number;
};

export class UndoManager {
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];
  private activeTransaction: {
    label: string;
    patches: Patch[];
    inversePatches: Patch[];
  } | null = null;
  /**
   * How many `beginTransaction` calls are open. Only the outermost `end`
   * commits.
   *
   * Transactions nest because the handlers nest: a high-level operation
   * composed of per-primitive commands opens a transaction, and those
   * commands open their own. Before this counter, the inner `begin`
   * overwrote `activeTransaction` outright and every patch recorded into the
   * outer one vanished — the undo entry for the whole operation silently
   * became the undo entry for its last fragment.
   *
   * Nesting rather than throwing: the damage from the bug is a confusing
   * undo stack, since the document itself is safe in the timeline. Throwing
   * would trade that for an exception mid-gesture, and a thrown error that
   * left a transaction open would wedge every later one. `endTransaction`
   * warns instead if it is called with no transaction open, which is the
   * unbalanced-caller case worth surfacing.
   */
  private depth = 0;

  /**
   * Record an undo entry.
   * @param entry - The undo entry to record
   */
  record(entry: UndoEntry): void {
    if (this.activeTransaction) {
      this.activeTransaction.patches.push(...entry.patches);
      this.activeTransaction.inversePatches.unshift(...entry.inversePatches);
      return;
    }

    this.past.push(entry);
    this.future = [];
    if (this.past.length > MAX_UNDO_DEPTH) this.past.shift();
  }

  /**
   * Apply undo - restores previous state.
   *
   * Refused while a transaction is open. The open transaction's patches were
   * recorded against the current state; undoing an older entry underneath
   * them changes what those patches describe, so the transaction's own undo
   * later replays against a document it was never recorded on (a removed
   * part makes it throw; a shifted array index makes it undo the wrong thing).
   * @param apply - Function that applies patches to the document state
   */
  undo(apply: (patches: Patch[]) => void): void {
    if (this.depth > 0) return;
    const entry = this.past.pop();
    if (!entry) return;
    apply(entry.inversePatches);
    this.future.push(entry);
  }

  /**
   * Apply redo - reapplies undone state. Refused while a transaction is
   * open, for the same reason as {@link undo}.
   * @param apply - Function that applies patches to the document state
   */
  redo(apply: (patches: Patch[]) => void): void {
    if (this.depth > 0) return;
    const entry = this.future.pop();
    if (!entry) return;
    apply(entry.patches);
    this.past.push(entry);
  }

  /** @returns Whether undo is available (never while a transaction is open) */
  canUndo(): boolean {
    return this.depth === 0 && this.past.length > 0;
  }

  /** @returns Whether redo is available (never while a transaction is open) */
  canRedo(): boolean {
    return this.depth === 0 && this.future.length > 0;
  }

  /** @returns Whether a transaction is open */
  isTransactionOpen(): boolean {
    return this.depth > 0;
  }

  /**
   * Begin a transaction that groups multiple commands into a single undo step.
   * @param label - Label for the transaction
   */
  beginTransaction(label: string): void {
    this.depth++;
    // Only the outermost begin establishes the transaction, so its label is
    // the one the user sees. That matches intent: they asked for "Paste
    // template", not the fourteen line draws it decomposed into.
    if (this.depth === 1) {
      this.activeTransaction = { label, patches: [], inversePatches: [] };
    }
  }

  /**
   * Close one level of transaction. Only the outermost close records an
   * entry — an inner close just decrements, leaving the group open.
   */
  endTransaction(): void {
    if (this.depth === 0) {
      // Unbalanced: more ends than begins. Nothing to commit, but the caller
      // is wrong and this is the one case worth surfacing, since nesting
      // deliberately swallows the mirror-image mistake.
      console.warn('[undo] endTransaction called with no transaction open');
      return;
    }
    this.depth--;
    if (this.depth > 0) return; // inner close — the group stays open

    if (!this.activeTransaction) return;
    const { label, patches, inversePatches } = this.activeTransaction;
    this.activeTransaction = null;
    if (patches.length > 0) {
      this.past.push({
        label,
        patches,
        inversePatches,
        timestamp: Date.now(),
      });
      this.future = [];
      // Trim here too. `record` has always capped the stack; this path did
      // not, so anything that batched — every multi-point sketch drag — grew
      // `past` without bound, each entry holding its patch arrays.
      if (this.past.length > MAX_UNDO_DEPTH) this.past.shift();
    }
  }

  /** @returns The label of the next undoable action, or undefined */
  undoLabel(): string | undefined {
    return this.past.at(-1)?.label;
  }

  /** @returns The label of the next redoable action, or undefined */
  redoLabel(): string | undefined {
    return this.future.at(-1)?.label;
  }

  /** Clear all undo/redo history, including any open transaction. */
  clear(): void {
    this.past = [];
    this.future = [];
    this.activeTransaction = null;
    // Reset the depth as well. Without this, clearing mid-transaction leaves
    // a non-zero count with no transaction behind it, and every later
    // `endTransaction` decrements toward a close that never commits.
    this.depth = 0;
  }
}

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
   * @param apply - Function that applies patches to the document state
   */
  undo(apply: (patches: Patch[]) => void): void {
    const entry = this.past.pop();
    if (!entry) return;
    apply(entry.inversePatches);
    this.future.push(entry);
  }

  /**
   * Apply redo - reapplies undone state.
   * @param apply - Function that applies patches to the document state
   */
  redo(apply: (patches: Patch[]) => void): void {
    const entry = this.future.pop();
    if (!entry) return;
    apply(entry.patches);
    this.past.push(entry);
  }

  /** @returns Whether undo is available */
  canUndo(): boolean {
    return this.past.length > 0;
  }

  /** @returns Whether redo is available */
  canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Begin a transaction that groups multiple commands into a single undo step.
   * @param label - Label for the transaction
   */
  beginTransaction(label: string): void {
    this.activeTransaction = { label, patches: [], inversePatches: [] };
  }

  /** End the current transaction and record it as a single undo entry. */
  endTransaction(): void {
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

  /** Clear all undo/redo history */
  clear(): void {
    this.past = [];
    this.future = [];
    this.activeTransaction = null;
  }
}

import type { Patch } from 'immer';

/** One undo step: the patches that redo it and the inverse patches that undo it. */
export interface HistoryEntry {
  label: string;
  patches: readonly Patch[];
  inverse: readonly Patch[];
}

interface Frame {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Closing it folds its edits into the newest undo step instead of recording one. */
  amend: boolean;
}

/**
 * Undo and redo stacks of Immer patches, with nested transactions. Edits
 * made inside a transaction collect into it; closing an inner transaction
 * folds it into the one around it, and only closing the outermost records
 * one undo step, under the outermost label (the action the user asked for,
 * not the steps it was made of). Undo and redo are refused while a
 * transaction is open: its patches were recorded against the current state,
 * and undoing an older step under them would replay them against a document
 * they were never recorded on.
 *
 * An amending transaction records no step of its own: its edits join the
 * newest undo step, so undoing that step undoes them too (what an edit
 * brings about after it, such as contexts re-captured from it).
 */
export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private readonly frames: Frame[] = [];

  constructor(private readonly limit = 200) {}

  record(label: string, patches: readonly Patch[], inverse: readonly Patch[]): void {
    const frame = this.frames.at(-1);
    if (frame) {
      frame.patches.push(...patches);
      frame.inverse.unshift(...inverse);
      return;
    }
    this.push({ label, patches, inverse });
  }

  private push(entry: HistoryEntry): void {
    this.past.push(entry);
    this.future = [];
    if (this.past.length > this.limit) this.past.shift();
  }

  get depth(): number {
    return this.frames.length;
  }

  begin(label: string, amend = false): void {
    this.frames.push({ label, patches: [], inverse: [], amend });
  }

  /** Closes the innermost transaction. Throws when none is open. */
  end(): void {
    const frame = this.frames.pop();
    if (!frame) throw new Error('no transaction is open');
    const outer = this.frames.at(-1);
    if (outer) {
      outer.patches.push(...frame.patches);
      outer.inverse.unshift(...frame.inverse);
    } else if (frame.patches.length > 0) {
      const last = frame.amend ? this.past.at(-1) : undefined;
      if (last) {
        this.past[this.past.length - 1] = {
          label: last.label,
          patches: [...last.patches, ...frame.patches],
          inverse: [...frame.inverse, ...last.inverse],
        };
        this.future = [];
      } else this.push({ label: frame.label, patches: frame.patches, inverse: frame.inverse });
    }
  }

  /** Drops the innermost transaction; returns the patches that undo what it held. */
  abort(): readonly Patch[] {
    const frame = this.frames.pop();
    if (!frame) throw new Error('no transaction is open');
    return frame.inverse;
  }

  /** The entry to undo, moved to the redo stack; undefined when there is none or a transaction is open. */
  undo(): HistoryEntry | undefined {
    if (this.frames.length > 0) return undefined;
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
    return entry;
  }

  redo(): HistoryEntry | undefined {
    if (this.frames.length > 0) return undefined;
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
    return entry;
  }

  canUndo(): boolean {
    return this.frames.length === 0 && this.past.length > 0;
  }

  canRedo(): boolean {
    return this.frames.length === 0 && this.future.length > 0;
  }

  undoLabel(): string | undefined {
    return this.past.at(-1)?.label;
  }

  redoLabel(): string | undefined {
    return this.future.at(-1)?.label;
  }

  /** Clears both stacks; refused while a transaction is open. */
  clear(): void {
    if (this.frames.length > 0) throw new Error('history cannot be cleared inside a transaction');
    this.past = [];
    this.future = [];
  }
}

import { enablePatches, freeze, Immer, type Draft, type Patch } from 'immer';
import { readDocument, type Diagnostic } from '@tweakcad/format';
import { CommandError } from './errors';
import { History } from './history';
import type { Doc } from './rows';

enablePatches();

const immer = new Immer({ autoFreeze: true });

/** A deep-frozen copy, so the caller's object stays theirs. */
function frozenCopy(document: Doc): Doc {
  return freeze(structuredClone(document), true);
}

/**
 * What changed the document. `readOnly`: a document shown read-only in
 * place of the live one, or in place of another shown so; `live`: the live
 * document shown again.
 */
export type ChangeCause = 'edit' | 'undo' | 'redo' | 'abort' | 'replace' | 'readOnly' | 'live';

/** The message of an edit refused while a document is shown read-only. */
export const READ_ONLY_MESSAGE = 'The document shown is read-only.';

export interface StoreChange {
  document: Doc;
  revision: number;
  cause: ChangeCause;
  /** The edit's or undo step's label. */
  label: string | undefined;
}

/** The refusals a document carries; empty when it reads clean. */
export type Validator = (document: Doc) => readonly Diagnostic[];

/** The format reader's refusals (chapter 20). */
export const formatRefusals: Validator = (document) => {
  const result = readDocument(document);
  return result.diagnostics.filter((d) => d.severity === 'refuse');
};

export interface StoreOptions {
  /** Checks each edit's result; an edit leaving refusals is rejected. Default: the format reader. */
  validate?: Validator;
  /** Undo steps kept. */
  undoLimit?: number;
  /**
   * Receives what a listener threw. A change is committed before its
   * listeners hear of it, so a listener's failure neither undoes it nor
   * stops the other listeners. Default: thrown again on its own, after the
   * change.
   */
  onListenerError?: (error: unknown) => void;
}

const rethrowLater = (error: unknown): void =>
  queueMicrotask(() => {
    throw error;
  });

/**
 * Holds one version-2 document as plain immutable JSON. Every edit is an
 * Immer recipe whose patches and inverse patches are the undo step; an edit
 * whose result the format would refuse is rejected and leaves the store as
 * it was, so the document held always reads clean.
 *
 * A rebuild is requested on every document change: which features to
 * rebuild is the worker's decision, from the hashes of what each depends
 * on, not the store's.
 *
 * Another document can be shown read-only in place of the live one
 * (`showReadOnly`): the live document and its undo history are held as they
 * are, every edit is refused and undo and redo do nothing, until
 * `endReadOnly` shows the live document again.
 */
export class DocumentStore {
  private state: Doc;
  /** The live document while another is shown read-only; null otherwise. */
  private live: Doc | null = null;
  private rev = 0;
  private readonly history: History;
  private readonly validate: Validator;
  private readonly onListenerError: (error: unknown) => void;
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private readonly historyListeners = new Set<() => void>();
  private readonly rebuildListeners = new Set<(document: Doc, revision: number) => void>();

  constructor(document: Doc, options: StoreOptions = {}) {
    this.validate = options.validate ?? formatRefusals;
    this.onListenerError = options.onListenerError ?? rethrowLater;
    this.history = new History(options.undoLimit);
    this.state = this.checked(frozenCopy(document));
  }

  get document(): Doc {
    return this.state;
  }

  /** Whether the document shown is a read-only one, in place of the live document. */
  get readOnly(): boolean {
    return this.live !== null;
  }

  /** The live document: the one shown, or the one held while another is shown read-only. */
  get liveDocument(): Doc {
    return this.live ?? this.state;
  }

  /** Increases by one on every document change. */
  get revision(): number {
    return this.rev;
  }

  /**
   * Applies an edit. Returns its patches (empty for an edit that changed
   * nothing, which records no undo step). Throws `CommandError` when the
   * recipe throws one or when the result would be refused; the document is
   * then unchanged.
   */
  edit(label: string, recipe: (draft: Draft<Doc>) => void): readonly Patch[] {
    if (this.live !== null) throw new CommandError('read-only', READ_ONLY_MESSAGE);
    const [next, patches, inverse] = immer.produceWithPatches(this.state, recipe);
    if (patches.length === 0) return patches;
    this.checked(next as Doc);
    this.history.record(label, patches, inverse);
    this.set(next as Doc, 'edit', label);
    return patches;
  }

  private checked(document: Doc): Doc {
    const refusals = this.validate(document);
    if (refusals.length > 0) {
      const first = refusals[0] as Diagnostic;
      throw new CommandError('invalid', `${first.message} (at ${first.path || '/'})`, refusals);
    }
    return document;
  }

  undo(): boolean {
    if (this.live !== null) return false;
    const entry = this.history.undo();
    if (!entry) return false;
    this.set(immer.applyPatches(this.state, entry.inverse as Patch[]) as Doc, 'undo', entry.label);
    this.notifyHistory();
    return true;
  }

  redo(): boolean {
    if (this.live !== null) return false;
    const entry = this.history.redo();
    if (!entry) return false;
    this.set(immer.applyPatches(this.state, entry.patches as Patch[]) as Doc, 'redo', entry.label);
    this.notifyHistory();
    return true;
  }

  canUndo(): boolean {
    return this.live === null && this.history.canUndo();
  }

  canRedo(): boolean {
    return this.live === null && this.history.canRedo();
  }

  undoLabel(): string | undefined {
    return this.live === null ? this.history.undoLabel() : undefined;
  }

  redoLabel(): string | undefined {
    return this.live === null ? this.history.redoLabel() : undefined;
  }

  get inTransaction(): boolean {
    return this.history.depth > 0;
  }

  /** Opens a transaction: the edits until the matching close are one undo step (with `amend`, part of the newest one). */
  beginTransaction(label: string, amend = false): void {
    this.history.begin(label, amend);
    if (this.history.depth === 1) this.notifyHistory();
  }

  endTransaction(): void {
    this.history.end();
    if (this.history.depth === 0) this.notifyHistory();
  }

  /** Closes the innermost transaction and reverts every edit made inside it. */
  abortTransaction(): void {
    const inverse = this.history.abort();
    if (inverse.length > 0) this.set(immer.applyPatches(this.state, inverse as Patch[]) as Doc, 'abort', undefined);
    if (this.history.depth === 0) this.notifyHistory();
  }

  /** Runs `body` in a transaction; when it throws, its edits are reverted and the error rethrown. */
  transaction<T>(label: string, body: () => T): T {
    this.beginTransaction(label);
    let result: T;
    try {
      result = body();
    } catch (e) {
      this.abortTransaction();
      throw e;
    }
    this.endTransaction();
    return result;
  }

  /**
   * Runs `body` so that its edits join the newest undo step rather than
   * making one; when there is none they make their own. When it throws, its
   * edits are reverted and the error rethrown.
   */
  amend<T>(label: string, body: () => T): T {
    this.beginTransaction(label, true);
    let result: T;
    try {
      result = body();
    } catch (e) {
      this.abortTransaction();
      throw e;
    }
    this.endTransaction();
    return result;
  }

  /**
   * Replaces the document (a load) and clears the history. A document shown
   * read-only ends with it: the live document held is dropped. Throws when
   * it would be refused.
   */
  replace(document: Doc): void {
    if (this.inTransaction) throw new Error('a document cannot be replaced inside a transaction');
    const next = this.checked(frozenCopy(document));
    this.history.clear();
    this.live = null;
    this.set(next, 'replace', undefined);
    this.notifyHistory();
  }

  /**
   * Shows `document` read-only in place of the live document, which is held
   * with its undo history untouched. While it shows, edits are refused
   * (`CommandError` `read-only`) and undo and redo do nothing. Shown while
   * another is, it takes that one's place. Throws when it would be refused,
   * or when a transaction is open over the live document.
   */
  showReadOnly(document: Doc): void {
    if (this.live === null && this.inTransaction)
      throw new Error('a document cannot be shown read-only inside a transaction');
    const next = this.checked(frozenCopy(document));
    if (this.live === null) this.live = this.state;
    this.set(next, 'readOnly', undefined);
    this.notifyHistory();
  }

  /** Shows the live document again, as it was held; nothing when none is shown read-only. */
  endReadOnly(): void {
    const live = this.live;
    if (live === null) return;
    this.live = null;
    this.set(live, 'live', undefined);
    this.notifyHistory();
  }

  clearHistory(): void {
    this.history.clear();
    this.notifyHistory();
  }

  /** Document changes. Returns the unsubscribe function. */
  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Undo and redo availability changes that are not document changes (a transaction opening or closing). */
  subscribeHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  /** A rebuild request on every document change. */
  onRebuild(listener: (document: Doc, revision: number) => void): () => void {
    this.rebuildListeners.add(listener);
    return () => this.rebuildListeners.delete(listener);
  }

  private set(document: Doc, cause: ChangeCause, label: string | undefined): void {
    this.state = document;
    this.rev++;
    const change: StoreChange = { document, revision: this.rev, cause, label };
    for (const listener of this.listeners) this.notify(() => listener(change));
    for (const listener of this.rebuildListeners) this.notify(() => listener(document, this.rev));
  }

  private notifyHistory(): void {
    for (const listener of this.historyListeners) this.notify(listener);
  }

  private notify(call: () => void): void {
    try {
      call();
    } catch (e) {
      this.onListenerError(e);
    }
  }
}

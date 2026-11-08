import type { Diagnostic } from '@tweakcad/format';
import { featureHandlers } from './commands/features';
import { libraryHandlers } from './commands/library';
import { sketchHandlers } from './commands/sketch';
import { structureHandlers } from './commands/structure';
import { valueHandlers } from './commands/values';
import type { Handler, Handlers } from './commands/common';
import type { CommandType, EditorCommand } from './commands/types';
import { CommandError, type CommandFailure } from './errors';
import { randomIds, type IdGenerator } from './ids';
import { loadDocument, saveDocument } from './load';
import type { Doc } from './rows';
import { DocumentStore, type StoreOptions } from './store';

const HANDLERS: Handlers<CommandType> = {
  ...structureHandlers,
  ...featureHandlers,
  ...valueHandlers,
  ...sketchHandlers,
  ...libraryHandlers,
};

/** The command types the editor runs. */
export const COMMAND_TYPES = Object.keys(HANDLERS) as CommandType[];

/** One entry of the command log. */
export interface LogEntry {
  kind: 'command' | 'undo' | 'redo';
  /** The short label of the undo menu. */
  label: string;
  /** For `command`: the command as run. */
  command?: EditorCommand;
  /** Ids the command made itself (region fates), in order, so a replay makes the same ones. */
  ids?: string[];
  /** The store revision after it. */
  revision: number;
}

export type CommandResult =
  | { ok: true; label: string; /** False when the command changed nothing (no undo step). */ changed: boolean }
  | { ok: false; error: CommandFailure };

export interface EditorOptions extends StoreOptions {
  /** Source of new ids; default random. */
  ids?: IdGenerator;
}

export type OpenResult =
  | { ok: true; editor: Editor; warnings: readonly Diagnostic[] }
  | { ok: false; message: string; diagnostics: readonly Diagnostic[] };

/**
 * The command bus over one document store: runs commands, labels them for
 * the undo menu, logs them, and makes new ids.
 */
export class Editor {
  readonly store: DocumentStore;
  private readonly ids: IdGenerator;
  private readonly entries: LogEntry[] = [];

  constructor(document: Doc | DocumentStore, options: EditorOptions = {}) {
    this.store = document instanceof DocumentStore ? document : new DocumentStore(document, options);
    this.ids = options.ids ?? randomIds();
  }

  /** Opens a `.cadjson` text (see `loadDocument`). */
  static open(text: string, options: EditorOptions = {}): OpenResult {
    const loaded = loadDocument(text);
    if (!loaded.ok) return loaded;
    return { ok: true, editor: new Editor(loaded.document, options), warnings: loaded.warnings };
  }

  get document(): Doc {
    return this.store.document;
  }

  /** The document in canonical form. */
  save(): string {
    return saveDocument(this.store.document);
  }

  /** A new id of a kind, for rows a caller builds before a command adds them. */
  newId(kind: string): string {
    return this.ids(kind);
  }

  get log(): readonly LogEntry[] {
    return this.entries;
  }

  /**
   * Runs one command. A refused command changes nothing and is not logged.
   * `ids` replays the ids a logged run made.
   */
  dispatch(command: EditorCommand, options: { ids?: readonly string[] } = {}): CommandResult {
    const handler = (HANDLERS as Record<string, Handler<CommandType> | undefined>)[command?.type];
    if (!handler) {
      return { ok: false, error: { code: 'unknown-command', message: `unknown command ${String(command?.type)}` } };
    }
    const doc = this.store.document;
    const replay = [...(options.ids ?? [])];
    const made: string[] = [];
    const newId = (kind: string): string => {
      const id = replay.shift() ?? this.ids(kind);
      made.push(id);
      return id;
    };
    let label: string;
    let patches;
    try {
      label = handler.label(command as never, doc);
      patches = this.store.edit(label, (draft) => handler.run(command as never, { doc, draft: draft as Doc, newId }));
    } catch (e) {
      if (e instanceof CommandError) return { ok: false, error: e.toFailure() };
      return { ok: false, error: { code: 'bad-argument', message: e instanceof Error ? e.message : String(e) } };
    }
    if (patches.length === 0) return { ok: true, label, changed: false };
    const entry: LogEntry = { kind: 'command', label, command, revision: this.store.revision };
    if (made.length > 0) entry.ids = made;
    this.entries.push(entry);
    return { ok: true, label, changed: true };
  }

  /** Runs `body` as one undo step; when it throws, everything it did is reverted. */
  transaction<T>(label: string, body: () => T): T {
    const logged = this.entries.length;
    try {
      return this.store.transaction(label, body);
    } catch (e) {
      // The store reverted the transaction, so its commands leave the log.
      this.entries.length = logged;
      throw e;
    }
  }

  /**
   * Runs `body` as part of the newest undo step: what an edit brings about
   * after it (contexts re-captured from it) undoes with it. When it throws,
   * everything it did is reverted.
   */
  amend<T>(label: string, body: () => T): T {
    const logged = this.entries.length;
    try {
      return this.store.amend(label, body);
    } catch (e) {
      this.entries.length = logged;
      throw e;
    }
  }

  undo(): boolean {
    const label = this.store.undoLabel();
    if (!this.store.undo() || label === undefined) return false;
    this.entries.push({ kind: 'undo', label, revision: this.store.revision });
    return true;
  }

  redo(): boolean {
    const label = this.store.redoLabel();
    if (!this.store.redo() || label === undefined) return false;
    this.entries.push({ kind: 'redo', label, revision: this.store.revision });
    return true;
  }
}

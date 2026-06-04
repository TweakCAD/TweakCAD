/**
 * CommandBus - dispatches validated commands to mutate the document.
 * All document mutations flow through this single entry point.
 */

import type { Result } from '../result.ts';
import { ok, err } from '../result.ts';
import type { CadProject } from '../document/schema.ts';
import type { DocumentStore } from '../store/documentStore.ts';
import type { CadCommand } from './types.ts';
import { commandLabel } from './types.ts';

/** Error from command validation */
export type ValidationError = {
  code: string;
  message: string;
  field?: string;
};

/**
 * Throw from a handler's `execute` to reject the command after work that
 * can only be evaluated mid-execute (e.g. running the constraint solver
 * with the candidate constraint in place). Immer's `produce` will throw,
 * `bus.dispatch` will catch and convert to `Result.err(error)`, and no
 * undo entry is recorded — the document state is exactly as it was before
 * dispatch. Use this instead of mutating-then-reverting for clean undo.
 */
export class CommandRejectedError extends Error {
  constructor(public readonly error: ValidationError) {
    super(error.message);
    this.name = 'CommandRejectedError';
  }
}

/** Handler for a specific command type */
export type CommandHandler = {
  /** Validate command inputs before execution */
  validate(command: CadCommand, state: Readonly<CadProject>): Result<void, ValidationError>;
  /**
   * Execute the command by mutating the draft. Throw `CommandRejectedError`
   * to reject after work that must run on the draft (e.g. solver pre-commit).
   */
  execute(draft: CadProject, command: CadCommand): void;
};

export class CommandBus {
  private handlers = new Map<string, CommandHandler>();

  /**
   * @param documentStore - The document store for state mutations
   */
  constructor(private documentStore: DocumentStore) {}

  /**
   * Register a handler for a command type.
   * @param type - The command type string
   * @param handler - The handler implementation
   */
  register(type: string, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Dispatch a command to mutate the document.
   * Validates, executes, and records undo entry.
   * @param command - The command to dispatch
   * @returns Success or validation error
   */
  dispatch(command: CadCommand): Result<void, ValidationError> {
    const handler = this.handlers.get(command.type);
    if (!handler) {
      return err({ code: 'UNKNOWN_COMMAND', message: `Unknown command: ${command.type}` });
    }

    const validation = handler.validate(command, this.documentStore.getState());
    if (!validation.ok) return validation;

    try {
      this.documentStore.mutate(commandLabel(command), draft => {
        handler.execute(draft, command);
      });
    } catch (e) {
      // Handler-initiated rejection: Immer abandoned the recipe, no state
      // change, no undo entry. Convert to Result.err so callers can react.
      if (e instanceof CommandRejectedError) return err(e.error);
      throw e;
    }

    return ok(undefined);
  }

  /**
   * Begin a transaction grouping multiple commands into a single undo step.
   * @param label - Label for the transaction
   */
  beginTransaction(label: string): void {
    this.documentStore.beginTransaction(label);
  }

  /** End the current transaction */
  endTransaction(): void {
    this.documentStore.endTransaction();
  }

  /** Undo the last command or transaction */
  undo(): void {
    this.documentStore.undo();
  }

  /** Redo the last undone command or transaction */
  redo(): void {
    this.documentStore.redo();
  }

  /** @returns Whether undo is available */
  canUndo(): boolean {
    return this.documentStore.canUndo();
  }

  /** @returns Whether redo is available */
  canRedo(): boolean {
    return this.documentStore.canRedo();
  }
}

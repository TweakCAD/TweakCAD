import type { Diagnostic } from '@tweakcad/format';

/** Why a command was refused. */
export type CommandErrorCode =
  /** The command names a row, value or table that does not exist, or one of the wrong kind. */
  | 'not-found'
  /** The command's arguments are malformed. */
  | 'bad-argument'
  /** The edit is not allowed where it is aimed (a cross-owner move, removing the root). */
  | 'not-allowed'
  /** The edited document would break a rule of the format; `diagnostics` says which. */
  | 'invalid'
  /** No command of this type exists. */
  | 'unknown-command'
  /** The store shows a document read-only (`DocumentStore.showReadOnly`). */
  | 'read-only';

export interface CommandFailure {
  code: CommandErrorCode;
  message: string;
  /** For `invalid`: the refusals the edited document would carry. */
  diagnostics?: readonly Diagnostic[];
}

/** Thrown inside a command to refuse it; the store is left as it was. */
export class CommandError extends Error {
  readonly code: CommandErrorCode;
  readonly diagnostics: readonly Diagnostic[] | undefined;

  constructor(code: CommandErrorCode, message: string, diagnostics?: readonly Diagnostic[]) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.diagnostics = diagnostics;
  }

  toFailure(): CommandFailure {
    const failure: CommandFailure = { code: this.code, message: this.message };
    if (this.diagnostics) failure.diagnostics = this.diagnostics;
    return failure;
  }
}

import { FormatError } from '../collections';

/**
 * Decidable from the text, so a document holding one is refused:
 * - `syntax`: the text does not follow the grammar.
 * - `name`: a name in the text is not bound, a `refs` entry is unused or binds
 *   a reserved word, or a function is unknown.
 * - `type`: the whole-expression check, judged with same-document references,
 *   found operands or a result breaking the type rules.
 *
 * Dependent on values, so what uses the value pauses:
 * - `value`: a wrong type only evaluation could show, such as a `lookup`
 *   result, a non-literal exponent, a published value, or a result that is no
 *   exact integer or no option of a choice.
 * - `domain`: division by zero, an out-of-range argument or a non-finite result.
 * - `range`: a value outside its parameter's `range`.
 * - `table`: a malformed lookup table, or a missing key or column.
 * - `unknown`: a grammar version, `refs` shape, quantity or value type this
 *   reader does not know.
 */
export type ExprErrorKind = 'syntax' | 'name' | 'type' | 'value' | 'domain' | 'range' | 'table' | 'unknown';

export class ExprError extends FormatError {
  constructor(
    readonly kind: ExprErrorKind,
    readonly detail: string,
    /** Offset into the expression text, where one applies. */
    readonly at?: number,
  ) {
    super(at === undefined ? detail : `${detail} at offset ${at}`);
    this.name = 'ExprError';
  }

  /** True when the document is refused, false when what uses the value pauses. */
  get integrity(): boolean {
    return this.kind === 'syntax' || this.kind === 'name' || this.kind === 'type';
  }
}

/** Refuses a non-finite result, and gives zero one sign. */
export function finite(x: number, what: string, at?: number): number {
  if (!Number.isFinite(x)) throw new ExprError('domain', `${what} has no finite result`, at);
  return x + 0;
}

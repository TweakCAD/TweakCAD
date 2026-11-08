/**
 * Keeping the undo groups an AI caller opens balanced.
 *
 * A group left open keeps the editor's undo closed and folds every later
 * edit into it. A caller can forget to close one, be cancelled, or
 * disconnect half way, so a balance counts the groups its caller opened and
 * its owner closes exactly those when the caller's work ends (a chat turn
 * finishing, a bridge connection dropping). An `end` with none of the
 * caller's own groups open is ignored, so a caller never closes a group
 * someone else opened.
 */
import type { Transactions } from './document';

export interface TransactionBalance {
  /** Transactions whose begin and end count into this balance. */
  readonly transactions: Transactions;
  /** Closes every group this balance's caller left open. */
  closeOpen(): void;
  /** How many groups the caller has open. */
  readonly open: number;
}

export function createTransactionBalance(inner: Transactions): TransactionBalance {
  let open = 0;
  return {
    transactions: {
      begin(label) {
        inner.begin(label);
        open++;
      },
      end() {
        if (open === 0) return;
        open--;
        inner.end();
      },
    },
    closeOpen() {
      while (open > 0) {
        open--;
        inner.end();
      }
    },
    get open() {
      return open;
    },
  };
}

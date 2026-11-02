/**
 * Keep the undo transactions an AI caller opens balanced.
 *
 * Tools can open and close undo transactions (`begin_transaction` /
 * `end_transaction`). A transaction left open keeps the undo stack open: since
 * undo is refused while one is open, Ctrl+Z stays disabled until it closes,
 * and every later edit joins it. A caller that forgets to close one, is
 * cancelled, or disconnects mid-way would otherwise leave the editor that way
 * for the rest of the session.
 *
 * A balance counts the levels its caller opened, through hosts it wraps, so
 * the owner can close exactly those when the caller's work ends — a chat turn
 * finishing, a bridge connection dropping. An `end_transaction` with none of
 * the caller's own levels open is ignored, so a caller can never close a
 * transaction someone else opened (the chat turn's own, or another caller's).
 */

import type { ToolHost } from '@tweakcad/core/src/ai/toolExecutor.ts';

export type TransactionBalance = {
  /** A host whose transaction methods count into this balance; everything else passes through. */
  wrap(host: ToolHost): ToolHost;
  /** Close every level this balance's caller left open, using `end`. */
  closeOpen(end: () => Promise<void> | void): Promise<void>;
  /** How many levels the caller has open. */
  readonly open: number;
};

export function createTransactionBalance(): TransactionBalance {
  let open = 0;
  return {
    wrap(host) {
      // Inherit every other method (and the optional viewport ones) from the
      // real host; only the transaction pair is replaced.
      const wrapped = Object.create(host) as ToolHost;
      wrapped.beginTransaction = async (label: string) => {
        await host.beginTransaction(label);
        open++;
      };
      wrapped.endTransaction = async () => {
        if (open === 0) return;
        open--;
        await host.endTransaction();
      };
      return wrapped;
    },
    async closeOpen(end) {
      while (open > 0) {
        open--;
        await end();
      }
    },
    get open() {
      return open;
    },
  };
}

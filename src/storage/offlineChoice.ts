/**
 * "Continue offline", remembered for this tab only.
 *
 * `sessionStorage`, deliberately, not `localStorage`: the choice belongs to
 * the window that made it. Someone can have one tab working offline on a
 * local sketch and another signed in on a cloud project, which is exactly
 * the situation the whole storage-modes change exists to make coherent —
 * a shared flag would make the two tabs fight over a single answer.
 *
 * It also means the choice does not outlive the browser session, so a new
 * window gets asked again rather than silently inheriting a decision made
 * last week.
 */

const KEY = 'tweakcad.offlineChosen';

export function hasChosenOffline(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(KEY) === '1';
  } catch {
    // Private-mode and storage-blocked browsers throw on access. Forgetting
    // the choice costs one extra prompt; throwing costs the whole boot.
    return false;
  }
}

export function rememberOfflineChoice(): void {
  try {
    globalThis.sessionStorage?.setItem(KEY, '1');
  } catch {
    // As above: the gate still works, it just asks again on reload.
  }
}

/** Signing in supersedes the choice — the window is no longer offline. */
export function forgetOfflineChoice(): void {
  try {
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    /* nothing to undo */
  }
}

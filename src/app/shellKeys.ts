/**
 * The app's own keys: Ctrl+Z undo, Ctrl+Y or Ctrl+Shift+Z redo, Ctrl+S save
 * (with Shift, Save As), Ctrl+O open, Ctrl+Alt+N new, the backtick toggles
 * the console, Escape steps back (closes the panel, ends the section view,
 * finishes the sketch, or clears the selection, the first that applies),
 * Delete removes the selected features while modelling.
 *
 * With the cursor in a text field the Ctrl/Cmd keys still act on the
 * document and Escape still closes an open panel; the other keys (the
 * backtick, Delete, Escape with no panel) are the field's.
 */
export type ShellAction =
  | 'undo'
  | 'redo'
  | 'save'
  | 'saveAs'
  | 'open'
  | 'new'
  | 'console'
  | 'closePanel'
  | 'endSection'
  | 'finishSketch'
  | 'deselect'
  | 'delete';

export interface ShellKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShellState {
  panel: boolean;
  section: boolean;
  sketching: boolean;
  /** The key goes to a text field. */
  typing?: boolean;
}

/** What a key press does in the shell, or null for a key it leaves alone. */
export function shellAction(e: ShellKey, s: ShellState): ShellAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z' && !e.shiftKey) return 'undo';
  if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) return 'redo';
  if (mod && key === 's') return e.shiftKey ? 'saveAs' : 'save';
  if (mod && key === 'o') return 'open';
  if (mod && e.altKey && key === 'n') return 'new';
  if (s.typing) return e.key === 'Escape' && s.panel ? 'closePanel' : null;
  if (e.key === '`' && !mod) return 'console';
  if (e.key === 'Escape')
    return s.panel ? 'closePanel' : s.section ? 'endSection' : s.sketching ? 'finishSketch' : 'deselect';
  if ((e.key === 'Delete' || e.key === 'Backspace') && !s.sketching) return 'delete';
  return null;
}

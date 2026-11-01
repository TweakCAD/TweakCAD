/**
 * Single-letter keyboard shortcuts for sketch tools. The letters come from
 * the toolbar's tool definitions (the same `shortcut` shown on the buttons
 * and in the dropdown menus), so a shortcut is advertised exactly when it
 * works.
 */

/** Minimal slice of a keydown event the matcher reads. */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  target: EventTarget | null;
}

/** True when the event target takes typed text (inputs, textareas, contenteditable). */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The tool whose shortcut letter matches the key, or null. Ignores
 * modified keys (Ctrl+O opens a file), auto-repeat, and keys typed into a
 * text field. Letters match case-insensitively.
 */
export function sketchToolForKey<Id extends string>(
  e: ShortcutKeyEvent,
  tools: readonly { id: Id; shortcut?: string | undefined }[],
): Id | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  if (e.key.length !== 1 || isEditableTarget(e.target)) return null;
  const key = e.key.toUpperCase();
  return tools.find((t) => t.shortcut?.toUpperCase() === key)?.id ?? null;
}

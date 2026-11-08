import { describe, it, expect } from 'vitest';
import { isEditableTarget, toolForShortcutKey, type ShortcutKeyEvent } from './toolShortcuts.ts';

const TOOLS = [
  { id: 'line', shortcut: 'L' },
  { id: 'point' },
  { id: 'trim', shortcut: 'T' },
  { id: 'offset', shortcut: 'O' },
];

function key(k: string, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: null, ...extra };
}

describe('toolForShortcutKey', () => {
  it('maps a shortcut letter to its tool, either case', () => {
    expect(toolForShortcutKey(key('o'), TOOLS)).toBe('offset');
    expect(toolForShortcutKey(key('O'), TOOLS)).toBe('offset');
    expect(toolForShortcutKey(key('t'), TOOLS)).toBe('trim');
    expect(toolForShortcutKey(key('l'), TOOLS)).toBe('line');
  });

  it('ignores letters without a shortcut and non-letter keys', () => {
    expect(toolForShortcutKey(key('p'), TOOLS)).toBeNull();
    expect(toolForShortcutKey(key('Escape'), TOOLS)).toBeNull();
    expect(toolForShortcutKey(key('Enter'), TOOLS)).toBeNull();
  });

  it('ignores modified keys and auto-repeat', () => {
    expect(toolForShortcutKey(key('o', { ctrlKey: true }), TOOLS)).toBeNull();
    expect(toolForShortcutKey(key('o', { metaKey: true }), TOOLS)).toBeNull();
    expect(toolForShortcutKey(key('o', { altKey: true }), TOOLS)).toBeNull();
    expect(toolForShortcutKey(key('o', { repeat: true }), TOOLS)).toBeNull();
  });

  it('ignores keys typed into text fields', () => {
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'textarea' },
      { tagName: 'SELECT' },
      { isContentEditable: true },
    ]) {
      expect(toolForShortcutKey(key('o', { target: target as unknown as EventTarget }), TOOLS)).toBeNull();
    }
    expect(toolForShortcutKey(key('o', { target: { tagName: 'BUTTON' } as unknown as EventTarget }), TOOLS)).toBe(
      'offset',
    );
  });
});

describe('isEditableTarget', () => {
  it('is false for no target and non-text elements', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { shellAction, type ShellKey, type ShellState } from './shellKeys';

const press = (key: string, mods: Partial<Omit<ShellKey, 'key'>> = {}): ShellKey => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const idle: ShellState = { panel: false, section: false, sketching: false };

describe('shell keys', () => {
  it('undoes, redoes and works with files under Ctrl or Cmd', () => {
    expect(shellAction(press('z', { ctrlKey: true }), idle)).toBe('undo');
    expect(shellAction(press('Z', { metaKey: true, shiftKey: true }), idle)).toBe('redo');
    expect(shellAction(press('y', { ctrlKey: true }), idle)).toBe('redo');
    expect(shellAction(press('s', { ctrlKey: true }), idle)).toBe('save');
    expect(shellAction(press('S', { ctrlKey: true, shiftKey: true }), idle)).toBe('saveAs');
    expect(shellAction(press('o', { ctrlKey: true }), idle)).toBe('open');
    expect(shellAction(press('n', { ctrlKey: true, altKey: true }), idle)).toBe('new');
    expect(shellAction(press('n', { ctrlKey: true }), idle)).toBeNull();
  });

  it('toggles the console with the backtick, not with Ctrl held', () => {
    expect(shellAction(press('`'), idle)).toBe('console');
    expect(shellAction(press('`', { ctrlKey: true }), idle)).toBeNull();
  });

  it('steps back with Escape: the panel, then the section view, then the sketch, then the selection', () => {
    expect(shellAction(press('Escape'), { panel: true, section: true, sketching: true })).toBe('closePanel');
    expect(shellAction(press('Escape'), { panel: false, section: true, sketching: true })).toBe('endSection');
    expect(shellAction(press('Escape'), { panel: false, section: false, sketching: true })).toBe('finishSketch');
    expect(shellAction(press('Escape'), idle)).toBe('deselect');
  });

  it('deletes selected features while modelling only', () => {
    expect(shellAction(press('Delete'), idle)).toBe('delete');
    expect(shellAction(press('Backspace'), idle)).toBe('delete');
    expect(shellAction(press('Delete'), { ...idle, sketching: true })).toBeNull();
    expect(shellAction(press('x'), idle)).toBeNull();
  });

  it('keeps the document keys and closing a panel while typing in a field, and leaves the rest to the field', () => {
    const typing: ShellState = { ...idle, typing: true };
    expect(shellAction(press('s', { ctrlKey: true }), typing)).toBe('save');
    expect(shellAction(press('S', { ctrlKey: true, shiftKey: true }), typing)).toBe('saveAs');
    expect(shellAction(press('o', { metaKey: true }), typing)).toBe('open');
    expect(shellAction(press('n', { ctrlKey: true, altKey: true }), typing)).toBe('new');
    expect(shellAction(press('z', { ctrlKey: true }), typing)).toBe('undo');
    expect(shellAction(press('y', { ctrlKey: true }), typing)).toBe('redo');
    expect(shellAction(press('Escape'), { ...typing, panel: true })).toBe('closePanel');
    expect(shellAction(press('Escape'), { ...typing, section: true })).toBeNull();
    expect(shellAction(press('`'), typing)).toBeNull();
    expect(shellAction(press('Backspace'), typing)).toBeNull();
  });
});

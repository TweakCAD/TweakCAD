import { beforeEach, describe, expect, it } from 'vitest';
import { clearConsole, consoleLog, consoleStore, rebuildMessage, toggleConsole } from './console';

describe('console', () => {
  beforeEach(() => {
    clearConsole();
    consoleStore.setState({ collapsed: true });
  });

  it('logs newest last, drops a repeat within a second, and clears', () => {
    consoleLog('info', 'Rebuilt in 12 ms', 'rebuild');
    consoleLog('info', 'Rebuilt in 12 ms', 'rebuild');
    consoleLog('warn', 'Extrude 1: the profile is gone', 'rebuild');
    expect(consoleStore.getState().entries.map((e) => [e.level, e.message])).toEqual([
      ['info', 'Rebuilt in 12 ms'],
      ['warn', 'Extrude 1: the profile is gone'],
    ]);
    clearConsole();
    expect(consoleStore.getState().entries).toEqual([]);
  });

  it('opens on an error, and the toggle (the backtick key, the panel header) opens and collapses it', () => {
    consoleLog('info', 'Opened', 'file');
    expect(consoleStore.getState().collapsed).toBe(true);
    consoleLog('error', 'Rebuild failed', 'rebuild');
    expect(consoleStore.getState().collapsed).toBe(false);
    toggleConsole();
    expect(consoleStore.getState().collapsed).toBe(true);
    toggleConsole();
    expect(consoleStore.getState().collapsed).toBe(false);
  });
});

describe('the rebuild line', () => {
  it('counts the features a rebuild reused, in the singular for one', () => {
    expect(rebuildMessage(12.4, 0)).toBe('Rebuilt in 12 ms');
    expect(rebuildMessage(12.4, 1)).toBe('Rebuilt in 12 ms (1 feature reused)');
    expect(rebuildMessage(30, 4)).toBe('Rebuilt in 30 ms (4 features reused)');
  });
});

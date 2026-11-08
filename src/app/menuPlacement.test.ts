import { describe, expect, it } from 'vitest';
import { MENU_MARGIN, keptInWindow } from './menuPlacement';

describe('a menu opened at the pointer', () => {
  it('stays where it was asked when it fits', () => {
    expect(keptInWindow(100, 200, 160, 300, 1200, 800)).toEqual({ x: 100, y: 200 });
  });

  it('moves up when it would run off the bottom, and left off the right', () => {
    expect(keptInWindow(1150, 700, 160, 300, 1200, 800)).toEqual({
      x: 1200 - 160 - MENU_MARGIN,
      y: 800 - 300 - MENU_MARGIN,
    });
  });

  it('keeps its top in the window when it is taller than the window', () => {
    expect(keptInWindow(100, 500, 160, 900, 1200, 800).y).toBe(MENU_MARGIN);
  });
});

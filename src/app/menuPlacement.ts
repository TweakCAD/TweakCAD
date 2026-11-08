/**
 * A menu opened at the pointer is moved up or left as far as it needs to be
 * to stay inside the window.
 */
import { useLayoutEffect, type RefObject } from 'react';

/** The gap kept between a menu and the window's edge, in pixels. */
export const MENU_MARGIN = 8;

/** Where a menu of `width` × `height` asked to open at (`x`, `y`) goes in a `viewWidth` × `viewHeight` window. */
export function keptInWindow(
  x: number,
  y: number,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
  const fit = (at: number, size: number, view: number) =>
    Math.max(MENU_MARGIN, Math.min(at, view - size - MENU_MARGIN));
  return { x: fit(x, width, viewWidth), y: fit(y, height, viewHeight) };
}

/** Keeps the fixed-position menu in `ref`, opened at `at` (each opening a new object), inside the window. */
export function useKeptInWindow(ref: RefObject<HTMLElement | null>, at: { x: number; y: number } | null): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !at) return;
    const { width, height } = el.getBoundingClientRect();
    const placed = keptInWindow(at.x, at.y, width, height, window.innerWidth, window.innerHeight);
    el.style.left = `${placed.x}px`;
    el.style.top = `${placed.y}px`;
  }, [ref, at]);
}

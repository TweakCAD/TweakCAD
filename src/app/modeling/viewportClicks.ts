/**
 * A panel's own clicks in the viewport: a left click (a press and release
 * that barely moved) goes to the panel with what lies under it, instead of
 * selecting. Drags still orbit, and hovering still highlights.
 *
 * Keys name entities of one evaluation. A click made while a newer
 * evaluation is on its way (just after an edit, or while a preview
 * rebuilds) waits until it is shown and picks again at the same point, so
 * the panel never asks the service about a key of a display it has left
 * behind.
 */
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import type { Viewport, ViewportPointer } from '../viewport/Viewport';

/** Pixels the pointer may move between press and release for a click. */
const CLICK_PIXELS = 3;

/** What a click needs to wait for the newest display. */
export type NewestDisplay = Pick<AppServices, 'scheduler' | 'whenShown'>;

/** Calls `onClick` with what lies under `e`, once the newest display is shown. */
export function clickWhenShown(
  services: NewestDisplay,
  viewport: Viewport,
  e: ViewportPointer,
  onClick: (item: SelectionItem | null, e: ViewportPointer) => void,
): void {
  if (!services.scheduler.busy) {
    onClick(viewport.pickAt(e.clientX, e.clientY), e);
    return;
  }
  void services.whenShown().then(() => onClick(viewport.pickAt(e.clientX, e.clientY), e));
}

/**
 * Takes the viewport's left clicks for `onClick`. With `gizmo`, a press
 * on one of its handles (it is dragging by then) and the drag that
 * follows are the gizmo's: they neither orbit nor click. `onMove` is told
 * where the pointer moves while no button is pressed.
 */
export function takeClicks(
  services: NewestDisplay,
  viewport: Viewport,
  onClick: (item: SelectionItem | null, e: ViewportPointer) => void,
  gizmo?: () => boolean,
  onMove?: (e: ViewportPointer) => void,
): () => void {
  let down: { x: number; y: number } | null = null;
  let dragging = false;
  const handler = (e: ViewportPointer): boolean => {
    if (e.type === 'move') {
      if (dragging) viewport.requestRender();
      else if (!down) onMove?.(e);
      return dragging;
    }
    if (e.button !== 0) return false;
    if (e.type === 'down') {
      dragging = gizmo?.() ?? false;
      down = { x: e.clientX, y: e.clientY };
      return dragging;
    }
    if (dragging) {
      dragging = false;
      down = null;
      return true;
    }
    const from = down;
    down = null;
    if (!from || Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_PIXELS) return false;
    clickWhenShown(services, viewport, e, onClick);
    return true;
  };
  viewport.setPointerHandler(handler);
  return () => viewport.setPointerHandler(null);
}

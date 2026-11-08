import { describe, expect, it } from 'vitest';
import type { SelectionItem } from '../selection';
import type { Viewport, ViewportPointer } from '../viewport/Viewport';
import { takeClicks, type NewestDisplay } from './viewportClicks';

/** A viewport whose pick answers what the newest scene shows. */
function fakeViewport(shown: { item: SelectionItem | null }) {
  let handler: ((e: ViewportPointer) => boolean) | null = null;
  const viewport = {
    setPointerHandler: (h: typeof handler) => {
      handler = h;
    },
    pickAt: () => shown.item,
  } as unknown as Viewport;
  const press = (type: 'down' | 'up') =>
    handler?.({ type, clientX: 10, clientY: 10, button: 0, shift: false, ctrl: false, alt: false }) ?? false;
  return { viewport, click: () => [press('down'), press('up')] };
}

function fakeServices(busy: boolean) {
  let release: () => void = () => undefined;
  const state = { busy };
  const services = {
    scheduler: {
      get busy() {
        return state.busy;
      },
    },
    whenShown: () => new Promise<void>((r) => (release = r)),
  } as unknown as NewestDisplay;
  return { services, settle: () => ((state.busy = false), release()) };
}

describe('panel clicks in the viewport', () => {
  it('pick what is under the pointer at once when the newest display is shown', () => {
    const shown = { item: { key: 4 } as SelectionItem | null };
    const { viewport, click } = fakeViewport(shown);
    const got: (SelectionItem | null)[] = [];
    takeClicks(fakeServices(false).services, viewport, (item) => got.push(item));
    expect(click()).toEqual([false, true]);
    expect(got).toEqual([{ key: 4 }]);
  });

  it('wait for an evaluation in flight and pick again in the display it shows', async () => {
    const shown = { item: { key: 4 } as SelectionItem | null };
    const { viewport, click } = fakeViewport(shown);
    const { services, settle } = fakeServices(true);
    const got: (SelectionItem | null)[] = [];
    takeClicks(services, viewport, (item) => got.push(item));
    expect(click()).toEqual([false, true]);
    expect(got).toEqual([]);
    // The new evaluation numbers the same face 9.
    shown.item = { key: 9 };
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual([{ key: 9 }]);
  });

  it('leave a press on a gizmo handle and its drag to the gizmo', () => {
    const shown = { item: { key: 4 } as SelectionItem | null };
    const { viewport, click } = fakeViewport(shown);
    (viewport as unknown as { requestRender: () => void }).requestRender = () => undefined;
    const got: (SelectionItem | null)[] = [];
    let onHandle = true;
    takeClicks(
      fakeServices(false).services,
      viewport,
      (item) => got.push(item),
      () => onHandle,
    );
    expect(click()).toEqual([true, true]);
    expect(got).toEqual([]);
    onHandle = false;
    expect(click()).toEqual([false, true]);
    expect(got).toEqual([{ key: 4 }]);
  });
});

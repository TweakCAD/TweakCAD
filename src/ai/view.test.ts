import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiContext, ViewControl } from './context';
import { FRAME_WAIT_MS, viewScreenshot } from './view';

/** A context whose display is settled and current, with a viewport that records its screenshots. */
function context(): { ctx: AiContext; shots: () => number } {
  let shots = 0;
  const canvas = { width: 400, height: 300 } as HTMLCanvasElement;
  const vp: ViewControl = {
    fitToView: () => undefined,
    setStandardView: () => undefined,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    screenshot: () => {
      shots++;
      return 'data:image/jpeg;base64,AAAA';
    },
    getCanvas: () => canvas,
  };
  const services = {
    scheduler: { previewing: false, busy: false, whenIdle: () => Promise.resolve() },
    display: { getState: () => ({ display: {}, error: null, preview: false, revision: 1 }) },
    editor: { store: { revision: 1 } },
  };
  return { ctx: { services, viewport: () => vp } as unknown as AiContext, shots: () => shots };
}

describe('view_screenshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers in a hidden tab, where no animation frame comes', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const { ctx, shots } = context();
    const shot = viewScreenshot(ctx);
    await vi.advanceTimersByTimeAsync(FRAME_WAIT_MS);
    await expect(shot).resolves.toEqual({ kind: 'image', mimeType: 'image/jpeg', data: 'AAAA' });
    expect(shots()).toBe(1);
  });

  it('takes the picture at the next frame when frames come', async () => {
    let frame: (() => void) | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frame = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const { ctx, shots } = context();
    const shot = viewScreenshot(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(shots()).toBe(0);
    (frame as (() => void) | null)?.();
    await expect(shot).resolves.toMatchObject({ kind: 'image', data: 'AAAA' });
    expect(shots()).toBe(1);
  });
});

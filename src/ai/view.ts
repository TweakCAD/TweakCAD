/**
 * The view tools: the camera, and a screenshot of the viewport as an image
 * value, scaled down so its size stays predictable.
 */
import type { Json } from '@tweakcad/editor';
import { str, type Args } from './common';
import { ToolError, invalid, settledDisplay, type AiContext, type ViewControl } from './context';

/** An image a tool returns: the tool loop and the bridge send it as image content, not as text. */
export interface ToolImageValue {
  kind: 'image';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Base64 data, without a `data:` prefix. */
  data: string;
}

export function isToolImageValue(v: unknown): v is ToolImageValue {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<ToolImageValue>;
  return o.kind === 'image' && typeof o.mimeType === 'string' && typeof o.data === 'string';
}

/** The long side of a screenshot, in pixels. */
export const SCREENSHOT_SIZE = 768;

function viewport(ctx: AiContext): ViewControl {
  const vp = ctx.viewport();
  if (!vp) throw new ToolError('UNSUPPORTED_BY_HOST', 'No viewport is shown here.');
  return vp;
}

const VIEWS = ['front', 'back', 'top', 'bottom', 'left', 'right', 'home'] as const;

export function viewFitAll(ctx: AiContext): Json {
  viewport(ctx).fitToView();
  return { ok: true };
}

export function viewSetStandard(ctx: AiContext, args: Args): Json {
  const view = str(args, 'view');
  if (!(VIEWS as readonly string[]).includes(view)) throw invalid(`\`view\` is one of ${VIEWS.join(', ')}`);
  viewport(ctx).setStandardView(view as (typeof VIEWS)[number]);
  return { ok: true };
}

export function viewZoom(ctx: AiContext, args: Args): Json {
  const direction = args.direction;
  if (direction !== 'in' && direction !== 'out') throw invalid("`direction` is 'in' or 'out'");
  const vp = viewport(ctx);
  if (direction === 'in') vp.zoomIn();
  else vp.zoomOut();
  return { ok: true };
}

/** The viewport as a JPEG, at most `SCREENSHOT_SIZE` on its long side, once the newest rebuild is drawn. */
export async function viewScreenshot(ctx: AiContext): Promise<ToolImageValue> {
  const vp = viewport(ctx);
  await settledDisplay(ctx);
  // A frame for the newest display, so the picture shows it.
  await new Promise<void>((resolve) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => resolve()) : resolve(),
  );
  const full = vp.screenshot(0.8);
  const canvas = vp.getCanvas();
  const scale = Math.min(1, SCREENSHOT_SIZE / Math.max(canvas.width, canvas.height, 1));
  let url = full;
  if (scale < 1 && typeof document !== 'undefined') {
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(canvas.width * scale));
    out.height = Math.max(1, Math.round(canvas.height * scale));
    // The WebGL canvas still holds the frame `screenshot` just drew.
    out.getContext('2d')?.drawImage(canvas, 0, 0, out.width, out.height);
    url = out.toDataURL('image/jpeg', 0.6);
  }
  const comma = url.indexOf(',');
  return { kind: 'image', mimeType: 'image/jpeg', data: comma >= 0 ? url.slice(comma + 1) : url };
}

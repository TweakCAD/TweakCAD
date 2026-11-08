/**
 * A project thumbnail from the viewport's canvas: the view scaled to fit
 * 800 × 600, letterboxed in the viewport's background colour, as WebP (PNG
 * where WebP is not encoded). The renderer keeps its drawing buffer, so the
 * canvas holds the last frame drawn.
 */

export async function canvasThumbnail(
  source: HTMLCanvasElement,
  { width = 800, height = 600, quality = 0.8 }: { width?: number; height?: number; quality?: number } = {},
): Promise<Blob | null> {
  if (source.width === 0 || source.height === 0) return null;
  if (typeof OffscreenCanvas === 'undefined') return null;
  const off = new OffscreenCanvas(width, height);
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  const { x, y, w, h } = fitRect(source.width, source.height, width, height);
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, w, h);
  try {
    return await off.convertToBlob({ type: 'image/webp', quality });
  } catch {
    try {
      return await off.convertToBlob({ type: 'image/png' });
    } catch {
      return null;
    }
  }
}

/** The rectangle a `sw` × `sh` image takes, centred and scaled to fit `dw` × `dh`. */
export function fitRect(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

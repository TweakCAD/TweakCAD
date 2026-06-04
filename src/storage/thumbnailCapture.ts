/**
 * Module-level registry for the thumbnail capture function.
 *
 * The viewport controller (which can render a snapshot) lives in the React
 * Shell component, but cloud saves happen in the autosave/cloudAdapter
 * layer which has no direct access to React state. This module is the
 * indirection: Shell registers its capture function on mount; cloudAdapter
 * calls `captureThumbnail()` whenever it's about to push a save to the API.
 *
 * Capture failures are non-fatal — the save proceeds without a thumbnail.
 */
type CaptureFn = () => Promise<Blob | null>;

let captureFn: CaptureFn | null = null;

/**
 * Register the capture function. Pass `null` on viewport unmount to clear.
 * Returns a disposer that clears the registration (idempotent — only
 * clears if the current fn is still ours).
 */
export function registerThumbnailCapture(fn: CaptureFn | null): () => void {
  captureFn = fn;
  return () => {
    if (captureFn === fn) captureFn = null;
  };
}

/**
 * Invoke the registered capture function. Returns null when no viewport
 * is mounted or when capture throws — caller treats null as "no
 * thumbnail this save, no big deal".
 */
export async function captureThumbnail(): Promise<Blob | null> {
  if (!captureFn) return null;
  try {
    return await captureFn();
  } catch (err) {
    console.warn('[thumbnail] capture failed', err);
    return null;
  }
}

/**
 * planegcs WASM loader.
 *
 * Eager-init at app boot per user preference: the editor stays sync and the
 * WASM cost (one network fetch + one compile) is paid once during startup.
 * Called from appInit.ts when the planegcs solver is enabled in settings.
 *
 * The WASM file is imported through Vite as a hashed asset (`?url`). Vite
 * emits it under `<base>assets/planegcs-<hash>.wasm` and rewrites the URL with
 * the build's `base` — so it resolves correctly whether the editor is served
 * at the domain root (standalone image, `base=/`) or under `/cad` (embedded in
 * the site, `base=/cad/`). A root-absolute `/planegcs/...` literal would 404
 * in the `/cad` embed. The content hash also makes it self-busting behind a
 * CDN, and it's still bundled locally (no CDN dependency, offline-capable) —
 * which is why we no longer copy it into `public/` via a sync script.
 */

import { make_gcs_wrapper } from '@salusoft89/planegcs';
import planegcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { attachPlaneGCSWrapper, getPlaneGCSSolver } from '@tweakcad/core/src/sketch/solver/index.ts';
import type { PlaneGCSSolver } from '@tweakcad/core/src/sketch/solver/PlaneGCSSolver.ts';

export { getPlaneGCSSolver } from '@tweakcad/core/src/sketch/solver/index.ts';
export type { PlaneGCSSolver };

/**
 * Load the WASM module and hand the resulting wrapper to the registry.
 * Safe to call multiple times — second+ calls are a no-op if already
 * initialised (the registry's attachPlaneGCSWrapper skips re-attach).
 *
 * Resolves once ready. Rejects if the WASM fetch fails. Init failure
 * leaves the registry in a "not ready" state and every subsequent
 * `getSolver()` will throw `PlaneGCSNotReadyError` until the wrapper is
 * attached — there is no fallback solver to absorb this
 * case during the boot window.
 */
export async function initPlaneGCS(wasmPath: string = planegcsWasmUrl): Promise<void> {
  if (getPlaneGCSSolver().ready) return;
  const wrapper = await make_gcs_wrapper(wasmPath);
  attachPlaneGCSWrapper(wrapper);
}

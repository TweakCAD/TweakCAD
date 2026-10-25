/**
 * Attach a live planegcs solver for tests that exercise the build path.
 *
 * `buildSketch` loads the solver through `ensureSketchSolver`, which imports
 * the WASM with Vite's `?url`. That resolves to a hashed asset in a browser
 * build — and it does, the production build proves it — but under vitest the
 * URL is handed to Emscripten as a filesystem path and resolved against the
 * wrong root, so the module fails to open.
 *
 * Attaching here sidesteps it entirely: `ensureSketchSolver` returns early
 * when the registry already holds a solver, so the `?url` path is never
 * taken. Resolution goes through Node instead, with `realpathSync` so
 * Emscripten's internal `dirname(__filename) + locateFile()` lands inside the
 * real package directory rather than the pnpm symlink.
 */

import { make_gcs_wrapper } from '@salusoft89/planegcs';
import {
  attachPlaneGCSWrapper,
  getPlaneGCSSolver,
} from '@tweakcad/core/src/sketch/solver/index.ts';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function findWasm(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From lib/testing/src: two up reaches the repo root where node_modules
  // lives. The extra candidates cover hoisted layouts.
  const candidates = [
    resolve(here, '../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    resolve(here, '../../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
  ];
  for (const c of candidates) if (existsSync(c)) return realpathSync(c);
  throw new Error('planegcs.wasm not found — check @salusoft89/planegcs install');
}

/** Idempotent: a second call with a solver already attached is a no-op. */
export async function attachTestSolver(): Promise<void> {
  if (getPlaneGCSSolver().ready) return;
  attachPlaneGCSWrapper(await make_gcs_wrapper(findWasm()));
}

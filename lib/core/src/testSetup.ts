/**
 * vitest setup — loads the planegcs WASM module once before any test
 * runs so the `getSolver()` registry is satisfied. With the in-house LM
 * solver retired, every test that goes through the bus
 * (`sketchDrawCommands.test.ts`, `sketchUndoE2E.test.ts`, etc.) would
 * otherwise throw `PlaneGCSNotReadyError` on the first solve.
 *
 * The WASM file ships inside `@salusoft89/planegcs` — same package that
 * provides `make_gcs_wrapper`. We resolve it via Node module resolution
 * so the tests work in any environment where the dep is installed
 * (local dev, CI, the SaaS server). No copy-out step required (unlike
 * the browser build which serves it from `public/planegcs/`).
 */

import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { attachPlaneGCSWrapper, getPlaneGCSSolver } from './sketch/solver/index.ts';
import { beforeAll } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function findWasm(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From cad/lib/core/src: three-up reaches cad/ (where node_modules lives now
  // that the libs are folded in). Extra fallbacks cover hoisted layouts.
  const candidates = [
    resolve(here, '../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    resolve(here, '../../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    resolve(here, '../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
  ];
  for (const c of candidates) if (existsSync(c)) return realpathSync(c);
  throw new Error('planegcs.wasm not found — check @salusoft89/planegcs install');
}

beforeAll(async () => {
  if (getPlaneGCSSolver().ready) return;
  const wrapper = await make_gcs_wrapper(findWasm());
  attachPlaneGCSWrapper(wrapper);
});

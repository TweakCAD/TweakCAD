/** planegcs for the sketch session tests, loaded from disk (kept out of the type check, which has no Node types). */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';

export async function loadTestSolver(): Promise<GcsWrapper> {
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [2, 3, 4]
    .map((up) => resolve(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'))
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  return make_gcs_wrapper(realpathSync(wasm));
}

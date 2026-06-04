import { defineConfig } from 'vitest/config';

/**
 * Vitest config for @tweakcad/core.
 *
 * `setupFiles` runs `src/testSetup.ts` once before any test file so the
 * planegcs WASM is attached to the solver registry. Required since task
 * U retired the in-house LM solver; bus tests (`SketchApplyConstraint`
 * etc.) now need a live planegcs instead of the always-ready LM fallback.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/testSetup.ts'],
  },
});

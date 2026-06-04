/**
 * Smoke test for the planegcs adapter.
 *
 * Confirms that:
 *   - The WASM module loads in vitest (Node + jsdom env).
 *   - A trivial horizontal-constraint sketch solves correctly.
 *   - Updated point positions round-trip back through the adapter.
 *
 * This is the spike's go/no-go check — if WASM init fails here, the
 * adapter can't be used at runtime either, and the registry stays on LM.
 */

import { describe, expect, it } from 'vitest';
import { initPlaneGCS, getPlaneGCSSolver } from './planegcsLoader.ts';
import {
  sketchConstraintId,
  sketchGeometryId,
  sketchPointId,
  type SketchConstraint,
  type SketchGeometry,
  type SketchPoint,
  type SketchPointId,
  type SketchGeometryId,
  type SketchConstraintId,
} from '@tweakcad/core/src/sketch/types.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

// In Node, Emscripten doesn't use fetch — it uses fs.readFileSync — so we
// pass an absolute filesystem path (not a file:// URL). The package is
// symlinked through pnpm's content-addressed store; resolve the real path
// so Emscripten's internal `path.dirname(__filename) + locateFile()` math
// lands inside the actual planegcs_dist directory.
function findWasm(): string {
  // Try the local workspace node_modules first (where pnpm hoists hard deps),
  // then the repo-root node_modules (where pnpm puts the .pnpm content store).
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    resolve(here, '../../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return realpathSync(c);
  }
  throw new Error('planegcs.wasm not found in any expected node_modules location');
}
const wasmPath = findWasm();

describe('PlaneGCSSolver smoke', () => {
  it('loads WASM and solves a horizontal constraint', async () => {
    await initPlaneGCS(wasmPath);
    const solver = getPlaneGCSSolver();
    expect(solver.ready).toBe(true);

    const a: SketchPointId = sketchPointId('p_a');
    const b: SketchPointId = sketchPointId('p_b');
    const line: SketchGeometryId = sketchGeometryId('g_line');
    const horiz: SketchConstraintId = sketchConstraintId('c_horiz');

    const points = new Map<SketchPointId, SketchPoint>([
      [a, { id: a, x: 0, y: 0, fixed: false }],
      [b, { id: b, x: 10, y: 5, fixed: false }],
    ]);
    const geometries = new Map<SketchGeometryId, SketchGeometry>([
      [line, { id: line, type: 'line', startId: a, endId: b, construction: false }],
    ]);
    const constraints = new Map<SketchConstraintId, SketchConstraint>([
      [horiz, { id: horiz, type: 'horizontal', geometryId: line }],
    ]);

    const result = solver.solve(points, geometries, constraints, new Set([a]));

    expect(result.diagnostic.converged).toBe(true);
    expect(result.diagnostic.unsatisfied.size).toBe(0);
    // Horizontal means endY == startY. `a` is anchored, so `b` must move to y=0.
    const pb = result.points.get(b)!;
    expect(pb.y).toBeCloseTo(0, 6);
    // x of `b` should stay near 10 (planegcs has no reason to move it).
    expect(pb.x).toBeCloseTo(10, 3);
  }, 30_000);
});

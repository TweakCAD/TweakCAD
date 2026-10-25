/**
 * Parity check: a parametric component driven by a *dimension constraint*
 * rather than by an expression baked into a `buildGeometry` coordinate.
 *
 * This is the test that decides whether `buildGeometry` can be collapsed.
 *
 * A component is parametric because instancing it with different parameter
 * values yields different geometry. Until now the only mechanism for that was
 * an `Expression` sitting in a coordinate — `diameter: 'D'` — which is why
 * deleting the stored projection would have removed the capability. With
 * expressions on dimension constraints and a solver in the build path, the
 * same behaviour has a home inside `editorModel`, which is derivable.
 *
 * If this passes, the projection carries nothing unique and can go.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { featureId } from '@tweakcad/core/src/ids.ts';
import { buildSketch } from './buildSketch.ts';

/**
 * A component sketch: one circle whose radius is driven by the public
 * parameter `D`. No expression appears in a coordinate — the parameter
 * reaches the geometry through the constraint the solver enforces.
 */
function parametricCircleSketch(): FeatureNode {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: featureId('sk_param'),
    type: 'sketch',
    name: 'Parametric circle',
    version: 1,
    enabled: true,
    visible: true,
    dependsOn: [],
    createdAt: now,
    updatedAt: now,
    inputs: {
      plane: { type: 'defaultPlane', name: 'XY' },
      buildGeometry: {
        c: { id: 'c', type: 'circle', center: ['0', '0'], diameter: '10' },
      },
      editorModel: {
        points: [{ id: 'pc', x: 0, y: 0, fixed: true }],
        geometries: [{ id: 'c', type: 'circle', centerId: 'pc', radius: 5, construction: false }],
        constraints: [
          // The whole point: a radius dimension carrying an expression.
          { id: 'con_r', type: 'radius', geometryId: 'c', value: 5, expression: 'D / 2' },
        ],
      },
    } as unknown as Record<string, unknown>,
  } as FeatureNode;
}

/** Radius the sketch actually built with, read back from the resolved output. */
async function builtRadius(params: ResolvedParams): Promise<number> {
  const kernel = new MockKernel();
  await kernel.init();
  const ctx = emptyBuildContext(params);
  const result = await buildSketch(parametricCircleSketch(), params, ctx, kernel);
  const data = (result.outputs as { data?: { resolvedEntities?: Record<string, { diameter?: number }> } })
    ?.data;
  const circle = data?.resolvedEntities?.['c'];
  if (!circle || typeof circle.diameter !== 'number') {
    throw new Error(`no resolved circle in output: ${JSON.stringify(result.outputs)}`);
  }
  return circle.diameter / 2;
}

describe('parametric component via dimension constraint', () => {
  beforeAll(attachTestSolver, 30_000);

  it('builds the radius the parameter asks for', async () => {
    expect(await builtRadius({ D: 10 })).toBeCloseTo(5, 6);
  });

  it('builds a DIFFERENT radius for a different parameter value', async () => {
    // Parity with the old mechanism: this is what "parametric component"
    // means — one definition, many instances, geometry following the value.
    expect(await builtRadius({ D: 30 })).toBeCloseTo(15, 6);
  });

  it('ignores the stale number stored on the constraint', async () => {
    // `value: 5` is baked into the fixture as the last solved radius. If the
    // build used it instead of re-evaluating, every instance would be 5 mm
    // and the component would not be parametric at all.
    const r = await builtRadius({ D: 100 });
    expect(r).toBeCloseTo(50, 6);
    expect(r).not.toBeCloseTo(5, 1);
  });
});

/**
 * Tests for buildSketch — particularly the region-detection pre-resolve
 * step, where the sketch builder must bake expression-driven entity
 * dimensions into literal numerics before handing the entities to the
 * region detector. The detector uses `Number(value)`-style coercion and
 * silently drops anything that doesn't parse — without the pre-resolve,
 * a `diameter: "D"` entity produces zero regions and breaks downstream
 * extrudes.
 */
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { sketchInputs } from '@tweakcad/testing/src/sketchFixtures.ts';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSketch } from './buildSketch.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { FeatureNode, SketchFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import { featureId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { ResolvedSketchRegionData } from './buildSketch.ts';

function makeCircleSketch(diameterExpr: string): FeatureNode {
  // Diameter is driven by a radius dimension carrying the expression —
  // the mechanism that replaced expression-valued coordinates.
  const inputs: SketchFeatureInputs = sketchInputs({
    circles: [{ id: 'circle_1', center: [0, 0], diameter: 10 }],
    constraints: [{
      id: 'con_r', type: 'radius', geometryId: 'circle_1',
      value: 5, expression: `(${diameterExpr}) / 2`,
    }],
  });
  return {
    id: featureId('sketch_1'),
    type: 'sketch',
    name: 'Test Sketch',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00Z',
    updatedAt: '2026-05-24T00:00:00Z',
  };
}

/**
 * A parametric rectangle: four lines sharing corner points, held square by
 * horizontal/vertical constraints, with width and height driven by signed
 * distance dimensions carrying parameter expressions.
 *
 * Starts at 2x1 on purpose. If the solve did not run, the derived geometry
 * would still be 2x1 and the area assertion would fail — so the test cannot
 * pass by accident with the dimensions merely recorded.
 */
function makeRectSketch(widthExpr: string, heightExpr: string): FeatureNode {
  const inputs = {
    plane: { type: 'defaultPlane', name: 'XY' },
    editorModel: {
      points: [
        { id: 'p_bl', x: -1, y: -0.5, fixed: true },
        { id: 'p_br', x: 1, y: -0.5, fixed: false },
        { id: 'p_tr', x: 1, y: 0.5, fixed: false },
        { id: 'p_tl', x: -1, y: 0.5, fixed: false },
      ],
      geometries: [
        { id: 'rect_bottom', type: 'line', startId: 'p_bl', endId: 'p_br', construction: false },
        { id: 'rect_right', type: 'line', startId: 'p_br', endId: 'p_tr', construction: false },
        { id: 'rect_top', type: 'line', startId: 'p_tr', endId: 'p_tl', construction: false },
        { id: 'rect_left', type: 'line', startId: 'p_tl', endId: 'p_bl', construction: false },
      ],
      constraints: [
        { id: 'c_hb', type: 'horizontal', geometryId: 'rect_bottom' },
        { id: 'c_ht', type: 'horizontal', geometryId: 'rect_top' },
        { id: 'c_vl', type: 'vertical', geometryId: 'rect_left' },
        { id: 'c_vr', type: 'vertical', geometryId: 'rect_right' },
        { id: 'c_w', type: 'distanceX', pointA: 'p_bl', pointB: 'p_br', value: 2, expression: widthExpr },
        { id: 'c_h', type: 'distanceY', pointA: 'p_bl', pointB: 'p_tl', value: 1, expression: heightExpr },
      ],
    },
  };
  return {
    id: featureId('sketch_rect'),
    type: 'sketch',
    name: 'Rect Sketch',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-24T00:00:00Z',
    updatedAt: '2026-05-24T00:00:00Z',
  };
}

function ctx(): BuildContext {
  return emptyBuildContext({} as ResolvedParams);
}

describe('buildSketch region detection with parameter-driven entities', () => {
  beforeAll(attachTestSolver, 30_000);

  it('detects a region for a circle whose diameter is a literal numeric string', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const result = await buildSketch(makeCircleSketch('10'), {}, ctx(), kernel);
    const regions = result.outputs?.data?.resolvedRegions as Record<string, ResolvedSketchRegionData>;
    expect(Object.keys(regions ?? {})).toHaveLength(1);
  });

  it('detects a region for a circle whose diameter references a parameter', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const params: ResolvedParams = { D: 8 };
    const result = await buildSketch(makeCircleSketch('D'), params, ctx(), kernel);
    const regions = result.outputs?.data?.resolvedRegions as Record<string, ResolvedSketchRegionData>;
    const list = Object.values(regions ?? {});
    expect(list).toHaveLength(1);
    // Area should match the resolved diameter (D=8 → r=4 → area=π·16)
    expect(list[0]!.area).toBeCloseTo(Math.PI * 16, 5);
  });

  it('detects a region for a circle whose diameter is a parametric expression', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const params: ResolvedParams = { D: 6 };
    const result = await buildSketch(makeCircleSketch('D * 2'), params, ctx(), kernel);
    const regions = result.outputs?.data?.resolvedRegions as Record<string, ResolvedSketchRegionData>;
    const list = Object.values(regions ?? {});
    expect(list).toHaveLength(1);
    // diameter = 12, radius = 6, area = π·36
    expect(list[0]!.area).toBeCloseTo(Math.PI * 36, 5);
  });

  it('detects a region for a parametric rectangle', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const params: ResolvedParams = { W: 20, H: 10 };
    const result = await buildSketch(makeRectSketch('W', 'H'), params, ctx(), kernel);
    const regions = result.outputs?.data?.resolvedRegions as Record<string, ResolvedSketchRegionData>;
    const list = Object.values(regions ?? {});
    expect(list).toHaveLength(1);
    expect(list[0]!.area).toBeCloseTo(200, 5);
  });

  it('regions are keyed by entity id so extrudes can match wireEntityIds', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const result = await buildSketch(makeCircleSketch('D'), { D: 5 }, ctx(), kernel);
    const regions = result.outputs?.data?.resolvedRegions as Record<string, ResolvedSketchRegionData>;
    const list = Object.values(regions ?? {});
    expect(list[0]!.entityIds.map(String)).toEqual(['circle_1']);
  });
});

/**
 * Tests for buildSketch — particularly the region-detection pre-resolve
 * step, where the sketch builder must bake expression-driven entity
 * dimensions into literal numerics before handing the entities to the
 * region detector. The detector uses `Number(value)`-style coercion and
 * silently drops anything that doesn't parse — without the pre-resolve,
 * a `diameter: "D"` entity produces zero regions and breaks downstream
 * extrudes.
 */
import { describe, expect, it } from 'vitest';
import { buildSketch } from './buildSketch.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { FeatureNode, SketchFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import { featureId, entityId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { ResolvedSketchRegionData } from './buildSketch.ts';

function makeCircleSketch(diameterExpr: string): FeatureNode {
  const inputs: SketchFeatureInputs = {
    plane: { type: 'defaultPlane', name: 'XY' },
    entities: {
      [entityId('circle_1')]: {
        id: entityId('circle_1'),
        type: 'circle',
        center: ['0', '0'],
        diameter: diameterExpr,
      },
    },
  };
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
 * Build a parametric rectangle as 4 line entities (invariant #11 — no
 * composite entities; rectangles are 4 lines + constraints). Width
 * spans `-W/2 .. +W/2`, height spans `-H/2 .. +H/2` so the rectangle
 * is centred on the origin (matches the old composite's `mode: 'center'`).
 */
function makeRectSketch(widthExpr: string, heightExpr: string): FeatureNode {
  const halfW = `(${widthExpr}) / 2`;
  const halfH = `(${heightExpr}) / 2`;
  const negHalfW = `0 - (${widthExpr}) / 2`;
  const negHalfH = `0 - (${heightExpr}) / 2`;
  const inputs: SketchFeatureInputs = {
    plane: { type: 'defaultPlane', name: 'XY' },
    entities: {
      [entityId('rect_bottom')]: {
        id: entityId('rect_bottom'),
        type: 'line',
        start: [negHalfW, negHalfH],
        end: [halfW, negHalfH],
      },
      [entityId('rect_right')]: {
        id: entityId('rect_right'),
        type: 'line',
        start: [halfW, negHalfH],
        end: [halfW, halfH],
      },
      [entityId('rect_top')]: {
        id: entityId('rect_top'),
        type: 'line',
        start: [halfW, halfH],
        end: [negHalfW, halfH],
      },
      [entityId('rect_left')]: {
        id: entityId('rect_left'),
        type: 'line',
        start: [negHalfW, halfH],
        end: [negHalfW, negHalfH],
      },
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

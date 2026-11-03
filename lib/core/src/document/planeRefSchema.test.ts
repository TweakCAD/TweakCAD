/**
 * Zod validation tests for PlaneRefSchema.
 *
 * Regression guard: PlaneRefSchema previously still encoded the retired
 * `unstableTopology` / `topologyId` variant while the TS `PlaneRef` type (and
 * FaceRefSchema) had moved to `stableTopology` / `stableFaceId`. Any persisted
 * PlaneRef using the stable variant — extrude `toPlane`, mirror plane, or a
 * construction plane offset from a face-plane — therefore failed Zod parse.
 */
import { describe, expect, it } from 'vitest';
import type { PlaneRef } from './schema.ts';
import { bodyId, partId, stableFaceId } from '../ids.ts';
import { PlaneRefSchema, ConstructionPlaneFeatureInputsSchema, ExtrudeFeatureInputsSchema } from './validation.ts';

describe('PlaneRefSchema', () => {
  it('accepts a stableTopology plane ref', () => {
    const ref: PlaneRef = {
      type: 'stableTopology',
      bodyRef: { partId: partId('p1'), bodyId: bodyId('body_a') },
      stableFaceId: stableFaceId('face_001'),
    };
    const result = PlaneRefSchema.safeParse(ref);
    expect(result.success).toBe(true);
  });

  it('accepts a stableTopology plane ref carrying a repairHint', () => {
    const ref = {
      type: 'stableTopology',
      bodyRef: { partId: 'p1', bodyId: 'body_a' },
      stableFaceId: 'face_002',
      repairHint: { center: [10, 0, 5], normal: [0, 1, 0], size: 42 },
    };
    expect(PlaneRefSchema.safeParse(ref).success).toBe(true);
  });

  it('still accepts the non-topology plane variants', () => {
    expect(PlaneRefSchema.safeParse({ type: 'defaultPlane', name: 'XY' }).success).toBe(true);
    expect(PlaneRefSchema.safeParse({ type: 'constructionPlane', planeId: 'cp1' }).success).toBe(true);
    expect(
      PlaneRefSchema.safeParse({ type: 'featureOutput', featureId: 'f1', output: 'plane' }).success,
    ).toBe(true);
  });

  it('rejects the retired unstableTopology / topologyId shape', () => {
    const retired = {
      type: 'unstableTopology',
      bodyRef: { partId: 'p1', bodyId: 'body_a' },
      topologyId: 'topo_1',
    };
    expect(PlaneRefSchema.safeParse(retired).success).toBe(false);
  });

  it('validates a construction plane offset from a stableTopology base plane', () => {
    const inputs = {
      kind: 'offsetFromPlane',
      basePlane: {
        type: 'stableTopology',
        bodyRef: { partId: 'p1', bodyId: 'body_a' },
        stableFaceId: 'face_003',
      },
      offset: '5',
    };
    expect(ConstructionPlaneFeatureInputsSchema.safeParse(inputs).success).toBe(true);
  });

  it('validates an extrude started from a face and extruded up to another face', () => {
    const face = (stableFaceId: string) => ({
      type: 'stableTopology',
      bodyRef: { partId: 'p1', bodyId: 'body_a' },
      stableFaceId,
    });
    const inputs = {
      profiles: [{ sketchId: 's1', wireEntityIds: ['c1'] }],
      operation: 'cut',
      direction: { type: 'normal' },
      extent: { type: 'toPlane', plane: face('face_top') },
      startFrom: face('face_floor'),
      startOffset: '1',
    };
    expect(ExtrudeFeatureInputsSchema.safeParse(inputs).success).toBe(true);
    expect(ExtrudeFeatureInputsSchema.safeParse({ ...inputs, startFrom: { type: 'face' } }).success).toBe(false);
  });
});

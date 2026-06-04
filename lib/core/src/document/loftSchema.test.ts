/**
 * Schema round-trip tests for the loft feature.
 *
 * Guards against regressions in the .cadjson serialization path for loft
 * features — most importantly that the ordered `profiles` list survives a
 * JSON trip with order preserved, and that the optional ruled/closed flags
 * round-trip cleanly when present or omitted.
 */
import { describe, expect, it } from 'vitest';
import type { FeatureNode, LoftFeatureInputs } from './schema.ts';
import { featureId, entityId } from '../ids.ts';

function makeLoftNode(overrides: Partial<LoftFeatureInputs> = {}): FeatureNode {
  const base: LoftFeatureInputs = {
    profiles: [
      { sketchId: featureId('sketch_a'), wireEntityIds: [entityId('circle_a')] },
      { sketchId: featureId('sketch_b'), wireEntityIds: [entityId('circle_b')] },
    ],
    operation: 'newBody',
  };
  const inputs: LoftFeatureInputs = { ...base, ...overrides };
  return {
    id: featureId('loft_1'),
    type: 'loft',
    name: 'Loft 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [featureId('sketch_a'), featureId('sketch_b')],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  };
}

describe('LoftFeatureInputs serialization', () => {
  it('round-trips a minimal 2-profile loft', () => {
    const node = makeLoftNode();
    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;
    expect(parsed).toEqual(node);
    const inputs = parsed.inputs as unknown as LoftFeatureInputs;
    expect(inputs.profiles).toHaveLength(2);
    expect(inputs.operation).toBe('newBody');
    expect(inputs.ruled).toBeUndefined();
    expect(inputs.closed).toBeUndefined();
  });

  it('preserves profile order under JSON round-trip', () => {
    const node = makeLoftNode({
      profiles: [
        { sketchId: featureId('s1'), wireEntityIds: [entityId('p1')] },
        { sketchId: featureId('s2'), wireEntityIds: [entityId('p2')] },
        { sketchId: featureId('s3'), wireEntityIds: [entityId('p3')] },
        { sketchId: featureId('s1'), wireEntityIds: [entityId('p4')] }, // back to s1
      ],
    });
    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;
    const inputs = parsed.inputs as unknown as LoftFeatureInputs;
    expect(inputs.profiles.map(p => String(p.sketchId))).toEqual([
      's1', 's2', 's3', 's1',
    ]);
    expect(inputs.profiles.map(p => p.wireEntityIds[0])).toEqual([
      'p1', 'p2', 'p3', 'p4',
    ]);
  });

  it('preserves ruled + closed flags when set', () => {
    const node = makeLoftNode({ ruled: true, closed: true });
    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;
    const inputs = parsed.inputs as unknown as LoftFeatureInputs;
    expect(inputs.ruled).toBe(true);
    expect(inputs.closed).toBe(true);
  });
});

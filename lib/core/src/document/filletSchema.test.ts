/**
 * Schema round-trip tests for the fillet feature.
 *
 * Guards the most common regression when adding a feature: the FeatureNode
 * + its inputs (including the stable EdgeRef) must survive the structured-
 * clone-style trip through JSON that .cadjson serialization performs.
 */
import { describe, expect, it } from 'vitest';
import type { FeatureNode, FilletFeatureInputs, EdgeRef } from './schema.ts';
import { featureId, bodyId, stableEdgeId, partId } from '../ids.ts';

function makeFilletNode(): FeatureNode {
  const edges: EdgeRef[] = [
    {
      type: 'stableTopology',
      bodyRef: { partId: partId('p1'), bodyId: bodyId('body_a') },
      stableEdgeId: stableEdgeId('edge_001'),
    },
    {
      type: 'stableTopology',
      bodyRef: { partId: partId('p1'), bodyId: bodyId('body_a') },
      stableEdgeId: stableEdgeId('edge_002'),
      repairHint: {
        center: [10, 0, 5],
        normal: [0, 1, 0],
      },
    },
  ];
  const inputs: FilletFeatureInputs = {
    edges,
    radius: '2.5',
  };
  return {
    id: featureId('fillet_1'),
    type: 'fillet',
    name: 'Fillet 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  };
}

describe('FilletFeatureInputs serialization', () => {
  it('round-trips through JSON without losing fields', () => {
    const node = makeFilletNode();
    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;

    expect(parsed).toEqual(node);
    expect(parsed.type).toBe('fillet');
    const parsedInputs = parsed.inputs as unknown as FilletFeatureInputs;
    expect(parsedInputs.radius).toBe('2.5');
    expect(parsedInputs.edges).toHaveLength(2);
  });

  it('preserves stable edge refs including repairHint payload', () => {
    const node = makeFilletNode();
    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;
    const parsedInputs = parsed.inputs as unknown as FilletFeatureInputs;

    const edge0 = parsedInputs.edges[0];
    expect(edge0?.type).toBe('stableTopology');
    if (edge0?.type === 'stableTopology') {
      expect(edge0.stableEdgeId).toBe('edge_001');
      expect(edge0.bodyRef.partId).toBe('p1');
      expect(edge0.bodyRef.bodyId).toBe('body_a');
    }

    const edge1 = parsedInputs.edges[1];
    expect(edge1?.type).toBe('stableTopology');
    if (edge1?.type === 'stableTopology') {
      expect(edge1.repairHint).toEqual({
        center: [10, 0, 5],
        normal: [0, 1, 0],
      });
    }
  });

  it('round-trips an empty edges array (for newly-created fillets)', () => {
    const node = makeFilletNode();
    const inputs = node.inputs as unknown as FilletFeatureInputs;
    inputs.edges = [];

    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;
    const parsedInputs = parsed.inputs as unknown as FilletFeatureInputs;
    expect(parsedInputs.edges).toEqual([]);
  });
});

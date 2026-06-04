/**
 * Schema round-trip tests for the revolve feature.
 *
 * These guard against the most common regression when adding a new feature
 * type: making sure the FeatureNode + its inputs survive a structured-clone
 * style trip through JSON (which is what .cadjson serialization does).
 */
import { describe, expect, it } from 'vitest';
import type { FeatureNode, RevolveFeatureInputs } from './schema.ts';
import { featureId } from '../ids.ts';

function makeRevolveNode(): FeatureNode {
  const inputs: RevolveFeatureInputs = {
    profile: {
      sketchId: featureId('sketch_1'),
      wireEntityIds: ['rect_base'] as unknown as RevolveFeatureInputs['profile']['wireEntityIds'],
    },
    axis: { type: 'z' },
    angle: '360',
    operation: 'newBody',
    startOffset: '5',
  };
  return {
    id: featureId('revolve_1'),
    type: 'revolve',
    name: 'Revolve 1',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [featureId('sketch_1')],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  };
}

describe('RevolveFeatureInputs serialization', () => {
  it('round-trips through JSON without losing fields', () => {
    const node = makeRevolveNode();
    const json = JSON.stringify(node);
    const parsed = JSON.parse(json) as FeatureNode;

    expect(parsed).toEqual(node);
    expect(parsed.type).toBe('revolve');
    const parsedInputs = parsed.inputs as unknown as RevolveFeatureInputs;
    expect(parsedInputs.angle).toBe('360');
    expect(parsedInputs.axis).toEqual({ type: 'z' });
    expect(parsedInputs.operation).toBe('newBody');
    expect(parsedInputs.startOffset).toBe('5');
    expect(parsedInputs.profile.sketchId).toBe('sketch_1');
  });

  it('preserves a custom axis spec across the round-trip', () => {
    const node = makeRevolveNode();
    const inputs = node.inputs as unknown as RevolveFeatureInputs;
    inputs.axis = {
      type: 'custom',
      origin: [10, 0, 0],
      direction: [0, 1, 0],
    };

    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;
    const parsedInputs = parsed.inputs as unknown as RevolveFeatureInputs;
    expect(parsedInputs.axis).toEqual({
      type: 'custom',
      origin: [10, 0, 0],
      direction: [0, 1, 0],
    });
  });

  it('round-trips when startOffset is omitted', () => {
    const node = makeRevolveNode();
    const inputs = node.inputs as unknown as RevolveFeatureInputs;
    delete inputs.startOffset;

    const parsed = JSON.parse(JSON.stringify(node)) as FeatureNode;
    const parsedInputs = parsed.inputs as unknown as RevolveFeatureInputs;
    expect(parsedInputs.startOffset).toBeUndefined();
    expect(parsedInputs.angle).toBe('360');
  });
});

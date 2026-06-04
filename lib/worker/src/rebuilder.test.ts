/**
 * Unit tests for the rebuilder's body-dependency synthesizer.
 *
 * The behavior these tests pin down: when a feature has a BodyRef
 * somewhere in its `inputs` tree (`{ partId, bodyId }` shape), the
 * rebuilder's `extractBodyProducerDeps` walker discovers it and maps
 * the body back to the feature that produced it. That mapping is
 * what powers the suppress-cascades-to-blocked behavior the user
 * was missing — without it, body-modifying features whose handlers
 * leave `dependsOn: []` empty (Fillet, Chamfer, Mirror, Hole, Shell,
 * Pattern, Sweep) would silently fail at build time instead of
 * cascade-blocking.
 *
 * The full integration (build a sketch + extrude + fillet, suppress
 * the sketch, watch the cascade) is exercised in the browser and via
 * the per-builder vitest suites; here we isolate the walker logic.
 */

import { describe, expect, it } from 'vitest';
import { extractBodyProducerDeps } from './rebuilder.ts';
import { featureId, bodyId, partId } from '@tweakcad/core/src/ids.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';

const PART = partId('p1');

function refTo(id: string): { partId: string; bodyId: string } {
  return { partId: String(PART), bodyId: String(bodyId(id)) };
}

function makeProducerMap(
  pairs: { body: string; producer: string }[],
): Map<string, FeatureId> {
  const m = new Map<string, FeatureId>();
  for (const { body, producer } of pairs) {
    m.set(String(bodyId(body)), featureId(producer));
  }
  return m;
}

describe('extractBodyProducerDeps', () => {
  it('returns empty set when inputs has no body refs', () => {
    const producers = makeProducerMap([{ body: 'b1', producer: 'f_pad' }]);
    const deps = extractBodyProducerDeps({ radius: '5', count: 3 }, producers);
    expect(deps.size).toBe(0);
  });

  it('finds a top-level BodyRef (e.g. Mirror.sourceBody)', () => {
    const producers = makeProducerMap([{ body: 'b1', producer: 'f_pad' }]);
    const inputs = {
      sourceBody: refTo('b1'),
      plane: { type: 'defaultPlane', name: 'XY' },
      operation: 'join',
    };
    const deps = extractBodyProducerDeps(inputs, producers);
    expect([...deps]).toEqual([featureId('f_pad')]);
  });

  it('finds a nested BodyRef (e.g. Fillet.edges[].bodyRef)', () => {
    const producers = makeProducerMap([{ body: 'b1', producer: 'f_extrude' }]);
    const inputs = {
      edges: [
        { type: 'stableTopology', bodyRef: refTo('b1'), stableEdgeId: 'e_001' },
        { type: 'stableTopology', bodyRef: refTo('b1'), stableEdgeId: 'e_002' },
      ],
      radius: '2',
    };
    const deps = extractBodyProducerDeps(inputs, producers);
    // Both edges reference the same body, so we still get one dep.
    expect([...deps]).toEqual([featureId('f_extrude')]);
  });

  it('collects multiple distinct producers (e.g. Shell.removedFaces from different bodies)', () => {
    const producers = makeProducerMap([
      { body: 'b1', producer: 'f_pad_a' },
      { body: 'b2', producer: 'f_pad_b' },
    ]);
    const inputs = {
      sourceBody: refTo('b1'),
      removedFaces: [
        { type: 'stableTopology', bodyRef: refTo('b1'), stableFaceId: 'f_001' },
        { type: 'stableTopology', bodyRef: refTo('b2'), stableFaceId: 'f_002' },
      ],
    };
    const deps = extractBodyProducerDeps(inputs, producers);
    expect(deps.has(featureId('f_pad_a'))).toBe(true);
    expect(deps.has(featureId('f_pad_b'))).toBe(true);
    expect(deps.size).toBe(2);
  });

  it('ignores BodyRefs whose body has no recorded producer', () => {
    const producers = makeProducerMap([{ body: 'b1', producer: 'f_pad' }]);
    const inputs = { sourceBody: refTo('b_unknown') };
    const deps = extractBodyProducerDeps(inputs, producers);
    expect(deps.size).toBe(0);
  });

  it('handles cycles in inputs without infinite-looping (defensive)', () => {
    const producers = makeProducerMap([{ body: 'b1', producer: 'f_pad' }]);
    const a: Record<string, unknown> = { sourceBody: refTo('b1') };
    const b: Record<string, unknown> = { ref: a };
    a['back'] = b;
    expect(() => extractBodyProducerDeps(a, producers)).not.toThrow();
    const deps = extractBodyProducerDeps(a, producers);
    expect([...deps]).toEqual([featureId('f_pad')]);
  });

  it('ignores values that look like BodyRef but have non-string fields', () => {
    const producers = makeProducerMap([{ body: 'b1', producer: 'f_pad' }]);
    // partId is a number here, not a string — should NOT trip the shape check.
    const inputs = { fake: { partId: 42, bodyId: String(bodyId('b1')) } };
    const deps = extractBodyProducerDeps(inputs, producers);
    expect(deps.size).toBe(0);
  });

  it('does not throw on null / undefined inputs', () => {
    const producers = makeProducerMap([]);
    expect(() => extractBodyProducerDeps(null, producers)).not.toThrow();
    expect(() => extractBodyProducerDeps(undefined, producers)).not.toThrow();
    expect(extractBodyProducerDeps(null, producers).size).toBe(0);
  });
});

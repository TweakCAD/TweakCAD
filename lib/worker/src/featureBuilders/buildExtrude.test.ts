/**
 * Tests for buildExtrude — the orchestration layer between sketch
 * region detection and the OCCT kernel. Regression coverage for the
 * 2026-05-27 bugs:
 *
 *  1. Multi-profile feature emitted one body *per profile* with the
 *     boolean op applied per-profile against the pre-extrude state,
 *     so `join` with N profiles produced N "previous_state ∪ profile_i"
 *     monster bodies. Fix: build all profile-bodies first, apply the
 *     op once, decompose by connected solid for newBody, single body
 *     for join/cut.
 *  2. `startOffset` was applied along `+normal` regardless of
 *     direction, so a reversed extrude with offset shifted the wrong
 *     way along the extrusion axis. Fix: signed offset by direction.
 *
 * These bugs lived in the gap between kernel tests (single-face
 * extrude works fine) and importedComponent tests (use single-profile
 * fixtures). No layer had been verifying multi-profile orchestration
 * or operation semantics.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildExtrude } from './buildExtrude.ts';
import { buildSketch } from './buildSketch.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type {
  FeatureNode,
  SketchFeatureInputs,
  ExtrudeFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { featureId, entityId, bodyId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';

// --- Sketch fixtures ------------------------------------------------------

const SKETCH_ID = featureId('sketch_main');

/**
 * Two non-overlapping circles on XY. The region detector emits two
 * disjoint regions — useful for the "disjoint profiles" case where
 * newBody must keep them as separate bodies.
 */
function twoCircleSketch(): FeatureNode {
  const inputs: SketchFeatureInputs = {
    plane: { type: 'defaultPlane', name: 'XY' },
    buildGeometry: {
      [entityId('cA')]: { id: entityId('cA'), type: 'circle', center: ['-10', '0'], diameter: '4' },
      [entityId('cB')]: { id: entityId('cB'), type: 'circle', center: ['10', '0'],  diameter: '4' },
    },
  };
  return makeSketchNode(inputs);
}

/**
 * One circle. Used for single-profile extrude flows where we want to
 * inspect the kernel call arguments (offset direction, extrude vector).
 */
function oneCircleSketch(): FeatureNode {
  const inputs: SketchFeatureInputs = {
    plane: { type: 'defaultPlane', name: 'XY' },
    buildGeometry: {
      [entityId('c1')]: { id: entityId('c1'), type: 'circle', center: ['0', '0'], diameter: '4' },
    },
  };
  return makeSketchNode(inputs);
}

function makeSketchNode(inputs: SketchFeatureInputs): FeatureNode {
  return {
    id: SKETCH_ID,
    type: 'sketch',
    name: 'Test Sketch',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-05-27T00:00:00Z',
    updatedAt: '2026-05-27T00:00:00Z',
  };
}

// --- Extrude fixtures -----------------------------------------------------

function makeExtrudeNode(inputs: ExtrudeFeatureInputs, id = 'ex_test'): FeatureNode {
  return {
    id: featureId(id),
    type: 'extrude',
    name: 'Test Extrude',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [SKETCH_ID],
    createdAt: '2026-05-27T00:00:00Z',
    updatedAt: '2026-05-27T00:00:00Z',
  };
}

async function ctxWithSketch(node: FeatureNode, kernel: MockKernel): Promise<BuildContext> {
  const context = emptyBuildContext({} as ResolvedParams);
  const sketchResult = await buildSketch(node, {}, context, kernel);
  if (sketchResult.outputs) {
    context.featureOutputs.set(node.id, sketchResult.outputs);
  }
  return context;
}

// --- Tests ----------------------------------------------------------------

describe('buildExtrude — operation semantics (one extrude → 1..N bodies)', () => {
  it('newBody with overlapping/touching profiles yields ONE body via decomposeBody', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const sketch = twoCircleSketch();
    const context = await ctxWithSketch(sketch, kernel);

    // Simulate the "all profile-bodies fused into a single connected
    // solid" case — decomposeBody returns a single-element array.
    const decomposeSpy = vi.spyOn(kernel, 'decomposeBody').mockResolvedValue([
      { handle: 'fused_solid', source: 'mock' } as KernelBody,
    ]);
    const fuseSpy = vi.spyOn(kernel, 'booleanFuse');

    const extrude = makeExtrudeNode({
      profiles: [
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cA')] },
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cB')] },
      ],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    });
    const result = await buildExtrude(extrude, {}, context, kernel);

    expect(result.bodies).toHaveLength(1);
    expect(fuseSpy).toHaveBeenCalledTimes(1); // one fuse over both profiles
    expect(decomposeSpy).toHaveBeenCalledTimes(1);
  });

  it('newBody with disjoint profiles yields ONE body PER connected solid', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(twoCircleSketch(), kernel);

    // Compound fuse result → decomposeBody splits into N independent bodies.
    vi.spyOn(kernel, 'decomposeBody').mockResolvedValue([
      { handle: 'solid_A', source: 'mock' } as KernelBody,
      { handle: 'solid_B', source: 'mock' } as KernelBody,
    ]);

    const extrude = makeExtrudeNode({
      profiles: [
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cA')] },
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cB')] },
      ],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    });
    const result = await buildExtrude(extrude, {}, context, kernel);

    expect(result.bodies).toHaveLength(2);
    // Body IDs must be deterministic per feature so picker references
    // survive rebuilds. Suffix encodes the per-solid index.
    expect(result.bodies.map(b => String(b.bodyId))).toEqual([
      'body_ex_test_0',
      'body_ex_test_1',
    ]);
  });

  it('join fuses all targets + all profile-bodies into ONE body and consumes the targets', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(twoCircleSketch(), kernel);

    // Pre-existing body in the context — the "target" of join.
    const targetId = bodyId('preexisting');
    context.bodies.set(targetId, { handle: 'preexisting_handle', source: 'mock' } as KernelBody);

    const fuseSpy = vi.spyOn(kernel, 'booleanFuse');

    const extrude = makeExtrudeNode({
      profiles: [
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cA')] },
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cB')] },
      ],
      operation: 'join',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    });
    const result = await buildExtrude(extrude, {}, context, kernel);

    // One feature → one body (even when the new geometry is disjoint).
    expect(result.bodies).toHaveLength(1);

    // Join is a MERGE: the result carries the primary target's id rather
    // than minting one from the extrude. Minting would invalidate every
    // stored BodyRef pointing at the body the user joined onto — the one
    // they still think of as theirs. See ./bodyIdentity.ts.
    expect(result.bodies.map(b => String(b.bodyId))).toEqual([String(targetId)]);

    // Target consumed: the join handler must delete the previous body
    // from context.bodies; otherwise the rebuilder leaves stale entries
    // around and the timeline grows new bodies on every join.
    expect(context.bodies.has(targetId)).toBe(false);

    // One fuse call — target + profile-bodies all in one shot, not
    // per-profile-against-base-state (which would emit N monster bodies).
    expect(fuseSpy).toHaveBeenCalledTimes(1);
    const fuseArgs = fuseSpy.mock.calls[0]?.[0] as KernelBody[];
    expect(fuseArgs).toHaveLength(3); // 1 target + 2 profiles
  });

  it('cut subtracts the union of profile-bodies from the first context body and consumes it', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(twoCircleSketch(), kernel);

    const targetId = bodyId('block');
    context.bodies.set(targetId, { handle: 'block_handle', source: 'mock' } as KernelBody);

    const cutSpy = vi.spyOn(kernel, 'booleanCut');

    const extrude = makeExtrudeNode({
      profiles: [
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cA')] },
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cB')] },
      ],
      operation: 'cut',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    });
    const result = await buildExtrude(extrude, {}, context, kernel);

    expect(result.bodies).toHaveLength(1);
    // Cut modifies the target in place — same body, material removed — so it
    // carries the target's id. See ./bodyIdentity.ts.
    expect(result.bodies.map(b => String(b.bodyId))).toEqual([String(targetId)]);
    expect(context.bodies.has(targetId)).toBe(false);
    expect(cutSpy).toHaveBeenCalledTimes(1);
    const [cutTarget, cutTools] = cutSpy.mock.calls[0]!;
    expect((cutTarget as KernelBody).handle).toBe('block_handle');
    expect((cutTools as KernelBody[])).toHaveLength(2); // both profile-bodies as tools
  });
});

describe('buildExtrude — direction-aware startOffset', () => {
  it('reversed direction + positive offset shifts the face in −normal direction', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const faceSpy = vi.spyOn(kernel, 'createSketchFace');
    const extrudeSpy = vi.spyOn(kernel, 'extrudeFace');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'newBody',
      direction: { type: 'reversed' },
      extent: { type: 'distance', value: '10' },
      startOffset: '2',
    });
    await buildExtrude(extrude, {}, context, kernel);

    // XY sketch → normal is +Z. Reversed + offset=2 must shift the
    // face to Z = -2 (not +2, which is the bug). Profile center is at
    // origin, so we check the shifted profile's center/origin Z.
    const profile = faceSpy.mock.calls[0]?.[0];
    expect(profile?.center?.[2]).toBeCloseTo(-2, 6);
    expect(profile?.origin?.[2]).toBeCloseTo(-2, 6);

    // Extrude vector must also point in −Z by `distance`.
    const vector = extrudeSpy.mock.calls[0]?.[1];
    expect(vector?.[2]).toBeCloseTo(-10, 6);
  });

  it('normal direction + positive offset shifts the face in +normal direction', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const faceSpy = vi.spyOn(kernel, 'createSketchFace');
    const extrudeSpy = vi.spyOn(kernel, 'extrudeFace');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
      startOffset: '2',
    });
    await buildExtrude(extrude, {}, context, kernel);

    const profile = faceSpy.mock.calls[0]?.[0];
    expect(profile?.center?.[2]).toBeCloseTo(2, 6);
    expect(profile?.origin?.[2]).toBeCloseTo(2, 6);

    const vector = extrudeSpy.mock.calls[0]?.[1];
    expect(vector?.[2]).toBeCloseTo(10, 6);
  });
});

// --- Extended behavior coverage. These exercise scenarios the builder
// is *supposed* to support. Tests that fail here are real bugs.
describe('buildExtrude — extended behavior coverage', () => {
  it('symmetric extent + non-zero startOffset centers the body about Z = startOffset', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const faceSpy = vi.spyOn(kernel, 'createSketchFace');
    const extrudeSpy = vi.spyOn(kernel, 'extrudeFace');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'symmetric', value: '10' },
      startOffset: '5',
    });
    await buildExtrude(extrude, {}, context, kernel);

    // Symmetric extent value=10 means total span = 10 about start plane;
    // halfDist = 5. Face is back-shifted by halfDist, so face Z = offset
    // − 5 = 0. Vector is full +distance, so body extends to Z = 10.
    // Final span [0, 10] is centred about Z = startOffset (5). ✓
    const profile = faceSpy.mock.calls[0]?.[0];
    expect(profile?.center?.[2]).toBeCloseTo(0, 6);

    const vector = extrudeSpy.mock.calls[0]?.[1];
    expect(vector?.[2]).toBeCloseTo(10, 6);
  });

  it('custom direction vector normalizes and scales by distance', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const extrudeSpy = vi.spyOn(kernel, 'extrudeFace');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'newBody',
      direction: { type: 'custom', vector: [3, 0, 4] }, // length 5
      extent: { type: 'distance', value: '10' },
    });
    await buildExtrude(extrude, {}, context, kernel);

    // [3, 0, 4] normalised = [0.6, 0, 0.8]; ×10 = [6, 0, 8].
    const vector = extrudeSpy.mock.calls[0]?.[1];
    expect(vector?.[0]).toBeCloseTo(6, 6);
    expect(vector?.[1]).toBeCloseTo(0, 6);
    expect(vector?.[2]).toBeCloseTo(8, 6);
  });

  it('expression-driven distance ("D*2" with params={D:6}) yields a 12 mm body', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const extrudeSpy = vi.spyOn(kernel, 'extrudeFace');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: 'D*2' },
    });
    await buildExtrude(extrude, { D: 6 } as ResolvedParams, context, kernel);

    const vector = extrudeSpy.mock.calls[0]?.[1];
    expect(vector?.[2]).toBeCloseTo(12, 6);
  });

  it('throws cleanly if wireEntityIds reference an entity that no longer exists', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('deleted_entity')] }],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    });
    await expect(buildExtrude(extrude, {}, context, kernel))
      .rejects.toThrow(/Missing profiles/);
  });

  it('multi-profile feature with one missing profile fails the whole feature', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(twoCircleSketch(), kernel);

    const extrude = makeExtrudeNode({
      profiles: [
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('cA')] },        // valid
        { sketchId: SKETCH_ID, wireEntityIds: [entityId('missing')] },   // bogus
      ],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    });
    await expect(buildExtrude(extrude, {}, context, kernel))
      .rejects.toThrow(/Missing profiles/);
  });

  it('extent=throughAll spans the AABB of all target bodies plus slop', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    // Pre-existing body the cut should clear. Mock bbox spans Z ∈ [0, 50]
    // — the prism must reach past 50 + slop.
    const blockId = bodyId('block');
    context.bodies.set(blockId, { handle: 'block_handle', source: 'mock' } as KernelBody);
    vi.spyOn(kernel, 'getBoundingBox').mockResolvedValue({
      min: [-25, -25, 0],
      max: [25, 25, 50],
    });

    const extrudeSpy = vi.spyOn(kernel, 'extrudeFace');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'cut',
      direction: { type: 'normal' },
      extent: { type: 'throughAll' },
    });
    await buildExtrude(extrude, {}, context, kernel);

    // Sketch is on XY (origin at Z=0), direction +Z. The block's max Z
    // is 50 → distance must be ≥ 50 + slop, well past the 10 mm fallback.
    const vector = extrudeSpy.mock.calls[0]?.[1];
    const len = Math.hypot(vector?.[0] ?? 0, vector?.[1] ?? 0, vector?.[2] ?? 0);
    expect(len).toBeGreaterThanOrEqual(50);
    expect(len).toBeGreaterThan(10); // tightens the "not the 10 mm fallback" guard
  });

  it('extent=toPlane stops the extrude at the target plane', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    // Stand in a construction plane parallel to XY but offset by Z=15.
    // PlaneRef.constructionPlane reads `data.plane` from featureOutputs,
    // so we seed an output directly (no need to build a real CP feature).
    const planeFeatureId = 'cp_target';
    context.featureOutputs.set(planeFeatureId as never, {
      data: {
        plane: {
          name: 'XY',
          origin: [0, 0, 15],
          uAxis: [1, 0, 0],
          vAxis: [0, 1, 0],
          normal: [0, 0, 1],
        },
      },
    });

    const extrudeSpy = vi.spyOn(kernel, 'extrudeFace');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: {
        type: 'toPlane',
        plane: { type: 'constructionPlane', planeId: planeFeatureId } as never,
      },
    });
    await buildExtrude(extrude, {}, context, kernel);

    // Sketch at Z=0, target plane at Z=15 → distance 15.
    const vector = extrudeSpy.mock.calls[0]?.[1];
    expect(vector?.[2]).toBeCloseTo(15, 6);
  });

  it('extent=toPlane throws if the target plane is at or behind the start position', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    // Target plane at Z = -5 (behind a +Z extrude from Z=0).
    context.featureOutputs.set('cp_behind' as never, {
      data: {
        plane: {
          name: 'XY',
          origin: [0, 0, -5],
          uAxis: [1, 0, 0],
          vAxis: [0, 1, 0],
          normal: [0, 0, 1],
        },
      },
    });

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: {
        type: 'toPlane',
        plane: { type: 'constructionPlane', planeId: 'cp_behind' } as never,
      },
    });
    await expect(buildExtrude(extrude, {}, context, kernel))
      .rejects.toThrow(/at or behind/i);
  });
});

// --- Target-body selectivity. `targetBodies` is now wired end-to-end
// (UI picker → schema → builder via `selectTargetEntries`), so the first
// two cases below pass: join consumes only the targeted body, and cut
// directs at the user-picked target. The third case (disjoint join-result
// stays its own body) is the tighter Fusion-style semantics we
// deliberately deferred — it stays a real failing test (not `.skip`) so
// the remaining gap is visible in CI.
describe('buildExtrude — target-body selectivity', () => {
  it('join with two disjoint pre-existing bodies consumes ONLY the targeted body', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const targetId = bodyId('target_A');
    const otherId = bodyId('other_B');
    context.bodies.set(targetId, { handle: 'A_handle', source: 'mock' } as KernelBody);
    context.bodies.set(otherId, { handle: 'B_handle', source: 'mock' } as KernelBody);

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'join',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
      targetBodies: [{ partId: 'p1' as never, bodyId: targetId }],
    });
    await buildExtrude(extrude, {}, context, kernel);

    // A is the targeted body → consumed and replaced by the join result.
    expect(context.bodies.has(targetId)).toBe(false);
    // B was NOT targeted → must remain untouched.
    expect(context.bodies.has(otherId)).toBe(true);
  });

  it('cut directs at the user-picked target body, not the first one in context', async () => {
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const firstId = bodyId('first_A');     // first by insertion order
    const targetId = bodyId('target_B');   // the user-picked target
    context.bodies.set(firstId, { handle: 'A_handle', source: 'mock' } as KernelBody);
    context.bodies.set(targetId, { handle: 'B_handle', source: 'mock' } as KernelBody);

    const cutSpy = vi.spyOn(kernel, 'booleanCut');

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'cut',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
      targetBodies: [{ partId: 'p1' as never, bodyId: targetId }],
    });
    await buildExtrude(extrude, {}, context, kernel);

    // Cut must target B (the picked target), not A (insertion-first).
    const [cutTarget] = cutSpy.mock.calls[0]!;
    expect((cutTarget as KernelBody).handle).toBe('B_handle');
    expect(context.bodies.has(targetId)).toBe(false); // B consumed
    expect(context.bodies.has(firstId)).toBe(true);   // A untouched
  });

  it('disjoint join-result piece stays as its own body instead of one compound', async () => {
    // When join geometry doesn't physically touch the target, the new
    // piece becomes its OWN body rather than getting absorbed into a
    // compound timeline body. The initial fix used "join always = 1
    // body"; this test documents the more permissive behavior we may
    // want.
    const kernel = new MockKernel();
    await kernel.init();
    const context = await ctxWithSketch(oneCircleSketch(), kernel);

    const targetId = bodyId('far_target');
    context.bodies.set(targetId, { handle: 'far_handle', source: 'mock' } as KernelBody);

    const extrude = makeExtrudeNode({
      profiles: [{ sketchId: SKETCH_ID, wireEntityIds: [entityId('c1')] }],
      operation: 'join',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
      // Imagined behavior: profile is far from `far_target`, so the
      // join can't physically merge; result is a new separate body.
      targetBodies: [{ partId: 'p1' as never, bodyId: targetId }],
    });
    const result = await buildExtrude(extrude, {}, context, kernel);

    // Target untouched because nothing actually merged; new body exists
    // as a fresh entry rather than a compound replacing target.
    expect(context.bodies.has(targetId)).toBe(true);
    expect(result.bodies).toHaveLength(1);
  });
});

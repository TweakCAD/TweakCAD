/**
 * The body-identity invariant, asserted across every modifier builder.
 *
 * Six builders used to disagree about whether modifying a body changes its
 * id, and both sides had written their reasoning down in comments that
 * contradicted each other. It survived because nothing tested it: before this
 * file, `buildFillet` and `buildChamfer` had **zero** body-id assertions
 * between them.
 *
 * So the point of this file is not to test fillet, or chamfer, or extrude. It
 * is to make the rule in `./bodyIdentity.ts` mechanically true for all of
 * them at once, so a seventh convention cannot appear quietly in the next
 * builder somebody writes.
 *
 * The rule: **a modifier re-emits the id of the body it consumed.** Body ids
 * are persisted inside every stored `BodyRef` — `targetBodies`, `sourceBody`,
 * `targetBody`, and every `EdgeRef`/`FaceRef` — so re-keying on modify
 * silently invalidates downstream features' saved references.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { featureId, bodyId, stableFaceId, stableEdgeId, partId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { buildFillet } from './buildFillet.ts';
import { buildChamfer } from './buildChamfer.ts';
import { buildShell } from './buildShell.ts';
import { carryBodyId, mintBodyId, pickIdentityHeir, rankSplitPieces } from './bodyIdentity.ts';

const PART = partId('p1');
/** Deliberately named after its CREATING feature, which is the whole point:
 *  the id still says `extrude_1` after a fillet and a chamfer have run. */
const SOURCE = bodyId('body_extrude_1_0');

function contextWithSource(): BuildContext {
  const ctx: BuildContext = emptyBuildContext({} as ResolvedParams);
  ctx.bodies.set(SOURCE, { handle: 'mock_body', source: 'mock' });
  return ctx;
}

async function kernelWithResolvers() {
  const kernel = new MockKernel();
  await kernel.init();
  vi.spyOn(kernel, 'resolveFaceRef').mockImplementation(async () => ({
    handle: 'mock_face',
    bodyHandle: 'mock_body',
  }));
  vi.spyOn(kernel, 'resolveEdgeRef').mockImplementation(async () => ({
    handle: 'mock_edge',
    bodyHandle: 'mock_body',
  }));
  return kernel;
}

function node(id: string, type: string, inputs: unknown): FeatureNode {
  return {
    id: featureId(id),
    type,
    name: id,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as FeatureNode;
}

const edgeRef = () => ({
  type: 'stableTopology' as const,
  bodyRef: { partId: PART, bodyId: SOURCE },
  stableEdgeId: stableEdgeId('se_1'),
});

/**
 * Every modifier, with the node that drives it. Each is expected to consume
 * SOURCE and emit SOURCE — note the feature ids differ from the body id on
 * purpose, so a builder that minted from its own `node.id` would fail.
 */
const MODIFIERS: {
  name: string;
  run: (ctx: BuildContext, kernel: MockKernel) => Promise<{ bodies: { bodyId: unknown }[] }>;
}[] = [
  {
    name: 'fillet',
    run: (ctx, kernel) =>
      buildFillet(
        node('fillet_99', 'fillet', { edges: [edgeRef()], radius: '2' }),
        {} as ResolvedParams,
        ctx,
        kernel,
      ) as never,
  },
  {
    name: 'chamfer',
    run: (ctx, kernel) =>
      buildChamfer(
        node('chamfer_99', 'chamfer', { edges: [edgeRef()], distance: '1' }),
        {} as ResolvedParams,
        ctx,
        kernel,
      ) as never,
  },
  {
    name: 'shell',
    run: (ctx, kernel) =>
      buildShell(
        node('shell_99', 'shell', {
          sourceBody: { partId: PART, bodyId: SOURCE },
          removedFaces: [{
            type: 'stableTopology',
            bodyRef: { partId: PART, bodyId: SOURCE },
            stableFaceId: stableFaceId('f_1'),
          }],
          thickness: '2',
        }),
        {} as ResolvedParams,
        ctx,
        kernel,
      ) as never,
  },
];

describe('body identity — every modifier carries the id it consumed', () => {
  for (const { name, run } of MODIFIERS) {
    it(`${name} re-emits the source bodyId`, async () => {
      const ctx = contextWithSource();
      const kernel = await kernelWithResolvers();
      const result = await run(ctx, kernel);

      expect(result.bodies).toHaveLength(1);
      expect(String(result.bodies[0]!.bodyId)).toBe(String(SOURCE));
    });

    it(`${name} does not mint an id from its own feature id`, async () => {
      // The specific regression: `body_${node.id}_0`. Feature ids above are
      // `*_99` so a minted id would be unmistakable.
      const ctx = contextWithSource();
      const kernel = await kernelWithResolvers();
      const result = await run(ctx, kernel);
      expect(String(result.bodies[0]!.bodyId)).not.toMatch(/_99_/);
    });

    it(`${name} consumes the source from the build context`, async () => {
      // Carrying the id only works if the old entry is also removed —
      // otherwise the same id would be registered twice.
      const ctx = contextWithSource();
      const kernel = await kernelWithResolvers();
      await run(ctx, kernel);
      expect(ctx.bodies.has(SOURCE)).toBe(false);
    });
  }
});

describe('carryBodyId / mintBodyId', () => {
  it('carryBodyId round-trips the id unchanged', () => {
    expect(String(carryBodyId(SOURCE))).toBe('body_extrude_1_0');
  });

  it('mintBodyId names the body after its CREATOR', () => {
    expect(String(mintBodyId('extrude_1', 0))).toBe('body_extrude_1_0');
    expect(String(mintBodyId('extrude_1', 2))).toBe('body_extrude_1_2');
  });
});

describe('pickIdentityHeir — which piece of a split keeps the id', () => {
  const at = (volume: number, centroid: [number, number, number]) => ({ volume, centroid });

  it('returns -1 when there is nothing to choose', () => {
    expect(pickIdentityHeir([])).toBe(-1);
  });

  it('picks the largest piece', () => {
    expect(pickIdentityHeir([at(1, [0, 0, 0]), at(9, [5, 5, 5]), at(3, [1, 1, 1])])).toBe(1);
  });

  it('breaks volume ties by centroid, not by kernel order', () => {
    // OCCT makes no ordering guarantee across rebuilds. If identity followed
    // output order, it would hop between pieces as unrelated upstream
    // geometry changed — so equal volumes must resolve on geometry alone.
    const a = [at(5, [0, 0, 0]), at(5, [1, 0, 0])];
    const b = [at(5, [1, 0, 0]), at(5, [0, 0, 0])];
    expect(pickIdentityHeir(a)).toBe(0);
    expect(pickIdentityHeir(b)).toBe(1);
    // Same winning piece either way round.
    expect(a[pickIdentityHeir(a)]!.centroid).toEqual(b[pickIdentityHeir(b)]!.centroid);
  });

  it('is deterministic for fully identical pieces', () => {
    const pieces = [at(5, [0, 0, 0]), at(5, [0, 0, 0])];
    expect(pickIdentityHeir(pieces)).toBe(pickIdentityHeir(pieces));
  });
});

describe('rankSplitPieces — the order the pieces of a split are named in', () => {
  const at = (volume: number, centroid: [number, number, number]) => ({ volume, centroid });

  it('treats volumes that differ only by float noise as a tie, and breaks it by centroid', () => {
    // A symmetric cut returns halves whose volumes differ in the last bits.
    // Exact comparison let that noise choose the heir.
    const left = at(400.0000000001, [-3, 0, 0]);
    const right = at(400, [3, 0, 0]);
    expect(pickIdentityHeir([left, right])).toBe(0);
    expect(pickIdentityHeir([right, left])).toBe(1);
    const noisier = at(400.0000000001, [3, 0, 0]);
    expect(pickIdentityHeir([at(400, [-3, 0, 0]), noisier])).toBe(0);
  });

  it('ranks heir first, then the rest by the same rule, whatever the input order', () => {
    const big = at(9, [0, 0, 0]);
    const smallA = at(1, [0, 0, 0]);
    const smallB = at(1, [5, 0, 0]);
    const order1 = rankSplitPieces([smallB, big, smallA]).map(i => [smallB, big, smallA][i]);
    const order2 = rankSplitPieces([smallA, smallB, big]).map(i => [smallA, smallB, big][i]);
    expect(order1).toEqual([big, smallA, smallB]);
    expect(order2).toEqual([big, smallA, smallB]);
  });
});

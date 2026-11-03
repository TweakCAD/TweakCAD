/**
 * A cut that goes right through a body splits it, and each piece becomes a
 * body of its own.
 *
 * The rule (`bodyIdentity.ts`): the identity heir — largest piece, ties
 * broken on centroid — keeps the body's id; the other pieces get ids minted
 * for the cutting feature, in a fixed order so they are named the same on
 * every rebuild. The pieces keep the face ids they had on the body, so a pick
 * made before the cut still resolves. Until this ran, the pieces were
 * published together as one compound under the original id.
 *
 * Real OCCT, through the real rebuild walk. Primitive boxes are centred on
 * their placement.
 */
import { describe, expect, it } from 'vitest';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { CadPart, CadProject, FeatureNode } from '@tweakcad/core/src/document/schema.ts';
import { createPart, emptyProject, newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { clearRebuildCache, incrementalRebuild } from '../rebuilder.ts';

function node(id: string, type: FeatureNode['type'], inputs: unknown): FeatureNode {
  return {
    id, type, name: id, version: 1, enabled: true, visible: true,
    inputs: inputs as Record<string, unknown>, dependsOn: [],
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
  } as unknown as FeatureNode;
}

function box(
  id: string,
  size: [number, number, number],
  position: [number, number, number],
  operation: 'newBody' | 'cut' = 'newBody',
): FeatureNode {
  return node(id, 'primitive', {
    shape: { kind: 'box', width: String(size[0]), height: String(size[1]), depth: String(size[2]) },
    transform: { position, rotation: [0, 0, 0, 1] },
    operation,
  });
}

function onePart(timeline: FeatureNode[], project = newProjectWithPart('P', 'Part 1')): { part: CadPart; project: CadProject } {
  const part = Object.values(project.parts)[0]!;
  part.timeline = timeline;
  return { part, project };
}

type Built = { bodyId: string; volume: number; centroidX: number; handle: KernelBody };

async function build(part: CadPart, project: CadProject, kernel: OcctKernel): Promise<Built[]> {
  const result = await incrementalRebuild(part, project, kernel, 0);
  const failed = result.featureResults.filter((r) => r.status !== 'success');
  if (failed.length > 0) throw new Error(`did not build: ${JSON.stringify(failed)}`);
  const out: Built[] = [];
  for (const b of result.bodies) {
    const m = await kernel.getMassProperties(b.handle);
    out.push({ bodyId: String(b.bodyId), volume: m.volume, centroidX: m.centerOfMass[0], handle: b.handle });
  }
  return out.sort((a, b) => a.bodyId.localeCompare(b.bodyId));
}

async function newKernel(): Promise<OcctKernel> {
  clearRebuildCache();
  const kernel = new OcctKernel();
  await kernel.init();
  return kernel;
}

const HOST = box('host', [10, 10, 10], [0, 0, 0]);

describe('a cut that splits a body', () => {
  it('publishes each piece; the larger keeps the id, the other is the cut feature\'s', async () => {
    // Slab at x 1..3 through a cube at x -5..5: pieces of 600 and 200 mm³.
    const { part, project } = onePart([HOST, box('slot', [2, 20, 20], [2, 0, 0], 'cut')]);
    const kernel = await newKernel();

    const bodies = await build(part, project, kernel);

    expect(bodies.map((b) => b.bodyId)).toEqual(['body_host_0', 'body_slot_0']);
    expect(bodies[0]!.volume).toBeCloseTo(600, 3);
    expect(bodies[0]!.centroidX).toBeCloseTo(-2, 3);
    expect(bodies[1]!.volume).toBeCloseTo(200, 3);
    expect(bodies[1]!.centroidX).toBeCloseTo(4, 3);
  }, 60_000);

  it('breaks an equal split on the centroid, the same way on every rebuild', async () => {
    // Centred slab: two 400 mm³ halves whose volumes differ only by float noise.
    const { part, project } = onePart([HOST, box('slot', [2, 20, 20], [0, 0, 0], 'cut')]);
    const kernel = await newKernel();

    for (let round = 0; round < 3; round++) {
      const bodies = await build(part, project, kernel);
      expect(bodies.map((b) => [b.bodyId, Math.round(b.volume), Math.sign(b.centroidX)])).toEqual([
        ['body_host_0', 400, -1], // the lower centroid inherits
        ['body_slot_0', 400, 1],
      ]);
    }
  }, 60_000);

  it('keeps the face ids the body had, so a face picked before the cut still resolves on the piece', async () => {
    // The host's face at x = -5 survives the cut untouched, on the heir.
    const hostOnly = onePart([HOST]);
    const probe = await newKernel();
    const [host] = await build(hostOnly.part, hostOnly.project, probe);
    const topo = await probe.getTopology(host!.handle);
    let leftFaceId: string | undefined;
    for (const f of topo.faces) {
      const face = await probe.resolveFaceRef(host!.handle, f.stableFaceId!);
      if (face && Math.abs((await probe.getFacePlane(face)).origin[0] + 5) < 1e-6) leftFaceId = f.stableFaceId;
    }
    expect(leftFaceId).toBeDefined();

    const { part, project } = onePart([HOST, box('slot', [2, 20, 20], [2, 0, 0], 'cut')]);
    const kernel = await newKernel();
    const bodies = await build(part, project, kernel);
    const heir = bodies.find((b) => b.bodyId === 'body_host_0')!;
    const face = await kernel.resolveFaceRef(heir.handle, leftFaceId as never);
    expect(face).not.toBeNull();
    expect((await kernel.getFacePlane(face!)).origin[0]).toBeCloseTo(-5, 6);
  }, 60_000);

  it('leaves a cut that does not go through as one body under its id', async () => {
    const { part, project } = onePart([HOST, box('pocket', [2, 2, 20], [0, 0, 5], 'cut')]);
    const kernel = await newKernel();

    const bodies = await build(part, project, kernel);

    expect(bodies.map((b) => b.bodyId)).toEqual(['body_host_0']);
  }, 60_000);

  it('splits a host the same way when a component cuts through it', async () => {
    const source = emptyProject('Slab');
    const sourcePart = createPart('Slab');
    sourcePart.timeline = [box('slab', [2, 20, 20], [0, 0, 0])];
    source.parts[sourcePart.id] = sourcePart;
    const { part, project } = onePart([
      HOST,
      node('comp', 'component', {
        componentRef: 'slab',
        transform: { position: [2, 0, 0], rotation: [0, 0, 0, 1] },
        parameterOverrides: {},
        boolean: 'cut',
      }),
    ]);
    project.embeddedComponents = { slab: { hash: 'slab', name: 'Slab', embeddedAt: '2026-11-03T00:00:00.000Z', source } };
    const kernel = await newKernel();

    const bodies = await build(part, project, kernel);

    expect(bodies.map((b) => [b.bodyId, Math.round(b.volume)])).toEqual([
      ['body_comp_0', 200],
      ['body_host_0', 600],
    ]);
  }, 60_000);
});

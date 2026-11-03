/**
 * Edges follow the edge history the kernel reports for each operation, so an
 * edge a join trims keeps the id it had, rather than taking an id numbered by
 * where it falls in the join result's edge order. That order changes with
 * edits that have nothing to do with the edge, so a fillet on a trimmed edge
 * used to move to another edge when the joined block moved.
 *
 * Block A is 40 × 20 × 10 at the origin; block B, 15 tall, is joined over
 * one end of it, so A's top-front edge (y = 0, z = 10) runs only up to B.
 *
 * Real OCCT, through the real rebuild walk.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { emptyProject, createPart } from '@tweakcad/core/src/document/factory.ts';
import { emptyEditorState, drawRectangle, toSnapshot, makeCounterIdFactory } from '@tweakcad/core/src/sketch/operations.ts';
import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { detectSketchRegions, regionToProfileRef } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { stableEdgeRef } from '@tweakcad/core/src/document/topologyRefs.ts';
import type { CadPart, EdgeRef, FeatureNode, SketchEditorSnapshot, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import type { Vec3 } from '@tweakcad/core/src/math.ts';
import { featureId, partId } from '@tweakcad/core/src/ids.ts';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { incrementalRebuild } from '../rebuilder.ts';

const PART = partId('part_1');

function feature(id: string, type: string, inputs: unknown): FeatureNode {
  return {
    id: featureId(id), type, name: id, version: 1, enabled: true, visible: true, dependsOn: [], inputs,
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
  } as unknown as FeatureNode;
}

function rectangleSketch(corner: [number, number], width: number, height: number): SketchEditorSnapshot {
  const state = drawRectangle(emptyEditorState(), { corner, width, height }, { idFactory: makeCounterIdFactory() }).state;
  return toSnapshot(state) as unknown as SketchEditorSnapshot;
}

function extrude(id: string, sketchId: string, editorModel: SketchEditorSnapshot, operation: 'newBody' | 'join', height: number) {
  const regions = detectSketchRegions(sketchBuildGeometry({ editorModel }));
  return feature(id, 'extrude', {
    profiles: regions.map(r => regionToProfileRef(featureId(sketchId), r, regions)),
    operation,
    direction: { type: 'normal' },
    extent: { type: 'distance', value: String(height) },
  });
}

/** Block A, with B (x from `bx` to `bx + width`) joined over it. */
function joinedBlocks(bx: number, width: number, extra: FeatureNode[] = []): CadPart {
  const a = rectangleSketch([0, 0], 40, 20);
  const b = rectangleSketch([bx, -5], width, 30);
  const part = createPart('Blocks');
  part.id = PART;
  part.timeline = [
    feature('sketch_a', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: a }),
    extrude('a', 'sketch_a', a, 'newBody', 10),
    feature('sketch_b', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: b }),
    extrude('b', 'sketch_b', b, 'join', 15),
    ...extra,
  ];
  return part;
}

async function rebuild(kernel: OcctKernel, part: CadPart) {
  const project = emptyProject('Edges');
  project.parts[part.id] = part;
  const result = await incrementalRebuild(part, project, kernel, 0);
  const failed = result.featureResults.filter(r => r.status !== 'success');
  if (failed.length > 0) throw new Error(`did not build: ${JSON.stringify(failed)}`);
  if (result.bodies.length !== 1 || result.topologyMaps.length !== 1) throw new Error('expected one body');
  return { body: result.bodies[0]!, topo: result.topologyMaps[0]! };
}

async function newKernel(): Promise<OcctKernel> {
  const kernel = new OcctKernel();
  await kernel.init();
  return kernel;
}

/** A's top-front edge: straight, at y = 0 and z = 10. */
function topFront(topo: TopologyMap): TopologyMap['edges'][number] {
  const edges = topo.edges.filter(e => {
    const c = e.repairHint?.center;
    return c !== undefined && Math.abs(c[1]) < 1e-6 && Math.abs(c[2] - 10) < 1e-6 && e.repairHint?.direction !== undefined;
  });
  if (edges.length !== 1) throw new Error(`expected one top-front edge, found ${edges.length}`);
  return edges[0]!;
}

/** Centres of the curved faces: a fillet's rounding. */
function rounds(topo: TopologyMap): Vec3[] {
  return topo.faces
    .map(f => f.repairHint)
    .filter(h => h !== undefined && h.normal === undefined && h.center !== undefined)
    .map(h => h!.center!);
}

describe('edge history (OCCT)', () => {
  beforeAll(attachTestSolver, 30_000);

  it('keeps the id an edge had before a join that trims it', async () => {
    const kernel = await newKernel();
    const blockA = joinedBlocks(30, 20);
    blockA.timeline = blockA.timeline.slice(0, 2);
    const alone = await rebuild(kernel, blockA);
    const before = String(topFront(alone.topo).stableEdgeId);

    const joined = await rebuild(kernel, joinedBlocks(30, 20));
    const edge = topFront(joined.topo);

    expect(edge.repairHint?.length).toBeCloseTo(30, 6); // trimmed where B starts
    expect(String(edge.stableEdgeId)).toBe(before);
  }, 60_000);

  it('keeps a fillet on a trimmed edge when the joined block moves to the other end', async () => {
    const kernel = await newKernel();
    const before = await rebuild(kernel, joinedBlocks(30, 20));
    const ref = stableEdgeRef({ partId: PART, bodyId: before.body.bodyId }, topFront(before.topo));
    expect(ref).not.toBeNull();
    const round: EdgeRef[] = [ref!];

    // B moves from the right end (x 30..50) to the left (x -10..5): A's
    // top-front edge now runs x 5..40, so it changed and its old place in
    // the join result's edge order is taken by another edge.
    const after = await rebuild(kernel, joinedBlocks(-10, 15, [feature('round', 'fillet', { edges: round, radius: '1' })]));

    const centres = rounds(after.topo);
    expect(centres).toHaveLength(1);
    const [x, y, z] = centres[0]!;
    expect(x).toBeCloseTo(22.5, 1);
    expect(y).toBeLessThan(1);
    expect(z).toBeGreaterThan(9);
  }, 60_000);
});

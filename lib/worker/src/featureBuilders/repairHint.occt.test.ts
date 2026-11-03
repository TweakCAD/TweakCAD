/**
 * A pick stores its stable id together with a repair hint — what the face
 * or edge looked like — and a rebuild checks the one the id resolves to
 * against it (`repairHint.ts` in the kernel).
 *
 * The ids of faces and edges a boolean creates are numbered in the order the
 * kernel walks them, so adding a hole to a sketch renumbers the walls and
 * rims of the holes already there: the id stored for one hole's rim comes to
 * name another hole's. The hint catches that and the ref follows the rim it
 * was picked on. A parametric edit that moves the picked edge must not send
 * the ref to a different edge that happens to sit near the old spot.
 *
 * Real OCCT, through the real rebuild walk.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { emptyProject, createPart } from '@tweakcad/core/src/document/factory.ts';
import {
  emptyEditorState,
  drawRectangle,
  drawCircle,
  toSnapshot,
  makeCounterIdFactory,
} from '@tweakcad/core/src/sketch/operations.ts';
import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { detectSketchRegions, regionToProfileRef } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { stableEdgeRef, stableFaceRef } from '@tweakcad/core/src/document/topologyRefs.ts';
import type {
  CadPart,
  EdgeRef,
  FeatureNode,
  RepairHint,
  SketchEditorSnapshot,
  TopologyMap,
} from '@tweakcad/core/src/document/schema.ts';
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

function circleSketch(centers: [number, number][], radius: number): SketchEditorSnapshot {
  let state = emptyEditorState();
  const ids = makeCounterIdFactory();
  for (const center of centers) state = drawCircle(state, { center, radius }, { idFactory: ids }).state;
  return toSnapshot(state) as unknown as SketchEditorSnapshot;
}

function profiles(sketchId: string, editorModel: SketchEditorSnapshot) {
  const regions = detectSketchRegions(sketchBuildGeometry({ editorModel }));
  return regions.map(r => regionToProfileRef(featureId(sketchId), r, regions));
}

function extrude(
  id: string,
  sketchId: string,
  editorModel: SketchEditorSnapshot,
  operation: 'newBody' | 'cut',
  height: number,
): FeatureNode {
  return feature(id, 'extrude', {
    profiles: profiles(sketchId, editorModel),
    operation,
    direction: { type: 'normal' },
    extent: { type: 'distance', value: String(height) },
  });
}

/** A 60 × 40 × 20 block with 3 mm holes right through it at `holes`. */
function holedBlock(holes: [number, number][], extra: FeatureNode[] = []): CadPart {
  const base = rectangleSketch([-30, -20], 60, 40);
  const holeSketch = circleSketch(holes, 3);
  const part = createPart('Holes');
  part.id = PART;
  part.timeline = [
    feature('sketch_block', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: base }),
    extrude('block', 'sketch_block', base, 'newBody', 20),
    feature('sketch_holes', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: holeSketch }),
    extrude('holes', 'sketch_holes', holeSketch, 'cut', 20),
    ...extra,
  ];
  return part;
}

/** A 10 × 10 block `height` tall. */
function smallBlock(height: number, extra: FeatureNode[] = []): CadPart {
  const base = rectangleSketch([0, 0], 10, 10);
  const part = createPart('Small');
  part.id = PART;
  part.timeline = [
    feature('sketch_block', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: base }),
    extrude('block', 'sketch_block', base, 'newBody', height),
    ...extra,
  ];
  return part;
}

async function rebuild(kernel: OcctKernel, part: CadPart) {
  const project = emptyProject('Hints');
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

const near = (a: readonly number[] | undefined, b: readonly number[], tol = 1e-3): boolean =>
  a !== undefined && a.every((v, i) => Math.abs(v - b[i]!) < tol);

/** The circular edge (measured without a direction) centred at `at`. */
function rimAt(topo: TopologyMap, at: Vec3): TopologyMap['edges'][number] {
  const edge = topo.edges.find(e => near(e.repairHint?.center, at) && e.repairHint?.direction === undefined);
  if (!edge) throw new Error(`no rim at ${at.join(',')}`);
  return edge;
}

function fillet(edges: EdgeRef[], radius: number): FeatureNode {
  return feature('round', 'fillet', { edges, radius: String(radius) });
}

/** Centroids of the curved faces centred within `band` of height `z`: a fillet's rounding. */
function roundsNearZ(topo: TopologyMap, z: number, band: number): Vec3[] {
  return topo.faces
    .map(f => f.repairHint)
    .filter((h): h is RepairHint & { center: Vec3 } =>
      h !== undefined && h.normal === undefined && h.center !== undefined && Math.abs(h.center[2] - z) < band)
    .map(h => h.center);
}

describe('repair hints (OCCT)', () => {
  beforeAll(attachTestSolver, 30_000);

  it('records a hint for every face and edge in the topology map', async () => {
    const { topo } = await rebuild(await newKernel(), holedBlock([[10, 0]]));

    for (const f of topo.faces) expect(f.repairHint?.center, String(f.stableFaceId)).toBeDefined();
    for (const e of topo.edges) expect(e.repairHint?.length, String(e.stableEdgeId)).toBeGreaterThan(0);
    // The top face is planar, so it has a normal; its box is the 60 × 40 top.
    const top = topo.faces.find(f => near(f.repairHint?.normal, [0, 0, 1]) && near(f.repairHint?.center?.slice(2), [20]));
    expect(top?.repairHint?.size).toBeCloseTo(Math.hypot(60, 40), 3);
    // A long top edge is straight, so it has a direction.
    const edge = topo.edges.find(e => near(e.repairHint?.center, [0, -20, 20]));
    expect(edge?.repairHint?.length).toBeCloseTo(60, 6);
    expect(Math.abs(edge?.repairHint?.direction?.[0] ?? 0)).toBeCloseTo(1, 6);
  }, 60_000);

  it('keeps a fillet on the hole it was picked on when another hole is added', async () => {
    const kernel = await newKernel();
    const before = await rebuild(kernel, holedBlock([[10, 0], [-10, 0]]));
    const ref = stableEdgeRef({ partId: PART, bodyId: before.body.bodyId }, rimAt(before.topo, [10, 0, 20]));
    expect(ref).not.toBeNull();

    // The same pick, then a hole added at (20, 10): the rim's id now names
    // the new hole's rim.
    const after = await rebuild(kernel, holedBlock([[20, 10], [10, 0], [-10, 0]], [fillet([ref!], 1)]));

    const rounds = roundsNearZ(after.topo, 20, 1);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]![0]).toBeCloseTo(10, 1);
    expect(rounds[0]![1]).toBeCloseTo(0, 1);
  }, 60_000);

  it('resolves a face ref to the hole wall it was picked on when another hole is added', async () => {
    const kernel = await newKernel();
    const before = await rebuild(kernel, holedBlock([[10, 0], [-10, 0]]));
    const wall = before.topo.faces.find(f => near(f.repairHint?.center, [10, 0, 10]));
    const ref = wall ? stableFaceRef({ partId: PART, bodyId: before.body.bodyId }, wall) : null;
    expect(ref).not.toBeNull();

    const after = await rebuild(kernel, holedBlock([[20, 10], [10, 0], [-10, 0]]));
    const face = await kernel.resolveFaceRef(after.body.handle, ref!.stableFaceId, ref!.repairHint);

    expect(face).not.toBeNull();
    const { origin } = await kernel.getFacePlane(face!);
    expect(origin[0]).toBeCloseTo(10, 3);
    expect(origin[1]).toBeCloseTo(0, 3);
  }, 60_000);

  it('keeps a fillet on its edge when a taller block moves it away and a look-alike sits near the old spot', async () => {
    // Top edge along x at y = 0: midpoint (5, 0, 10). At height 22 it is at
    // (5, 0, 22), 12 mm away. The bottom edge under it, (5, 0, 0), is 10 mm
    // from the old spot, runs the same way and is as long: close, but not
    // the picked geometry, so it is no reason to leave the id's edge.
    const kernel = await newKernel();
    const before = await rebuild(kernel, smallBlock(10));
    const top = before.topo.edges.find(e => near(e.repairHint?.center, [5, 0, 10]));
    const ref = top ? stableEdgeRef({ partId: PART, bodyId: before.body.bodyId }, top) : null;
    expect(ref).not.toBeNull();

    const after = await rebuild(kernel, smallBlock(22, [fillet([ref!], 1)]));

    const rounds = roundsNearZ(after.topo, 22, 1);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]![0]).toBeCloseTo(5, 1);
    expect(rounds[0]![1]).toBeLessThan(1);
  }, 60_000);
});

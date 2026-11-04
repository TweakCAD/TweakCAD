/**
 * The faces an extrude or a partial revolve creates are named from the
 * sketch: a side face after the segment it is swept from, a cap after its
 * region. A sketch edit renames only what it changed.
 *
 * Real OCCT, through the real rebuild walk.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { isWalkOrderId } from '@tweakcad/kernel/src/topologyTracker.ts';
import { emptyProject, createPart } from '@tweakcad/core/src/document/factory.ts';
import {
  drawCircle, drawLine, drawRectangle, emptyEditorState, makeCounterIdFactory, toSnapshot,
} from '@tweakcad/core/src/sketch/operations.ts';
import type { EditorState } from '@tweakcad/core/src/sketch/operations.ts';
import { trimAt } from '@tweakcad/core/src/sketch/modifyOps.ts';
import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { detectSketchRegions, pointInRegion, regionToProfileRef } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type { CadPart, FeatureNode, SketchEditorSnapshot, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import { featureId, partId } from '@tweakcad/core/src/ids.ts';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { incrementalRebuild } from '../rebuilder.ts';

function feature(id: string, type: string, inputs: unknown): FeatureNode {
  return {
    id: featureId(id), type, name: id, version: 1, enabled: true, visible: true, dependsOn: [], inputs,
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z',
  } as unknown as FeatureNode;
}

/** The sketch, and refs to the regions containing `points` (smallest first). */
function sketchWith(state: EditorState, points: [number, number][]) {
  const editorModel = toSnapshot(state) as unknown as SketchEditorSnapshot;
  const regions = detectSketchRegions(sketchBuildGeometry({ editorModel }));
  const picked = points.map(p => regions.filter(r => pointInRegion(p, r)).sort((a, b) => a.area - b.area)[0]!);
  return { editorModel, profiles: picked.map(r => regionToProfileRef(featureId('sk'), r, regions)) };
}

function extrudePart(state: EditorState, points: [number, number][]): CadPart {
  const { editorModel, profiles } = sketchWith(state, points);
  const part = createPart('P');
  part.id = partId('part_1');
  part.timeline = [
    feature('sk', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel }),
    feature('ext', 'extrude', { profiles, operation: 'newBody', direction: { type: 'normal' }, extent: { type: 'distance', value: '10' } }),
  ];
  return part;
}

async function rebuild(part: CadPart): Promise<TopologyMap[]> {
  const kernel = new OcctKernel();
  await kernel.init();
  const project = emptyProject('Names');
  project.parts[part.id] = part;
  const result = await incrementalRebuild(part, project, kernel, 0);
  const failed = result.featureResults.filter(r => r.status !== 'success');
  if (failed.length > 0) throw new Error(`did not build: ${JSON.stringify(failed)}`);
  return result.topologyMaps;
}

/** Face IDs of the body whose faces lie in x ∈ [x0, x1]. */
function faceIdsWithin(maps: TopologyMap[], x0: number, x1: number): string[] {
  return maps
    .flatMap(t => t.faces)
    .filter(f => {
      const c = f.repairHint?.center;
      return c !== undefined && c[0] >= x0 - 1e-6 && c[0] <= x1 + 1e-6;
    })
    .map(f => String(f.stableFaceId))
    .sort();
}

describe('faces named from the sketch (OCCT)', () => {
  beforeAll(attachTestSolver, 30_000);

  it('names every face of an extruded rectangle: four sides and two caps', async () => {
    const ids = makeCounterIdFactory();
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 20, height: 10 }, { idFactory: ids });
    const [topo] = await rebuild(extrudePart(rect.state, [[5, 5]]));
    const names = topo!.faces.map(f => String(f.stableFaceId));
    for (const edge of Object.values(rect.edges)) expect(names).toContain(`sf_extrude_ext~side(${String(edge)})`);
    expect(names.filter(n => /^sf_extrude_ext~start\([0-9a-f]{16}\)$/.test(n))).toHaveLength(1);
    expect(names.filter(n => /^sf_extrude_ext~end\([0-9a-f]{16}\)$/.test(n))).toHaveLength(1);
    expect(names.some(isWalkOrderId)).toBe(false);
  }, 60_000);

  it('adding a profile renames no face of the existing one', async () => {
    const ids = makeCounterIdFactory();
    const first = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 20, height: 10 }, { idFactory: ids }).state;
    const both = drawRectangle(first, { corner: [40, 0], width: 10, height: 10 }, { idFactory: ids }).state;
    const alone = faceIdsWithin(await rebuild(extrudePart(first, [[5, 5]])), 0, 20);
    const withSecond = faceIdsWithin(await rebuild(extrudePart(both, [[5, 5], [45, 5]])), 0, 20);
    expect(withSecond).toEqual(alone);
  }, 60_000);

  it('a hole on the top face stays on it, by the same ID, when a profile is added', async () => {
    const ids = makeCounterIdFactory();
    const first = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 20, height: 10 }, { idFactory: ids }).state;
    const both = drawRectangle(first, { corner: [40, 0], width: 10, height: 10 }, { idFactory: ids }).state;
    const [alone] = await rebuild(extrudePart(first, [[5, 5]]));
    const top = alone!.faces.find(f => String(f.stableFaceId).startsWith('sf_extrude_ext~end('))!;
    const drilled = (state: EditorState, points: [number, number][]) => {
      const part = extrudePart(state, points);
      part.timeline.push(feature('hole_1', 'hole', {
        face: { type: 'stableTopology', bodyRef: { partId: part.id, bodyId: alone!.bodyId }, stableFaceId: top.stableFaceId },
        center: ['0', '0'],
        direction: { type: 'normal' },
        diameter: '4',
        extent: { type: 'distance', value: '4' },
        kind: 'simple',
      }));
      return part;
    };
    const maps = await rebuild(drilled(both, [[5, 5], [45, 5]]));
    // The hole's wall sits under the face's centre, (10, 5).
    const walls = maps.flatMap(t => t.faces).filter(f => {
      const c = f.repairHint?.center;
      return c !== undefined && Math.abs(c[0] - 10) < 1e-3 && Math.abs(c[1] - 5) < 1e-3 && c[2] > 1 && c[2] < 9;
    });
    expect(walls.length).toBeGreaterThan(0);
    expect(faceIdsWithin(maps, 0, 20)).toContain(String(top.stableFaceId));
  }, 60_000);

  it('trimming a crossing line renames only the face swept from it', async () => {
    // A 40 x 20 rectangle cut at x = 10 by a line running past both edges;
    // the left part is extruded. Trimming the stub below the bottom edge
    // ends the line on that edge.
    const ids = makeCounterIdFactory();
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 40, height: 20 }, { idFactory: ids });
    const cut = drawLine(rect.state, [10, -5], [10, 25], { idFactory: ids, distinctStart: true });
    const trimmed = trimAt(cut.state, cut.lineId, [10, -2]);
    expect(trimmed).not.toBeNull();

    const before = faceIdsWithin(await rebuild(extrudePart(cut.state, [[5, 10]])), 0, 10);
    const after = faceIdsWithin(await rebuild(extrudePart(trimmed!, [[5, 10]])), 0, 10);
    const gone = before.filter(id => !after.includes(id));
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatch(new RegExp(`^sf_extrude_ext~side\\(${String(cut.lineId)}\\[`));
    expect(after.filter(id => !before.includes(id))).toHaveLength(1);
  }, 60_000);

  it('names a hole\'s wall after its circle', async () => {
    const ids = makeCounterIdFactory();
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 20, height: 20 }, { idFactory: ids });
    const hole = drawCircle(rect.state, { center: [10, 10], radius: 3 }, { idFactory: ids });
    // A point in the annulus picks the square with the circle as its hole.
    const [topo] = await rebuild(extrudePart(hole.state, [[2, 2]]));
    const wall = topo!.faces.find(f => {
      const c = f.repairHint?.center;
      return c !== undefined && Math.abs(c[0] - 10) < 1e-3 && Math.abs(c[1] - 10) < 1e-3 && Math.abs(c[2] - 5) < 1e-3;
    });
    expect(String(wall?.stableFaceId)).toBe(`sf_extrude_ext~side(${String(hole.circleId)})`);
  }, 60_000);

  it('names the faces of a quarter revolve the same way', async () => {
    const ids = makeCounterIdFactory();
    const rect = drawRectangle(emptyEditorState(), { corner: [10, 0], width: 5, height: 10 }, { idFactory: ids });
    const { editorModel, profiles } = sketchWith(rect.state, [[12, 5]]);
    const part = createPart('P');
    part.id = partId('part_1');
    part.timeline = [
      feature('sk', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel }),
      feature('rev', 'revolve', { profile: profiles[0], axis: { type: 'y' }, angle: '90', operation: 'newBody' }),
    ];
    const [topo] = await rebuild(part);
    const names = topo!.faces.map(f => String(f.stableFaceId));
    expect(names).toHaveLength(6);
    for (const edge of Object.values(rect.edges)) expect(names).toContain(`sf_revolve_rev~side(${String(edge)})`);
    expect(names.some(n => n.startsWith('sf_revolve_rev~start('))).toBe(true);
    expect(names.some(n => n.startsWith('sf_revolve_rev~end('))).toBe(true);
  }, 60_000);
});

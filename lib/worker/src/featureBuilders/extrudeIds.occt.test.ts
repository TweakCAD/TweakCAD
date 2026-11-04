/**
 * A newBody extrude publishes the face IDs its extrude and fuse assigned.
 * Before, the result was copied and renumbered by a walk of the whole fused
 * solid, so changing one of two fused profiles renamed the other's faces.
 *
 * Real OCCT, through the real rebuild walk.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { emptyProject, createPart } from '@tweakcad/core/src/document/factory.ts';
import {
  drawPolygon, drawRectangle, emptyEditorState, makeCounterIdFactory, toSnapshot,
} from '@tweakcad/core/src/sketch/operations.ts';
import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { detectSketchRegions, regionToProfileRef } from '@tweakcad/core/src/sketch/profileRegions.ts';
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

/** A 20 x 10 block, with a `sides`-gon overlapping its right end, extruded 10 as one newBody. */
function blockWithPolygon(sides: number): CadPart {
  const ids = makeCounterIdFactory();
  let state = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 20, height: 10 }, { idFactory: ids }).state;
  state = drawPolygon(state, { center: [24, 5], vertex: [30, 5], sides }, { idFactory: ids }).state;
  const sketch = toSnapshot(state) as unknown as SketchEditorSnapshot;
  const regions = detectSketchRegions(sketchBuildGeometry({ editorModel: sketch }));
  const part = createPart('Block');
  part.id = partId('part_1');
  part.timeline = [
    feature('sk', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: sketch }),
    feature('ext', 'extrude', {
      profiles: regions.map(r => regionToProfileRef(featureId('sk'), r, regions)),
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    }),
  ];
  return part;
}

async function rebuild(part: CadPart): Promise<TopologyMap[]> {
  const kernel = new OcctKernel();
  await kernel.init();
  const project = emptyProject('Ids');
  project.parts[part.id] = part;
  const result = await incrementalRebuild(part, project, kernel, 0);
  const failed = result.featureResults.filter(r => r.status !== 'success');
  if (failed.length > 0) throw new Error(`did not build: ${JSON.stringify(failed)}`);
  return result.topologyMaps;
}

/** The top face over the block's left end. */
function blockTop(topo: TopologyMap): string {
  const tops = topo.faces.filter(f => {
    const c = f.repairHint?.center;
    return c !== undefined && Math.abs(c[2] - 10) < 1e-6 && c[0] < 15;
  });
  expect(tops).toHaveLength(1);
  return String(tops[0]!.stableFaceId);
}

describe('newBody extrude keeps the IDs its extrude assigned (OCCT)', () => {
  beforeAll(attachTestSolver, 30_000);

  it('changing one fused profile does not rename the other profile\'s faces', async () => {
    const [square] = await rebuild(blockWithPolygon(4));
    const [hexagon] = await rebuild(blockWithPolygon(6));
    expect(blockTop(hexagon!)).toBe(blockTop(square!));
    expect(blockTop(square!)).toMatch(/^sf_extrude_ext~end\(/);
  }, 60_000);
});

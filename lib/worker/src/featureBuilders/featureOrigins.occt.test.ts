/**
 * The IDs a modify op mints for the faces and edges it creates carry the
 * feature that ran it, so two features of the same kind never share them.
 * Before, every fillet minted `sf_fillet_…`, and which of two fillets' faces
 * got a `:n` suffix depended on build order.
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

function block(extra: FeatureNode[] = []): CadPart {
  const sketch = toSnapshot(
    drawRectangle(emptyEditorState(), { corner: [0, 0], width: 40, height: 20 }, { idFactory: makeCounterIdFactory() }).state,
  ) as unknown as SketchEditorSnapshot;
  const regions = detectSketchRegions(sketchBuildGeometry({ editorModel: sketch }));
  const part = createPart('Block');
  part.id = PART;
  part.timeline = [
    feature('sketch_block', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: sketch }),
    feature('block', 'extrude', {
      profiles: regions.map(r => regionToProfileRef(featureId('sketch_block'), r, regions)),
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '10' },
    }),
    ...extra,
  ];
  return part;
}

async function rebuild(kernel: OcctKernel, part: CadPart): Promise<TopologyMap> {
  const project = emptyProject('Origins');
  project.parts[part.id] = part;
  const result = await incrementalRebuild(part, project, kernel, 0);
  const failed = result.featureResults.filter(r => r.status !== 'success');
  if (failed.length > 0) throw new Error(`did not build: ${JSON.stringify(failed)}`);
  return result.topologyMaps[0]!;
}

/** The ref to the straight top edge whose centre is at (x, y, 10). */
function topEdge(topo: TopologyMap, x: number, y: number): EdgeRef {
  const edge = topo.edges.find(e => {
    const c = e.repairHint?.center;
    return c !== undefined && Math.abs(c[0] - x) < 1e-6 && Math.abs(c[1] - y) < 1e-6 && Math.abs(c[2] - 10) < 1e-6;
  });
  const ref = edge ? stableEdgeRef({ partId: PART, bodyId: topo.bodyId }, edge) : null;
  if (!ref) throw new Error(`no top edge at ${x},${y}`);
  return ref;
}

describe('feature-scoped origins (OCCT)', () => {
  beforeAll(attachTestSolver, 30_000);

  it('names what each of two fillets creates after that fillet', async () => {
    const kernel = new OcctKernel();
    await kernel.init();
    const base = await rebuild(kernel, block());
    const front = topEdge(base, 20, 0);
    const back = topEdge(base, 20, 20);

    const topo = await rebuild(kernel, block([
      feature('round_front', 'fillet', { edges: [front], radius: '2' }),
      feature('round_back', 'fillet', { edges: [back], radius: '2' }),
    ]));

    const created = [
      ...topo.faces.map(f => String(f.stableFaceId)),
      ...topo.edges.map(e => String(e.stableEdgeId)),
    ].filter(id => id.includes('fillet'));
    // Each fillet's rounded face, at least.
    expect(created.some(id => id.startsWith('sf_fillet_round_front_'))).toBe(true);
    expect(created.some(id => id.startsWith('sf_fillet_round_back_'))).toBe(true);
    for (const id of created) expect(id, id).toMatch(/^s[fe]_fillet_round_(front|back)_/);
  }, 60_000);
});

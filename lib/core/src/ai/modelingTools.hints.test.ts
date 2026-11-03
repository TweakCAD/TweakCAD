/**
 * Refs made by the AI tools carry the repair hint the host's topology map
 * has for the face or edge, as refs picked in the viewport do.
 */
import { describe, expect, it } from 'vitest';
import { CommandBus } from '../commands/bus.ts';
import { DocumentStore } from '../store/documentStore.ts';
import { newProjectWithPart } from '../document/factory.ts';
import { createFilletHandler, createShellHandler } from '../commands/handlers/featureCommands.ts';
import type { FilletFeatureInputs, RepairHint, ShellFeatureInputs, TopologyMap } from '../document/schema.ts';
import type { PartId } from '../ids.ts';
import { executeTool, type ToolHost } from './toolExecutor.ts';

const EDGE_HINT: RepairHint = { center: [5, 0, 10], length: 10, direction: [1, 0, 0] };
const FACE_HINT: RepairHint = { center: [5, 5, 10], size: 14.142, normal: [0, 0, 1] };

const TOPOLOGY = {
  bodyId: 'body_box_0',
  faces: [
    { faceId: 'f_0', triStart: 0, triEnd: 2, stableFaceId: 'sf_box_5', repairHint: FACE_HINT },
    { faceId: 'f_1', triStart: 2, triEnd: 4, stableFaceId: 'sf_box_4' },
  ],
  edges: [
    { edgeId: 'e_0', lineSegments: new Float32Array(0), adjacentFaces: ['f_0', 'f_1'], stableEdgeId: 'se_box_3', repairHint: EDGE_HINT },
    { edgeId: 'e_1', lineSegments: new Float32Array(0), adjacentFaces: ['f_0', 'f_1'], stableEdgeId: 'se_box_9' },
  ],
} as unknown as TopologyMap;

function newHost(topology: boolean): { host: ToolHost; store: DocumentStore; partId: PartId } {
  const project = newProjectWithPart('Box');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateFillet', createFilletHandler);
  bus.register('CreateShell', createShellHandler);
  const host: ToolHost = {
    getDocument: () => store.getState(),
    getDiagnostics: () => ({ diagnostics: [], featureResults: {} }),
    dispatchCommand: async (cmd) => {
      const r = bus.dispatch(cmd as never);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return store.getState();
    },
    beginTransaction: async () => {},
    endTransaction: async () => {},
    ...(topology ? { getTopology: async (bodyId: string) => (bodyId === 'body_box_0' ? TOPOLOGY : null) } : {}),
  };
  return { host, store, partId: Object.keys(project.parts)[0] as PartId };
}

function lastInputs<T>(store: DocumentStore, partId: PartId): T {
  const timeline = store.getState().parts[partId]!.timeline;
  return timeline[timeline.length - 1]!.inputs as unknown as T;
}

describe('repair hints on refs made by AI tools', () => {
  it('feature_fillet copies each edge\'s hint, and leaves it off an edge without one', async () => {
    const { host, store, partId } = newHost(true);
    const r = await executeTool('feature_fillet', {
      partId, bodyId: 'body_box_0', stableEdgeIds: ['se_box_3', 'se_box_9'], radius: 1,
    }, host);
    expect(r.ok).toBe(true);

    const { edges } = lastInputs<FilletFeatureInputs>(store, partId);
    expect(edges.map(e => (e.type === 'stableTopology' ? e.repairHint : 'other'))).toEqual([EDGE_HINT, undefined]);
  });

  it('feature_shell copies the removed face\'s hint', async () => {
    const { host, store, partId } = newHost(true);
    const r = await executeTool('feature_shell', {
      partId, bodyId: 'body_box_0', removedFaceIds: ['sf_box_5'], thickness: 1,
    }, host);
    expect(r.ok).toBe(true);

    const { removedFaces } = lastInputs<ShellFeatureInputs>(store, partId);
    expect(removedFaces[0]).toMatchObject({ stableFaceId: 'sf_box_5', repairHint: FACE_HINT });
  });

  it('makes refs without hints on a host that exposes no topology', async () => {
    const { host, store, partId } = newHost(false);
    const r = await executeTool('feature_fillet', {
      partId, bodyId: 'body_box_0', stableEdgeIds: ['se_box_3'], radius: 1,
    }, host);
    expect(r.ok).toBe(true);

    const { edges } = lastInputs<FilletFeatureInputs>(store, partId);
    expect(edges[0]).not.toHaveProperty('repairHint');
  });
});

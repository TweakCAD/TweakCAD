/**
 * Region-facing AI tools over a real CommandBus: `list_sketch_regions`
 * and `feature_extrude` on a boss circle with a concentric insert circle.
 */
import { describe, expect, it } from 'vitest';
import { CommandBus } from '../commands/bus.ts';
import { DocumentStore } from '../store/documentStore.ts';
import { newProjectWithPart } from '../document/factory.ts';
import { createSketchHandler, createExtrudeHandler } from '../commands/handlers/featureCommands.ts';
import { sketchDrawCircleHandler } from '../commands/handlers/sketchDrawCommands.ts';
import { detectSketchRegions, pointInRegion, resolveProfile } from '../sketch/profileRegions.ts';
import { sketchBuildGeometry } from '../sketch/derivedGeometry.ts';
import type { ExtrudeFeatureInputs, SketchFeatureInputs } from '../document/schema.ts';
import type { PartId } from '../ids.ts';
import { executeTool, type ToolHost } from './toolExecutor.ts';

function newHost(): { host: ToolHost; store: DocumentStore; partId: PartId } {
  const project = newProjectWithPart('Boss');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketch', createSketchHandler);
  bus.register('CreateExtrude', createExtrudeHandler);
  bus.register('SketchDrawCircle', sketchDrawCircleHandler);
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
  };
  return { host, store, partId: Object.keys(project.parts)[0] as PartId };
}

async function call<T>(host: ToolHost, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await executeTool(name, args, host);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function bossSketch() {
  const { host, store, partId } = newHost();
  const { sketchId } = await call<{ sketchId: string }>(host, 'sketch_create', { partId, plane: 'XY' });
  const { entityId: outer } = await call<{ entityId: string }>(host, 'sketch_draw_circle', {
    sketchId, center: [0, 0], radius: 4,
  });
  const { entityId: inner } = await call<{ entityId: string }>(host, 'sketch_draw_circle', {
    sketchId, center: [0, 0], radius: 2,
  });
  return { host, store, partId, sketchId, outer, inner };
}

type RegionSummary = {
  id: string;
  type: string;
  area: number;
  center: [number, number];
  wireEntityIds: string[];
  holeEntityIds?: string[];
};

function sketchRegions(store: DocumentStore, partId: PartId, sketchId: string) {
  const sketch = store.getState().parts[partId]!.timeline.find(f => f.id === sketchId)!;
  return detectSketchRegions(sketchBuildGeometry(sketch.inputs as unknown as SketchFeatureInputs));
}

function lastExtrude(store: DocumentStore, partId: PartId): ExtrudeFeatureInputs {
  const timeline = store.getState().parts[partId]!.timeline;
  const ex = [...timeline].reverse().find(f => f.type === 'extrude')!;
  return ex.inputs as unknown as ExtrudeFeatureInputs;
}

describe('list_sketch_regions on concentric circles', () => {
  it('reports the ring (net area, hole ids, a material point) and the inner disc', async () => {
    const { host, sketchId, outer, inner } = await bossSketch();
    const regions = await call<RegionSummary[]>(host, 'list_sketch_regions', { sketchId });
    expect(regions).toHaveLength(2);
    const [ring, disc] = regions;
    expect(ring!.wireEntityIds).toEqual([outer]);
    expect(ring!.holeEntityIds).toEqual([inner]);
    expect(ring!.area).toBeCloseTo(Math.PI * 12, 6);
    const r = Math.hypot(ring!.center[0], ring!.center[1]);
    expect(r).toBeGreaterThan(2);
    expect(r).toBeLessThan(4);
    expect(disc!.wireEntityIds).toEqual([inner]);
    expect(disc!.holeEntityIds).toBeUndefined();
    expect(disc!.area).toBeCloseTo(Math.PI * 4, 6);
  });
});

describe('feature_extrude on concentric circles', () => {
  it('a [outer, inner] profile resolves to the ring', async () => {
    const { host, store, partId, sketchId, outer, inner } = await bossSketch();
    await call(host, 'feature_extrude', {
      sketchId, distance: 5, profiles: [{ wireEntityIds: [outer, inner] }],
    });
    const [ref] = lastExtrude(store, partId).profiles;
    const regions = sketchRegions(store, partId, sketchId);
    const resolved = resolveProfile(ref!, regions);
    expect(resolved.status).toBe('resolved');
    expect(resolved.region?.holes?.map(h => String(h.entityIds[0]))).toEqual([inner]);
  });

  it('auto-profile interior points land in each region\'s material', async () => {
    const { host, store, partId, sketchId } = await bossSketch();
    await call(host, 'feature_extrude', { sketchId, distance: 5 });
    const profiles = lastExtrude(store, partId).profiles;
    const regions = sketchRegions(store, partId, sketchId);
    expect(profiles).toHaveLength(2);
    for (const ref of profiles) {
      const region = resolveProfile(ref, regions).region!;
      expect(pointInRegion(ref.interiorPoint!, region)).toBe(true);
    }
  });
});

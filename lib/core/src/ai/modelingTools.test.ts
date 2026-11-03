/**
 * Region-facing AI tools over a real CommandBus: `list_sketch_regions`
 * and `feature_extrude` on a boss circle with a concentric insert circle.
 */
import { describe, expect, it } from 'vitest';
import { CommandBus } from '../commands/bus.ts';
import { DocumentStore } from '../store/documentStore.ts';
import { newProjectWithPart } from '../document/factory.ts';
import { createSketchHandler, createExtrudeHandler } from '../commands/handlers/featureCommands.ts';
import { sketchDrawCircleHandler, sketchDrawRectangleHandler, sketchDrawSlotHandler } from '../commands/handlers/sketchDrawCommands.ts';
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
  bus.register('SketchDrawRectangle', sketchDrawRectangleHandler);
  bus.register('SketchDrawSlot', sketchDrawSlotHandler);
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

describe('face anchors in sketch_create / feature_extrude', () => {
  const top = { bodyId: 'body_box_0', stableFaceId: 'sf_box_5' };

  it('sketch_create on a face stores the face as the sketch plane', async () => {
    const { host, store, partId } = newHost();
    const { sketchId } = await call<{ sketchId: string }>(host, 'sketch_create', { partId, face: top });
    const sketch = store.getState().parts[partId]!.timeline.find(f => f.id === sketchId)!;
    expect((sketch.inputs as unknown as SketchFeatureInputs).plane).toEqual({
      type: 'stableTopology',
      bodyRef: { partId, bodyId: 'body_box_0' },
      stableFaceId: 'sf_box_5',
    });
  });

  it('sketch_create takes exactly one of plane / face', async () => {
    const { host, partId } = newHost();
    const both = await executeTool('sketch_create', { partId, plane: 'XY', face: top }, host);
    expect(both.ok).toBe(false);
    const neither = await executeTool('sketch_create', { partId }, host);
    expect(neither.ok).toBe(false);
    const badFace = await executeTool('sketch_create', { partId, face: { bodyId: 'b' } }, host);
    expect(badFace.ok).toBe(false);
  });

  it('feature_extrude maps toFace to a toPlane extent and startFace to startFrom', async () => {
    const { host, store, partId, sketchId } = await bossSketch();
    await call(host, 'feature_extrude', {
      sketchId, operation: 'cut', toFace: top, startFace: { bodyId: 'body_box_0', stableFaceId: 'sf_box_4' }, startOffset: 2,
    });
    const inputs = lastExtrude(store, partId);
    expect(inputs.extent).toEqual({
      type: 'toPlane',
      plane: { type: 'stableTopology', bodyRef: { partId, bodyId: 'body_box_0' }, stableFaceId: 'sf_box_5' },
    });
    expect(inputs.startFrom).toEqual({
      type: 'stableTopology', bodyRef: { partId, bodyId: 'body_box_0' }, stableFaceId: 'sf_box_4',
    });
    expect(inputs.startOffset).toBe('2');
    expect(inputs.operation).toBe('cut');
  });

  it('feature_extrude needs a distance or a toFace, not both', async () => {
    const { host, sketchId } = await bossSketch();
    expect((await executeTool('feature_extrude', { sketchId }, host)).ok).toBe(false);
    expect((await executeTool('feature_extrude', { sketchId, distance: 5, toFace: top }, host)).ok).toBe(false);
    expect((await executeTool('feature_extrude', { sketchId, toFace: top, direction: 'symmetric' }, host)).ok).toBe(false);
  });
});

describe('sketch_draw_rectangle / sketch_draw_slot return every curve they draw', () => {
  // Both draw several curves (invariant #11: no composite entity). They used
  // to return one `entityId` — whichever new id the diff met first — so a
  // caller could not build a profile from the result.
  it.each([
    ['sketch_draw_rectangle', { corner: [0, 0], width: 60, height: 30 }, ['line', 'line', 'line', 'line']],
    ['sketch_draw_slot', { center1: [0, 0], center2: [20, 0], width: 6 }, ['arc', 'arc', 'line', 'line']],
  ] as const)('%s returns all its entity ids, which close into one region', async (tool, args, kinds) => {
    const { host, store, partId } = newHost();
    const { sketchId } = await call<{ sketchId: string }>(host, 'sketch_create', { partId, plane: 'XY' });

    const { entityIds } = await call<{ entityIds: string[] }>(host, tool, { sketchId, ...args });

    const sketch = store.getState().parts[partId]!.timeline.find((f) => f.id === sketchId)!;
    const entities = sketchBuildGeometry(sketch.inputs as unknown as SketchFeatureInputs) as Record<string, { type: string }>;
    expect(entityIds.map((id) => entities[id]!.type).sort()).toEqual([...kinds]);
    expect(new Set(entityIds)).toEqual(new Set(Object.keys(entities)));
    const regions = detectSketchRegions(entities as never);
    expect(regions).toHaveLength(1);
    expect(new Set(regions[0]!.entityIds.map(String))).toEqual(new Set(entityIds));
  });
});

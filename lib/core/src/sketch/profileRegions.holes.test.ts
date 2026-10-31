import { describe, it, expect } from 'vitest';
import {
  assignHoles,
  detectSketchRegions,
  fillSelectedHoles,
  pointInRegion,
  regionInteriorPoint,
  regionNetArea,
  regionToProfileRef,
  regionWireEntityIds,
  resolveProfile,
} from './profileRegions.ts';
import type { SketchRegion } from './profileRegions.ts';
import type { EntityId, FeatureId } from '../ids.ts';
import {
  emptyEditorState,
  drawCircle,
  drawPolygon,
  drawRectangle,
  makeCounterIdFactory,
  type EditorState,
} from './operations.ts';
import { editorModelToBuildGeometry } from './serialization.ts';

function circle(id: string, entities: string[], cx: number, cy: number, r: number): SketchRegion {
  return {
    id, label: id, type: 'circle',
    entityIds: entities as EntityId[], allEntityIds: entities as EntityId[],
    segments: [], vertices: [], center: [cx, cy], area: Math.PI * r * r,
  };
}

describe('assignHoles', () => {
  it('makes the outer region an annulus when a separate loop nests inside', () => {
    const out = assignHoles([circle('outer', ['a'], 0, 0, 50), circle('inner', ['b'], 0, 0, 10)]);
    const outer = out.find(r => r.id === 'outer')!;
    const inner = out.find(r => r.id === 'inner')!;
    expect(outer.holes?.map(h => h.id)).toEqual(['inner']);
    expect(inner.holes ?? []).toEqual([]); // inner stays its own hole-less region
  });

  it('does NOT nest when the regions share entities (an intersection sub-face)', () => {
    // A lens sub-face references both circle entities, so it must not be
    // mistaken for a hole of the full circle even though it sits inside it.
    const full = circle('full', ['a'], 0, 0, 50);
    const lens = circle('lens', ['a', 'b'], 0, 0, 8); // shares 'a' with full
    const out = assignHoles([full, lens]);
    expect(out.find(r => r.id === 'full')!.holes ?? []).toEqual([]);
  });

  it('assigns to the SMALLEST container (concentric rings)', () => {
    const out = assignHoles([
      circle('big', ['a'], 0, 0, 50),
      circle('mid', ['b'], 0, 0, 30),
      circle('small', ['c'], 0, 0, 10),
    ]);
    expect(out.find(r => r.id === 'big')!.holes?.map(h => h.id)).toEqual(['mid']);
    expect(out.find(r => r.id === 'mid')!.holes?.map(h => h.id)).toEqual(['small']);
  });
});

describe('pointInRegion (hole-aware)', () => {
  it('excludes a point that lies inside a hole', () => {
    const [outer] = assignHoles([circle('outer', ['a'], 0, 0, 50), circle('inner', ['b'], 0, 0, 10)]);
    // (0,0) is the centre — inside the hole → NOT in the annulus.
    expect(pointInRegion([0, 0], outer!)).toBe(false);
    // (30,0) is in the ring gap → in the annulus.
    expect(pointInRegion([30, 0], outer!)).toBe(true);
  });
});

// --- Detection on drawn geometry ------------------------------------------

const SKETCH = 'sketch_1' as FeatureId;

function detect(build: (s: EditorState, f: ReturnType<typeof makeCounterIdFactory>) => EditorState) {
  const f = makeCounterIdFactory();
  return detectSketchRegions(editorModelToBuildGeometry(build(emptyEditorState(), f)));
}

/** r=4 boss with an r=2 insert hole, both centred on the origin. */
function bossSketch() {
  return detect((s, f) => {
    let st = drawCircle(s, { center: [0, 0], radius: 4 }, { idFactory: f }).state;
    st = drawCircle(st, { center: [0, 0], radius: 2 }, { idFactory: f }).state;
    return st;
  });
}

function threeRings() {
  return detect((s, f) => {
    let st = drawCircle(s, { center: [0, 0], radius: 9 }, { idFactory: f }).state;
    st = drawCircle(st, { center: [0, 0], radius: 6 }, { idFactory: f }).state;
    st = drawCircle(st, { center: [0, 0], radius: 3 }, { idFactory: f }).state;
    return st;
  });
}

function ringAndDisc(regions: SketchRegion[]): { ring: SketchRegion; disc: SketchRegion } {
  const ring = regions.find(r => (r.holes?.length ?? 0) > 0)!;
  const disc = regions.find(r => r.id === ring.holes![0]!.id)!;
  return { ring, disc };
}

describe('nested closed loops (detection)', () => {
  it('circle in circle: a ring region plus the inner disc', () => {
    const regions = bossSketch();
    expect(regions).toHaveLength(2);
    const { ring, disc } = ringAndDisc(regions);
    expect(ring.type).toBe('circle');
    expect(regionNetArea(ring)).toBeCloseTo(Math.PI * (16 - 4), 6);
    expect(regionNetArea(disc)).toBeCloseTo(Math.PI * 4, 6);
    expect(regionWireEntityIds(ring)).toEqual([...ring.entityIds, ...disc.entityIds]);
  });

  it('circle in hexagon: the hexagon region is holed by the circle', () => {
    const regions = detect((s, f) => {
      let st = drawPolygon(s, { center: [0, 0], vertex: [10, 0], sides: 6 }, { idFactory: f }).state;
      st = drawCircle(st, { center: [0, 0], radius: 3 }, { idFactory: f }).state;
      return st;
    });
    expect(regions).toHaveLength(2);
    const { ring, disc } = ringAndDisc(regions);
    expect(ring.entityIds).toHaveLength(6);
    expect(disc.type).toBe('circle');
  });

  it('square in rectangle: polygon holes nest like circles', () => {
    const regions = detect((s, f) => {
      let st = drawRectangle(s, { corner: [0, 0], width: 30, height: 20 }, { idFactory: f }).state;
      st = drawRectangle(st, { corner: [10, 5], width: 10, height: 10 }, { idFactory: f }).state;
      return st;
    });
    expect(regions).toHaveLength(2);
    const { ring, disc } = ringAndDisc(regions);
    expect(regionNetArea(ring)).toBeCloseTo(600 - 100, 6);
    expect(disc.area).toBeCloseTo(100, 6);
  });

  it('three concentric circles: big ring, middle ring, centre disc', () => {
    const [big, mid, small] = threeRings();
    expect(big!.holes?.map(h => h.id)).toEqual([mid!.id]);
    expect(mid!.holes?.map(h => h.id)).toEqual([small!.id]);
  });
});

describe('resolveProfile on a ring', () => {
  it('[outer, inner] resolves to the ring', () => {
    const regions = bossSketch();
    const { ring, disc } = ringAndDisc(regions);
    const r = resolveProfile(
      { sketchId: SKETCH, wireEntityIds: [...ring.entityIds, ...disc.entityIds] },
      regions,
    );
    expect(r.status).toBe('resolved');
    expect(r.region?.id).toBe(ring.id);
  });

  it('[inner, outer] (any order) resolves to the ring too', () => {
    const regions = bossSketch();
    const { ring, disc } = ringAndDisc(regions);
    const r = resolveProfile(
      { sketchId: SKETCH, wireEntityIds: [...disc.entityIds, ...ring.entityIds] },
      regions,
    );
    expect(r.region?.id).toBe(ring.id);
  });

  it('[outer] still names the ring and [inner] the disc', () => {
    const regions = bossSketch();
    const { ring, disc } = ringAndDisc(regions);
    expect(resolveProfile({ sketchId: SKETCH, wireEntityIds: ring.entityIds }, regions).region?.id)
      .toBe(ring.id);
    expect(resolveProfile({ sketchId: SKETCH, wireEntityIds: disc.entityIds }, regions).region?.id)
      .toBe(disc.id);
  });

  it('one rectangle edge plus the inner circle resolves to the holed rectangle', () => {
    const regions = detect((s, f) => {
      let st = drawRectangle(s, { corner: [0, 0], width: 60, height: 30 }, { idFactory: f }).state;
      st = drawCircle(st, { center: [30, 15], radius: 3 }, { idFactory: f }).state;
      return st;
    });
    const { ring, disc } = ringAndDisc(regions);
    const r = resolveProfile(
      { sketchId: SKETCH, wireEntityIds: [ring.entityIds[0]!, ...disc.entityIds] },
      regions,
    );
    expect(r.region?.id).toBe(ring.id);
  });

  it('a wire set that is not a region still fails', () => {
    const r = resolveProfile({ sketchId: SKETCH, wireEntityIds: ['nope' as EntityId] }, bossSketch());
    expect(r.status).toBe('missing');
  });
});

describe('regionInteriorPoint', () => {
  it('keeps the centre of a plain disc', () => {
    const { disc } = ringAndDisc(bossSketch());
    expect(regionInteriorPoint(disc)).toEqual(disc.center);
  });

  it('moves a ring point off its hole and into the material', () => {
    const { ring, disc } = ringAndDisc(bossSketch());
    const p = regionInteriorPoint(ring);
    expect(pointInRegion(p, ring)).toBe(true);
    expect(pointInRegion(p, disc)).toBe(false);
  });

  it('regionToProfileRef stores a material point when it needs one', () => {
    const { ring } = ringAndDisc(bossSketch());
    // A second region with the same wire set forces the interior point.
    const twin: SketchRegion = { ...ring, id: 'twin' };
    const ref = regionToProfileRef(SKETCH, ring, [ring, twin]);
    expect(ref.interiorPoint).toBeDefined();
    expect(pointInRegion(ref.interiorPoint!, ring)).toBe(true);
  });
});

describe('fillSelectedHoles', () => {
  it('ring + its disc → one outer region with no holes', () => {
    const { ring, disc } = ringAndDisc(bossSketch());
    const out = fillSelectedHoles([ring, disc]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(ring.id);
    expect(out[0]!.holes).toBeUndefined();
  });

  it('the ring alone keeps its hole', () => {
    const { ring } = ringAndDisc(bossSketch());
    expect(fillSelectedHoles([ring])).toEqual([ring]);
  });

  it('the disc alone stays a disc', () => {
    const { disc } = ringAndDisc(bossSketch());
    expect(fillSelectedHoles([disc])).toEqual([disc]);
  });

  it('outer ring + middle ring keeps the innermost hole open', () => {
    const [big, mid, small] = threeRings();
    const out = fillSelectedHoles([big!, mid!]);
    expect(out.map(r => r.id)).toEqual([big!.id]);
    expect(out[0]!.holes?.map(h => h.id)).toEqual([small!.id]);
  });

  it('all three rings → one solid disc', () => {
    const [big, mid, small] = threeRings();
    const out = fillSelectedHoles([small!, mid!, big!]);
    expect(out.map(r => r.id)).toEqual([big!.id]);
    expect(out[0]!.holes).toBeUndefined();
  });

  it('a duplicate selection collapses to one region', () => {
    const { disc } = ringAndDisc(bossSketch());
    expect(fillSelectedHoles([disc, disc])).toHaveLength(1);
  });
});

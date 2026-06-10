import { describe, it, expect } from 'vitest';
import { assignHoles, pointInRegion } from './profileRegions.ts';
import type { SketchRegion } from './profileRegions.ts';
import type { EntityId } from '../ids.ts';

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

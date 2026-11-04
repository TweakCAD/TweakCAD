import { describe, expect, it } from 'vitest';
import type { EditorState } from './operations.ts';
import { drawCircle, drawLine, drawRectangle, emptyEditorState, makeCounterIdFactory, toSnapshot } from './operations.ts';
import { sketchBuildGeometry } from './derivedGeometry.ts';
import { detectSketchRegions, pointInRegion } from './profileRegions.ts';
import type { SketchRegion } from './profileRegions.ts';
import { fnv1a64, regionIdentity, regionKey, segmentIdentity } from './provenance.ts';
import { detectIntersectionRegions } from './planarGraph.ts';

function regions(state: EditorState): SketchRegion[] {
  return detectSketchRegions(sketchBuildGeometry({ editorModel: toSnapshot(state) }));
}

function regionAt(all: SketchRegion[], point: [number, number]): SketchRegion {
  // The smallest region there: a closed loop that a line cuts is still a
  // region of its own, around its pieces.
  const found = all.filter(r => pointInRegion(point, r)).sort((a, b) => a.area - b.area);
  expect(found.length).toBeGreaterThan(0);
  return found[0]!;
}

function identities(region: SketchRegion): string[] {
  return region.segments.map(segmentIdentity).sort();
}

/** A 40 x 20 rectangle cut by vertical lines at each x, bottom to top. */
function cutRectangle(xs: number[]) {
  const ids = makeCounterIdFactory();
  const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 40, height: 20 }, { idFactory: ids });
  let state = rect.state;
  const cuts: string[] = [];
  for (const x of xs) {
    const line = drawLine(state, [x, -5], [x, 25], { idFactory: ids, distinctStart: true });
    state = line.state;
    cuts.push(String(line.lineId));
  }
  return { state, edges: rect.edges, cuts };
}

describe('segment identity', () => {
  it('names a piece by the entities that bound it, not by where it sits', () => {
    const { state, edges, cuts } = cutRectangle([10]);
    const left = regionAt(regions(state), [5, 10]);
    const [cut] = cuts;
    const { bottom, top } = edges;
    expect(identities(left)).toEqual([
      `${String(bottom)}[<,${cut}]`,
      `${cut}[${String(bottom)},${String(top)}]`,
      String(edges.left),
      `${String(top)}[${cut},>]`,
    ].sort());
  });

  it('is the same when the cut moves, or another cut is added beside it', () => {
    const base = identities(regionAt(regions(cutRectangle([10]).state), [5, 10]));
    expect(identities(regionAt(regions(cutRectangle([12]).state), [5, 10]))).toEqual(base);
    expect(identities(regionAt(regions(cutRectangle([10, 30]).state), [5, 10]))).toEqual(base);
  });

  it('numbers the bounds of an entity crossed twice by the same one, along the entity', () => {
    // A circle on the rectangle's bottom edge crosses it at x = 15 and 25.
    const ids = makeCounterIdFactory();
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 40, height: 20 }, { idFactory: ids });
    const circle = drawCircle(rect.state, { center: [20, 0], radius: 5 }, { idFactory: ids });
    const faces = detectIntersectionRegions(sketchBuildGeometry({ editorModel: toSnapshot(circle.state) }));
    const pieces = new Set(faces.flatMap(f => f.edges.map(e => e.identity)));
    const bottom = String(rect.edges.bottom);
    const c = String(circle.circleId);
    expect(pieces).toContain(`${bottom}[<,${c}#0]`);
    expect(pieces).toContain(`${bottom}[${c}#0,${c}#1]`);
    expect(pieces).toContain(`${bottom}[${c}#1,>]`);
    // The arc over the edge bounds the lens below it and the rest above.
    expect(faces.filter(f => f.edges.some(e => e.identity === `${c}[${bottom}#0,${bottom}#1]`))).toHaveLength(2);
  });

  it('bounds the arcs of two crossing circles by each other', () => {
    const ids = makeCounterIdFactory();
    let state = drawCircle(emptyEditorState(), { center: [0, 0], radius: 8 }, { idFactory: ids }).state;
    state = drawCircle(state, { center: [10, 0], radius: 8 }, { idFactory: ids }).state;
    const faces = detectIntersectionRegions(sketchBuildGeometry({ editorModel: toSnapshot(state) }));
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const pieces = face.edges.map(e => e.identity);
      expect(new Set(pieces).size).toBe(pieces.length);
      expect(pieces.some(p => p.includes('?'))).toBe(false);
    }
  });
});

describe('region key', () => {
  const keyAt = (state: EditorState, point: [number, number]): string => {
    const all = regions(state);
    return regionKey(regionAt(all, point), all);
  };

  it('is the same when the cut moves or another is added beside it, and differs between the sides', () => {
    const left = keyAt(cutRectangle([10]).state, [5, 10]);
    expect(keyAt(cutRectangle([12]).state, [5, 10])).toBe(left);
    expect(keyAt(cutRectangle([10, 30]).state, [5, 10])).toBe(left);
    expect(keyAt(cutRectangle([10]).state, [30, 10])).not.toBe(left);
  });

  it('is named by its entities, so trimming one of them keeps it', () => {
    const { state, edges, cuts } = cutRectangle([10]);
    const all = regions(state);
    const left = regionAt(all, [5, 10]);
    expect(regionIdentity(left, all)).toEqual(['region/v1/entities', ...[String(edges.bottom), cuts[0]!, String(edges.top), String(edges.left)].sort()]);
  });

  it('falls back to the segment pieces when another region has the same entities', () => {
    // Two halves of a circle cut by a line: both bounded by the circle and the line.
    const half = (arc: string): SketchRegion => ({
      id: arc, label: arc, type: 'polygon', entityIds: [], allEntityIds: [], vertices: [], center: [0, 0], area: 1,
      segments: [
        { entityId: 'c' as never, identity: arc, reversed: false },
        { entityId: 'l' as never, identity: 'l[c#0,c#1]', reversed: false },
      ],
    });
    const upper = half('c[l#0,l#1]');
    const lower = half('c[l#1,l#0]');
    expect(regionIdentity(upper, [upper, lower])).toEqual(['region/v1/segments', 'c[l#0,l#1]', 'l[c#0,c#1]']);
    expect(regionKey(upper, [upper, lower])).not.toBe(regionKey(lower, [upper, lower]));
  });
});

describe('fnv1a64', () => {
  it('matches the published test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

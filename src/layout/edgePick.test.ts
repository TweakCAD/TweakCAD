import { describe, it, expect } from 'vitest';
import type { EdgeRef, Selection, TopologyMap } from '@tweakcad/core/src/document/schema.ts';
import { resolveEdgePick, appendEdgeRefs } from './edgePick.ts';

// A box top: four straight edges around f_top, one vertical edge, and an
// edge with no stable id yet.
const seg = (a: number[], b: number[]) => new Float32Array([...a, ...b]);
const BOX = {
  bodyId: 'b1',
  faces: [{ faceId: 'f_top', triStart: 0, triEnd: 2 }],
  edges: [
    { edgeId: 'e0', lineSegments: seg([0, 0, 5], [10, 0, 5]), adjacentFaces: ['f_top', 'f_front'], stableEdgeId: 's0' },
    { edgeId: 'e1', lineSegments: seg([10, 0, 5], [10, 10, 5]), adjacentFaces: ['f_top', 'f_right'], stableEdgeId: 's1' },
    { edgeId: 'e2', lineSegments: seg([10, 10, 5], [0, 10, 5]), adjacentFaces: ['f_top', 'f_back'], stableEdgeId: 's2' },
    { edgeId: 'e3', lineSegments: seg([0, 10, 5], [0, 0, 5]), adjacentFaces: ['f_top', 'f_left'] },
    { edgeId: 'e4', lineSegments: seg([10, 0, 5], [10, 0, 0]), adjacentFaces: ['f_front', 'f_right'], stableEdgeId: 's4' },
    // Straight continuation of e0 past x=10 (as if the front edge were split).
    { edgeId: 'e5', lineSegments: seg([10, 0, 5], [20, 0, 5]), adjacentFaces: ['f_ext', 'f_front'], stableEdgeId: 's5' },
  ],
} as unknown as TopologyMap;

const ref = (stableEdgeId: string): EdgeRef => ({
  type: 'stableTopology',
  bodyRef: { partId: 'p1', bodyId: 'b1' },
  stableEdgeId,
} as EdgeRef);

const faceSel = { type: 'face', partId: 'p1', bodyId: 'b1', faceId: 'f_top' } as unknown as Selection;
const edgeSel = (edgeId: string) => ({ type: 'edge', partId: 'p1', bodyId: 'b1', edgeId }) as unknown as Selection;

describe('resolveEdgePick', () => {
  it('a face pick yields its boundary edges as stable refs', () => {
    const r = resolveEdgePick(faceSel, [BOX], { tangentChain: false });
    expect(r.refs).toEqual([ref('s0'), ref('s1'), ref('s2')]);
    expect(r.missingStableIds).toBe(1);
  });

  it('a face pick ignores the tangent-chain option', () => {
    const r = resolveEdgePick(faceSel, [BOX], { tangentChain: true });
    expect(r.refs).toEqual([ref('s0'), ref('s1'), ref('s2')]);
  });

  it('an edge pick yields only that edge', () => {
    expect(resolveEdgePick(edgeSel('e0'), [BOX], { tangentChain: false }))
      .toEqual({ refs: [ref('s0')], missingStableIds: 0 });
  });

  it('an edge pick with tangent chain adds tangent neighbours only', () => {
    const r = resolveEdgePick(edgeSel('e0'), [BOX], { tangentChain: true });
    expect(r.refs).toEqual([ref('s0'), ref('s5')]);
  });

  it('reports an edge without a stable id or topology', () => {
    expect(resolveEdgePick(edgeSel('e3'), [BOX], { tangentChain: false }))
      .toEqual({ refs: [], missingStableIds: 1 });
    expect(resolveEdgePick(edgeSel('e0'), [], { tangentChain: false }))
      .toEqual({ refs: [], missingStableIds: 1 });
  });

  it('ignores other selection kinds', () => {
    const body = { type: 'body', partId: 'p1', bodyId: 'b1' } as unknown as Selection;
    expect(resolveEdgePick(body, [BOX], { tangentChain: false })).toEqual({ refs: [], missingStableIds: 0 });
    expect(resolveEdgePick(null, [BOX], { tangentChain: false })).toEqual({ refs: [], missingStableIds: 0 });
  });
});

describe('appendEdgeRefs', () => {
  it('appends only refs not already picked, in order', () => {
    const current = [ref('s1')];
    expect(appendEdgeRefs(current, [ref('s0'), ref('s1'), ref('s2'), ref('s0')]))
      .toEqual([ref('s1'), ref('s0'), ref('s2')]);
  });

  it('returns the same list when nothing is new', () => {
    const current = [ref('s0'), ref('s1')];
    expect(appendEdgeRefs(current, [ref('s1')])).toBe(current);
  });
});

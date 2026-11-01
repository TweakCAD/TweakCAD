/**
 * Tests for the chain offset engine and the `offsetCurveAt` op built on it.
 *
 * The defining property of a clean offset is checked directly: every point
 * of the result sits exactly |d| from the source chain, the result is one
 * closed chain (shared joint points, back to its start) and it never
 * crosses itself. Shapes cover the cases the trinket workflows hit: a
 * rectangle (mitred corners), a filleted rectangle (arcs grow / shrink /
 * collapse), a Bézier "logo" outline with a sharp point and a concave cusp,
 * a spline, an open polyline, a neck that pinches apart, and outlines
 * straight out of the SVG importer.
 */

import { describe, it, expect } from 'vitest';
import { emptyEditorState, drawRectangle, drawSpline, type EditorState } from './operations.ts';
import { offsetCurveAt } from './modifyOps.ts';
import { findChain, chainToPieces, pointAt, type OffsetPiece, type Vec2 } from './chainOffset.ts';
import { editorModelToBuildGeometry } from './serialization.ts';
import { svgToEditorState } from './io/svgImport.ts';
import { detectSketchRegions, regionNetArea } from './profileRegions.ts';
import type { SketchGeometry, SketchGeometryId, SketchPointId } from './types.ts';
import { sketchGeometryId, sketchPointId } from './types.ts';

// ---- Fixtures --------------------------------------------------------------

type Seg =
  | { line: Vec2 }
  | { arc: { c: Vec2; to: Vec2; cw?: boolean } }
  | { bez: [Vec2, Vec2, Vec2] };

/**
 * Build an outline from `start` through `segs`, sharing one point per
 * vertex the way drawn outlines do. A closed outline's last segment ends on
 * the start point.
 */
function outline(start: Vec2, segs: Seg[], closed = true): { state: EditorState; ids: SketchGeometryId[] } {
  const state = emptyEditorState();
  let n = 0;
  const pt = (x: number, y: number): SketchPointId => {
    const id = sketchPointId(`p${n++}`);
    state.points.set(id, { id, x, y, fixed: false });
    return id;
  };
  const ids: SketchGeometryId[] = [];
  const add = (g: Omit<SketchGeometry, 'id'>) => {
    const id = sketchGeometryId(`g${ids.length}`);
    state.geometries.set(id, { ...g, id } as SketchGeometry);
    ids.push(id);
  };
  const first = pt(start[0], start[1]);
  let cur = first;
  segs.forEach((s, i) => {
    const to = 'line' in s ? s.line : 'arc' in s ? s.arc.to : s.bez[2];
    const end = closed && i === segs.length - 1 ? first : pt(to[0], to[1]);
    if ('line' in s) {
      add({ type: 'line', startId: cur, endId: end, construction: false });
    } else if ('arc' in s) {
      const c = state.points.get(cur)!;
      const centerId = pt(s.arc.c[0], s.arc.c[1]);
      const radius = Math.hypot(c.x - s.arc.c[0], c.y - s.arc.c[1]);
      // Editor arcs run counter-clockwise from start to end.
      const [a, b] = s.arc.cw ? [end, cur] : [cur, end];
      add({ type: 'arc', centerId, startId: a, endId: b, radius, construction: false });
    } else {
      add({ type: 'bezier', startId: cur, cp1Id: pt(...s.bez[0]), cp2Id: pt(...s.bez[1]), endId: end, construction: false });
    }
    cur = end;
  });
  return { state, ids };
}

/** 20 × 10 rectangle at the origin with radius-2 corner fillets, counter-clockwise. */
function filletedRect(): { state: EditorState; ids: SketchGeometryId[] } {
  const r = 2;
  return outline([r, 0], [
    { line: [20 - r, 0] },
    { arc: { c: [20 - r, r], to: [20, r] } },
    { line: [20, 10 - r] },
    { arc: { c: [20 - r, 10 - r], to: [20 - r, 10] } },
    { line: [r, 10] },
    { arc: { c: [r, 10 - r], to: [0, 10 - r] } },
    { line: [0, r] },
    { arc: { c: [r, r], to: [r, 0] } },
  ]);
}

/**
 * Heart-shaped Bézier outline, as an SVG import produces it: two lobes
 * meeting at a concave cusp on top and a sharp convex point at the bottom.
 */
function heart(): { state: EditorState; ids: SketchGeometryId[] } {
  return outline([0, -10], [
    { bez: [[-6, -5], [-14, 0], [-12, 6]] },
    { bez: [[-10, 12], [-2, 12], [0, 6]] },
    { bez: [[2, 12], [10, 12], [12, 6]] },
    { bez: [[14, 0], [6, -5], [0, -10]] },
  ]);
}

// ---- Result inspection -----------------------------------------------------

function addedIds(before: EditorState, after: EditorState): SketchGeometryId[] {
  return [...after.geometries.keys()].filter(id => !before.geometries.has(id));
}

/** The offset result's chains (by walking from each unvisited new curve). */
function resultChains(after: EditorState, ids: SketchGeometryId[]) {
  const only = new Map(ids.map(id => [id, after.geometries.get(id)!]));
  const seen = new Set<SketchGeometryId>();
  const chains: Array<{ closed: boolean; pieces: OffsetPiece[] }> = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const chain = findChain(after.points, only, id)!;
    chain.edges.forEach(e => seen.add(e.id));
    chains.push({ closed: chain.closed, pieces: chainToPieces(after.points, only, chain) });
  }
  return chains;
}

function dense(pieces: readonly OffsetPiece[], perPiece: number): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pieces) for (let i = 0; i <= perPiece; i++) out.push(pointAt(p, i / perPiece));
  return out;
}

function distToPolyline(q: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!, b = poly[i]!;
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const l2 = abx * abx + aby * aby;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((q[0] - a[0]) * abx + (q[1] - a[1]) * aby) / l2));
    best = Math.min(best, Math.hypot(q[0] - (a[0] + abx * t), q[1] - (a[1] + aby * t)));
  }
  return best;
}

/**
 * Largest violation of the clean-offset property. Arcs and Béziers (curve
 * offsets and round joins) must sit exactly |d| from the source along their
 * whole length. A line must never come closer than |d| and sits exactly |d|
 * at its midpoint; its ends may reach further out, at a mitred corner.
 */
function offsetError(src: EditorState, srcIds: SketchGeometryId[], pieces: OffsetPiece[], d: number): number {
  const s = new Map(srcIds.map(id => [id, src.geometries.get(id)!]));
  const chain = findChain(src.points, s, srcIds[0]!)!;
  const srcPoly = dense(chainToPieces(src.points, s, chain), 200);
  const off = (q: Vec2) => distToPolyline(q, srcPoly) - Math.abs(d);
  let err = 0;
  for (const p of pieces) {
    err = Math.max(err, Math.abs(off(pointAt(p, 0.5))));
    for (const q of dense([p], 12)) err = Math.max(err, p.kind === 'line' ? -off(q) : Math.abs(off(q)));
  }
  return err;
}

/** Whether a closed polyline crosses itself (adjacent segments excluded). */
function selfCrosses(poly: Vec2[]): boolean {
  const n = poly.length;
  // Sweep segments by min x so only x-overlapping pairs are tested.
  const segs = poly.map((a, i) => {
    const b = poly[(i + 1) % n]!;
    return { i, a, b, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) };
  }).sort((p, q) => p.x0 - q.x0);
  for (let k = 0; k < n; k++) {
    const s1 = segs[k]!;
    for (let m = k + 1; m < n && segs[m]!.x0 <= s1.x1; m++) {
      const s2 = segs[m]!;
      const gap = Math.abs(s1.i - s2.i);
      if (gap <= 1 || gap === n - 1) continue;
      const { a, b } = s1, { a: c, b: d } = s2;
      const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      if (Math.abs(den) < 1e-15) continue;
      const u = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
      const v = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
      if (u > 1e-9 && u < 1 - 1e-9 && v > 1e-9 && v < 1 - 1e-9) return true;
    }
  }
  return false;
}

function polyArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Offset `ids[pick]` and return the result's chains plus the new state. */
function runOffset(fixture: { state: EditorState; ids: SketchGeometryId[] }, d: number, cursor: Vec2, pick = 0) {
  const after = offsetCurveAt(fixture.state, fixture.ids[pick]!, d, cursor, false);
  expect(after).not.toBeNull();
  const ids = addedIds(fixture.state, after!);
  return { after: after!, ids, chains: resultChains(after!, ids) };
}

/** Assert a clean closed offset at |d| and return its sampled polygon. */
function expectCleanLoop(fixture: { state: EditorState; ids: SketchGeometryId[] }, d: number, cursor: Vec2): Vec2[] {
  const { chains } = runOffset(fixture, d, cursor);
  expect(chains).toHaveLength(1);
  expect(chains[0]!.closed).toBe(true);
  expect(offsetError(fixture.state, fixture.ids, chains[0]!.pieces, d)).toBeLessThan(1e-2);
  const poly = dense(chains[0]!.pieces, 16);
  expect(selfCrosses(poly)).toBe(false);
  return poly;
}

// ---- Tests -----------------------------------------------------------------

describe('offsetCurveAt: closed chains', () => {
  it('offsets a drawn rectangle (coincident corners) to a mitred rectangle', () => {
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 10, height: 6 });
    const fixture = { state: rect.state, ids: [rect.edges.bottom, rect.edges.right, rect.edges.top, rect.edges.left] };

    const { after, ids, chains } = runOffset(fixture, 1, [5, -3]);
    expect(ids).toHaveLength(4);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.closed).toBe(true);
    const xs = ids.flatMap(id => {
      const g = after.geometries.get(id)!;
      if (g.type !== 'line') throw new Error('expected lines');
      return [after.points.get(g.startId)!, after.points.get(g.endId)!];
    });
    expect(Math.min(...xs.map(p => p.x))).toBeCloseTo(-1, 9);
    expect(Math.max(...xs.map(p => p.x))).toBeCloseTo(11, 9);
    expect(Math.min(...xs.map(p => p.y))).toBeCloseTo(-1, 9);
    expect(Math.max(...xs.map(p => p.y))).toBeCloseTo(7, 9);

    const inward = runOffset(fixture, 1, [5, 3]);
    expect(Math.abs(polyArea(dense(inward.chains[0]!.pieces, 1)))).toBeCloseTo(8 * 4, 9);
  });

  it('grows and shrinks the fillets of a filleted rectangle by ±1 mm', () => {
    const fixture = filletedRect();
    for (const [cursor, r] of [[[10, -5], 3], [[10, 5], 1]] as const) {
      const { after, ids } = runOffset(fixture, 1, cursor as Vec2);
      const arcs = ids.map(id => after.geometries.get(id)!).filter(g => g.type === 'arc');
      const lines = ids.map(id => after.geometries.get(id)!).filter(g => g.type === 'line');
      expect(arcs).toHaveLength(4);
      expect(lines).toHaveLength(4);
      for (const a of arcs) expect(a.type === 'arc' && a.radius).toBeCloseTo(r, 9);
      expectCleanLoop(fixture, 1, cursor as Vec2);
    }
  });

  it('collapses fillets smaller than an inward offset into sharp corners', () => {
    const fixture = filletedRect();
    const { after, ids, chains } = runOffset(fixture, 3, [10, 5]);
    expect(ids.map(id => after.geometries.get(id)!.type)).toEqual(['line', 'line', 'line', 'line']);
    expect(chains[0]!.closed).toBe(true);
    expect(Math.abs(polyArea(dense(chains[0]!.pieces, 1)))).toBeCloseTo(14 * 4, 6);
  });

  it('offsets a Bézier logo outline (sharp point + concave cusp) cleanly both ways', () => {
    const fixture = heart();
    const outward = expectCleanLoop(fixture, 1, [30, 0]);
    const inward = expectCleanLoop(fixture, 1, [-6, 4]);
    expect(Math.abs(polyArea(outward))).toBeGreaterThan(Math.abs(polyArea(inward)));
  });

  it('offsets a closed spline as a closed chain of Béziers', () => {
    const s = drawSpline(emptyEditorState(), [[0, 0], [10, -2], [14, 6], [4, 10], [-3, 5], [0, 0]]);
    const fixture = { state: s.state, ids: [s.splineId] };
    expectCleanLoop(fixture, 1, [40, 40]);
    expectCleanLoop(fixture, 1, [5, 4]);
  });

  it('splits an inward offset that pinches a narrow neck into two loops', () => {
    const fixture = outline([0, 0], [
      { line: [10, 0] }, { line: [10, 4.5] }, { line: [14, 4.5] }, { line: [14, 0] },
      { line: [24, 0] }, { line: [24, 10] }, { line: [14, 10] }, { line: [14, 5.5] },
      { line: [10, 5.5] }, { line: [10, 10] }, { line: [0, 10] }, { line: [0, 0] },
    ]);
    const { chains } = runOffset(fixture, 1, [5, 5]);
    expect(chains).toHaveLength(2);
    for (const c of chains) {
      expect(c.closed).toBe(true);
      expect(Math.abs(polyArea(dense(c.pieces, 1)))).toBeCloseTo(64, 6);
    }
    // A thinner offset leaves the neck open: still one loop.
    expect(runOffset(fixture, 0.25, [5, 5]).chains).toHaveLength(1);
  });

  it('returns null when an inward offset consumes the whole shape', () => {
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 4, height: 4 });
    expect(offsetCurveAt(rect.state, rect.edges.bottom, 3, [2, 2], false)).toBeNull();
  });

  it('original + 1 mm outward offset detect as one 1 mm wall region', () => {
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 10, height: 6 });
    const { after } = runOffset({ state: rect.state, ids: [rect.edges.bottom] }, 1, [5, -3]);
    const wall = detectSketchRegions(editorModelToBuildGeometry(after)).find(r => (r.holes?.length ?? 0) === 1);
    expect(wall).toBeDefined();
    expect(regionNetArea(wall!)).toBeCloseTo(12 * 8 - 10 * 6, 9);
  });

  it('filleted rectangle + 1 mm outward offset: the offset rings the original', () => {
    const fixture = filletedRect();
    const { after, ids } = runOffset(fixture, 1, [10, -5]);
    const wall = detectSketchRegions(editorModelToBuildGeometry(after)).find(r => (r.holes?.length ?? 0) === 1);
    expect(wall).toBeDefined();
    expect(new Set(wall!.entityIds.map(String))).toEqual(new Set(ids.map(String)));
    expect(new Set(wall!.holes![0]!.entityIds.map(String))).toEqual(new Set(fixture.ids.map(String)));
  });

  it('heart + 1 mm inward offset detect as a wall region', () => {
    const fixture = heart();
    const { after } = runOffset(fixture, 1, [-6, 4]);
    const regions = detectSketchRegions(editorModelToBuildGeometry(after));
    expect(regions.some(r => (r.holes?.length ?? 0) === 1)).toBe(true);
  });
});

describe('offsetCurveAt: open chains', () => {
  it('offsets an L polyline to the cursor side with a mitred corner', () => {
    const fixture = outline([0, 0], [{ line: [10, 0] }, { line: [10, 8] }], false);
    const { after, ids, chains } = runOffset(fixture, 1, [12, -2]);
    expect(ids).toHaveLength(2);
    expect(chains[0]!.closed).toBe(false);
    const ends = dense(chains[0]!.pieces, 1);
    expect(ends[0]).toEqual([expect.closeTo(0, 9), expect.closeTo(-1, 9)]);
    expect(ends[1]).toEqual([expect.closeTo(11, 9), expect.closeTo(-1, 9)]);
    expect(ends[3]).toEqual([expect.closeTo(11, 9), expect.closeTo(8, 9)]);
    // The corner is one shared point.
    const [a, b] = ids.map(id => after.geometries.get(id)!);
    expect(a!.type === 'line' && b!.type === 'line' && a.endId === b.startId).toBe(true);
  });

  it('rounds the outside of a line → Bézier corner and keeps |d| everywhere', () => {
    const fixture = outline([0, 0], [{ line: [10, 0] }, { bez: [[12, 4], [8, 8], [14, 12]] }], false);
    const { after, ids, chains } = runOffset(fixture, 1, [5, -2]);
    expect(ids.some(id => after.geometries.get(id)!.type === 'arc')).toBe(true);
    expect(offsetError(fixture.state, fixture.ids, chains[0]!.pieces, 1)).toBeLessThan(1e-2);
  });

  it('offsets an open spline into Béziers at |d|', () => {
    const s = drawSpline(emptyEditorState(), [[0, 0], [5, 4], [10, 0], [15, 5]]);
    const fixture = { state: s.state, ids: [s.splineId] };
    const { after, ids, chains } = runOffset(fixture, 1, [5, 10]);
    expect(ids.every(id => after.geometries.get(id)!.type === 'bezier')).toBe(true);
    expect(chains).toHaveLength(1);
    expect(offsetError(fixture.state, fixture.ids, chains[0]!.pieces, 1)).toBeLessThan(1e-2);
  });

  it('chain: false offsets only the picked curve', () => {
    const rect = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 10, height: 6 });
    const after = offsetCurveAt(rect.state, rect.edges.bottom, 1, [5, -3], false, false)!;
    const ids = addedIds(rect.state, after);
    expect(ids).toHaveLength(1);
    const g = after.geometries.get(ids[0]!)!;
    expect(g.type === 'line' && after.points.get(g.startId)!.y).toBeCloseTo(-1, 9);
  });

  it('a branch ends the chain', () => {
    // T junction: the stem shares the bar's right end with a third line.
    const fixture = outline([0, 0], [{ line: [10, 0] }, { line: [10, 8] }], false);
    const s = fixture.state;
    const joint = (s.geometries.get(fixture.ids[0]!) as Extract<SketchGeometry, { type: 'line' }>).endId;
    const tip = sketchPointId('tip');
    s.points.set(tip, { id: tip, x: 20, y: 0, fixed: false });
    const extra = sketchGeometryId('extra');
    s.geometries.set(extra, { id: extra, type: 'line', startId: joint, endId: tip, construction: false });
    expect(findChain(s.points, s.geometries, fixture.ids[0]!)!.edges).toHaveLength(1);
  });
});

describe('offsetCurveAt: SVG-imported outlines', () => {
  const svg = (size: number, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}mm" height="${size}mm">${body}</svg>`;
  /** 24 petals: tight convex tips and concave cusps between them. */
  const flower = (() => {
    let d = '';
    const p = (r: number, a: number) => `${(50 + r * Math.cos(a)).toFixed(3)} ${(50 + r * Math.sin(a)).toFixed(3)}`;
    for (let i = 0; i < 24; i++) {
      const a0 = (i / 24) * 2 * Math.PI, a1 = ((i + 1) / 24) * 2 * Math.PI, am = (a0 + a1) / 2;
      if (i === 0) d += `M ${p(20, a0)} `;
      d += `C ${p(45, a0 + 0.05)} ${p(49.5, am)} ${p(45, am)} C ${p(49.5, am)} ${p(45, a1 - 0.05)} ${p(20, a1)} `;
    }
    return `<path d="${d}Z"/>`;
  })();
  const cases: Array<[string, string, Vec2]> = [
    ['cloud (C curves + line)', svg(60, '<path d="M25 70 C10 70 10 50 25 50 C25 35 45 30 52 42 C58 28 82 32 80 50 C95 50 95 70 80 70 Z"/>'), [30, 24]],
    ['star (concave line corners)', svg(50, '<path d="M50 5 L61 38 L95 38 L67 58 L78 92 L50 72 L22 92 L33 58 L5 38 L39 38 Z"/>'), [25, 25]],
    ['arch with a notch (A arcs)', svg(40, '<path d="M20 50 A30 30 0 0 1 80 50 L80 80 L60 80 A10 10 0 0 0 40 80 L20 80 Z"/>'), [12, 14]],
    ['flower (tight tips, cusps)', svg(80, flower), [40, 40]],
  ];

  it.each(cases)('%s offsets ±1 mm to one clean closed chain', (_name, text, inside) => {
    const { state } = svgToEditorState(text);
    const fixture = { state, ids: [...state.geometries.keys()] };
    expect(findChain(state.points, state.geometries, fixture.ids[0]!)!.closed).toBe(true);
    expectCleanLoop(fixture, 1, [-100, -100]);
    expectCleanLoop(fixture, 1, inside);
  });
});

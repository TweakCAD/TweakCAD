/**
 * Chain offset: offset a connected chain of sketch curves (lines, arcs,
 * cubic Béziers, Catmull-Rom splines) by a signed distance and return the
 * result as primitive pieces (lines, arcs, cubic Béziers) ready to become
 * sketch geometry.
 *
 * Pipeline:
 *   1. {@link findChain} walks endpoint-connected curves from a seed through
 *      every vertex shared by exactly two curves (a branch ends the chain).
 *   2. {@link chainToPieces} lowers the chain to oriented pieces. A spline
 *      becomes one cubic Bézier per Catmull-Rom span (an exact conversion).
 *   3. Each piece is offset to the left of travel: lines and arcs exactly,
 *      Béziers by a least-squares cubic fit that subdivides until every
 *      point of it is within {@link FIT_TOLERANCE} of |d| from the source.
 *   4. Neighbours are joined: endpoints that already meet are snapped,
 *      overlapping pieces are trimmed at their intersection, diverging
 *      line pairs are mitred, and any other gap is bridged with an arc of
 *      radius |d| about the source vertex.
 *   5. Self-intersections split the raw offset into loops; a loop is kept
 *      only if it keeps the source's winding and stays |d| clear of the
 *      source. This removes cusp loops and handles necks that pinch off.
 *
 * Pure geometry on plain coordinates. The editor-state op that turns the
 * result into sketch geometry is `offsetCurveAt` in `modifyOps.ts`.
 */

import type { SketchGeometry, SketchGeometryId, SketchPoint, SketchPointId } from './types.ts';

export type Vec2 = [number, number];

/**
 * One primitive of an offset chain, parametrised on t ∈ [0, 1] in travel
 * order. An arc runs from angle `a0` through the signed `sweep` (positive =
 * counter-clockwise).
 */
export type OffsetPiece =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number }
  | { kind: 'bezier'; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 };

/** An oriented run of offset pieces; consecutive pieces meet end-to-start. */
export type OffsetPath = { pieces: OffsetPiece[]; closed: boolean };

/** A chain of sketch geometries in travel order. */
export type SketchChain = {
  edges: Array<{ id: SketchGeometryId; reversed: boolean }>;
  closed: boolean;
};

/** Max deviation (mm) of a fitted Bézier from the true offset curve. */
export const FIT_TOLERANCE = 5e-3;
/** Endpoints closer than this (mm) are the same chain vertex. */
const LINK_TOLERANCE = 1e-6;
/** Max parameter-matched distance (mm) between a fit and the sampled offset. */
const MAX_FIT_DRIFT = 0.1;
/** Bézier fit subdivision depth (up to 2^depth pieces per source Bézier). */
const MAX_FIT_DEPTH = 6;
/** A mitre corner further than this many |d| from its vertex is rounded instead. */
const MITER_LIMIT = 4;
/** Pieces shorter than this (mm) are dropped. */
const MIN_PIECE_LENGTH = 1e-7;

// ---- Vector helpers --------------------------------------------------------

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** Left-hand normal of a direction (rotate +90°). */
const left = (a: Vec2): Vec2 => [-a[1], a[0]];

function unit(a: Vec2): Vec2 | null {
  const l = len(a);
  return l < 1e-12 ? null : [a[0] / l, a[1] / l];
}

/** Wrap an angle into (0, 2π] when `positive`, else [-2π, 0). */
function wrapSweep(sweep: number, positive: boolean): number {
  const TAU = 2 * Math.PI;
  let s = sweep % TAU;
  if (positive) { if (s <= 0) s += TAU; } else if (s >= 0) s -= TAU;
  return s;
}

/** Wrap an angle into (-π, π]. */
function wrapPi(a: number): number {
  const TAU = 2 * Math.PI;
  let s = a % TAU;
  if (s <= -Math.PI) s += TAU; else if (s > Math.PI) s -= TAU;
  return s;
}

// ---- Piece evaluation ------------------------------------------------------

export function pointAt(p: OffsetPiece, t: number): Vec2 {
  switch (p.kind) {
    case 'line': return lerp(p.a, p.b, t);
    case 'arc': {
      const a = p.a0 + p.sweep * t;
      return [p.c[0] + p.r * Math.cos(a), p.c[1] + p.r * Math.sin(a)];
    }
    case 'bezier': {
      const u = 1 - t;
      const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      return [
        b0 * p.p0[0] + b1 * p.p1[0] + b2 * p.p2[0] + b3 * p.p3[0],
        b0 * p.p0[1] + b1 * p.p1[1] + b2 * p.p2[1] + b3 * p.p3[1],
      ];
    }
  }
}

function derivAt(p: OffsetPiece, t: number): Vec2 {
  switch (p.kind) {
    case 'line': return sub(p.b, p.a);
    case 'arc': {
      const a = p.a0 + p.sweep * t;
      return [-p.r * p.sweep * Math.sin(a), p.r * p.sweep * Math.cos(a)];
    }
    case 'bezier': {
      const u = 1 - t;
      const d0 = sub(p.p1, p.p0), d1 = sub(p.p2, p.p1), d2 = sub(p.p3, p.p2);
      return [
        3 * (u * u * d0[0] + 2 * u * t * d1[0] + t * t * d2[0]),
        3 * (u * u * d0[1] + 2 * u * t * d1[1] + t * t * d2[1]),
      ];
    }
  }
}

/**
 * Unit tangent in travel direction. A Bézier whose derivative vanishes
 * (a pole on its endpoint) falls back to the direction toward the next
 * distinct pole, which is the limit tangent there.
 */
function tangentAt(p: OffsetPiece, t: number): Vec2 | null {
  const d = unit(derivAt(p, t));
  if (d || p.kind !== 'bezier') return d;
  if (t <= 0.5) return unit(sub(p.p2, p.p0)) ?? unit(sub(p.p3, p.p0));
  return unit(sub(p.p3, p.p1)) ?? unit(sub(p.p3, p.p0));
}

const startOf = (p: OffsetPiece): Vec2 => pointAt(p, 0);
const endOf = (p: OffsetPiece): Vec2 => pointAt(p, 1);

/** The part of `p` between parameters t0 and t1 (t0 < t1). */
function subPiece(p: OffsetPiece, t0: number, t1: number): OffsetPiece {
  switch (p.kind) {
    case 'line': return { kind: 'line', a: lerp(p.a, p.b, t0), b: lerp(p.a, p.b, t1) };
    case 'arc': return { ...p, a0: p.a0 + p.sweep * t0, sweep: p.sweep * (t1 - t0) };
    case 'bezier': {
      // Blossom the cubic at (t0, t0, t0) … (t1, t1, t1).
      const blossom = (u: number, v: number, w: number): Vec2 => {
        const l1 = (a: Vec2, b: Vec2, s: number) => lerp(a, b, s);
        const a1 = l1(p.p0, p.p1, u), b1 = l1(p.p1, p.p2, u), c1 = l1(p.p2, p.p3, u);
        const a2 = l1(a1, b1, v), b2 = l1(b1, c1, v);
        return l1(a2, b2, w);
      };
      return {
        kind: 'bezier',
        p0: blossom(t0, t0, t0),
        p1: blossom(t0, t0, t1),
        p2: blossom(t0, t1, t1),
        p3: blossom(t1, t1, t1),
      };
    }
  }
}

function reversePiece(p: OffsetPiece): OffsetPiece {
  switch (p.kind) {
    case 'line': return { kind: 'line', a: p.b, b: p.a };
    case 'arc': return { ...p, a0: p.a0 + p.sweep, sweep: -p.sweep };
    case 'bezier': return { kind: 'bezier', p0: p.p3, p1: p.p2, p2: p.p1, p3: p.p0 };
  }
}

/** Move a piece's start to `q`, keeping its shape as far as the kind allows. */
function withStart(p: OffsetPiece, q: Vec2): OffsetPiece {
  switch (p.kind) {
    case 'line': return { ...p, a: q };
    case 'bezier': return { ...p, p0: q, p1: add(p.p1, sub(q, p.p0)) };
    case 'arc': {
      // Nearest equivalent angle, so a small move stays a small change.
      const delta = wrapPi(Math.atan2(q[1] - p.c[1], q[0] - p.c[0]) - p.a0);
      return { ...p, a0: p.a0 + delta, sweep: p.sweep - delta };
    }
  }
}

/** Move a piece's end to `q`, keeping its shape as far as the kind allows. */
function withEnd(p: OffsetPiece, q: Vec2): OffsetPiece {
  switch (p.kind) {
    case 'line': return { ...p, b: q };
    case 'bezier': return { ...p, p3: q, p2: add(p.p2, sub(q, p.p3)) };
    case 'arc': {
      const delta = wrapPi(Math.atan2(q[1] - p.c[1], q[0] - p.c[0]) - (p.a0 + p.sweep));
      return { ...p, sweep: p.sweep + delta };
    }
  }
}

/** Parameters at which to sample a piece into a polyline (both ends included). */
function sampleParams(p: OffsetPiece): number[] {
  const n = p.kind === 'line' ? 1
    : p.kind === 'arc' ? Math.max(2, Math.ceil(Math.abs(p.sweep) / (Math.PI / 32)))
      : 32;
  const ts: number[] = [];
  for (let i = 0; i <= n; i++) ts.push(i / n);
  return ts;
}

function pieceLength(p: OffsetPiece): number {
  if (p.kind === 'line') return dist(p.a, p.b);
  if (p.kind === 'arc') return Math.abs(p.sweep) * p.r;
  const ts = sampleParams(p);
  let l = 0;
  for (let i = 1; i < ts.length; i++) l += dist(pointAt(p, ts[i - 1]!), pointAt(p, ts[i]!));
  return l;
}

/** Polyline through a run of pieces (shared joints not duplicated). */
export function samplePath(pieces: readonly OffsetPiece[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pieces) {
    const ts = sampleParams(p);
    for (let i = out.length === 0 ? 0 : 1; i < ts.length; i++) out.push(pointAt(p, ts[i]!));
  }
  return out;
}

/** Shoelace area of a closed polyline (positive = counter-clockwise). */
function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointInPolygon(pt: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Closest point on a polyline to `pt`, with the direction of the segment it lies on. */
function closestOnPolyline(pt: Vec2, poly: readonly Vec2[]): { q: Vec2; dir: Vec2; d: number } {
  let best = { q: poly[0]!, dir: [1, 0] as Vec2, d: Infinity };
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!, b = poly[i]!;
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(pt, a), ab) / l2));
    const q = lerp(a, b, t);
    const d = dist(pt, q);
    if (d < best.d && l2 >= 1e-24) best = { q, dir: ab, d };
  }
  return best;
}

// ---- Intersections ---------------------------------------------------------

type Hit = { x: Vec2; ta: number; tb: number };
type Box = [number, number, number, number];

function boxOf(pts: readonly Vec2[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

const boxesOverlap = (a: Box, b: Box, pad = 1e-9): boolean =>
  a[0] <= b[2] + pad && b[0] <= a[2] + pad && a[1] <= b[3] + pad && b[1] <= a[3] + pad;

/** Exact distance from `pt` to a piece (Bézier: sampled, then Newton-refined). */
function distanceToPiece(pt: Vec2, p: OffsetPiece): number {
  if (p.kind === 'line') {
    const ab = sub(p.b, p.a);
    const l2 = dot(ab, ab);
    const t = l2 < 1e-24 ? 0 : Math.max(0, Math.min(1, dot(sub(pt, p.a), ab) / l2));
    return dist(pt, lerp(p.a, p.b, t));
  }
  if (p.kind === 'arc') {
    // On the arc's span the nearest point is radial; otherwise an endpoint.
    const ang = Math.atan2(pt[1] - p.c[1], pt[0] - p.c[0]);
    const rel = p.sweep > 0 ? wrapSweep(ang - p.a0, true) : -wrapSweep(ang - p.a0, false);
    if (rel <= Math.abs(p.sweep) || rel >= 2 * Math.PI) return Math.abs(dist(pt, p.c) - p.r);
    return Math.min(dist(pt, startOf(p)), dist(pt, endOf(p)));
  }
  const ts = sampleParams(p);
  let bestT = 0, best = Infinity;
  for (const t of ts) {
    const d = dist(pt, pointAt(p, t));
    if (d < best) { best = d; bestT = t; }
  }
  // Newton on (B(t) − pt)·B'(t) = 0 from the nearest sample.
  let t = bestT;
  for (let k = 0; k < 8; k++) {
    const r = sub(pointAt(p, t), pt);
    const d1 = derivAt(p, t);
    const h = 1e-6;
    const d2 = scale(sub(derivAt(p, Math.min(1, t + h)), derivAt(p, Math.max(0, t - h))), 1 / (Math.min(1, t + h) - Math.max(0, t - h)));
    const den = dot(d1, d1) + dot(r, d2);
    if (Math.abs(den) < 1e-18) break;
    t = Math.max(0, Math.min(1, t - dot(r, d1) / den));
  }
  return Math.min(best, dist(pt, pointAt(p, t)));
}

/** Distance from `pt` to the nearest of `pieces`, pruned by bounding boxes. */
function distanceToPieces(pt: Vec2, pieces: readonly OffsetPiece[], boxes: readonly Box[]): number {
  let best = Infinity;
  for (let i = 0; i < pieces.length; i++) {
    const b = boxes[i]!;
    const dx = Math.max(b[0] - pt[0], 0, pt[0] - b[2]);
    const dy = Math.max(b[1] - pt[1], 0, pt[1] - b[3]);
    if (Math.hypot(dx, dy) >= best) continue;
    best = Math.min(best, distanceToPiece(pt, pieces[i]!));
  }
  return best;
}


/**
 * Intersections of two pieces within their parameter ranges. Candidates
 * come from their sampled polylines and are refined by Newton iteration on
 * the exact curves, so line/arc hits are exact and Bézier hits converge to
 * machine precision. Tangential touches may be missed; that is acceptable
 * for trimming and loop removal, which only need transversal crossings.
 */
function intersectPieces(A: OffsetPiece, B: OffsetPiece): Hit[] {
  const ta = sampleParams(A), tb = sampleParams(B);
  const pa = ta.map(t => pointAt(A, t)), pb = tb.map(t => pointAt(B, t));
  if (!boxesOverlap(boxOf(pa), boxOf(pb))) return [];
  const hits: Hit[] = [];
  for (let i = 1; i < pa.length; i++) {
    const a0 = pa[i - 1]!, a1 = pa[i]!;
    const ba: Box = boxOf([a0, a1]);
    for (let j = 1; j < pb.length; j++) {
      const b0 = pb[j - 1]!, b1 = pb[j]!;
      if (!boxesOverlap(ba, boxOf([b0, b1]))) continue;
      const r = sub(a1, a0), s = sub(b1, b0);
      const den = cross(r, s);
      if (Math.abs(den) < 1e-18) continue;
      const qp = sub(b0, a0);
      const u = cross(qp, s) / den, v = cross(qp, r) / den;
      const eps = 1e-9;
      if (u < -eps || u > 1 + eps || v < -eps || v > 1 + eps) continue;
      let sa = ta[i - 1]! + (ta[i]! - ta[i - 1]!) * u;
      let sb = tb[j - 1]! + (tb[j]! - tb[j - 1]!) * v;
      for (let k = 0; k < 12; k++) {
        const f = sub(pointAt(A, sa), pointAt(B, sb));
        if (len(f) < 1e-13) break;
        const da = derivAt(A, sa), db = derivAt(B, sb);
        const det = -da[0] * db[1] + db[0] * da[1];
        if (Math.abs(det) < 1e-18) break;
        // Solve [da, -db] · [δa, δb]ᵀ = -f.
        const dA = (-f[0] * -db[1] - -db[0] * -f[1]) / det;
        const dB = (da[0] * -f[1] - -f[0] * da[1]) / det;
        sa += dA; sb += dB;
      }
      if (sa < -1e-9 || sa > 1 + 1e-9 || sb < -1e-9 || sb > 1 + 1e-9) continue;
      sa = Math.max(0, Math.min(1, sa));
      sb = Math.max(0, Math.min(1, sb));
      const x = pointAt(A, sa);
      if (dist(x, pointAt(B, sb)) > 1e-6) continue;
      if (hits.some(h => Math.abs(h.ta - sa) < 1e-9 && Math.abs(h.tb - sb) < 1e-9)) continue;
      hits.push({ x, ta: sa, tb: sb });
    }
  }
  return hits;
}

// ---- Chain discovery -------------------------------------------------------

/** Catmull-Rom splines are closed when their ends meet (see `sampleSplinePolyline`). */
function isClosedSpline(pts: readonly SketchPoint[]): boolean {
  if (pts.length < 4) return false;
  const a = pts[0]!, b = pts[pts.length - 1]!;
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

/** Start/end of a geometry that can sit in an open chain, or null. */
function chainEnds(
  g: SketchGeometry,
  points: ReadonlyMap<SketchPointId, SketchPoint>,
): [Vec2, Vec2] | null {
  let s: SketchPoint | undefined, e: SketchPoint | undefined;
  if (g.type === 'line' || g.type === 'arc' || g.type === 'bezier') {
    s = points.get(g.startId); e = points.get(g.endId);
  } else if (g.type === 'spline') {
    const pts = g.pointIds.map(id => points.get(id));
    if (pts.some(p => !p) || pts.length < 2) return null;
    if (isClosedSpline(pts as SketchPoint[])) return null;
    s = pts[0]; e = pts[pts.length - 1];
  }
  if (!s || !e) return null;
  if (Math.hypot(s.x - e.x, s.y - e.y) < LINK_TOLERANCE) return null;
  return [[s.x, s.y], [e.x, e.y]];
}

/**
 * The chain of curves connected end-to-end with `seedId`, in travel order
 * (the seed's own direction). Walks through vertices shared by exactly two
 * curves of the same construction kind; a branch or a free end stops the
 * walk. Endpoints link by coordinate, so curves joined by a shared point or
 * by a coincident constraint both chain. A closed spline is a closed chain
 * by itself. Returns null for curves that cannot chain (circle, ellipse,
 * point).
 */
export function findChain(
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
  seedId: SketchGeometryId,
): SketchChain | null {
  const seed = geometries.get(seedId);
  if (!seed) return null;
  if (seed.type === 'spline') {
    const pts = seed.pointIds.map(id => points.get(id));
    if (pts.every(p => p) && isClosedSpline(pts as SketchPoint[])) {
      return { edges: [{ id: seedId, reversed: false }], closed: true };
    }
  }
  const seedEnds = chainEnds(seed, points);
  if (!seedEnds) return null;

  const cands: Array<{ id: SketchGeometryId; ends: [Vec2, Vec2] }> = [];
  for (const g of geometries.values()) {
    if (g.construction !== seed.construction) continue;
    const ends = chainEnds(g, points);
    if (ends) cands.push({ id: g.id, ends });
  }
  /** Every (curve, end) slot touching `v`; end 0 = start, 1 = end. */
  const slotsAt = (v: Vec2) => {
    const out: Array<{ id: SketchGeometryId; end: 0 | 1 }> = [];
    for (const c of cands) {
      if (dist(c.ends[0], v) < LINK_TOLERANCE) out.push({ id: c.id, end: 0 });
      if (dist(c.ends[1], v) < LINK_TOLERANCE) out.push({ id: c.id, end: 1 });
    }
    return out;
  };
  const endsOf = new Map(cands.map(c => [c.id, c.ends]));

  /** Walk from `fromId` leaving through vertex `v`; returns edges entered and whether it looped to the seed. */
  const walk = (fromId: SketchGeometryId, v: Vec2) => {
    const out: Array<{ id: SketchGeometryId; reversed: boolean }> = [];
    const seen = new Set<SketchGeometryId>([seedId]);
    let cur = fromId;
    let at = v;
    for (;;) {
      const slots = slotsAt(at);
      if (slots.length !== 2) return { out, looped: false };
      const next = slots.find(s => s.id !== cur);
      if (!next) return { out, looped: false };
      if (next.id === seedId) return { out, looped: true };
      if (seen.has(next.id)) return { out, looped: false };
      seen.add(next.id);
      // Entering through its start = forward; through its end = reversed.
      out.push({ id: next.id, reversed: next.end === 1 });
      at = endsOf.get(next.id)![next.end === 0 ? 1 : 0];
      cur = next.id;
    }
  };

  const fwd = walk(seedId, seedEnds[1]);
  if (fwd.looped) {
    return { edges: [{ id: seedId, reversed: false }, ...fwd.out], closed: true };
  }
  const back = walk(seedId, seedEnds[0]);
  // The backward walk travels against the chain; flip it into travel order.
  const before = back.out.reverse().map(e => ({ id: e.id, reversed: !e.reversed }));
  return { edges: [...before, { id: seedId, reversed: false }, ...fwd.out], closed: false };
}

// ---- Lowering to pieces ----------------------------------------------------

/** Catmull-Rom spans as exact cubic Béziers (tension ½, phantom or wrapped ends). */
function splineToBeziers(ctrl: Vec2[], closed: boolean): OffsetPiece[] {
  if (closed) {
    const ring = ctrl.slice(0, -1);
    const n = ring.length;
    const out: OffsetPiece[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = ring[(i - 1 + n) % n]!, p1 = ring[i]!, p2 = ring[(i + 1) % n]!, p3 = ring[(i + 2) % n]!;
      out.push(crSpan(p0, p1, p2, p3));
    }
    return out;
  }
  if (ctrl.length === 2) return [{ kind: 'line', a: ctrl[0]!, b: ctrl[1]! }];
  const ext: Vec2[] = [
    sub(scale(ctrl[0]!, 2), ctrl[1]!),
    ...ctrl,
    sub(scale(ctrl[ctrl.length - 1]!, 2), ctrl[ctrl.length - 2]!),
  ];
  const out: OffsetPiece[] = [];
  for (let i = 1; i < ext.length - 2; i++) out.push(crSpan(ext[i - 1]!, ext[i]!, ext[i + 1]!, ext[i + 2]!));
  return out;
}

function crSpan(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): OffsetPiece {
  return {
    kind: 'bezier',
    p0: p1,
    p1: add(p1, scale(sub(p2, p0), 1 / 6)),
    p2: sub(p2, scale(sub(p3, p1), 1 / 6)),
    p3: p2,
  };
}

/** Lower a chain to oriented pieces, dropping zero-length curves. */
export function chainToPieces(
  points: ReadonlyMap<SketchPointId, SketchPoint>,
  geometries: ReadonlyMap<SketchGeometryId, SketchGeometry>,
  chain: SketchChain,
): OffsetPiece[] {
  const P = (id: SketchPointId): Vec2 | null => {
    const p = points.get(id);
    return p ? [p.x, p.y] : null;
  };
  const out: OffsetPiece[] = [];
  for (const { id, reversed } of chain.edges) {
    const g = geometries.get(id);
    if (!g) continue;
    let pieces: OffsetPiece[] = [];
    if (g.type === 'line') {
      const a = P(g.startId), b = P(g.endId);
      if (a && b) pieces = [{ kind: 'line', a, b }];
    } else if (g.type === 'arc') {
      const c = P(g.centerId), s = P(g.startId), e = P(g.endId);
      if (c && s && e) {
        const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
        const a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
        pieces = [{ kind: 'arc', c, r: dist(c, s), a0, sweep: wrapSweep(a1 - a0, true) }];
      }
    } else if (g.type === 'bezier') {
      const p0 = P(g.startId), p1 = P(g.cp1Id), p2 = P(g.cp2Id), p3 = P(g.endId);
      if (p0 && p1 && p2 && p3) pieces = [{ kind: 'bezier', p0, p1, p2, p3 }];
    } else if (g.type === 'spline') {
      const ctrl = g.pointIds.map(P);
      if (ctrl.every(c => c)) {
        const pts = g.pointIds.map(pid => points.get(pid)!);
        pieces = splineToBeziers(ctrl as Vec2[], isClosedSpline(pts));
      }
    }
    if (reversed) pieces = pieces.reverse().map(reversePiece);
    for (const p of pieces) if (pieceLength(p) > MIN_PIECE_LENGTH) out.push(p);
  }
  return out;
}

// ---- Offsetting ------------------------------------------------------------

/**
 * Offset a cubic Bézier by `d` (left of travel). The offset of a cubic is
 * not a cubic, so fit one: endpoints and end tangents are exact, the two
 * handle lengths are a linear least-squares fit to sampled offset points,
 * and the piece is split in half until every fit point is within
 * FIT_TOLERANCE of |d| from the source.
 */
function offsetBezier(bz: Extract<OffsetPiece, { kind: 'bezier' }>, d: number, depth: number): OffsetPiece[] {
  const t0 = tangentAt(bz, 0), t3 = tangentAt(bz, 1);
  if (!t0 || !t3) return [];
  const q0 = add(bz.p0, scale(left(t0), d));
  const q3 = add(bz.p3, scale(left(t3), d));

  const samples: Array<{ t: number; q: Vec2 }> = [];
  for (let i = 1; i < 16; i++) {
    const t = i / 16;
    const tan = tangentAt(bz, t);
    if (tan) samples.push({ t, q: add(pointAt(bz, t), scale(left(tan), d)) });
  }

  // B(t) = (b0+b1)·q0 + (b2+b3)·q3 + a·b1·t0 − b·b2·t3; solve for a, b.
  let m00 = 0, m01 = 0, m11 = 0, r0 = 0, r1 = 0;
  for (const { t, q } of samples) {
    const u = 1 - t;
    const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
    const base = add(scale(q0, b0 + b1), scale(q3, b2 + b3));
    const res = sub(q, base);
    const U = scale(t0, b1), V = scale(t3, -b2);
    m00 += dot(U, U); m01 += dot(U, V); m11 += dot(V, V);
    r0 += dot(U, res); r1 += dot(V, res);
  }
  const det = m00 * m11 - m01 * m01;
  let a = dist(q0, q3) / 3, b = a;
  if (Math.abs(det) > 1e-18) {
    a = (r0 * m11 - r1 * m01) / det;
    b = (m00 * r1 - m01 * r0) / det;
  }
  const fit: OffsetPiece = { kind: 'bezier', p0: q0, p1: add(q0, scale(t0, a)), p2: sub(q3, scale(t3, b)), p3: q3 };

  // Geometric error: how far each fit point is from sitting |d| off the
  // source. The parameter-matched distance only guards against a fit that
  // wanders (it overstates the error, since the offset's speed differs).
  let err = 0, drift = 0;
  for (let i = 1; i < 32; i++) {
    const t = i / 32;
    err = Math.max(err, Math.abs(distanceToPiece(pointAt(fit, t), bz) - Math.abs(d)));
  }
  for (const { t, q } of samples) drift = Math.max(drift, dist(pointAt(fit, t), q));
  const bad = err > FIT_TOLERANCE || drift > MAX_FIT_DRIFT || a < 0 || b < 0;
  if (bad && depth < MAX_FIT_DEPTH) {
    const lo = subPiece(bz, 0, 0.5) as typeof bz, hi = subPiece(bz, 0.5, 1) as typeof bz;
    return [...offsetBezier(lo, d, depth + 1), ...offsetBezier(hi, d, depth + 1)];
  }
  return [fit];
}

/** Offset one piece by `d` (left of travel); empty when it collapses. */
function offsetPiece(p: OffsetPiece, d: number): OffsetPiece[] {
  if (p.kind === 'line') {
    const n = unit(left(sub(p.b, p.a)));
    if (!n) return [];
    return [{ kind: 'line', a: add(p.a, scale(n, d)), b: add(p.b, scale(n, d)) }];
  }
  if (p.kind === 'arc') {
    // Left of a counter-clockwise arc points at its centre.
    const r = p.sweep > 0 ? p.r - d : p.r + d;
    return r > 1e-9 ? [{ ...p, r }] : [];
  }
  return offsetBezier(p, d, 0);
}

/**
 * Join the end of `P` to the start of `Q` around source vertex `V`, where
 * the source turned from direction `tin` to `tout`. Returns the adjusted
 * pieces and an optional bridging arc between them.
 */
function joinPieces(
  P: OffsetPiece, Q: OffsetPiece, V: Vec2, tin: Vec2, tout: Vec2, d: number,
): { P: OffsetPiece; Q: OffsetPiece; bridge?: OffsetPiece } {
  const pe = endOf(P), qs = startOf(Q);
  const gap = dist(pe, qs);
  const bothArcs = P.kind === 'arc' && Q.kind === 'arc';
  if (gap <= 1e-9 || (gap <= FIT_TOLERANCE && !bothArcs)) {
    // Keep an arc's endpoint exact; free kinds take the move.
    const joint = P.kind === 'arc' ? pe : Q.kind === 'arc' ? qs : lerp(pe, qs, 0.5);
    return { P: withEnd(P, joint), Q: withStart(Q, joint) };
  }

  const hits = intersectPieces(P, Q);
  if (hits.length > 0) {
    let best = hits[0]!;
    for (const h of hits) if (dist(h.x, V) < dist(best.x, V)) best = h;
    return {
      P: withEnd(subPiece(P, 0, best.ta), best.x),
      Q: withStart(subPiece(Q, best.tb, 1), best.x),
    };
  }

  const turn = cross(tin, tout);
  const convex = turn * d < 0 || (Math.abs(turn) < 1e-12 && dot(tin, tout) < 0);
  if (convex && P.kind === 'line' && Q.kind === 'line') {
    const r = sub(P.b, P.a), s = sub(Q.b, Q.a);
    const den = cross(r, s);
    if (Math.abs(den) > 1e-12) {
      const u = cross(sub(Q.a, P.a), s) / den;
      const x = add(P.a, scale(r, u));
      if (dist(x, V) <= MITER_LIMIT * Math.abs(d)) return { P: withEnd(P, x), Q: withStart(Q, x) };
    }
  }

  // Round join about the source vertex, turning the way the source turned
  // (a hairpin turns away from the offset side).
  const ccw = Math.abs(turn) < 1e-12 ? d < 0 : turn > 0;
  const a0 = Math.atan2(pe[1] - V[1], pe[0] - V[0]);
  const a1 = Math.atan2(qs[1] - V[1], qs[0] - V[0]);
  return { P, Q, bridge: { kind: 'arc', c: V, r: Math.abs(d), a0, sweep: wrapSweep(a1 - a0, ccw) } };
}

/** Raw offset: offset every piece and join neighbours (no global cleanup). */
function rawOffset(src: readonly OffsetPiece[], closed: boolean, d: number): OffsetPiece[] {
  const groups = src.map(orig => ({ orig, out: offsetPiece(orig, d) }));
  const live = groups.map((g, i) => ({ ...g, i })).filter(g => g.out.length > 0);
  if (live.length === 0) return [];

  /** Source vertex between live groups `a` and `b`: their shared point, or a collapsed arc's centre. */
  const vertexBetween = (ai: number, bi: number): Vec2 => {
    const n = src.length;
    const next = (ai + 1) % n;
    if (next === bi) return endOf(src[ai]!);
    const collapsed = src[next]!;
    return collapsed.kind === 'arc' ? collapsed.c : startOf(collapsed);
  };

  const out: OffsetPiece[] = [...live[0]!.out];
  const joinInto = (prevIdx: number, nextGroup: typeof live[number], wrap: boolean) => {
    const P = out[out.length - 1]!;
    const Q = wrap ? out[0]! : nextGroup.out[0]!;
    const V = vertexBetween(prevIdx, nextGroup.i);
    const tin = tangentAt(src[prevIdx]!, 1) ?? [1, 0];
    const tout = tangentAt(src[nextGroup.i]!, 0) ?? [1, 0];
    const j = joinPieces(P, Q, V, tin, tout, d);
    out[out.length - 1] = j.P;
    if (j.bridge) out.push(j.bridge);
    if (wrap) out[0] = j.Q;
    else out.push(j.Q, ...nextGroup.out.slice(1));
  };

  for (let k = 1; k < live.length; k++) joinInto(live[k - 1]!.i, live[k]!, false);
  if (closed && out.length >= 2) joinInto(live[live.length - 1]!.i, live[0]!, true);
  return out;
}

/**
 * Split a raw offset at its self-intersections. A closed path splits into
 * two loops at each crossing; an open path sheds the closed loop between
 * its two crossing pieces. Recurses until no crossings remain.
 */
function splitAtCrossings(path: OffsetPath, depth = 0): OffsetPath[] {
  const { pieces, closed } = path;
  const n = pieces.length;
  if (depth > 256 || n < 2) return [path];
  const boxes = pieces.map(p => boxOf(sampleParams(p).map(t => pointAt(p, t))));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!boxesOverlap(boxes[i]!, boxes[j]!)) continue;
      const nextTo = j === i + 1;
      const wrapTo = closed && i === 0 && j === n - 1;
      let hits = intersectPieces(pieces[i]!, pieces[j]!);
      // Neighbours always meet at their shared joint; that is not a crossing.
      if (nextTo) hits = hits.filter(h => dist(h.x, endOf(pieces[i]!)) > 1e-6);
      if (wrapTo) hits = hits.filter(h => dist(h.x, startOf(pieces[i]!)) > 1e-6);
      if (n === 2 && closed) hits = hits.filter(h => dist(h.x, startOf(pieces[0]!)) > 1e-6 && dist(h.x, endOf(pieces[0]!)) > 1e-6);
      if (hits.length === 0) continue;
      const h = hits[0]!;
      const headI = subPiece(pieces[i]!, 0, h.ta), tailI = subPiece(pieces[i]!, h.ta, 1);
      const headJ = subPiece(pieces[j]!, 0, h.tb), tailJ = subPiece(pieces[j]!, h.tb, 1);
      const keep = (ps: OffsetPiece[]) => ps.filter(p => pieceLength(p) > MIN_PIECE_LENGTH);
      const inner: OffsetPath = { pieces: keep([tailI, ...pieces.slice(i + 1, j), headJ]), closed: true };
      const outer: OffsetPath = closed
        ? { pieces: keep([tailJ, ...pieces.slice(j + 1), ...pieces.slice(0, i), headI]), closed: true }
        : { pieces: keep([...pieces.slice(0, i), headI, tailJ, ...pieces.slice(j + 1)]), closed: false };
      return [
        ...(inner.pieces.length > 0 ? splitAtCrossings(inner, depth + 1) : []),
        ...(outer.pieces.length > 0 ? splitAtCrossings(outer, depth + 1) : []),
      ];
    }
  }
  return [path];
}

/**
 * Offset a run of pieces by `d` (positive = left of travel). Returns the
 * clean offset as one or more paths: one for a simple outline, several when
 * an inward offset pinches a narrow neck apart, none when the offset
 * consumes the whole shape.
 */
export function offsetPieces(src: readonly OffsetPiece[], closed: boolean, d: number): OffsetPath[] {
  if (src.length === 0 || d === 0) return [];
  const raw = rawOffset(src, closed, d);
  if (raw.length === 0) return [];

  const srcArea = closed ? signedArea(samplePath(src)) : 0;
  const srcBoxes = src.map(p => boxOf(sampleParams(p).map(t => pointAt(p, t))));
  const clearance = (p: OffsetPiece): number => distanceToPieces(pointAt(p, 0.5), src, srcBoxes);
  // A valid offset point sits |d| from the source; a point inside a cusp or
  // crossed-over loop sits closer. The slack covers fit + sampling error.
  const minClearance = Math.abs(d) * 0.9 - FIT_TOLERANCE;

  const parts = splitAtCrossings({ pieces: raw, closed });
  return parts.filter(part => {
    if (part.pieces.length === 0) return false;
    if (part.closed !== closed) return false; // a loop shed by an open path
    if (closed) {
      const area = signedArea(samplePath(part.pieces));
      if (Math.abs(area) < 1e-9 || Math.sign(area) !== Math.sign(srcArea)) return false;
    }
    return part.pieces.every(p => clearance(p) >= minClearance);
  });
}

/**
 * The signed offset distance for a cursor pick: positive = left of the
 * chain's travel direction. A closed chain offsets inward when the cursor
 * is inside it and outward otherwise; an open chain offsets toward the side
 * of its nearest point the cursor is on.
 */
export function signedDistanceForCursor(
  src: readonly OffsetPiece[], closed: boolean, distance: number, cursor: Vec2,
): number {
  const poly = samplePath(src);
  if (closed) {
    const inside = pointInPolygon(cursor, poly);
    const ccw = signedArea(poly) > 0;
    // Left of a counter-clockwise loop is its inside.
    return (inside === ccw ? 1 : -1) * distance;
  }
  const { q, dir } = closestOnPolyline(cursor, poly);
  return (Math.sign(cross(dir, sub(cursor, q))) || 1) * distance;
}

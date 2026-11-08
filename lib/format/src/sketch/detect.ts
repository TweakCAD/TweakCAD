import { canonicalBytes } from '../canonical';
import { compareBytes, makeSet, type JsonSet } from '../collections';
import { buildArrangement, type Arrangement, type Edge, type Incidence, type LiveCurve } from './arrangement';
import { at, boundsOf, distance, mod, TAU, type Bounds } from './curves';
import type { CurveKey, Loop, SolvedSketch, Use, UseEnd, Vec2 } from './types';

/** Half-edge `2e` walks edge `e` along its curve, `2e + 1` against it. */
export type HalfEdge = number;

/** A boundary cycle walked with its region on the left. */
export interface Cycle {
  halfEdges: readonly HalfEdge[];
  /** Signed area: positive counter-clockwise. */
  area: number;
}

export interface DetectedRegion {
  loop: Loop;
  holes: JsonSet<Loop>;
  /** The sorted set of its uses: its identity while it has no id. */
  identity: JsonSet<Use>;
  /** Area inside the loop and outside the holes. */
  area: number;
  outer: Cycle;
  inner: readonly Cycle[];
}

export interface Detection {
  arrangement: Arrangement;
  /** Detected regions, in order of their sorted uses. */
  regions: readonly DetectedRegion[];
}

function edgeOf(arrangement: Arrangement, h: HalfEdge): Edge {
  return at(arrangement.edges, h >> 1);
}

function isForward(h: HalfEdge): boolean {
  return (h & 1) === 0;
}

function originOf(arrangement: Arrangement, h: HalfEdge): Incidence {
  const edge = edgeOf(arrangement, h);
  return isForward(h) ? edge.from : edge.to;
}

function targetOf(arrangement: Arrangement, h: HalfEdge): Incidence {
  const edge = edgeOf(arrangement, h);
  return isForward(h) ? edge.to : edge.from;
}

function liveOf(arrangement: Arrangement, h: HalfEdge): LiveCurve {
  return at(arrangement.curves, edgeOf(arrangement, h).curve);
}

/** Edges that lie on no cycle: dangling lines and links between separate loops. */
function findBridges(edges: readonly Edge[], active: readonly number[], vertexCount: number): Set<number> {
  const adjacent: { to: number; edge: number }[][] = Array.from({ length: vertexCount }, () => []);
  for (const e of active) {
    const edge = at(edges, e);
    if (edge.from.vertex === edge.to.vertex) continue;
    at(adjacent, edge.from.vertex).push({ to: edge.to.vertex, edge: e });
    at(adjacent, edge.to.vertex).push({ to: edge.from.vertex, edge: e });
  }
  const order = new Array<number>(vertexCount).fill(-1);
  const low = new Array<number>(vertexCount).fill(0);
  const bridges = new Set<number>();
  let clock = 0;
  for (let root = 0; root < vertexCount; root++) {
    if (at(order, root) !== -1) continue;
    const stack = [{ vertex: root, viaEdge: -1, next: 0 }];
    order[root] = clock;
    low[root] = clock++;
    while (stack.length > 0) {
      const frame = at(stack, stack.length - 1);
      const links = at(adjacent, frame.vertex);
      if (frame.next < links.length) {
        const link = at(links, frame.next++);
        if (link.edge === frame.viaEdge) continue;
        if (at(order, link.to) === -1) {
          order[link.to] = clock;
          low[link.to] = clock++;
          stack.push({ vertex: link.to, viaEdge: link.edge, next: 0 });
        } else {
          low[frame.vertex] = Math.min(at(low, frame.vertex), at(order, link.to));
        }
      } else {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
          low[parent.vertex] = Math.min(at(low, parent.vertex), at(low, frame.vertex));
          if (at(low, frame.vertex) > at(order, parent.vertex)) bridges.add(frame.viaEdge);
        }
      }
    }
  }
  return bridges;
}

/** The unit direction a half-edge leaves its origin in. */
function leaving(arrangement: Arrangement, h: HalfEdge): Vec2 {
  const edge = edgeOf(arrangement, h);
  const { curve } = at(arrangement.curves, edge.curve);
  return isForward(h) ? curve.direction(edge.t0, 1) : curve.direction(edge.t1, -1);
}

/** The point a half-edge reaches after `length` along it from its origin. */
function along(arrangement: Arrangement, h: HalfEdge, length: number): Vec2 {
  const edge = edgeOf(arrangement, h);
  const { curve } = at(arrangement.curves, edge.curve);
  const start = curve.lengthTo(isForward(h) ? edge.t0 : edge.t1);
  return curve.point(curve.paramAt(isForward(h) ? start + length : start - length));
}

function halfEdgeLength(arrangement: Arrangement, h: HalfEdge): number {
  const edge = edgeOf(arrangement, h);
  return at(arrangement.curves, edge.curve).curve.spanLength(edge.t0, edge.t1);
}

const TANGENT_TIE = 1e-5;

/**
 * Sorts the half-edges leaving a vertex counter-clockwise. Those that leave
 * along one tangent are told apart a short way along: they have no vertex
 * before their ends, so they cannot change order on the way.
 */
function sortAround(arrangement: Arrangement, leavingEdges: HalfEdge[], at0: Vec2): HalfEdge[] {
  const items = leavingEdges.map((h) => {
    const [x, y] = leaving(arrangement, h);
    return { h, angle: mod(Math.atan2(y, x), TAU) };
  });
  items.sort((a, b) => a.angle - b.angle || a.h - b.h);
  if (items.length < 2) return items.map((i) => i.h);
  // Start after the widest gap so no tied group straddles the wrap.
  let widest = -1;
  let startAt = 0;
  for (let i = 0; i < items.length; i++) {
    const next = at(items, (i + 1) % items.length);
    const gap = mod(next.angle - at(items, i).angle, TAU);
    if (gap > widest) {
      widest = gap;
      startAt = (i + 1) % items.length;
    }
  }
  const rotated = [...items.slice(startAt), ...items.slice(0, startAt)];
  const out: HalfEdge[] = [];
  let i = 0;
  while (i < rotated.length) {
    let j = i + 1;
    while (j < rotated.length) {
      const gap = mod(at(rotated, j).angle - at(rotated, j - 1).angle, TAU);
      if (gap > TANGENT_TIE) break;
      j++;
    }
    const group = rotated.slice(i, j);
    if (group.length === 1) {
      out.push(at(group, 0).h);
    } else {
      const base = at(group, 0).angle;
      const reach = Math.min(...group.map((g) => halfEdgeLength(arrangement, g.h))) / 4;
      const swing = group.map((g) => {
        const p = along(arrangement, g.h, reach);
        const a = Math.atan2(p[1] - at0[1], p[0] - at0[0]);
        return { h: g.h, delta: mod(a - base + Math.PI, TAU) - Math.PI };
      });
      swing.sort((a, b) => a.delta - b.delta || a.h - b.h);
      for (const s of swing) out.push(s.h);
    }
    i = j;
  }
  return out;
}

function cycleArea(arrangement: Arrangement, halfEdges: readonly HalfEdge[]): number {
  let area = 0;
  for (const h of halfEdges) {
    const edge = edgeOf(arrangement, h);
    const term = at(arrangement.curves, edge.curve).curve.areaTerm(edge.t0, edge.t1, arrangement.origin);
    area += isForward(h) ? term : -term;
  }
  return area;
}

/** True when `b` carries straight on from `a` along the same stretch of the same key. */
function continues(arrangement: Arrangement, a: HalfEdge, b: HalfEdge): boolean {
  if (isForward(a) !== isForward(b)) return false;
  const ea = edgeOf(arrangement, a);
  const eb = edgeOf(arrangement, b);
  const la = at(arrangement.curves, ea.curve);
  const lb = at(arrangement.curves, eb.curve);
  if (la.keyText !== lb.keyText) return false;
  const forward = isForward(a);
  if (la === lb) {
    const count = la.edges.length;
    const [first, second] = forward ? [ea, eb] : [eb, ea];
    if (first.index + 1 === second.index) return true;
    return la.curve.closed && mod(first.index + 1, count) === second.index;
  }
  const [first, second] = forward ? [ea, eb] : [eb, ea];
  const [before, after] = forward ? [la, lb] : [lb, la];
  if (first.index !== before.edges.length - 1 || second.index !== 0) return false;
  const end = before.source.anchors;
  const start = after.source.anchors;
  return end.kind === 'points' && start.kind === 'points' && end.end === start.start;
}

/** Names a place on a curve: its own point, its own extremity, else the crossing with `neighbour`. */
function endAt(arrangement: Arrangement, inc: Incidence, neighbour: Incidence): UseEnd {
  if (inc.anchor !== null) return { point: { id: inc.anchor } };
  if (inc.extremity !== null) return { extremity: { which: inc.extremity } };
  const crossing = arrangement.crossingOf(inc, neighbour);
  if (!crossing) throw new RangeError('a boundary corner has no crossing to name it');
  const { sense, k, kWith } = crossing;
  return { cross: { with: at(arrangement.curves, neighbour.curve).source.key, sense, k, kWith } };
}

function bytesOfUse(use: Use): Uint8Array {
  return canonicalBytes(use);
}

const keyBytes = new WeakMap<CurveKey, Uint8Array>();

function bytesOfKey(key: CurveKey): Uint8Array {
  let bytes = keyBytes.get(key);
  if (!bytes) {
    bytes = canonicalBytes(key);
    keyBytes.set(key, bytes);
  }
  return bytes;
}

function keyOfUse(use: Use): CurveKey {
  return 'closed' in use ? use.closed.curve : use.open.curve;
}

function fromBytes(use: Use): Uint8Array {
  return 'closed' in use ? new Uint8Array() : canonicalBytes(use.open.from);
}

function compareSequences(a: readonly Use[], b: readonly Use[]): number {
  for (let i = 0; i < a.length; i++) {
    const order = compareBytes(bytesOfUse(at(a, i)), bytesOfUse(at(b, i)));
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Rotates a cycle to its canonical start: the use with the smallest curve, then
 * the smallest `from`; when a cycle meets that pair twice, the rotation whose
 * uses read smallest in order.
 */
export function canonicalStart(uses: readonly Use[]): Use[] {
  const smallest = (indices: readonly number[], bytes: (i: number) => Uint8Array): number[] => {
    let best: number[] = [];
    let bestBytes: Uint8Array | undefined;
    for (const i of indices) {
      const here = bytes(i);
      const order = bestBytes ? compareBytes(here, bestBytes) : -1;
      if (order < 0) {
        best = [i];
        bestBytes = here;
      } else if (order === 0) {
        best.push(i);
      }
    }
    return best;
  };
  const byCurve = smallest([...uses.keys()], (i) => bytesOfKey(keyOfUse(at(uses, i))));
  const byFrom = byCurve.length > 1 ? smallest(byCurve, (i) => fromBytes(at(uses, i))) : byCurve;
  const rotate = (i: number): Use[] => [...uses.slice(i), ...uses.slice(0, i)];
  return byFrom.map(rotate).reduce((a, b) => (compareSequences(b, a) < 0 ? b : a));
}

/** The maximal runs of a cycle along one stretch of one key, as uses in canonical order. */
function cycleUses(arrangement: Arrangement, cycle: readonly HalfEdge[]): Use[] {
  const n = cycle.length;
  let breakAt = -1;
  for (let i = 0; i < n; i++) {
    if (!continues(arrangement, at(cycle, mod(i - 1, n)), at(cycle, i))) {
      breakAt = i;
      break;
    }
  }
  if (breakAt < 0) {
    const live = liveOf(arrangement, at(cycle, 0));
    if (live.curve.closed) return [{ closed: { curve: live.source.key } }];
    // The live descendants of one root close up: start where one meets the next.
    breakAt = cycle.findIndex((h, i) => liveOf(arrangement, h) !== liveOf(arrangement, at(cycle, mod(i - 1, n))));
  }
  const walk = [...cycle.slice(breakAt), ...cycle.slice(0, breakAt)];
  const runs: HalfEdge[][] = [];
  for (const h of walk) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run && last !== undefined && continues(arrangement, last, h)) run.push(h);
    else runs.push([h]);
  }
  const uses = runs.map((run, i): Use => {
    const first = at(run, 0);
    const last = at(run, run.length - 1);
    const before = at(runs, mod(i - 1, runs.length));
    const after = at(runs, mod(i + 1, runs.length));
    const previous = targetOf(arrangement, at(before, before.length - 1));
    const next = originOf(arrangement, at(after, 0));
    return {
      open: {
        curve: liveOf(arrangement, first).source.key,
        from: endAt(arrangement, originOf(arrangement, first), previous),
        to: endAt(arrangement, targetOf(arrangement, last), next),
        reversed: !isForward(first),
      },
    };
  });
  return canonicalStart(uses);
}

/** Flattened boundary of a cycle, closed, at a density. */
export function cyclePolyline(arrangement: Arrangement, cycle: Cycle, factor: number): Vec2[] {
  const out: Vec2[] = [];
  for (const h of cycle.halfEdges) {
    const edge = edgeOf(arrangement, h);
    const { curve } = at(arrangement.curves, edge.curve);
    const chords = curve.flatten(edge.t0, edge.t1, factor);
    if (!isForward(h)) chords.reverse();
    for (let i = 0; i + 1 < chords.length; i++) out.push(at(chords, i));
  }
  const first = out[0];
  if (first) out.push(first);
  return out;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  const u = Math.min(1, Math.max(0, t));
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
}

/** Even-odd containment and boundary distance of `p` against a closed polygon. */
export function againstPolygon(
  p: Vec2,
  polygon: readonly Vec2[],
): { inside: boolean; distance: number; chord: number } {
  let inside = false;
  let nearest = Infinity;
  let chord = 0;
  for (let i = 1; i < polygon.length; i++) {
    const a = at(polygon, i - 1);
    const b = at(polygon, i);
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x > p[0]) inside = !inside;
    }
    const d = segmentDistance(p, a, b);
    if (d < nearest) {
      nearest = d;
      chord = distance(a, b);
    }
  }
  return { inside, distance: nearest, chord };
}

/**
 * Places `p` against a cycle, flattening finer while `p` sits so near a chord
 * that the chord's sag could decide the answer.
 */
export function locateInCycle(arrangement: Arrangement, cycle: Cycle, p: Vec2): { inside: boolean; distance: number } {
  let result = againstPolygon(p, cyclePolyline(arrangement, cycle, 1));
  for (let factor = 8; factor <= 512 && result.distance < 0.1 * result.chord; factor *= 8) {
    result = againstPolygon(p, cyclePolyline(arrangement, cycle, factor));
  }
  return result;
}

function cycleBounds(arrangement: Arrangement, cycle: Cycle): Bounds {
  return boundsOf(cyclePolyline(arrangement, cycle, 1));
}

/** True when `p` lies in the box, widened to cover what flattening cut off. */
function contains(b: Bounds, p: Vec2): boolean {
  const margin = 0.01 * (b.maxX - b.minX + b.maxY - b.minY);
  return p[0] >= b.minX - margin && p[0] <= b.maxX + margin && p[1] >= b.minY - margin && p[1] <= b.maxY + margin;
}

/** Uses in set order, without repeats, each with its canonical bytes. */
function sortedUses(uses: readonly Use[]): { use: Use; bytes: Uint8Array }[] {
  const entries = uses
    .map((use) => ({ use, bytes: canonicalBytes(use) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes));
  return entries.filter((entry, i) => i === 0 || compareBytes(at(entries, i - 1).bytes, entry.bytes) !== 0);
}

function compareUseLists(a: readonly Uint8Array[], b: readonly Uint8Array[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const order = compareBytes(at(a, i), at(b, i));
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

interface Face {
  cycle: Cycle;
  component: number;
  bounds?: Bounds;
  holes: Cycle[];
}

function perimeter(arrangement: Arrangement, halfEdges: readonly HalfEdge[]): number {
  return halfEdges.reduce((sum, h) => sum + halfEdgeLength(arrangement, h), 0);
}

/** Finds the regions of a solved sketch at shared points and crossings. */
export function detectRegions(sketch: SolvedSketch): Detection {
  const arrangement = buildArrangement(sketch);
  const { edges, vertices, tolerance } = arrangement;

  const standing: number[] = [];
  edges.forEach((edge, i) => {
    if (!edge.duplicate) standing.push(i);
  });
  const bridges = findBridges(edges, standing, vertices.length);
  const active = standing.filter((e) => !bridges.has(e));

  const out: HalfEdge[][] = Array.from({ length: vertices.length }, () => []);
  for (const e of active) {
    const edge = at(edges, e);
    at(out, edge.from.vertex).push(2 * e);
    at(out, edge.to.vertex).push(2 * e + 1);
  }

  // At each vertex a walk arriving by the twin of `around[k]` leaves by the
  // neighbour clockwise of it, which keeps the region on the walk's left.
  const next = new Map<HalfEdge, HalfEdge>();
  out.forEach((leavingHere, v) => {
    if (leavingHere.length === 0) return;
    const around = sortAround(arrangement, leavingHere, at(vertices, v));
    around.forEach((h, k) => {
      next.set(h ^ 1, at(around, mod(k - 1, around.length)));
    });
  });

  const parent = vertices.map((_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (at(parent, r) !== r) r = at(parent, r);
    parent[i] = r;
    return r;
  };
  for (const e of active) {
    const edge = at(edges, e);
    parent[root(edge.from.vertex)] = root(edge.to.vertex);
  }

  const faces: Face[] = [];
  const outerCycles: { cycle: Cycle; component: number; at: Vec2 }[] = [];
  const seen = new Set<HalfEdge>();
  for (const e of active) {
    for (const start of [2 * e, 2 * e + 1]) {
      if (seen.has(start)) continue;
      const walk: HalfEdge[] = [];
      let h = start;
      do {
        seen.add(h);
        walk.push(h);
        const step = next.get(h);
        if (step === undefined) throw new RangeError('boundary walk lost its way');
        h = step;
      } while (h !== start);
      const area = cycleArea(arrangement, walk);
      if (Math.abs(area) <= tolerance * perimeter(arrangement, walk)) continue;
      const cycle: Cycle = { halfEdges: walk, area };
      const component = root(originOf(arrangement, start).vertex);
      if (area > 0) {
        faces.push({ cycle, component, holes: [] });
      } else {
        const here = at(vertices, originOf(arrangement, start).vertex);
        outerCycles.push({ cycle, component, at: here });
      }
    }
  }

  if (new Set(faces.map((f) => f.component)).size + outerCycles.length > 1) {
    for (const outer of outerCycles) {
      let best: Face | undefined;
      for (const face of faces) {
        if (face.component === outer.component) continue;
        if (best && face.cycle.area >= best.cycle.area) continue;
        face.bounds ??= cycleBounds(arrangement, face.cycle);
        if (!contains(face.bounds, outer.at)) continue;
        if (locateInCycle(arrangement, face.cycle, outer.at).inside) best = face;
      }
      best?.holes.push(outer.cycle);
    }
  }

  const regions = faces.map((face) => {
    const loop = cycleUses(arrangement, face.cycle.halfEdges);
    const holeLoops = face.holes.map((hole) => cycleUses(arrangement, hole.halfEdges));
    const sorted = sortedUses([...loop, ...holeLoops.flat()]);
    const region: DetectedRegion = {
      loop,
      holes: holeLoops.length > 0 ? makeSet(holeLoops) : { set: [] },
      identity: { set: sorted.map((entry) => entry.use) },
      area: face.holes.reduce((sum, hole) => sum + hole.area, face.cycle.area),
      outer: face.cycle,
      inner: face.holes,
    };
    return { region, order: sorted.map((entry) => entry.bytes) };
  });
  regions.sort((a, b) => compareUseLists(a.order, b.order));
  return { arrangement, regions: regions.map((entry) => entry.region) };
}

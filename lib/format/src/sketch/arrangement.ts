import { canonicalBytes, canonicalize } from '../canonical';
import { compareBytes, FormatError } from '../collections';
import { at, distance, prepareCurve, type Curve } from './curves';
import { contactsBetween, selfContacts } from './intersect';
import type { CrossingSense, CurveKey, SolvedCurve, SolvedSketch, Vec2 } from './types';

/** A place on a live curve where it may stop: an end, a sketch point on it, or a contact. */
export interface Incidence {
  curve: number;
  t: number;
  /** Arc length from the curve's start. */
  s: number;
  vertex: number;
  /** The curve's own sketch point here. */
  anchor: string | null;
  /** The curve's own extremity here, when it is a defining external curve. */
  extremity: 'start' | 'end' | null;
}

/** One stretch of a live curve between neighbouring incidences, `t0 < t1`. */
export interface Edge {
  curve: number;
  /** Position among the edges of its curve. */
  index: number;
  from: Incidence;
  to: Incidence;
  t0: number;
  t1: number;
  /** The same stretch is already covered by a curve with a smaller key. */
  duplicate: boolean;
}

export interface LiveCurve {
  index: number;
  source: SolvedCurve;
  curve: Curve;
  keyText: string;
  incidences: Incidence[];
  edges: Edge[];
}

/** One crossing as seen from `on`, numbered among those of its sense with one key. */
export interface Crossing {
  on: Incidence;
  other: Incidence;
  sense: CrossingSense;
  /** Number along the curve of `on`. */
  k: number;
  /** Number along the curve of `other`; one place counts once. */
  kWith: number;
}

export interface Arrangement {
  curves: readonly LiveCurve[];
  /** Live curves of each key, in table order. */
  byKey: ReadonlyMap<string, readonly LiveCurve[]>;
  vertices: readonly Vec2[];
  edges: readonly Edge[];
  /** Distance below which two places are one. */
  tolerance: number;
  /** Centre of the sketch, where area integrals are taken. */
  origin: Vec2;
  /** The place on a key's live curves of the crossing numbered `k` and `kWith`, if one is. */
  crossing(key: string, withKey: string, sense: CrossingSense, k: number, kWith: number): Incidence | undefined;
  /** The sense and numbers of the crossing of one incidence with another at the same place. */
  crossingOf(on: Incidence, other: Incidence): Crossing | undefined;
}

const keyTexts = new WeakMap<CurveKey, string>();

/** The canonical form of a curve key: the text keys are compared and grouped by. */
export function keyText(key: CurveKey): string {
  let text = keyTexts.get(key);
  if (text === undefined) {
    text = canonicalize(key);
    keyTexts.set(key, text);
  }
  return text;
}

/** Distance tolerance for a sketch of the given extent. */
export function regionTolerance(extent: number): number {
  return 1e-6 + 1e-9 * extent;
}

function find(parent: number[], i: number): number {
  let root = i;
  while (at(parent, root) !== root) root = at(parent, root);
  let node = i;
  while (at(parent, node) !== root) {
    const next = at(parent, node);
    parent[node] = root;
    node = next;
  }
  return root;
}

function union(parent: number[], a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

interface RawIncidence {
  curve: number;
  t: number;
  p: Vec2;
  anchor: string | null;
  extremity: 'start' | 'end' | null;
}

function curveEnds(live: LiveCurve, raw: RawIncidence[]): void {
  const { curve, source, index } = live;
  const { anchors } = source;
  const add = (t: number, anchor: string | null, extremity: 'start' | 'end' | null): void => {
    raw.push({ curve: index, t, p: curve.point(t), anchor, extremity });
  };
  if (anchors.kind === 'points') {
    add(curve.tMin, anchors.start, null);
    if (!curve.closed) add(curve.tMax, anchors.end, null);
  } else if (!curve.closed) {
    if (anchors.kind === 'none') throw new FormatError('an open curve needs named ends');
    add(curve.tMin, null, 'start');
    add(curve.tMax, null, 'end');
  }
}

function throughPoints(live: LiveCurve, points: ReadonlyMap<string, Vec2>, tol: number, raw: RawIncidence[]): void {
  const { anchors } = live.source;
  if (anchors.kind !== 'points') return;
  for (const id of anchors.through ?? []) {
    const p = points.get(id);
    if (!p) continue;
    for (const hit of live.curve.closest(p)) {
      if (hit.distance <= tol) {
        raw.push({ curve: live.index, t: hit.t, p, anchor: id, extremity: null });
      }
    }
  }
}

/** Pairs of curves whose boxes overlap, by a sweep along x. */
function overlappingPairs(curves: readonly LiveCurve[], tol: number): [LiveCurve, LiveCurve][] {
  const sorted = [...curves].sort((a, b) => a.curve.bounds.minX - b.curve.bounds.minX);
  const pairs: [LiveCurve, LiveCurve][] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = at(sorted, i);
    for (let j = i + 1; j < sorted.length; j++) {
      const b = at(sorted, j);
      if (b.curve.bounds.minX > a.curve.bounds.maxX + tol) break;
      pairs.push(a.index < b.index ? [a, b] : [b, a]);
    }
  }
  return pairs.sort((x, y) => x[0].index - y[0].index || x[1].index - y[1].index);
}

/** Joins raw incidences that lie within `tol` of each other. */
function clusterNear(raw: readonly RawIncidence[], parent: number[], tol: number): void {
  const cell = 2 * tol;
  const grid = new Map<string, number[]>();
  raw.forEach((r, i) => {
    const cx = Math.floor(r.p[0] / cell);
    const cy = Math.floor(r.p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (distance(at(raw, j).p, r.p) <= tol) union(parent, i, j);
        }
      }
    }
    const home = `${cx},${cy}`;
    const list = grid.get(home);
    if (list) list.push(i);
    else grid.set(home, [i]);
  });
}

/** Sorts a curve's incidences along it and folds together those that are one place. */
function settleIncidences(live: LiveCurve, tol: number): void {
  const { curve } = live;
  const sorted = [...live.incidences].sort((a, b) => a.t - b.t);
  const out: Incidence[] = [];
  const absorb = (into: Incidence, other: Incidence): void => {
    into.anchor ??= other.anchor;
    into.extremity ??= other.extremity;
  };
  for (const inc of sorted) {
    const previous = out[out.length - 1];
    if (previous && previous.vertex === inc.vertex && inc.s - previous.s <= 4 * tol) {
      absorb(previous, inc);
    } else {
      out.push(inc);
    }
  }
  const head = out[0];
  const tail = out[out.length - 1];
  if (curve.closed && out.length > 1 && head && tail && head.vertex === tail.vertex) {
    if (curve.length - tail.s + head.s <= 4 * tol) {
      absorb(head, tail);
      out.pop();
    }
  }
  live.incidences = out;
}

function buildEdges(live: LiveCurve, edges: Edge[]): void {
  const { curve, incidences } = live;
  const count = incidences.length;
  const add = (from: Incidence, to: Incidence, t0: number, t1: number): void => {
    const edge: Edge = {
      curve: live.index,
      index: live.edges.length,
      from,
      to,
      t0,
      t1,
      duplicate: false,
    };
    live.edges.push(edge);
    edges.push(edge);
  };
  for (let i = 0; i + 1 < count; i++) {
    const from = at(incidences, i);
    const to = at(incidences, i + 1);
    add(from, to, from.t, to.t);
  }
  if (curve.closed) {
    const last = at(incidences, count - 1);
    const first = at(incidences, 0);
    add(last, first, last.t, first.t + curve.period);
  }
}

/**
 * Where two curves run along each other, keeps the stretch of the smaller key
 * only: a boundary is walked once.
 */
function markDuplicates(curves: readonly LiveCurve[], edges: readonly Edge[], tol: number): void {
  const byEnds = new Map<string, Edge[]>();
  for (const edge of edges) {
    const a = Math.min(edge.from.vertex, edge.to.vertex);
    const b = Math.max(edge.from.vertex, edge.to.vertex);
    const group = `${a},${b}`;
    const list = byEnds.get(group);
    if (list) list.push(edge);
    else byEnds.set(group, [edge]);
  }
  const midpoint = (edge: Edge): Vec2 => {
    const { curve } = at(curves, edge.curve);
    const start = curve.lengthTo(edge.t0);
    return curve.point(curve.paramAt(start + curve.spanLength(edge.t0, edge.t1) / 2));
  };
  const rank = (edge: Edge): Uint8Array => canonicalBytes(at(curves, edge.curve).source.key);
  for (const group of byEnds.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => compareBytes(rank(a), rank(b)) || a.curve - b.curve || a.index - b.index);
    const kept: { mid: Vec2 }[] = [];
    for (const edge of ordered) {
      const mid = midpoint(edge);
      if (kept.some((k) => distance(k.mid, mid) <= 4 * tol)) edge.duplicate = true;
      else kept.push({ mid });
    }
  }
}

/** Sines of the angle between tangents below this are a tangency. */
const TANGENT_SINE = 1e-5;

/** The sign of this curve's tangent × the other's at a crossing; 0 at a tangency. */
function crossingSense(curves: readonly LiveCurve[], on: Incidence, other: Incidence): CrossingSense {
  const a = at(curves, on.curve).curve.tangent(on.t);
  const b = at(curves, other.curve).curve.tangent(other.t);
  const cross = a[0] * b[1] - a[1] * b[0];
  if (Math.abs(cross) <= TANGENT_SINE) return 0;
  return cross > 0 ? 1 : -1;
}

function crossingRow(withKey: string, sense: CrossingSense): string {
  return `${sense}${withKey}`;
}

function byPlaceAlong(a: Incidence, b: Incidence): number {
  return a.curve - b.curve || a.t - b.t;
}

/** Numbers the crossings of one sense with one key along both curves. */
function numberCrossings(pairs: readonly { on: Incidence; other: Incidence; sense: CrossingSense }[]): Crossing[] {
  const ons = [...new Set(pairs.map((p) => p.on))].sort(byPlaceAlong);
  const others = [...new Set(pairs.map((p) => p.other))].sort(byPlaceAlong);
  const k = new Map(ons.map((on, i) => [on, i]));
  const places = new Map<number, number>();
  for (const other of others) {
    if (!places.has(other.vertex)) places.set(other.vertex, places.size);
  }
  return pairs.map((pair) => ({
    ...pair,
    k: k.get(pair.on) ?? 0,
    kWith: places.get(pair.other.vertex) ?? 0,
  }));
}

function crossingTable(curves: readonly LiveCurve[], vertexCount: number): Map<string, Map<string, Crossing[]>> {
  const atVertex: Incidence[][] = Array.from({ length: vertexCount }, () => []);
  for (const live of curves) {
    for (const inc of live.incidences) at(atVertex, inc.vertex).push(inc);
  }
  type Pair = { on: Incidence; other: Incidence; sense: CrossingSense };
  const table = new Map<string, Map<string, Pair[]>>();
  const note = (on: Incidence, other: Incidence): void => {
    const sense = crossingSense(curves, on, other);
    const key = at(curves, on.curve).keyText;
    const withKey = crossingRow(at(curves, other.curve).keyText, sense);
    let row = table.get(key);
    if (!row) table.set(key, (row = new Map()));
    const list = row.get(withKey);
    if (list) list.push({ on, other, sense });
    else row.set(withKey, [{ on, other, sense }]);
  };
  for (const group of atVertex) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = at(group, i);
        const b = at(group, j);
        if (a.anchor !== null && a.anchor === b.anchor) continue;
        note(a, b);
        note(b, a);
      }
    }
  }
  const numbered = new Map<string, Map<string, Crossing[]>>();
  for (const [key, row] of table) {
    const out = new Map<string, Crossing[]>();
    for (const [withKey, pairs] of row) out.set(withKey, numberCrossings(pairs));
    numbered.set(key, out);
  }
  return numbered;
}

/** Splits the solved curves at every shared point, crossing and touch. */
export function buildArrangement(sketch: SolvedSketch): Arrangement {
  const points = new Map<string, Vec2>(sketch.points.map((p) => [p.id, [p.x, p.y]]));
  const curves: LiveCurve[] = [];
  for (const source of sketch.curves) {
    const { anchors } = source;
    const curve = prepareCurve(source.shape, anchors.kind === 'points' && anchors.start === anchors.end);
    if (!curve) continue;
    curves.push({
      index: curves.length,
      source,
      curve,
      keyText: keyText(source.key),
      incidences: [],
      edges: [],
    });
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { curve } of curves) {
    minX = Math.min(minX, curve.bounds.minX);
    minY = Math.min(minY, curve.bounds.minY);
    maxX = Math.max(maxX, curve.bounds.maxX);
    maxY = Math.max(maxY, curve.bounds.maxY);
  }
  const extent = curves.length > 0 ? Math.hypot(maxX - minX, maxY - minY) : 0;
  const origin: Vec2 = curves.length > 0 ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0, 0];
  const tol = regionTolerance(extent);
  for (const live of curves) {
    const { curve, source } = live;
    if (curve.closed || source.shape.kind === 'line') continue;
    if (distance(curve.point(curve.tMin), curve.point(curve.tMax)) > tol) continue;
    live.curve = prepareCurve(source.shape, true) ?? curve;
  }
  const kept = curves.filter((live) => live.curve.length > tol);

  const raw: RawIncidence[] = [];
  const joined: [number, number][] = [];
  const addContact = (a: LiveCurve, b: LiveCurve, ta: number, tb: number): void => {
    const first = raw.length;
    raw.push({ curve: a.index, t: ta, p: a.curve.point(ta), anchor: null, extremity: null });
    raw.push({ curve: b.index, t: tb, p: b.curve.point(tb), anchor: null, extremity: null });
    joined.push([first, first + 1]);
  };
  for (const live of kept) {
    curveEnds(live, raw);
    throughPoints(live, points, tol, raw);
    for (const [s, t] of selfContacts(live.curve, tol)) addContact(live, live, s, t);
  }
  for (const [a, b] of overlappingPairs(kept, tol)) {
    for (const [s, t] of contactsBetween(a.curve, b.curve, tol)) addContact(a, b, s, t);
  }
  const touched = new Set(raw.map((r) => r.curve));
  for (const live of kept) {
    if (touched.has(live.index)) continue;
    const t = live.curve.tMin;
    raw.push({ curve: live.index, t, p: live.curve.point(t), anchor: null, extremity: null });
  }

  const parent = raw.map((_, i) => i);
  for (const [a, b] of joined) union(parent, a, b);
  clusterNear(raw, parent, tol);
  const vertexOf = new Map<number, number>();
  const vertices: Vec2[] = [];
  raw.forEach((r, i) => {
    const root = find(parent, i);
    if (!vertexOf.has(root)) {
      vertexOf.set(root, vertices.length);
      vertices.push(r.p);
    }
    const live = at(curves, r.curve);
    const t = live.curve.wrap(r.t);
    live.incidences.push({
      curve: r.curve,
      t,
      s: live.curve.lengthTo(t),
      vertex: vertexOf.get(root) ?? 0,
      anchor: r.anchor,
      extremity: r.extremity,
    });
  });

  const edges: Edge[] = [];
  for (const live of kept) {
    settleIncidences(live, tol);
    buildEdges(live, edges);
  }
  markDuplicates(curves, edges, tol);

  const byKey = new Map<string, LiveCurve[]>();
  for (const live of kept) {
    const list = byKey.get(live.keyText);
    if (list) list.push(live);
    else byKey.set(live.keyText, [live]);
  }
  const table = crossingTable(curves, vertices.length);
  return {
    curves,
    byKey,
    vertices,
    edges,
    tolerance: tol,
    origin,
    crossing: (key, withKey, sense, k, kWith) =>
      table
        .get(key)
        ?.get(crossingRow(withKey, sense))
        ?.find((c) => c.k === k && c.kWith === kWith)?.on,
    crossingOf: (on, other) => {
      const sense = crossingSense(curves, on, other);
      const key = at(curves, on.curve).keyText;
      const withKey = at(curves, other.curve).keyText;
      const row = table.get(key)?.get(crossingRow(withKey, sense));
      return row?.find((c) => c.on === on && c.other === other);
    },
  };
}

import type { Arrangement, LiveCurve } from './arrangement';
import { keyText } from './arrangement';
import { at } from './curves';
import type { DetectedRegion } from './detect';
import type { CurveKey, Loop, Use, UseEnd } from './types';

export type Role = 'outer' | 'hole';

/** Part of one live curve, as arc lengths in its own direction, `s0 < s1`. */
export interface Interval {
  curve: number;
  s0: number;
  s1: number;
}

/** A use laid on the current geometry. */
export interface Stretch {
  key: string;
  role: Role;
  /** Runs against the curve's direction. */
  reversed: boolean;
  intervals: readonly Interval[];
  length: number;
}

interface Location {
  curve: number;
  s: number;
}

function locate(arrangement: Arrangement, key: string, end: UseEnd): Location[] {
  const group = arrangement.byKey.get(key) ?? [];
  if ('cross' in end) {
    const { sense, k, kWith } = end.cross;
    const hit = arrangement.crossing(key, keyText(end.cross.with), sense, k, kWith);
    return hit ? [{ curve: hit.curve, s: hit.s }] : [];
  }
  if ('extremity' in end) {
    const live = group.find((g) => g.source.anchors.kind === 'extremities');
    if (!live) return [];
    return [{ curve: live.index, s: end.extremity.which === 'start' ? 0 : live.curve.length }];
  }
  return locatePoint(group, end.point.id);
}

/** Where a sketch point lies on the live curves that own it; a point not theirs does not exist. */
function locatePoint(group: readonly LiveCurve[], id: string): Location[] {
  const found: Location[] = [];
  for (const live of group) {
    const { anchors } = live.source;
    if (anchors.kind === 'points') {
      if (anchors.start === id) found.push({ curve: live.index, s: 0 });
      if (anchors.end === id) {
        found.push({ curve: live.index, s: live.curve.closed ? 0 : live.curve.length });
      }
    }
    for (const inc of live.incidences) {
      if (inc.anchor === id) found.push({ curve: live.index, s: inc.s });
    }
  }
  return found;
}

/** The live curve of the group that carries on from where `live` ends, sharing its end point. */
function successor(group: readonly LiveCurve[], live: LiveCurve): LiveCurve | undefined {
  const { anchors } = live.source;
  if (anchors.kind !== 'points' || live.curve.closed) return undefined;
  return group.find((g) => {
    const a = g.source.anchors;
    return g !== live && a.kind === 'points' && a.start === anchors.end;
  });
}

/** Forward intervals from `a` to `b` along the key's live curves; null if `b` is not reached. */
function forwardBetween(
  arrangement: Arrangement,
  group: readonly LiveCurve[],
  a: Location,
  b: Location,
): Interval[] | null {
  const tol = arrangement.tolerance;
  const live = at(arrangement.curves, a.curve);
  if (a.curve === b.curve) {
    const { length, closed } = live.curve;
    if (!closed) return b.s - a.s > tol ? [{ curve: a.curve, s0: a.s, s1: b.s }] : null;
    if (Math.abs(a.s - b.s) <= tol) return [{ curve: a.curve, s0: 0, s1: length }];
    if (a.s < b.s) return [{ curve: a.curve, s0: a.s, s1: b.s }];
    return [
      { curve: a.curve, s0: a.s, s1: length },
      { curve: a.curve, s0: 0, s1: b.s },
    ];
  }
  const out: Interval[] = [{ curve: a.curve, s0: a.s, s1: live.curve.length }];
  const visited = new Set([live]);
  let current = successor(group, live);
  while (current && !visited.has(current)) {
    if (current.index === b.curve) {
      out.push({ curve: b.curve, s0: 0, s1: b.s });
      return out;
    }
    out.push({ curve: current.index, s0: 0, s1: current.curve.length });
    visited.add(current);
    current = successor(group, current);
  }
  return null;
}

/** Winding of a closed use: true when it runs against the curve's direction. */
function closedReversed(arrangement: Arrangement, group: readonly LiveCurve[], role: Role): boolean {
  let area = 0;
  for (const live of group) {
    area += live.curve.areaTerm(live.curve.tMin, live.curve.tMax, arrangement.origin);
  }
  const counterClockwise = area > 0;
  return role === 'outer' ? !counterClockwise : counterClockwise;
}

/**
 * Lays a use on the current geometry: the parameters where its ends lie in this
 * solve, on the live curves of its key. Null when an end does not exist.
 */
export function layUse(arrangement: Arrangement, use: Use, role: Role): Stretch | null {
  if ('closed' in use) {
    const key = keyText(use.closed.curve);
    const group = arrangement.byKey.get(key);
    if (!group) return null;
    const intervals = group.map((g) => ({ curve: g.index, s0: 0, s1: g.curve.length }));
    return measured(key, role, closedReversed(arrangement, group, role), intervals);
  }
  const { curve, from, to, reversed } = use.open;
  const key = keyText(curve);
  const group = arrangement.byKey.get(key);
  if (!group) return null;
  const starts = locate(arrangement, key, reversed ? to : from);
  const stops = locate(arrangement, key, reversed ? from : to);
  const pairs = starts
    .flatMap((a) => stops.map((b) => ({ a, b })))
    .sort((x, y) => Number(x.a.curve !== x.b.curve) - Number(y.a.curve !== y.b.curve));
  for (const { a, b } of pairs) {
    const intervals = forwardBetween(arrangement, group, a, b);
    if (intervals) return measured(key, role, reversed, intervals);
  }
  return null;
}

function measured(key: string, role: Role, reversed: boolean, intervals: readonly Interval[]): Stretch {
  const length = intervals.reduce((sum, i) => sum + i.s1 - i.s0, 0);
  return { key, role, reversed, intervals, length };
}

/** One half-edge of a detected boundary as a stretch: geometry, with no ends to look up. */
export function halfEdgeStretch(arrangement: Arrangement, h: number, role: Role): Stretch {
  const { curve, from, to } = at(arrangement.edges, h >> 1);
  const { keyText: key, curve: shape } = at(arrangement.curves, curve);
  const intervals =
    to.s > from.s
      ? [{ curve, s0: from.s, s1: to.s }]
      : [
          { curve, s0: from.s, s1: shape.length },
          { curve, s0: 0, s1: to.s },
        ].filter((i) => i.s1 > i.s0);
  return measured(key, role, (h & 1) === 1, intervals);
}

/** A detected region's boundary as it lies in this solve. */
export function layDetected(arrangement: Arrangement, region: DetectedRegion): { stretches: Stretch[] } {
  const stretches = region.outer.halfEdges.map((h) => halfEdgeStretch(arrangement, h, 'outer'));
  for (const hole of region.inner) {
    for (const h of hole.halfEdges) stretches.push(halfEdgeStretch(arrangement, h, 'hole'));
  }
  return { stretches };
}

/** Stretches of a stored region's boundary that exist in the current solve. */
export function layRegion(
  arrangement: Arrangement,
  loop: Loop,
  holes: readonly Loop[],
): { stretches: Stretch[]; length: number } {
  const stretches: Stretch[] = [];
  const lay = (cycle: Loop, role: Role): void => {
    for (const use of cycle) {
      const stretch = layUse(arrangement, use, role);
      if (stretch) stretches.push(stretch);
    }
  };
  lay(loop, 'outer');
  for (const hole of holes) lay(hole, 'hole');
  return { stretches, length: stretches.reduce((sum, s) => sum + s.length, 0) };
}

/** Length two lists of intervals have in common. */
export function overlapLength(a: readonly Interval[], b: readonly Interval[]): number {
  let sum = 0;
  for (const x of a) {
    for (const y of b) {
      if (x.curve !== y.curve) continue;
      const shared = Math.min(x.s1, y.s1) - Math.max(x.s0, y.s0);
      if (shared > 0) sum += shared;
    }
  }
  return sum;
}

export function curveKeyOf(arrangement: Arrangement, key: string): CurveKey {
  const live = arrangement.byKey.get(key);
  if (!live) throw new RangeError('no live curve has this key');
  return at(live, 0).source.key;
}

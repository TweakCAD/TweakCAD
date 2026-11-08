import { canonicalBytes } from '../canonical';
import { compareBytes, type JsonSet } from '../collections';
import { keyText, type Arrangement } from './arrangement';
import { at } from './curves';
import type { Cycle, DetectedRegion, Detection } from './detect';
import { regionSamplePoint, sideOfKey } from './sides';
import {
  curveKeyOf,
  halfEdgeStretch,
  layDetected,
  layRegion,
  overlapLength,
  type Interval,
  type Stretch,
} from './stretches';
import type { CurveKey, RegionRow, Use } from './types';

/** Lengths closer than this share of the larger are a tie. */
const TIE = 1e-9;

/**
 * What a tie for the most shared length does: at a solve no stored region keeps
 * the detected region, and all the tied ones resolve to nothing; a fate command
 * must write one winner, the earliest in the table.
 */
type TieRule = 'nothing' | 'earliest';

/** The sign of a piece's sample point against one dividing curve. */
export interface SideSign {
  curve: CurveKey;
  sign: 1 | -1;
}

/** A detected region that is a piece of a divided stored region. */
export interface RegionPiece {
  region: DetectedRegion;
  /** Signs against the dividing curves the piece touches, sorted by canonical key. */
  sides: readonly SideSign[];
  /** The curves that divide the stored region along this piece, sorted by canonical key. */
  dividers: readonly CurveKey[];
  /** The piece's sides cannot be told, so its feature pauses. */
  paused: boolean;
}

export interface RegionMatching {
  /** Stored regions matched by exactly one detected region. */
  kept: readonly { id: string; region: DetectedRegion }[];
  /** Stored regions matched by several detected regions, islands in a new hole included. */
  divided: readonly { id: string; pieces: readonly RegionPiece[] }[];
  /** Detected regions matched by none: identified by the sorted set of their uses. */
  new: readonly { identity: JsonSet<Use>; region: DetectedRegion }[];
  /** Stored regions no detected region matches or that tied: they resolve to nothing. */
  unmatched: readonly string[];
  /** For each detected region (by index), the length shared with each stored row (by index). */
  shared: readonly ReadonlyMap<number, number>[];
}

/** True when `a` is larger than `b` by more than a tie. */
export function isLarger(a: number, b: number): boolean {
  return a - b > TIE * Math.max(a, b);
}

function bucketOf(s: Stretch, interval: Interval): string {
  return `${s.role}|${s.reversed}|${interval.curve}`;
}

/** Pairs each detected region with the stored rows it shares boundary with. */
function shareLengths(
  arrangement: Arrangement,
  detected: readonly { stretches: readonly Stretch[] }[],
  stored: readonly { stretches: readonly Stretch[] }[],
): Map<number, number>[] {
  const buckets = new Map<string, { row: number; interval: Interval }[]>();
  stored.forEach((row, index) => {
    for (const s of row.stretches) {
      for (const interval of s.intervals) {
        const key = bucketOf(s, interval);
        const list = buckets.get(key);
        if (list) list.push({ row: index, interval });
        else buckets.set(key, [{ row: index, interval }]);
      }
    }
  });
  return detected.map((region) => {
    const shares = new Map<number, number>();
    for (const s of region.stretches) {
      for (const interval of s.intervals) {
        for (const entry of buckets.get(bucketOf(s, interval)) ?? []) {
          const length = overlapLength([interval], [entry.interval]);
          if (length > 0) shares.set(entry.row, (shares.get(entry.row) ?? 0) + length);
        }
      }
    }
    for (const [row, length] of shares) {
      if (length <= arrangement.tolerance) shares.delete(row);
    }
    return shares;
  });
}

/** The stored rows sharing the most length with a detected region, in table order. */
function leadingRows(shares: ReadonlyMap<number, number>): number[] {
  const top = Math.max(0, ...shares.values());
  return [...shares]
    .filter(([, length]) => !isLarger(top, length))
    .map(([row]) => row)
    .sort((a, b) => a - b);
}

/** The stored row each detected region matches, or null. */
function assignRows(shared: readonly ReadonlyMap<number, number>[], ties: TieRule): (number | null)[] {
  const leaders = shared.map(leadingRows);
  const tied = new Set(ties === 'nothing' ? leaders.filter((l) => l.length > 1).flat() : []);
  return leaders.map((rows) => {
    const [first] = rows;
    if (first === undefined) return null;
    if (ties === 'earliest') return first;
    return rows.length === 1 && !tied.has(first) ? first : null;
  });
}

/** True when the hole's boundary runs along a hole of the stored region. */
function hadHole(arrangement: Arrangement, hole: Cycle, stored: readonly Stretch[]): boolean {
  return hole.halfEdges.some((h) => {
    const s = halfEdgeStretch(arrangement, h, 'hole');
    return stored.some(
      (p) =>
        p.role === 'hole' &&
        p.key === s.key &&
        p.reversed === s.reversed &&
        overlapLength(s.intervals, p.intervals) > arrangement.tolerance,
    );
  });
}

/** Every detected region inside a hole of `host`, those in holes of those included. */
function regionsInside(
  regions: readonly DetectedRegion[],
  owners: ReadonlyMap<number, number>,
  host: number,
  hole: Cycle,
): number[] {
  const seen = new Set([host]);
  const found: number[] = [];
  const queue = [...hole.halfEdges];
  for (let h = queue.pop(); h !== undefined; h = queue.pop()) {
    const owner = owners.get(h ^ 1);
    if (owner === undefined || seen.has(owner)) continue;
    seen.add(owner);
    found.push(owner);
    const region = at(regions, owner);
    for (const cycle of [region.outer, ...region.inner]) queue.push(...cycle.halfEdges);
  }
  return found;
}

/**
 * Gives islands to the stored region around them: detected regions sharing no
 * length with any stored region that together fill a hole of a matched detected
 * region, a hole the stored region did not have.
 */
function assignIslands(
  arrangement: Arrangement,
  regions: readonly DetectedRegion[],
  rows: (number | null)[],
  shared: readonly ReadonlyMap<number, number>[],
  laidStored: readonly { stretches: readonly Stretch[] }[],
): void {
  const owners = new Map<number, number>();
  regions.forEach((region, index) => {
    for (const cycle of [region.outer, ...region.inner]) {
      for (const h of cycle.halfEdges) owners.set(h, index);
    }
  });
  regions.forEach((region, host) => {
    const row = at(rows, host);
    if (row === null) return;
    for (const hole of region.inner) {
      const inside = regionsInside(regions, owners, host, hole);
      if (inside.some((i) => at(rows, i) !== null || at(shared, i).size > 0)) continue;
      if (hadHole(arrangement, hole, at(laidStored, row).stretches)) continue;
      for (const i of inside) rows[i] = row;
    }
  });
}

function sortedKeys(keys: Iterable<string>, arrangement: Arrangement): CurveKey[] {
  return [...keys]
    .map((key) => curveKeyOf(arrangement, key))
    .sort((a, b) => compareBytes(canonicalBytes(a), canonicalBytes(b)));
}

/** The keys along which a piece's boundary runs inside the stored region it came from. */
function dividingKeys(arrangement: Arrangement, piece: readonly Stretch[], parent: readonly Stretch[]): Set<string> {
  const keys = new Set<string>();
  for (const s of piece) {
    const onParent = parent
      .filter((p) => p.key === s.key && p.reversed === s.reversed)
      .reduce((sum, p) => sum + overlapLength(s.intervals, p.intervals), 0);
    if (s.length - onParent > arrangement.tolerance) keys.add(s.key);
  }
  return keys;
}

function namePiece(
  arrangement: Arrangement,
  region: DetectedRegion,
  stretches: readonly Stretch[],
  parent: readonly Stretch[],
): RegionPiece {
  const keys = dividingKeys(arrangement, stretches, parent);
  const dividers = sortedKeys(keys, arrangement);
  const sample = regionSamplePoint(arrangement, region);
  const sides: SideSign[] = [];
  let paused = sample === null;
  if (sample) {
    for (const curve of dividers) {
      const sign = sideOfKey(arrangement, keyText(curve), sample);
      if (sign === null) paused = true;
      else sides.push({ curve, sign });
    }
  }
  return { region, sides, dividers, paused };
}

function layAll(
  arrangement: Arrangement,
  rows: readonly { loop: readonly Use[]; holes: JsonSet<readonly Use[]> }[],
): { stretches: Stretch[]; length: number }[] {
  return rows.map((row) => layRegion(arrangement, row.loop, row.holes.set));
}

function assignRegions(detection: Detection, stored: readonly RegionRow[], ties: TieRule): RegionMatching {
  const { arrangement, regions } = detection;
  const laidStored = layAll(arrangement, stored);
  const laidDetected = regions.map((region) => layDetected(arrangement, region));
  const shared = shareLengths(arrangement, laidDetected, laidStored);
  const rows = assignRows(shared, ties);
  assignIslands(arrangement, regions, rows, shared, laidStored);

  const byRow = new Map<number, number[]>();
  const fresh: { identity: JsonSet<Use>; region: DetectedRegion }[] = [];
  regions.forEach((region, index) => {
    const row = at(rows, index);
    if (row === null) {
      fresh.push({ identity: region.identity, region });
      return;
    }
    const list = byRow.get(row);
    if (list) list.push(index);
    else byRow.set(row, [index]);
  });

  const kept: { id: string; region: DetectedRegion }[] = [];
  const divided: { id: string; pieces: RegionPiece[] }[] = [];
  const unmatched: string[] = [];
  stored.forEach((row, index) => {
    const matched = byRow.get(index);
    if (!matched) {
      unmatched.push(row.id);
    } else if (matched.length === 1) {
      kept.push({ id: row.id, region: at(regions, at(matched, 0)) });
    } else {
      const parent = at(laidStored, index).stretches;
      const pieces = matched.map((d) => namePiece(arrangement, at(regions, d), at(laidDetected, d).stretches, parent));
      divided.push({ id: row.id, pieces });
    }
  });
  return { kept, divided, new: fresh, unmatched, shared };
}

/**
 * Matches detected regions to the stored table by shared boundary, the one rule
 * every solve applies. Reads the table and writes nothing.
 */
export function matchRegions(detection: Detection, stored: readonly RegionRow[]): RegionMatching {
  return assignRegions(detection, stored, 'nothing');
}

/** The same rule for a fate command, which must name a winner where lengths tie. */
export function matchForFates(detection: Detection, stored: readonly RegionRow[]): RegionMatching {
  return assignRegions(detection, stored, 'earliest');
}

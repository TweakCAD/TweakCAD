import { newId } from '../ids';
import { keyText } from './arrangement';
import type { DetectedRegion, Detection } from './detect';
import { isLarger, matchForFates, type RegionMatching } from './match';
import type { CurveKey, RegionFields, RegionRow, RegionTable, RetiredRow, Use } from './types';

export interface FateOptions {
  /** Keys of the boundary curves the command added, removed or retired. */
  commandCurves: readonly CurveKey[];
  /** Source of new region ids. */
  newRegionId?: () => string;
}

function keyOfUse(use: Use): string {
  return keyText('closed' in use ? use.closed.curve : use.open.curve);
}

function usesOf(fields: Pick<RegionFields, 'loop' | 'holes'>): Use[] {
  return [...fields.loop, ...fields.holes.set.flat()];
}

function touches(fields: Pick<RegionFields, 'loop' | 'holes'>, keys: ReadonlySet<string>): boolean {
  return usesOf(fields).some((use) => keys.has(keyOfUse(use)));
}

/** A retired row keeps the region as it was, extensions and unknown fields too, without its `id` (8, 18). */
function retire(row: RegionRow, fate: RetiredRow['fate']): RetiredRow {
  const { id, ...region } = row;
  return { id, was: { region }, fate };
}

/** The detected region sharing most length with a stored row, the first in order on a tie. */
function largestHeir(matching: RegionMatching, row: number): number | null {
  let best: number | null = null;
  let bestShare = 0;
  matching.shared.forEach((shares, detected) => {
    const share = shares.get(row) ?? 0;
    if (share > 0 && isLarger(share, bestShare)) {
      best = detected;
      bestShare = share;
    }
  });
  return best;
}

/**
 * The fates of one command that adds, removes or retires boundary curves: a
 * pure function from the old table and the detection after the command to the
 * new table. A divide or merge the command's curves take no part in stays
 * unwritten, like one a value or configuration produced.
 *
 * - a stored region divided along one of the command's curves is retired
 *   (`split`) and its pieces take its place in the table, in detection order,
 *   with new ids;
 * - a stored region left unmatched that has one of the command's curves on its
 *   boundary is retired `merged` into the region holding most of its boundary,
 *   or `deleted` when none does; where shared lengths tie, the earliest in the
 *   table keeps its id;
 * - a kept region whose boundary carries one of the command's curves takes the
 *   newly detected boundary. Detected regions matched by none are not written.
 */
export function writeRegionFates(table: RegionTable, detection: Detection, options: FateOptions): RegionTable {
  const makeId = options.newRegionId ?? ((): string => newId('reg'));
  const commandKeys = new Set(options.commandCurves.map(keyText));
  const matching = matchForFates(detection, table.regions);
  const regionIndex = new Map(detection.regions.map((region, i) => [region, i]));

  const landed = new Map<number, string>();
  const replaced = new Map<string, RegionRow[]>();
  const retired: RetiredRow[] = [];
  const kept = new Map(matching.kept.map((k) => [k.id, k.region]));
  const rowsById = new Map(table.regions.map((row) => [row.id, row]));

  for (const { id, region } of matching.kept) {
    landed.set(regionIndex.get(region) ?? -1, id);
  }
  for (const { id, pieces } of matching.divided) {
    const row = rowsById.get(id);
    if (!row) continue;
    const byCommand = pieces.some((piece) => piece.dividers.some((key) => commandKeys.has(keyText(key))));
    if (!byCommand) {
      for (const piece of pieces) landed.set(regionIndex.get(piece.region) ?? -1, id);
      continue;
    }
    const rows = pieces.map((piece): RegionRow => {
      const pieceId = makeId();
      landed.set(regionIndex.get(piece.region) ?? -1, pieceId);
      return {
        id: pieceId,
        loop: piece.region.loop,
        holes: piece.region.holes,
        origin: { from: { id } },
      };
    });
    replaced.set(id, rows);
    retired.push(retire(row, { split: {} }));
  }

  const gone = new Set<string>();
  for (const id of matching.unmatched) {
    const row = rowsById.get(id);
    if (!row || !touches(row, commandKeys)) continue;
    const index = table.regions.indexOf(row);
    const heir = largestHeir(matching, index);
    const into = heir === null ? undefined : landed.get(heir);
    retired.push(retire(row, into === undefined ? { deleted: {} } : { merged: { into: { id: into } } }));
    gone.add(id);
  }

  const regions: RegionRow[] = [];
  for (const row of table.regions) {
    if (gone.has(row.id)) continue;
    const pieces = replaced.get(row.id);
    if (pieces) {
      regions.push(...pieces);
      continue;
    }
    const region = kept.get(row.id);
    const refresh = region && (touches(row, commandKeys) || touches(region, commandKeys));
    regions.push(refresh ? { ...row, loop: region.loop, holes: region.holes } : row);
  }
  return { regions, retired: [...table.retired, ...retired] };
}

/** Writes a picked detected region into the table: the editor's command for a new region. */
export function writePickedRegion(table: RegionTable, region: DetectedRegion, id: string = newId('reg')): RegionTable {
  const row: RegionRow = { id, loop: region.loop, holes: region.holes, origin: { detected: {} } };
  return { regions: [...table.regions, row], retired: table.retired };
}

/**
 * What a region id resolves to in this build, following lineage without asking:
 * a kept region is its detected region, a divided region all its pieces, a split
 * all its live descendants, a merge the region it merged into. Empty when it
 * resolves to nothing.
 */
export function resolveRegion(id: string, table: RegionTable, matching: RegionMatching): DetectedRegion[] {
  const seen = new Set<string>();
  const walk = (current: string): DetectedRegion[] => {
    if (seen.has(current)) return [];
    seen.add(current);
    const kept = matching.kept.find((k) => k.id === current);
    if (kept) return [kept.region];
    const divided = matching.divided.find((d) => d.id === current);
    if (divided) return divided.pieces.map((p) => p.region);
    const retired = table.retired.find((r) => r.id === current && 'region' in r.was);
    if (!retired) return [];
    if ('merged' in retired.fate) return walk(retired.fate.merged.into.id);
    if ('deleted' in retired.fate) return [];
    const children = [...table.regions, ...retiredRegionRows(table)]
      .filter((row) => 'from' in row.origin && row.origin.from.id === current)
      .map((row) => row.id);
    return children.flatMap(walk);
  };
  return walk(id);
}

function retiredRegionRows(table: RegionTable): RegionRow[] {
  const rows: RegionRow[] = [];
  for (const r of table.retired) {
    if ('region' in r.was) rows.push({ id: r.id, ...r.was.region });
  }
  return rows;
}

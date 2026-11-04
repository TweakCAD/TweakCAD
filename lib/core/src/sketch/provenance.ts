/**
 * Names for what a sketch profile is made of, independent of how the sketch
 * happens to be laid out: which piece of which entity a boundary segment is,
 * and which region a profile is. The kernel names the faces a sketch-driven
 * operation creates from these (`occtKernel.ts`, extrude and revolve), so an
 * edit elsewhere in the sketch renames nothing it did not change.
 */

import type { SketchRegion, SketchRegionSegment } from './profileRegions.ts';

/** The segment's identity: its entity id, or the piece of the entity it is. */
export function segmentIdentity(segment: SketchRegionSegment): string {
  return segment.identity ?? String(segment.entityId);
}

/**
 * The region's identity, as a digest of {@link regionIdentity}. Holes are left
 * out, so punching one does not rename the region.
 */
export function regionKey(region: SketchRegion, regions: readonly SketchRegion[]): string {
  return fnv1a64(regionIdentity(region, regions).join('\0'));
}

/**
 * What the region is: the sorted set of entities on its outer boundary.
 * Trimming, moving a crossing or adding a profile elsewhere leaves that set
 * alone. When another region of the sketch has the same entities (the two
 * halves of a circle cut by a line), the set of boundary segment identities
 * tells them apart: a segment bounds at most one region on each side, so no
 * two regions share it.
 */
export function regionIdentity(region: SketchRegion, regions: readonly SketchRegion[]): string[] {
  const entities = entitySet(region);
  const twin = regions.some(other => other !== region && other.id !== region.id && sameSet(entitySet(other), entities));
  if (!twin) return ['region/v1/entities', ...entities];
  return ['region/v1/segments', ...[...new Set(region.segments.map(segmentIdentity))].sort()];
}

function entitySet(region: SketchRegion): string[] {
  return [...new Set(region.segments.map(s => String(s.entityId)))].sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

/** 64-bit FNV-1a over the string's UTF-8 bytes, as 16 hex digits. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Sketch regions as extrude profiles: which region a display key names, the
 * profile it makes, and back from a profile to the key it shows under.
 */
import type { Doc, Json } from '@tweakcad/editor';
import type { Display, Key, SketchDisplay, SketchRegionDisplay } from '@tweakcad/worker/src/v2/service/types';
import { isPickedRegion, regionReference } from '../picking';
import type { AppServices } from '../services';
import { regionRowOf, type ExtrudeProfile } from './extrude';
import { at, type NewRegion } from './feature';

/** The sketches a part shows. */
export function sketchesOf(display: Display | null, part: string): SketchDisplay[] {
  const index = display?.parts[part];
  return (index === undefined ? undefined : display?.definitions[index])?.sketches ?? [];
}

/** The region a key names in a part's display, with its sketch. */
export function regionAt(
  display: Display | null,
  part: string,
  key: Key,
): { sketch: SketchDisplay; region: SketchRegionDisplay } | null {
  for (const sketch of sketchesOf(display, part)) {
    const region = sketch.regions.find((r) => r.key === key);
    if (region) return { sketch, region };
  }
  return null;
}

/** A closed polyline of the part frame (XYZ per point) in the sketch frame's coordinates. */
function inFrame(sketch: SketchDisplay, loop: Float32Array): [number, number][] {
  const { origin, x, y } = sketch.frame;
  const out: [number, number][] = [];
  for (let i = 0; i + 2 < loop.length; i += 3) {
    const dx = (loop[i] as number) - origin[0];
    const dy = (loop[i + 1] as number) - origin[1];
    const dz = (loop[i + 2] as number) - origin[2];
    out.push([dx * x[0] + dy * x[1] + dz * x[2], dx * y[0] + dy * y[1] + dz * y[2]]);
  }
  return out;
}

function inside(p: readonly [number, number], polygon: readonly [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j] as [number, number];
    const b = polygon[i] as [number, number];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) hit = !hit;
  }
  return hit;
}

function area(polygon: readonly [number, number][]): number {
  let s = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j] as [number, number];
    const b = polygon[i] as [number, number];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/**
 * The keys of a sketch's shown regions holding `points` (sketch-frame
 * coordinates): for each point the smallest region whose outer loop holds it
 * and whose holes do not.
 */
export function regionKeysAt(
  display: Display | null,
  part: string,
  feature: string,
  points: readonly (readonly [number, number])[],
): Key[] {
  const sketch = sketchesOf(display, part).find((s) => s.feature === feature);
  if (!sketch) return [];
  const shapes = sketch.regions.map((r) => ({ key: r.key, loops: r.loops.map((l) => inFrame(sketch, l)) }));
  const keys: Key[] = [];
  for (const p of points) {
    let best: { key: Key; area: number } | null = null;
    for (const s of shapes) {
      const [outer, ...holes] = s.loops;
      if (!outer || !inside(p, outer) || holes.some((h) => inside(p, h))) continue;
      const a = area(outer);
      if (!best || a < best.area) best = { key: s.key, area: a };
    }
    if (best && !keys.includes(best.key)) keys.push(best.key);
  }
  return keys;
}

/** The key a region-row profile shows under, or null when the display does not show its row. */
export function profileKey(display: Display | null, part: string, profile: ExtrudeProfile): Key | null {
  if ('kept' in profile) return null;
  const sketch = sketchesOf(display, part).find((s) => s.feature === profile.sketch);
  return sketch?.regions.find((r) => r.row === profile.row)?.key ?? null;
}

/**
 * The profile a region key makes: its region row, or for a detected region
 * no row holds yet, its loops and the id its row will take. Null when the
 * key is not a region or the display is gone.
 */
export async function profileOf(services: AppServices, part: string, key: Key): Promise<ExtrudeProfile | null> {
  const found = regionAt(services.display.getState().display, part, key);
  if (!found) return null;
  if (found.region.row !== null) return { sketch: found.sketch.feature, row: found.region.row };
  const picked = await services.pick({ key });
  if (!picked || !isPickedRegion(picked)) return null;
  const { sketch, loop, holes } = picked.region;
  return { sketch, row: services.editor.newId('reg'), detected: { loop: loop as never, holes: holes as never } };
}

/** The references a set of profiles writes, the names they need, and the region rows to add first. */
export function profileReferences(profiles: readonly ExtrudeProfile[]): {
  refs: Json[];
  names: Json;
  regions: NewRegion[];
} {
  const names: Json = {};
  const regions: NewRegion[] = [];
  const refs = profiles.map((p) => {
    if ('kept' in p) return p.kept;
    const r = regionReference(p.sketch, p.row);
    Object.assign(names, r.names);
    if (p.detected) regions.push({ sketch: p.sketch, row: p.row, loop: p.detected.loop, holes: p.detected.holes });
    return r.reference;
  });
  return { refs, names, regions };
}

/** The profiles a stored profile set holds: region rows of the part's sketches, or references kept as found. */
export function readProfiles(doc: Doc, part: string, set: unknown): ExtrudeProfile[] {
  const members = (at(set, 'set') as unknown[] | undefined) ?? [];
  return members.map((m) => regionRowOf(doc, part, m) ?? { kept: m as Json });
}

/** The one sketch the profiles come from, or null. */
export function profilesSketch(profiles: readonly ExtrudeProfile[]): string | null {
  for (const p of profiles) if (!('kept' in p)) return p.sketch;
  return null;
}

/** True when two profiles are the same region: one row, or one detected region not yet a row. */
function sameRegion(a: ExtrudeProfile, b: ExtrudeProfile): boolean {
  if ('kept' in a || 'kept' in b) return a === b;
  if (a.sketch === b.sketch && a.row === b.row) return true;
  return (
    a.detected !== undefined && b.detected !== undefined && JSON.stringify(a.detected) === JSON.stringify(b.detected)
  );
}

/**
 * True for a profile that names no region of the part's sketches: one whose
 * reference is to be reconnected, or whose region is gone. It builds nothing.
 */
export function isMissingProfile(p: ExtrudeProfile): boolean {
  return 'kept' in p;
}

/**
 * What a profile list reads as: the sketch for one profile, "3 profiles from
 * Sketch 2" for more, with how many are missing ("1 profile from Sketch 2,
 * 1 missing"); null for none.
 */
export function profilesLabel(profiles: readonly ExtrudeProfile[], sketchName: string): string | null {
  const missing = profiles.filter(isMissingProfile).length;
  const found = profiles.length - missing;
  const count = (n: number) => `${n} ${n === 1 ? 'profile' : 'profiles'}`;
  if (profiles.length === 0) return null;
  if (missing === 0) return found > 1 ? `${count(found)} from ${sketchName}` : sketchName;
  if (found === 0) return `${count(missing)} missing`;
  return `${count(found)} from ${sketchName}, ${missing} missing`;
}

/**
 * `now` with region profile `p` clicked: picked again, it is dropped;
 * otherwise it takes the place of the first missing profile, reconnecting
 * it; with none missing it is added.
 */
export function clickedProfile(now: readonly ExtrudeProfile[], p: ExtrudeProfile): ExtrudeProfile[] {
  const same = now.find((q) => sameRegion(p, q));
  if (same) return now.filter((q) => q !== same);
  const lost = now.findIndex(isMissingProfile);
  if (lost >= 0) return now.map((q, i) => (i === lost ? p : q));
  return [...now, p];
}

/** What a click does to a list of picks, applied to the list as it is when the click's picks are known. */
export type Toggle<T> = { toggle: (now: readonly T[]) => T[] } | { hint: string };

/**
 * A click on region `key` toggles it among the profiles: picked again, it
 * is dropped; otherwise it reconnects a missing profile, or joins, if it
 * lies in the sketch the others come from, or in any sketch with
 * `anySketch`. A hint says why nothing changed. `current` is the list when
 * the click lands; the toggle applies to the list when the pick is known, so
 * clicks whose picks overlap all count.
 */
export async function toggleProfile(
  services: AppServices,
  part: string,
  current: readonly ExtrudeProfile[],
  key: Key,
  o: { anySketch?: boolean } = {},
): Promise<Toggle<ExtrudeProfile> | null> {
  const display = services.display.getState().display;
  const found = regionAt(display, part, key);
  if (!found) return null;
  const sketch = profilesSketch(current);
  if (sketch && sketch !== found.sketch.feature && !o.anySketch) return { hint: 'Profiles come from one sketch' };
  const shownAs = current.find((p) => profileKey(display, part, p) === key);
  if (shownAs) return { toggle: (now) => now.filter((p) => p !== shownAs) };
  const p = await profileOf(services, part, key);
  if (!p) return null;
  return {
    toggle: (now) => {
      const from = profilesSketch(now);
      if (from && from !== found.sketch.feature && !o.anySketch) return [...now];
      return clickedProfile(now, p);
    },
  };
}

/** The profiles a new feature starts with: the selected regions of `sketch` (any sketch when absent), or its only region. */
export async function startingProfiles(
  services: AppServices,
  part: string,
  sketch: string | undefined,
  regions?: readonly Key[],
): Promise<ExtrudeProfile[]> {
  const display = services.display.getState().display;
  const keys = (
    regions && regions.length > 0
      ? [...regions]
      : services.selection.getState().items.flatMap((i) => ('key' in i && !i.instance ? [i.key] : []))
  ).filter((k) => {
    const r = regionAt(display, part, k);
    return r !== null && (sketch === undefined || r.sketch.feature === sketch);
  });
  if (keys.length === 0 && sketch) {
    const regions = sketchesOf(display, part).find((s) => s.feature === sketch)?.regions ?? [];
    if (regions.length === 1) keys.push((regions[0] as { key: number }).key);
  }
  const found: ExtrudeProfile[] = [];
  for (const key of keys) {
    const p = await profileOf(services, part, key);
    if (p && !found.some((q) => sameRegion(p, q))) found.push(p);
  }
  return found;
}

/**
 * Thread standards the core knows by name: ISO metric, coarse and fine
 * (ISO 261 sizes and pitches, the ISO 68-1 basic profile, tap drills as
 * ISO 2306 recommends for 6H). Sizes in mm.
 */
import { FeaturePause } from './context';

export interface ThreadSize {
  designation: string;
  /** Nominal (major) diameter. */
  major: number;
  pitch: number;
  pitchDiameter: number;
  /** Basic minor diameter of the internal thread. */
  minor: number;
  /** The drill a tapped hole is made with. */
  tapDrill: number;
}

export const ISO_METRIC = 'ISO metric';

/** [size, coarse pitch, tap drill]. */
const COARSE: readonly (readonly [number, number, number])[] = [
  [1, 0.25, 0.75],
  [1.1, 0.25, 0.85],
  [1.2, 0.25, 0.95],
  [1.4, 0.3, 1.1],
  [1.6, 0.35, 1.25],
  [1.8, 0.35, 1.45],
  [2, 0.4, 1.6],
  [2.2, 0.45, 1.75],
  [2.5, 0.45, 2.05],
  [3, 0.5, 2.5],
  [3.5, 0.6, 2.9],
  [4, 0.7, 3.3],
  [4.5, 0.75, 3.75],
  [5, 0.8, 4.2],
  [6, 1, 5],
  [7, 1, 6],
  [8, 1.25, 6.8],
  [9, 1.25, 7.75],
  [10, 1.5, 8.5],
  [11, 1.5, 9.5],
  [12, 1.75, 10.2],
  [14, 2, 12],
  [16, 2, 14],
  [18, 2.5, 15.5],
  [20, 2.5, 17.5],
  [22, 2.5, 19.5],
  [24, 3, 21],
  [27, 3, 24],
  [30, 3.5, 26.5],
  [33, 3.5, 29.5],
  [36, 4, 32],
  [39, 4, 35],
  [42, 4.5, 37.5],
  [45, 4.5, 40.5],
  [48, 5, 43],
  [52, 5, 47],
  [56, 5.5, 50.5],
  [60, 5.5, 54.5],
  [64, 6, 58],
  [68, 6, 62],
];

/**
 * The fine pitches of each size (ISO 261), largest first, with the sizes
 * that have fine pitches only. M14x1.25 is for spark plugs and M35x1.5 for
 * bearing locknuts; M30x3 and M33x3 are to be avoided. M17 is not in ISO 261
 * but is in common use, and imported FreeCAD files may hold holes of that
 * size, so it is listed for them to read.
 */
const FINE: readonly (readonly [number, readonly number[]])[] = [
  [1, [0.2]],
  [1.1, [0.2]],
  [1.2, [0.2]],
  [1.4, [0.2]],
  [1.6, [0.2]],
  [1.8, [0.2]],
  [2, [0.25]],
  [2.2, [0.25]],
  [2.5, [0.35]],
  [3, [0.35]],
  [3.5, [0.35]],
  [4, [0.5]],
  [4.5, [0.5]],
  [5, [0.5]],
  [5.5, [0.5]],
  [6, [0.75]],
  [7, [0.75]],
  [8, [1, 0.75]],
  [9, [1, 0.75]],
  [10, [1.25, 1, 0.75]],
  [11, [1, 0.75]],
  [12, [1.5, 1.25, 1]],
  [14, [1.5, 1.25, 1]],
  [15, [1.5, 1]],
  [16, [1.5, 1]],
  [17, [1.5, 1]],
  [18, [2, 1.5, 1]],
  [20, [2, 1.5, 1]],
  [22, [2, 1.5, 1]],
  [24, [2, 1.5, 1]],
  [25, [2, 1.5, 1]],
  [26, [1.5]],
  [27, [2, 1.5, 1]],
  [28, [2, 1.5, 1]],
  [30, [3, 2, 1.5, 1]],
  [32, [2, 1.5]],
  [33, [3, 2, 1.5]],
  [35, [1.5]],
  [36, [3, 2, 1.5]],
  [38, [1.5]],
  [39, [3, 2, 1.5]],
  [40, [3, 2, 1.5]],
  [42, [4, 3, 2, 1.5]],
  [45, [4, 3, 2, 1.5]],
  [48, [4, 3, 2, 1.5]],
  [50, [3, 2, 1.5]],
  [52, [4, 3, 2, 1.5]],
  [55, [4, 3, 2, 1.5]],
  [56, [4, 3, 2, 1.5]],
  [58, [4, 3, 2, 1.5]],
  [60, [4, 3, 2, 1.5]],
  [62, [4, 3, 2, 1.5]],
  [64, [4, 3, 2, 1.5]],
  [65, [4, 3, 2, 1.5]],
  [68, [4, 3, 2, 1.5]],
];

/**
 * A fine thread's tap drill (ISO 2306): the size less its pitch, from the
 * drill series, which takes 0.8 off at 0.75 mm pitch and 1.2 at 1.25 mm.
 */
function fineTapDrill(size: number, pitch: number): number {
  const less = pitch === 0.75 ? 0.8 : pitch === 1.25 ? 1.2 : pitch;
  return Math.round((size - less) * 100) / 100;
}

/** One designation of a size: its pitch and tap drill, and whether the pitch is the coarse one. */
interface Pitch {
  designation: string;
  pitch: number;
  tapDrill: number;
  coarse: boolean;
}

/** Every ISO metric size, smallest first, the coarse designation first (`M8`), then the fine ones, largest pitch first (`M8x1`). */
const SIZES: readonly { size: number; pitches: readonly Pitch[] }[] = (() => {
  const sizes = new Map<number, Pitch[]>();
  for (const [size, pitch, tapDrill] of COARSE)
    sizes.set(size, [{ designation: `M${size}`, pitch, tapDrill, coarse: true }]);
  for (const [size, pitches] of FINE) {
    const list = sizes.get(size) ?? [];
    for (const pitch of pitches)
      list.push({ designation: `M${size}x${pitch}`, pitch, tapDrill: fineTapDrill(size, pitch), coarse: false });
    sizes.set(size, list);
  }
  return [...sizes].sort(([a], [b]) => a - b).map(([size, pitches]) => ({ size, pitches }));
})();

/** The ISO metric sizes, smallest first, as nominal diameters in mm. */
export const ISO_METRIC_SIZES: readonly number[] = SIZES.map((s) => s.size);

/** The designations of an ISO metric size: the coarse one first, when it has one (`M8`), then the fine ones (`M8x1`, `M8x0.75`). */
export function isoDesignations(size: number): readonly string[] {
  return SIZES.find((s) => s.size === size)?.pitches.map((p) => p.designation) ?? [];
}

/** Every ISO metric designation, size by size, as `isoDesignations` lists them. */
export const ISO_METRIC_DESIGNATIONS: readonly string[] = SIZES.flatMap((s) => s.pitches.map((p) => p.designation));

/** A designation's nominal size and the pitch written in it, or null for text that is not `M<d>` or `M<d>x<p>`. */
export function parseIsoDesignation(designation: string): { size: number; pitch: number | null } | null {
  const m = /^M(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?$/.exec(designation);
  return m ? { size: Number(m[1]), pitch: m[2] === undefined ? null : Number(m[2]) } : null;
}

function rowOf(
  designation: string,
): { size: number; written: number | null; pitches: readonly Pitch[]; row: Pitch | undefined } | null {
  const parsed = parseIsoDesignation(designation);
  const pitches = parsed && SIZES.find((s) => s.size === parsed.size)?.pitches;
  if (!parsed || !pitches) return null;
  const row = pitches.find((p) => (parsed.pitch === null ? p.coarse : p.pitch === parsed.pitch));
  return { size: parsed.size, written: parsed.pitch, pitches, row };
}

/** A designation as the table lists it: `M8x1.25`, the coarse pitch written out, is `M8`. Null for one the table does not have. */
export function listedDesignation(designation: string): string | null {
  return rowOf(designation)?.row?.designation ?? null;
}

/**
 * A size of a named standard: ISO metric takes `M8` (the coarse pitch),
 * `M8x1.25` (the same, the pitch written out) or a fine pitch, `M8x1`.
 * Anything else pauses.
 */
export function threadSize(standard: string, designation: string): ThreadSize {
  if (standard !== ISO_METRIC) throw new FeaturePause(`the thread standard "${standard}" is not known`);
  const found = rowOf(designation);
  if (!found) throw new FeaturePause(`"${designation}" is not an ISO metric size`);
  if (!found.row) {
    throw new FeaturePause(
      found.written === null
        ? `M${found.size} has no coarse pitch; give its pitch, as in "${found.pitches[0]?.designation}"`
        : `"${designation}" is not an ISO metric pitch of M${found.size}`,
    );
  }
  const { pitch, tapDrill } = found.row;
  const major = found.size;
  const h = (Math.sqrt(3) / 2) * pitch;
  return {
    designation,
    major,
    pitch,
    pitchDiameter: major - 0.75 * h,
    minor: major - 1.25 * h,
    tapDrill,
  };
}

/**
 * Whether an ISO tolerance class is for an internal thread (capital letters,
 * `6H`) or an external one (`6g`); `5H6H`-style pairs are one class.
 */
export function isInternalClass(cls: string): boolean {
  const m = /^(?:\d[A-Za-z]){1,2}$/.exec(cls);
  const letters = m ? cls.replace(/\d/g, '') : '';
  if (letters === letters.toUpperCase() && letters !== '') return true;
  if (letters === letters.toLowerCase() && letters !== '') return false;
  throw new FeaturePause(`"${cls}" is not an ISO tolerance class`);
}

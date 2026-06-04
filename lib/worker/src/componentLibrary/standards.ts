/**
 * ISO/DIN dimension tables for the standard parts we model.
 *
 * Keeping the dimensions in one place (rather than hard-coded in each
 * builder) lets us:
 *   - quote the standard's table values directly
 *   - extend the size range without touching geometry code
 *   - share head/across-flats numbers between bolt and nut where they match
 *
 * Numbers come from ISO 4017 (hex bolts), ISO 4032 (hex nuts), and the
 * 608-series deep-groove ball-bearing spec (8 mm bore × 22 mm OD × 7 mm).
 * Hex prism is regular — distance "across flats" (s) plus head height (k).
 */

export type HexThread = 'M3' | 'M4' | 'M5' | 'M6' | 'M8';

export type HexBoltDims = {
  /** Major thread diameter (mm). */
  diameter: number;
  /** Distance across the hex flats (mm). */
  acrossFlats: number;
  /** Head height (mm). */
  headHeight: number;
};

export type HexNutDims = {
  /** Major thread diameter (mm), i.e. through-hole diameter. */
  diameter: number;
  /** Distance across the hex flats (mm). */
  acrossFlats: number;
  /** Nut thickness/height (mm). */
  thickness: number;
};

/** ISO 4017 — fully threaded hex bolt. Values per the standard. */
export const HEX_BOLTS: Record<HexThread, HexBoltDims> = {
  M3: { diameter: 3, acrossFlats: 5.5, headHeight: 2.0 },
  M4: { diameter: 4, acrossFlats: 7.0, headHeight: 2.8 },
  M5: { diameter: 5, acrossFlats: 8.0, headHeight: 3.5 },
  M6: { diameter: 6, acrossFlats: 10.0, headHeight: 4.0 },
  M8: { diameter: 8, acrossFlats: 13.0, headHeight: 5.3 },
};

/** ISO 4032 — standard hex nut. */
export const HEX_NUTS: Record<HexThread, HexNutDims> = {
  M3: { diameter: 3, acrossFlats: 5.5, thickness: 2.4 },
  M4: { diameter: 4, acrossFlats: 7.0, thickness: 3.2 },
  M5: { diameter: 5, acrossFlats: 8.0, thickness: 4.7 },
  M6: { diameter: 6, acrossFlats: 10.0, thickness: 5.2 },
  M8: { diameter: 8, acrossFlats: 13.0, thickness: 6.8 },
};

/**
 * 608-series deep-groove ball bearing (the "skate bearing").
 * We model the outer + inner ring as solid annuli and skip the balls —
 * users care about envelope + bore alignment, not roller detail.
 */
export const BEARING_608 = {
  outerDiameter: 22,
  innerDiameter: 8,
  width: 7,
  /** Approximate race depth (purely cosmetic, controls the visible step). */
  raceDepth: 1.5,
} as const;

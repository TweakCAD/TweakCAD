import type { JsonSet } from '../collections';

export type Vec2 = readonly [number, number];

/** What a use is on: the root of a drawn curve, or one contour of one glyph of a text row. */
export type CurveKey = { drawn: { id: string } } | { glyph: { text: string; glyph: number; contour: number } };

/** The sign of this curve's tangent × the other's at a crossing; 0 at a tangency. */
export type CrossingSense = 1 | -1 | 0;

/** Where a use starts or stops. */
export type UseEnd =
  | { point: { id: string } }
  | { cross: { with: CurveKey; sense: CrossingSense; k: number; kWith: number } }
  | { extremity: { which: 'start' | 'end' } };

/** A stretch of a curve, or the whole of a closed curve. */
export type Use =
  { open: { curve: CurveKey; from: UseEnd; to: UseEnd; reversed: boolean } } | { closed: { curve: CurveKey } };

/** A cycle of uses. */
export type Loop = readonly Use[];

export type RegionOrigin = { detected: Record<string, never> } | { from: { id: string } };

/** A region row without its id. */
export interface RegionFields {
  loop: Loop;
  holes: JsonSet<Loop>;
  origin: RegionOrigin;
}

export interface RegionRow extends RegionFields {
  id: string;
}

export type RetiredFate =
  { split: Record<string, never> } | { merged: { into: { id: string } } } | { deleted: Record<string, never> };

/** A row of the `retired` table; curve rows pass through region code untouched. */
export interface RetiredRow {
  id: string;
  was: { region: RegionFields } | { curve: unknown };
  fate: RetiredFate;
}

/** The two tables region fates change. */
export interface RegionTable {
  regions: readonly RegionRow[];
  retired: readonly RetiredRow[];
}

/**
 * Solved shape of a curve, in the sketch frame. Each shape runs in the format's
 * direction: a line from `start` to `end`; an arc and an elliptical arc
 * counter-clockwise from `start` to `end`; a circle counter-clockwise from
 * `center` + (radius, 0); an ellipse counter-clockwise from `majorEnd`; a NURBS
 * along its parameter from its first knot (a spline, bezier and conic arrive as
 * the equivalent NURBS); a glyph contour through its segments in order, in the
 * font's direction from its first on-curve point.
 *
 * A periodic NURBS has one pole per flat knot, the last knot's multiplicity
 * counted with the first's, and the span after its first knot uses the first
 * `degree` + 1 poles.
 */
export type CurveShape =
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; center: Vec2; start: Vec2; end: Vec2 }
  | { kind: 'circle'; center: Vec2; radius: number }
  | { kind: 'ellipse'; center: Vec2; majorEnd: Vec2; minorRadius: number }
  | {
      kind: 'ellipticalArc';
      center: Vec2;
      majorEnd: Vec2;
      minorRadius: number;
      start: Vec2;
      end: Vec2;
    }
  | {
      kind: 'nurbs';
      degree: number;
      poles: readonly Vec2[];
      weights: readonly number[];
      knots: readonly number[];
      multiplicities: readonly number[];
      periodic: boolean;
    }
  | {
      kind: 'contour';
      /** Bezier segments in order, each 2, 3 or 4 control points; each starts where the last ended. */
      segments: readonly (readonly Vec2[])[];
    };

/**
 * How a curve's ends are named. `points`: the sketch points at its ends, the
 * first and last poles for a clamped NURBS, and any it passes through in
 * between; `extremities`: ends at no sketch point, those of a defining external
 * curve or an unclamped NURBS; `none`: a closed curve with no ends. A curve whose
 * two ends coincide is closed.
 */
export type CurveAnchors =
  | { kind: 'points'; start: string; end: string; through?: readonly string[] }
  | { kind: 'extremities' }
  | { kind: 'none' };

/** One live curve of the solved sketch. */
export interface SolvedCurve {
  /** The curve's root, or its glyph contour. Live descendants of one root share a key. */
  key: CurveKey;
  shape: CurveShape;
  anchors: CurveAnchors;
}

/**
 * Solved geometry regions are detected on: the curves that bound regions, in
 * table order, without construction curves and without external curves that are
 * not `defining`, then the glyph contours built at this solve.
 */
export interface SolvedSketch {
  points: readonly { id: string; x: number; y: number }[];
  curves: readonly SolvedCurve[];
}

/**
 * Text → sketch outline primitives.
 *
 * Turns a font's glyph outlines into closed loops of `line` + cubic `bezier`
 * primitives — the same normalized `DxfPrimitive` the DXF/SVG importers
 * produce — so `addPrimitivesToEditorState` places them in a sketch as
 * ordinary editable geometry with removable `coincident` junctions. There is
 * no text entity: once placed, a letter is just lines and curves (Invariant
 * #11), and region detection + extrude treat it like any other closed profile
 * (a letter's counters — the holes in A, O, e — come out as nested loops).
 *
 * Font parsing stays outside core: callers pass anything that matches
 * `OutlineFont` (structurally the slice of an opentype.js `Font` used here).
 *
 * Conventions:
 *   - Glyph paths are Y-DOWN (the SVG/opentype convention, baseline at y=0);
 *     the sketch plane is Y-UP, so every Y is negated.
 *   - `height` is the CAP height in mm: "10 mm text" means a capital letter
 *     stands 10 mm tall. Descenders and accents extend beyond it.
 *   - `origin` is the left end of the baseline.
 *   - TrueType quadratics are elevated to one cubic each (exact). Segments
 *     that are degenerate (zero length) are dropped and curves whose control
 *     points lie on their chord become lines, so every loop stays closed and
 *     the kernel never sees a zero-length edge.
 */

import type { DxfPrimitive } from '../io/dxfImport.ts';

/** One outline command, Y-down, in font units (opentype.js `Path.commands`). */
export type OutlineCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

/** The part of a parsed font this module needs. */
export interface OutlineFont {
  unitsPerEm: number;
  getPath(
    text: string,
    x: number,
    y: number,
    fontSize: number,
    options?: { kerning?: boolean },
  ): { commands: readonly OutlineCommand[] };
  tables?: { os2?: { sCapHeight?: number } };
}

export interface TextOutlineOptions {
  /** Cap height in mm (must be > 0). */
  height: number;
  /** Left end of the baseline in sketch coordinates. Default [0, 0]. */
  origin?: readonly [number, number];
}

/** Segments shorter than this (mm) are dropped; also the on-chord test for curves. */
const DEGENERATE_MM = 1e-4;

/**
 * Cap height in font units: the OS/2 `sCapHeight` when the font declares it,
 * otherwise the measured top of a capital H.
 */
export function capHeightUnits(font: OutlineFont): number {
  const declared = font.tables?.os2?.sCapHeight;
  if (declared !== undefined && declared > 0) return declared;
  let minY = 0;
  for (const c of font.getPath('H', 0, 0, font.unitsPerEm).commands) {
    if (c.type !== 'Z') minY = Math.min(minY, c.y);
  }
  return minY < 0 ? -minY : font.unitsPerEm * 0.7;
}

/**
 * Lay `text` out on one line in `font` and return its outline as sketch
 * primitives (Y-up, mm). Line breaks are treated as spaces. Returns an empty
 * list for blank text.
 */
export function textToPrimitives(
  font: OutlineFont,
  text: string,
  opts: TextOutlineOptions,
): DxfPrimitive[] {
  if (!(opts.height > 0) || !Number.isFinite(opts.height)) return [];
  const line = text.replace(/[\r\n]+/g, ' ');
  if (line.trim() === '') return [];
  const scale = opts.height / capHeightUnits(font);
  const commands = font.getPath(line, 0, 0, font.unitsPerEm, { kerning: true }).commands;
  return outlineToPrimitives(commands, { scale, origin: opts.origin ?? [0, 0] });
}

/**
 * Convert Y-down outline commands to closed loops of line + cubic bezier
 * primitives, scaled and placed at `origin` (Y flipped to sketch up).
 */
export function outlineToPrimitives(
  commands: readonly OutlineCommand[],
  placement: { scale: number; origin: readonly [number, number] },
): DxfPrimitive[] {
  const { scale } = placement;
  const [ox, oy] = placement.origin;
  const map = (x: number, y: number): [number, number] => [ox + x * scale, oy - y * scale];

  const out: DxfPrimitive[] = [];
  let contour: DxfPrimitive[] = [];
  let start: [number, number] | null = null;
  // Current pen position in sketch space. Advanced only when a segment is
  // emitted, so a dropped degenerate segment leaves no gap: the next segment
  // starts exactly where the last emitted one ended.
  let pen: [number, number] = [0, 0];

  const emitLine = (to: [number, number]): void => {
    if (dist(pen, to) < DEGENERATE_MM) return;
    contour.push({ kind: 'line', start: pen, end: to });
    pen = to;
  };

  const emitCubic = (c1: [number, number], c2: [number, number], to: [number, number]): void => {
    if (dist(pen, to) < DEGENERATE_MM) return;
    if (offChord(pen, to, c1) < DEGENERATE_MM && offChord(pen, to, c2) < DEGENERATE_MM) {
      emitLine(to);
      return;
    }
    contour.push({ kind: 'bezier', start: pen, cp1: c1, cp2: c2, end: to });
    pen = to;
  };

  const closeContour = (): void => {
    if (start) {
      if (dist(pen, start) >= DEGENERATE_MM) {
        emitLine(start);
      } else if (contour.length > 0) {
        // Within tolerance of the start but not bit-identical: snap the last
        // segment's end onto the start so the junction is exact.
        const last = contour[contour.length - 1]!;
        if (last.kind === 'line' || last.kind === 'bezier') last.end = start;
      }
    }
    // A closed loop needs at least two segments (one would be a zero-area
    // curve back onto itself).
    if (contour.length >= 2) out.push(...contour);
    contour = [];
    start = null;
  };

  for (const c of commands) {
    switch (c.type) {
      case 'M':
        if (start) closeContour();
        start = map(c.x, c.y);
        pen = start;
        break;
      case 'L':
        if (start) emitLine(map(c.x, c.y));
        break;
      case 'Q': {
        if (!start) break;
        // Degree elevation: cp1 = p0 + ⅔(q − p0), cp2 = p1 + ⅔(q − p1).
        const q = map(c.x1, c.y1);
        const to = map(c.x, c.y);
        const c1: [number, number] = [pen[0] + (2 / 3) * (q[0] - pen[0]), pen[1] + (2 / 3) * (q[1] - pen[1])];
        const c2: [number, number] = [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])];
        emitCubic(c1, c2, to);
        break;
      }
      case 'C':
        if (start) emitCubic(map(c.x1, c.y1), map(c.x2, c.y2), map(c.x, c.y));
        break;
      case 'Z':
        closeContour();
        break;
    }
  }
  if (start) closeContour();
  return out;
}

function dist(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Distance from `p` to the segment a→b. */
function offChord(a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

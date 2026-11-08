/**
 * Sketch text (chapter 8 `text`): glyph outlines built at every solve from the
 * string, the font, the size and the frame, never stored.
 *
 * Layout: one glyph per character of the string (no ligatures), set along
 * the baseline by each glyph's advance and the font's kerning, starting at
 * the frame's origin with x along the baseline. `size` is the cap height:
 * the font's OS/2 cap height, or the top of its "H" when it declares none.
 *
 * Glyphs are numbered from 0 by character, so an edit that keeps a character
 * where it was keeps its glyph number; contours are numbered in the font's
 * order. A contour runs in the font's direction from its first on-curve
 * point, as Bézier segments: TrueType's quadratics and CFF's cubics exactly,
 * each segment numbered from 0 along the contour, a zero-length segment left
 * out, and a closing line counted last where the font leaves the contour open.
 */
import { parse, type Font, type Glyph, type GlyphCommand, type GlyphPoint } from 'opentype.js';
import type { SolvedCurve, Vec2 } from '@tweakcad/format';
import { FeaturePause, LENGTH, TEXT, type BuildContext, type Json } from './context';
import { frameOf } from './places';

const LIBRARY = { type: 'library' } as const;

/** Where a text row's baseline starts in the sketch, and its direction (radians from the sketch's x). */
export interface TextPlacement {
  origin: Vec2;
  angle: number;
}

/** The Bézier segments of one contour, each 2, 3 or 4 control points, each starting where the last ended. */
type Segments = Vec2[][];

const same = (a: Vec2, b: Vec2) => a[0] === b[0] && a[1] === b[1];

/** Adds a segment unless it has no length: every control point at one place. */
function addSegment(out: Segments, segment: Vec2[]): void {
  const first = segment[0] as Vec2;
  if (!segment.every((p) => same(p, first))) out.push(segment);
}

interface OutlinePoint {
  p: Vec2;
  on: boolean;
}

/** TrueType contours from the glyph's points: quadratic segments, implied on-curve points between two off-curve ones. */
function trueTypeContours(points: readonly GlyphPoint[]): Segments[] {
  const contours: OutlinePoint[][] = [];
  let current: OutlinePoint[] = [];
  for (const q of points) {
    current.push({ p: [q.x, q.y], on: q.onCurve });
    if (q.lastPointOfContour) {
      contours.push(current);
      current = [];
    }
  }
  if (current.length > 0) contours.push(current);
  return contours.map((contour) => {
    // The implied on-curve point between two off-curve ones, the pair of the last and first points included.
    const expanded: OutlinePoint[] = [];
    contour.forEach((q, i) => {
      expanded.push(q);
      const next = contour[(i + 1) % contour.length] as OutlinePoint;
      if (!q.on && !next.on) expanded.push({ p: [(q.p[0] + next.p[0]) / 2, (q.p[1] + next.p[1]) / 2], on: true });
    });
    // From the first on-curve point in the contour's order, back round to it.
    const first = expanded.findIndex((q) => q.on);
    if (first < 0) return [];
    const start = expanded[first] as OutlinePoint;
    const walk = [...expanded.slice(first + 1), ...expanded.slice(0, first), start];
    const out: Segments = [];
    let pen = start.p;
    for (let i = 0; i < walk.length; i++) {
      const q = walk[i] as OutlinePoint;
      if (q.on) {
        addSegment(out, [pen, q.p]);
        pen = q.p;
        continue;
      }
      // An off-curve point is always followed by an on-curve one here.
      const next = walk[i + 1] as OutlinePoint;
      addSegment(out, [pen, q.p, next.p]);
      pen = next.p;
      i++;
    }
    return out;
  });
}

/** Contours from outline commands (CFF): lines, quadratics and cubics, each contour starting at its move. */
function commandContours(commands: readonly GlyphCommand[]): Segments[] {
  const out: Segments[] = [];
  let segments: Segments | null = null;
  let [start, pen]: Vec2[] = [
    [0, 0],
    [0, 0],
  ];
  const close = () => {
    if (!segments) return;
    if (!same(pen as Vec2, start as Vec2)) addSegment(segments, [pen as Vec2, start as Vec2]);
    out.push(segments);
    segments = null;
  };
  for (const c of commands) {
    const to: Vec2 = [c.x ?? 0, c.y ?? 0];
    switch (c.type) {
      case 'M':
        close();
        segments = [];
        start = to;
        pen = to;
        break;
      case 'L':
        if (segments) addSegment(segments, [pen as Vec2, to]);
        pen = to;
        break;
      case 'Q':
        if (segments) addSegment(segments, [pen as Vec2, [c.x1 ?? 0, c.y1 ?? 0], to]);
        pen = to;
        break;
      case 'C':
        if (segments) addSegment(segments, [pen as Vec2, [c.x1 ?? 0, c.y1 ?? 0], [c.x2 ?? 0, c.y2 ?? 0], to]);
        pen = to;
        break;
      case 'Z':
        close();
        break;
    }
  }
  close();
  return out;
}

/** A glyph's contours in font units, y up, in the font's order. */
export function glyphContours(font: Font, glyph: Glyph): Segments[] {
  // Reading the path builds it, and a TrueType glyph's points with it.
  const path = glyph.path;
  if (font.outlinesFormat === 'truetype' && glyph.points) return trueTypeContours(glyph.points);
  return commandContours(path.commands);
}

/** The cap height in font units: the OS/2 value, or the top of "H". */
export function capHeight(font: Font): number {
  const declared = font.tables.os2?.sCapHeight;
  if (declared !== undefined && declared > 0) return declared;
  const h = font.charToGlyph('H');
  const top = Math.max(
    ...glyphContours(font, h)
      .flat(2)
      .map((p) => p[1]),
  );
  if (h.index === 0 || !(top > 0))
    throw new FeaturePause('the font declares no cap height and has no "H" to measure one');
  return top;
}

/**
 * The glyph contours of a text row: one closed curve per contour of each
 * glyph, keyed by the row, the glyph and the contour (8.3).
 */
export function layoutText(font: Font, textId: string, string: string, size: number, at: TextPlacement): SolvedCurve[] {
  const breaks = [0x0a, 0x0d, 0x2028, 0x2029];
  if (Array.from(string).some((ch) => breaks.includes(ch.charCodeAt(0))))
    throw new FeaturePause('text with line breaks is not built yet');
  if (!(size > 0)) throw new FeaturePause('a text size is positive');
  const k = size / capHeight(font);
  const [cos, sin] = [Math.cos(at.angle), Math.sin(at.angle)];
  const characters = Array.from(string);
  const glyphs = characters.map((ch) => {
    const glyph = font.charToGlyph(ch);
    if (glyph.index === 0 && !/\s/.test(ch)) throw new FeaturePause(`the font has no glyph for "${ch}"`);
    return glyph;
  });
  const out: SolvedCurve[] = [];
  let pen = 0;
  glyphs.forEach((glyph, g) => {
    const place = (p: Vec2): Vec2 => {
      const [x, y] = [(p[0] + pen) * k, p[1] * k];
      return [at.origin[0] + x * cos - y * sin, at.origin[1] + x * sin + y * cos];
    };
    glyphContours(font, glyph).forEach((segments, contour) => {
      if (segments.length === 0) return;
      out.push({
        key: { glyph: { text: textId, glyph: g, contour } },
        shape: { kind: 'contour', segments: segments.map((s) => s.map(place)) },
        anchors: { kind: 'none' },
      });
    });
    pen += glyph.advanceWidth ?? 0;
    const next = glyphs[g + 1];
    if (next) pen += font.getKerningValue(glyph, next);
  });
  return out;
}

const fonts = new Map<string, Font>();

/** A font file parsed, cached by its content hash. */
export function fontOf(hash: string, bytes: Uint8Array): Font {
  const cached = fonts.get(hash);
  if (cached) return cached;
  let font: Font;
  try {
    font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch {
    throw new FeaturePause('the font file cannot be read');
  }
  fonts.set(hash, font);
  return font;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The font a library value names: a `font` entry whose definition is `{asset}`, its bytes in the document's assets. */
function libraryFont(ctx: BuildContext, value: unknown): Font {
  const { values, library, assets } = ctx.ev;
  const id = values.literal(value, LIBRARY) as string;
  const entry = library.find((e) => e.id === id);
  if (!entry) throw new FeaturePause(`the library has no entry ${id}`);
  if (entry.kind !== 'font') throw new FeaturePause('the text font names a library entry that is not a font');
  const content = entry.content as Json;
  if (!('inline' in content)) throw new FeaturePause('the font is missing from the library');
  const definition = (content.inline as Json).definition as Json | undefined;
  const hash = definition?.asset;
  if (typeof hash !== 'string') throw new FeaturePause('the font definition names no font file');
  const row = assets[hash] as Json | undefined;
  if (!row) throw new FeaturePause('the font file is not in the assets');
  const data = row.data as Json;
  if (!('inline' in data)) throw new FeaturePause('the font file is not loaded');
  return fontOf(hash, decodeBase64((data.inline as Json).base64 as string));
}

/** Where a text frame puts the baseline in the sketch: a fixed placement is in the sketch frame; an attached one must lie in the sketch plane. */
function placementOf(ctx: BuildContext, frame: Json): TextPlacement {
  const f = frameOf(ctx, frame);
  if ('fixed' in frame) {
    const flat = Math.abs(f.origin[2]) <= 1e-9 && Math.abs(f.x[2]) <= 1e-9 && f.normal[2] > 1 - 1e-9;
    if (!flat) throw new FeaturePause('the text frame leaves the sketch plane');
    return { origin: [f.origin[0], f.origin[1]], angle: Math.atan2(f.x[1], f.x[0]) };
  }
  throw new FeaturePause('text attached to model geometry is not built yet');
}

/** The glyph contours of every text row of the sketch being built. */
export function buildText(ctx: BuildContext): SolvedCurve[] {
  const { values } = ctx.ev;
  const out: SolvedCurve[] = [];
  for (const row of (ctx.inputs.text as Json[] | undefined) ?? []) {
    const id = row.id as string;
    if (!('straight' in (row.path as Json))) {
      throw new FeaturePause(
        'text along a curve is not built yet: where it starts on the curve and how its glyphs sit there are not specified',
      );
    }
    const font = libraryFont(ctx, row.font);
    const string = values.literal(row.string, TEXT) as string;
    const size = values.number(row.size, LENGTH);
    out.push(...layoutText(font, id, string, size, placementOf(ctx, row.frame as Json)));
  }
  return out;
}

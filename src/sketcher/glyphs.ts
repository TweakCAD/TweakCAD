/**
 * Where each geometric constraint's glyph sits: beside the point it holds, or
 * the middle of each curve it relates.
 * Glyphs at one place are numbered by `slot`; on screen `placeGlyphs` sets
 * badges that would overlap apart.
 */
import { isPlainObject } from '@tweakcad/format';
import type { SketchGeometry } from './geometry';
import { operandOf, standardOf, type Json, type P2 } from './rows';

/** The symbol each constraint glyph shows. */
export const GLYPHS: Record<string, string> = {
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⊥',
  equal: '=',
  tangent: '◠',
  normal: '⊾',
  midpoint: 'Δ',
  pointOnCurve: '•',
  coincident: '•',
  fixed: 'F',
  block: 'B',
  concentric: '◎',
  collinear: '⋯',
  coradial: '◎',
  symmetric: '⇹',
  offset: '⇉',
  curvature: '≈',
};

export interface GlyphAnchor {
  /** The constraint id. */
  id: string;
  kind: string;
  symbol: string;
  /** Sketch coordinates. */
  at: P2;
  /** Its place among the glyphs at the same spot, from 0. */
  slot: number;
}

export function glyphAnchors(geometry: SketchGeometry, rows: readonly Json[]): GlyphAnchor[] {
  const out: GlyphAnchor[] = [];
  const placed = new Map<string, number>();
  const at = (p: P2 | undefined, kind: string, id: string) => {
    const symbol = GLYPHS[kind];
    if (!p || !symbol) return;
    const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    const slot = placed.get(key) ?? 0;
    placed.set(key, slot + 1);
    out.push({ id, kind, symbol, at: p, slot });
  };
  const pointOf = (v: unknown) => geometry.operandPoint(v);
  const curveMiddle = (v: unknown): P2 | undefined => {
    const standard = standardOf(v);
    if (standard === 'x') return [10, 0];
    if (standard === 'y') return [0, 10];
    const o = operandOf(v);
    return o && !o.point ? geometry.middleOf(o.id) : undefined;
  };
  for (const c of rows) {
    const kind = c.kind as string;
    const id = c.id as string;
    switch (kind) {
      case 'horizontal':
      case 'vertical': {
        const of = c.of as Json;
        if (isPlainObject(of.points)) {
          const [a, b] = [pointOf(of.points.a), pointOf(of.points.b)];
          if (a && b) at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind, id);
        } else at(curveMiddle(of), kind, id);
        break;
      }
      case 'fixed':
      case 'coincident':
      case 'midpoint':
      case 'pointOnCurve':
        at(pointOf(c.point), kind, id);
        break;
      case 'block':
        at(curveMiddle(c.curve), kind, id);
        break;
      case 'symmetric':
        at(curveMiddle(c.axis), kind, id);
        break;
      case 'offset':
        at(curveMiddle(c.b), kind, id);
        break;
      default:
        at(curveMiddle(c.a), kind, id);
        at(curveMiddle(c.b), kind, id);
    }
  }
  return out;
}

/** A glyph badge on screen, in pixels: its anchor, or the top-left corner it is drawn at. */
export interface ScreenSpot {
  x: number;
  y: number;
}

/** Offsets from a badge's first place to try in turn, in steps: along its row first, then the rows above and below, nearest first. */
const TRIES: readonly [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let j = -3; j <= 3; j++) for (let i = -2; i <= 6; i++) out.push([i, j]);
  return out.sort((a, b) => Math.hypot(a[0], 1.4 * a[1]) - Math.hypot(b[0], 1.4 * b[1]) || a[1] - b[1] || a[0] - b[0]);
})();

/**
 * Where each badge goes: beside and below its anchor, or where nearest
 * that no badge placed before it overlaps, so glyphs crowding one spot
 * stand apart. Badges are `size` pixels square, a `step` apart.
 */
export function placeGlyphs(anchors: readonly ScreenSpot[], size: number, step: number): ScreenSpot[] {
  const cells = new Map<string, ScreenSpot[]>();
  const cell = (x: number, y: number) => `${Math.floor(x / step)},${Math.floor(y / step)}`;
  const free = (x: number, y: number) => {
    const [cx, cy] = [Math.floor(x / step), Math.floor(y / step)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of cells.get(`${cx + dx},${cy + dy}`) ?? [])
          if (Math.abs(p.x - x) < size + 1 && Math.abs(p.y - y) < size + 1) return false;
      }
    }
    return true;
  };
  return anchors.map((a) => {
    const [x0, y0] = [a.x + 6, a.y + 4];
    const found = TRIES.find(([i, j]) => free(x0 + i * step, y0 + j * step)) ?? [0, 0];
    const spot = { x: x0 + found[0] * step, y: y0 + found[1] * step };
    const key = cell(spot.x, spot.y);
    cells.set(key, [...(cells.get(key) ?? []), spot]);
    return spot;
  });
}

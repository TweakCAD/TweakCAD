/**
 * The lines a dimension draws in the sketch, in sketch coordinates:
 * extension lines from what it measures out to the dimension line (or arc),
 * the dimension line itself, and an arrowhead at each measured end. The
 * dimension line passes through the label, so where the label sits decides
 * how far the line stands off; a label beyond the measured span runs the
 * line on to it.
 */
import { isPlainObject } from '@tweakcad/format';
import type { SketchGeometry } from './geometry';
import { angleFrame, angleSide, labelAnchor } from './dimensions';
import { operandOf, standardOf, type Json, type P2 } from './rows';

export interface DimensionArrow {
  /** The arrow's tip. */
  at: P2;
  /** The unit direction the arrow points, away from the span it ends. */
  dir: P2;
  /** The length of the span between the arrows, in mm; a span too short for both arrows turns them to point inward from outside. */
  span: number;
}

export interface DimensionLines {
  /** Extension lines and the dimension line or arc, each a polyline. */
  lines: P2[][];
  arrows: DimensionArrow[];
}

/** One measured end: the point measured, and where its extension line starts on the geometry. */
interface End {
  at: P2;
  from: P2;
}

const EPS = 1e-9;
const ARC_STEP = Math.PI / 90;

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const perp = (a: P2): P2 => [-a[1], a[0]];
const unit = (a: P2): P2 | null => {
  const n = len(a);
  return n > EPS ? [a[0] / n, a[1] / n] : null;
};
const along = (o: P2, d: P2, t: number): P2 => add(o, scale(d, t));
const extension = (from: P2, to: P2): P2[][] => (len(sub(to, from)) > EPS ? [[from, to]] : []);

/** What a dimension draws, or null when it has nothing to draw (its operands do not fit, or the span is empty). */
export function dimensionLines(g: SketchGeometry, row: Json): DimensionLines | null {
  const label = labelAnchor(g, row);
  if (!label) return null;
  switch (row.kind) {
    case 'distance':
      return distance(g, row, label);
    case 'distanceX':
    case 'distanceY': {
      const [a, b] = [g.operandPoint(row.a), g.operandPoint(row.b)];
      if (!a || !b) return null;
      const normal: P2 = row.kind === 'distanceX' ? [0, 1] : [1, 0];
      return linear({ at: a, from: a }, { at: b, from: b }, normal, label);
    }
    case 'length': {
      const o = operandOf(row.curve);
      const shape = o && !o.point ? g.curves.get(o.id)?.shape : undefined;
      if (shape?.kind !== 'line') return null;
      return aligned({ at: shape.start, from: shape.start }, { at: shape.end, from: shape.end }, label);
    }
    case 'radius':
    case 'diameter':
      return round(g, row, label);
    case 'angle':
      return angle(g, row, label);
    default:
      return null;
  }
}

function distance(g: SketchGeometry, row: Json, label: P2): DimensionLines | null {
  const [pa, pb] = [g.operandPoint(row.a), g.operandPoint(row.b)];
  if (pa && pb) return aligned({ at: pa, from: pa }, { at: pb, from: pb }, label);
  const p = pa ?? pb;
  if (!p) return null;
  const other = pa ? row.b : row.a;
  const foot = footOn(g, other, p);
  if (!foot) return null;
  const ends: [End, End] = pa ? [{ at: p, from: p }, foot] : [foot, { at: p, from: p }];
  return aligned(ends[0], ends[1], label);
}

/**
 * Where the distance from `p` to a curve operand is measured to: the foot
 * on a line (its extension line starting at the nearest point of the
 * segment; a sketch axis has no end), or the nearest point of a circle or arc.
 */
function footOn(g: SketchGeometry, v: unknown, p: P2): End | null {
  const line = g.operandLine(v);
  if (line) {
    const [s, e] = line;
    const d = unit(sub(e, s));
    if (!d) return null;
    const t = dot(sub(p, s), d);
    const at = along(s, d, t);
    if (standardOf(v)) return { at, from: at };
    return { at, from: along(s, d, Math.min(Math.max(t, 0), len(sub(e, s)))) };
  }
  const o = operandOf(v);
  const shape = o && !o.point ? g.curves.get(o.id)?.shape : undefined;
  const r = o ? g.radius(o.id) : undefined;
  if (!shape || r === undefined || (shape.kind !== 'circle' && shape.kind !== 'arc')) return null;
  const toward = unit(sub(p, shape.center));
  if (!toward) return null;
  const at = along(shape.center, toward, r);
  return { at, from: at };
}

/** A distance measured along the line between its two ends. */
function aligned(a: End, b: End, label: P2): DimensionLines | null {
  const d = unit(sub(b.at, a.at));
  return d ? linear(a, b, perp(d), label) : null;
}

/**
 * A distance between two ends measured across `normal`: the dimension line
 * runs square to `normal` through the label, each end's extension line runs
 * from the geometry to it, and the line runs on to a label beyond the ends.
 */
function linear(a: End, b: End, normal: P2, label: P2): DimensionLines | null {
  const level = dot(label, normal);
  const da = along(a.at, normal, level - dot(a.at, normal));
  const db = along(b.at, normal, level - dot(b.at, normal));
  const span = len(sub(db, da));
  const d = unit(sub(db, da));
  if (!d) return null;
  const t = dot(sub(label, da), d);
  const line: P2[] = [t < 0 ? along(da, d, t) : da, t > span ? along(da, d, t) : db];
  return {
    lines: [...extension(a.from, da), ...extension(b.from, db), line],
    arrows: [
      { at: da, dir: scale(d, -1), span },
      { at: db, dir: d, span },
    ],
  };
}

/** A radius from the centre out to the curve toward the label, or a diameter through the centre. */
function round(g: SketchGeometry, row: Json, label: P2): DimensionLines | null {
  const o = operandOf(row.curve);
  const shape = o && !o.point ? g.curves.get(o.id)?.shape : undefined;
  const r = o ? g.radius(o.id) : undefined;
  if (!shape || r === undefined || r < EPS || (shape.kind !== 'circle' && shape.kind !== 'arc')) return null;
  const c = shape.center;
  const u = unit(sub(label, c)) ?? [1, 0];
  const reach = Math.max(r, len(sub(label, c)));
  const edge = along(c, u, r);
  if (row.kind === 'radius')
    return { lines: [[c, along(c, u, reach)]], arrows: [{ at: edge, dir: u, span: Infinity }] };
  const opposite = along(c, u, -r);
  return {
    lines: [[opposite, along(c, u, reach)]],
    arrows: [
      { at: edge, dir: u, span: 2 * r },
      { at: opposite, dir: scale(u, -1), span: 2 * r },
    ],
  };
}

/** The segment an angle's operand draws, or null for a sketch axis or the sketch x direction. */
function segmentOf(g: SketchGeometry, v: unknown): [P2, P2] | null {
  return isPlainObject(v) && !standardOf(v) && !('sketchX' in v) ? (g.operandLine(v) ?? null) : null;
}

/**
 * An arc about the angle's vertex, through the label, from one line to the
 * other, on the side of the vertex the label is on. A line that stops short
 * of the arc, or starts beyond it, gets an extension line along itself; a
 * side with no segment (an axis, or the sketch x direction) gets one from
 * the vertex.
 */
function angle(g: SketchGeometry, row: Json, label: P2): DimensionLines | null {
  const frame = angleFrame(g, row);
  if (!frame) return null;
  const { vertex, theta } = frame;
  const w = sub(label, vertex);
  const radius = len(w);
  if (radius < EPS) return null;
  const sign = angleSide(frame, label);
  const ra = scale(frame.a, sign);
  const rb = scale(frame.b, sign);
  const start = Math.atan2(ra[1], ra[0]);
  const steps = Math.max(2, Math.ceil(Math.abs(theta) / ARC_STEP));
  const arc = Array.from({ length: steps + 1 }, (_, i): P2 => {
    const t = start + (theta * i) / steps;
    return [vertex[0] + radius * Math.cos(t), vertex[1] + radius * Math.sin(t)];
  });
  const reach = (segment: [P2, P2] | null, ray: P2): P2[][] => {
    const end = along(vertex, ray, radius);
    if (!segment) return extension(vertex, end);
    const ts = segment.map((p) => dot(sub(p, vertex), ray));
    const [lo, hi] = [Math.min(...ts), Math.max(...ts)];
    if (radius > hi) return extension(along(vertex, ray, hi), end);
    if (radius < lo) return extension(end, along(vertex, ray, lo));
    return [];
  };
  const turn = Math.sign(theta);
  const span = radius * Math.abs(theta);
  return {
    lines: [...reach(segmentOf(g, row.a), ra), ...reach(segmentOf(g, row.b), rb), arc],
    arrows: [
      { at: arc[0] as P2, dir: scale(perp(ra), -turn), span },
      { at: arc[steps] as P2, dir: scale(perp(rb), turn), span },
    ],
  };
}

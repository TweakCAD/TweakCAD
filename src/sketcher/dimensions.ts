/**
 * Dimensions (8.2): what a pick of one or two entities dimensions (a
 * line its length, a round curve its size, two entities the distance or
 * angle between them), and where and how a dimension's label shows.
 */
import { isPlainObject } from '@tweakcad/format';
import type { SketchGeometry } from './geometry';
import { operandFor } from './constraints';
import { exprText, isMeasured, operandOf, standardName, standardOf, type Json, type P2 } from './rows';

/** `free` dimensions what was picked; `x` and `y` measure along the sketch axes only. */
export type DimensionMode = 'free' | 'x' | 'y';

export interface DimensionPlan {
  kind: string;
  fields: Json;
  /** The current measure: the dimension's value, so placing it moves nothing. */
  value: number;
}

const LINE_LIKE = (g: SketchGeometry, id: string) =>
  g.curves.get(id)?.kind === 'line' || standardName(id) === 'x' || standardName(id) === 'y';
const ref = (g: SketchGeometry, id: string) => operandFor(g, id);
const ROUND = (g: SketchGeometry, id: string) => {
  const k = g.curves.get(id)?.kind;
  return k === 'circle' || k === 'arc';
};

function centerOf(g: SketchGeometry, id: string): string | undefined {
  const row = g.curves.get(id)?.row;
  return row && (row.kind === 'circle' || row.kind === 'arc') ? (row.center as string) : undefined;
}

/** Two points measured along an axis, ordered so the value is positive. */
function alongAxis(g: SketchGeometry, kind: 'distanceX' | 'distanceY', a: string, b: string): DimensionPlan | null {
  const [pa, pb] = [g.point(a), g.point(b)];
  if (!pa || !pb) return null;
  const axis = kind === 'distanceX' ? 0 : 1;
  const [first, second] = pb[axis] >= pa[axis] ? [a, b] : [b, a];
  const value = Math.abs(pb[axis] - pa[axis]);
  return { kind, fields: { a: ref(g, first), b: ref(g, second) }, value };
}

function between(g: SketchGeometry, a: string, b: string): DimensionPlan | null {
  const [pa, pb] = [g.point(a), g.point(b)];
  return pa && pb
    ? { kind: 'distance', fields: { a: ref(g, a), b: ref(g, b) }, value: Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) }
    : null;
}

/**
 * The dimension for one or two picked entities (point or curve ids), or
 * null when they cannot be dimensioned together.
 */
export function planDimension(g: SketchGeometry, picks: readonly string[], mode: DimensionMode): DimensionPlan | null {
  const pointOf = (id: string) =>
    g.points.has(id) || standardName(id) === 'origin'
      ? id
      : g.curves.get(id)?.kind === 'point'
        ? (g.curves.get(id)?.row.at as string)
        : undefined;
  if (picks.every((id) => standardName(id) !== null)) return null;
  const axisKind = mode === 'x' ? 'distanceX' : 'distanceY';
  if (picks.length === 1) {
    const id = picks[0] as string;
    const row = g.curves.get(id)?.row;
    if (!row) return null;
    if (row.kind === 'line') {
      const [a, b] = [row.start as string, row.end as string];
      return mode === 'free' ? between(g, a, b) : alongAxis(g, axisKind, a, b);
    }
    if (mode !== 'free') return null;
    // An ellipse alone: its major radius, from the centre to the major axis end.
    if (row.kind === 'ellipse' || row.kind === 'ellipticalArc')
      return between(g, row.center as string, row.majorEnd as string);
    const r = g.radius(id);
    if (r === undefined) return null;
    return row.kind === 'circle'
      ? { kind: 'diameter', fields: { curve: ref(g, id) }, value: 2 * r }
      : { kind: 'radius', fields: { curve: ref(g, id) }, value: r };
  }
  if (picks.length !== 2) return null;
  const [x, y] = picks as [string, string];
  const [px, py] = [pointOf(x), pointOf(y)];
  if (px && py) return mode === 'free' ? between(g, px, py) : alongAxis(g, axisKind, px, py);
  if (mode !== 'free') {
    // Along an axis, a circle or arc stands for its centre.
    const [cx, cy] = [px ?? centerOf(g, x), py ?? centerOf(g, y)];
    return cx && cy ? alongAxis(g, axisKind, cx, cy) : null;
  }
  if (px || py) {
    const [p, curve] = px ? [px, y] : [py as string, x];
    if (!LINE_LIKE(g, curve) && !ROUND(g, curve)) return null;
    const fields = { a: ref(g, p), b: ref(g, curve) };
    const value = g.measure({ kind: 'distance', ...fields });
    return value === null ? null : { kind: 'distance', fields, value };
  }
  if (LINE_LIKE(g, x) && LINE_LIKE(g, y)) {
    const [dx, dy] = [g.direction(x), g.direction(y)];
    if (!dx || !dy) return null;
    const cross = dx[0] * dy[1] - dx[1] * dy[0];
    if (Math.abs(cross) < 1e-9) {
      // Parallel lines: the distance from one to the other, measured from a sketch line's start.
      const [on, other] = standardName(y) ? [x, y] : [y, x];
      const start = g.curves.get(on)?.row.start as string;
      const fields = { a: ref(g, start), b: ref(g, other) };
      const value = g.measure({ kind: 'distance', ...fields });
      return value === null ? null : { kind: 'distance', fields, value };
    }
    // Counter-clockwise from a to b (8.2), ordered so the angle is positive.
    const [a, b] = cross > 0 ? [x, y] : [y, x];
    const fields = { a: ref(g, a), b: ref(g, b) };
    const value = g.measure({ kind: 'angle', ...fields });
    return value === null ? null : { kind: 'angle', fields, value };
  }
  const [cx, cy] = [centerOf(g, x), centerOf(g, y)];
  if (cx && cy) return between(g, cx, cy);
  const center = cx ?? cy;
  const line = cx ? y : x;
  if (center && LINE_LIKE(g, line)) {
    const fields = { a: ref(g, center), b: ref(g, line) };
    const value = g.measure({ kind: 'distance', ...fields });
    return value === null ? null : { kind: 'distance', fields, value };
  }
  return null;
}

/** A number as a label shows it: at most two decimals, no trailing zeros. */
export function formatNumber(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toString();
}

/** A measure as expression text, precise to a thousandth: the value a new dimension starts with. */
export function valueText(v: number, angle: boolean): string {
  const rounded = Math.round(v * 1000) / 1000;
  return `${Object.is(rounded, -0) ? 0 : rounded} ${angle ? 'deg' : 'mm'}`;
}

/** What a dimension's label reads, e.g. "40 mm", "R 5 mm", "30°"; a driven one in brackets. */
export function labelText(row: Json, measured: number | null): string {
  const v = measured ?? (typeof row.solved === 'number' ? row.solved : 0);
  const n = formatNumber(Math.abs(v));
  const text =
    row.kind === 'angle'
      ? `${n}°`
      : row.kind === 'radius'
        ? `R ${n} mm`
        : row.kind === 'diameter'
          ? `⌀ ${n} mm`
          : `${n} mm`;
  return isMeasured(row.value) ? `(${text})` : text;
}

/**
 * The expression as its field shows it beside `unit`: a plain number in
 * that unit loses the unit (the field adds it back); anything else stays.
 */
export function fieldText(expression: string, unit: string): string {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z]+)\s*$/i.exec(expression);
  return m && m[2]?.toLowerCase() === unit ? (m[1] as string) : expression;
}

/** The expression a label edits. */
export function labelExpression(row: Json, measured: number | null): string {
  return exprText(row.value) ?? valueText(measured ?? 0, row.kind === 'angle');
}

/** Where a dimension's label is drawn, in sketch coordinates. */
export function labelAnchor(g: SketchGeometry, row: Json): P2 | null {
  const label = row.label;
  if (isPlainObject(label) && isPlainObject(label.at) && Array.isArray(label.at.p)) return label.at.p as unknown as P2;
  const point = (v: unknown) => g.operandPoint(v);
  const curve = (v: unknown) => {
    const o = operandOf(v);
    return o && !o.point ? o.id : undefined;
  };
  const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  switch (row.kind) {
    case 'distance': {
      const [a, b] = [point(row.a), point(row.b)];
      if (a && b) return mid(a, b);
      const p = a ?? b;
      if (!p) return null;
      // To a sketch axis: the foot on it.
      const axis = standardOf(a ? row.b : row.a);
      if (axis === 'x') return mid(p, [p[0], 0]);
      if (axis === 'y') return mid(p, [0, p[1]]);
      const c = curve(a ? row.b : row.a);
      const shape = c ? g.curves.get(c)?.curve : undefined;
      if (!shape) return null;
      const hit = shape.closest(p as [number, number])[0];
      return hit ? mid(p, shape.point(hit.t)) : p;
    }
    case 'distanceX': {
      const [a, b] = [point(row.a), point(row.b)];
      return a && b ? [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 4] : null;
    }
    case 'distanceY': {
      const [a, b] = [point(row.a), point(row.b)];
      return a && b ? [Math.max(a[0], b[0]) + 4, (a[1] + b[1]) / 2] : null;
    }
    case 'length': {
      const c = curve(row.curve);
      return c ? (g.middleOf(c) ?? null) : null;
    }
    case 'radius':
    case 'diameter': {
      const c = curve(row.curve);
      const shape = c ? g.curves.get(c)?.shape : undefined;
      const r = c ? g.radius(c) : undefined;
      if (!shape || r === undefined || (shape.kind !== 'circle' && shape.kind !== 'arc')) return null;
      return [shape.center[0] + r * 0.6, shape.center[1] + r * 0.6];
    }
    case 'angle': {
      const a = curve(row.a);
      const b = curve(row.b);
      const ma = a ? g.middleOf(a) : undefined;
      const mb = b ? g.middleOf(b) : undefined;
      // Against an axis or the sketch x direction, beside the line alone.
      return ma && mb ? mid(ma, mb) : (ma ?? mb ?? null);
    }
    default:
      return null;
  }
}

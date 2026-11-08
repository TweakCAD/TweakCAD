/**
 * The geometry of a working copy of a sketch at its stored positions: each
 * curve's shape and flattening for drawing and picking, and the measures
 * dimensions report.
 */
import { prepareCurve, type Curve, type CurveShape, type ValueEvaluator } from '@tweakcad/format';
import { curveGeometry, curveReader } from '@tweakcad/worker/src/v2/sketchCurves';
import { DIMENSION_KINDS, STANDARD_IDS, curvePoints, operandOf, standardOf, table, type Json, type P2 } from './rows';

const FLAG = { type: 'boolean' } as const;

export interface CurveView {
  id: string;
  row: Json;
  kind: string;
  construction: boolean;
  /** Null for a point curve, or a curve whose shape cannot be read. */
  shape: CurveShape | null;
  curve: Curve | null;
  /** The flattened curve, for drawing and picking. */
  polyline: P2[];
}

/** Whether a flag value object reads true; a value that cannot be read is false. */
export function flagOn(values: ValueEvaluator, v: unknown): boolean {
  try {
    return values.literal(v, FLAG) === true;
  } catch {
    return false;
  }
}

export class SketchGeometry {
  readonly points = new Map<string, P2>();
  readonly curves = new Map<string, CurveView>();
  /** The points live curves use; the others are kept only for retired rows and are not shown. */
  readonly used = new Set<string>();

  /**
   * @param externals the shapes evaluation built for external curve rows,
   * by row id; a row without one has no shape here.
   */
  constructor(
    readonly inputs: Json,
    readonly values: ValueEvaluator,
    readonly externals: ReadonlyMap<string, CurveShape> = new Map(),
  ) {
    for (const p of table(inputs, 'points')) {
      if (typeof p.x === 'number' && typeof p.y === 'number') this.points.set(p.id as string, [p.x, p.y]);
    }
    const read = curveReader(values, this.points, () => undefined);
    for (const row of table(inputs, 'curves')) {
      for (const p of curvePoints(row)) this.used.add(p);
      const id = row.id as string;
      const kind = row.kind as string;
      let shape: CurveShape | null;
      try {
        shape = kind === 'external' ? (externals.get(id) ?? null) : (curveGeometry(row, read)?.shape ?? null);
      } catch {
        shape = null;
      }
      const closed = kind === 'arc' && row.start === row.end;
      const curve = shape ? prepareCurve(shape, closed) : null;
      const polyline = curve ? curve.flatten(curve.tMin, curve.tMax, 2) : [];
      this.curves.set(id, { id, row, kind, construction: flagOn(values, row.construction), shape, curve, polyline });
    }
  }

  /** A sketch point, or the sketch origin by its selection id. */
  point(id: string): P2 | undefined {
    return id === STANDARD_IDS.origin ? [0, 0] : this.points.get(id);
  }

  /** The shortest distance from `p` to a curve; a point curve is its point. */
  distanceToCurve(id: string, p: P2): number {
    const c = this.curves.get(id);
    if (!c) return Infinity;
    if (c.kind === 'point') {
      const at = this.points.get(c.row.at as string);
      return at ? Math.hypot(p[0] - at[0], p[1] - at[1]) : Infinity;
    }
    if (!c.curve) return Infinity;
    const hits = c.curve.closest(p as [number, number]);
    return hits.length > 0 ? Math.min(...hits.map((h) => h.distance)) : Infinity;
  }

  /** A line's midpoint. */
  midpoint(id: string): P2 | undefined {
    const c = this.curves.get(id);
    if (!c || c.kind !== 'line') return undefined;
    const [a, b] = [this.points.get(c.row.start as string), this.points.get(c.row.end as string)];
    return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : undefined;
  }

  /** A circle's or arc's radius at the stored positions. */
  radius(id: string): number | undefined {
    const s = this.curves.get(id)?.shape;
    if (s?.kind === 'circle') return s.radius;
    if (s?.kind === 'arc') return Math.hypot(s.start[0] - s.center[0], s.start[1] - s.center[1]);
    return undefined;
  }

  /** A line's direction from start to end, unit length. */
  direction(id: string): P2 | undefined {
    if (id === STANDARD_IDS.x) return [1, 0];
    if (id === STANDARD_IDS.y) return [0, 1];
    const c = this.curves.get(id);
    if (!c || c.kind !== 'line') return undefined;
    const [a, b] = [this.points.get(c.row.start as string), this.points.get(c.row.end as string)];
    if (!a || !b) return undefined;
    const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return n > 0 ? [(b[0] - a[0]) / n, (b[1] - a[1]) / n] : undefined;
  }

  /** A point on a curve near its middle, for glyphs and labels. */
  middleOf(id: string): P2 | undefined {
    const c = this.curves.get(id);
    if (!c) return undefined;
    if (c.kind === 'point') return this.points.get(c.row.at as string);
    if (!c.curve) return undefined;
    return c.curve.point((c.curve.tMin + c.curve.tMax) / 2) as P2;
  }

  /** The point an operand names: a sketch point, or the sketch origin. */
  operandPoint(v: unknown): P2 | undefined {
    if (standardOf(v) === 'origin') return [0, 0];
    const o = operandOf(v);
    return o?.point ? this.points.get(o.id) : undefined;
  }

  /** The line an operand names, from start to end: a sketch line, or a sketch axis from the origin. */
  operandLine(v: unknown): [P2, P2] | undefined {
    const standard = standardOf(v);
    if (standard === 'x')
      return [
        [0, 0],
        [1, 0],
      ];
    if (standard === 'y')
      return [
        [0, 0],
        [0, 1],
      ];
    const o = operandOf(v);
    const s = o && !o.point ? this.curves.get(o.id)?.shape : undefined;
    return s?.kind === 'line' ? [s.start, s.end] : undefined;
  }

  /** What a dimension measures at the stored positions, in mm or degrees; null when its operands do not fit. */
  measure(row: Json): number | null {
    if (!DIMENSION_KINDS.has(row.kind as string)) return null;
    const pt = (v: unknown) => this.operandPoint(v);
    const crv = (v: unknown) => {
      const o = operandOf(v);
      return o && !o.point ? this.curves.get(o.id) : undefined;
    };
    const unit = (line: [P2, P2] | undefined): P2 | undefined => {
      if (!line) return undefined;
      const [a, b] = line;
      const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return n > 0 ? [(b[0] - a[0]) / n, (b[1] - a[1]) / n] : undefined;
    };
    switch (row.kind) {
      case 'distance': {
        const [pa, pb] = [pt(row.a), pt(row.b)];
        if (pa && pb) return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        const p = pa ?? pb;
        const other = pa ? row.b : row.a;
        if (!p) return null;
        const line = this.operandLine(other);
        if (line) {
          const [a, b] = line;
          const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
          return n > 0 ? Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / n : null;
        }
        const c = crv(other);
        if (!c?.shape) return null;
        const r = this.radius(c.id);
        const center = c.shape.kind === 'circle' || c.shape.kind === 'arc' ? c.shape.center : undefined;
        return r !== undefined && center ? Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1]) - r) : null;
      }
      case 'distanceX':
      case 'distanceY': {
        const [pa, pb] = [pt(row.a), pt(row.b)];
        if (!pa || !pb) return null;
        return row.kind === 'distanceX' ? pb[0] - pa[0] : pb[1] - pa[1];
      }
      case 'length': {
        const c = crv(row.curve);
        return c?.curve ? c.curve.length : null;
      }
      case 'radius':
      case 'diameter': {
        const c = crv(row.curve);
        const r = c ? this.radius(c.id) : undefined;
        return r === undefined ? null : row.kind === 'radius' ? r : 2 * r;
      }
      case 'angle': {
        const da = unit(this.operandLine(row.a));
        const b = row.b as Json;
        const db: P2 | undefined = b && 'sketchX' in b ? [1, 0] : unit(this.operandLine(row.b));
        if (!da || !db) return null;
        return (Math.atan2(da[0] * db[1] - da[1] * db[0], da[0] * db[0] + da[1] * db[1]) * 180) / Math.PI;
      }
      default:
        return null;
    }
  }
}

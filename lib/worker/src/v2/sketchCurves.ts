/** The geometry of version-2 sketch curve rows (8.1), shared by the solve and region detection. */
import {
  FormatError,
  bezierShape,
  conicShape,
  splineShape,
  type CurveAnchors,
  type CurveShape,
  type ValueEvaluator,
  type ValueTarget,
} from '@tweakcad/format';
import { FLAG, FeaturePause, INTEGER, RATIO, type Json } from './context';

type P2 = readonly [number, number];

/** What building a curve's geometry reads: its points, its shape values and its solved variables. */
export interface CurveReader {
  point: (id: unknown) => P2;
  /** A value object as a number; a flag reads 1 or 0. */
  number: (v: unknown, target: ValueTarget) => number;
  /** A curve's solved variable (a circle's radius, an ellipse's minor radius), when the sketch was solved. */
  variable: (curve: string) => number | undefined;
}

function equivalent<T>(make: () => T): T {
  try {
    return make();
  } catch (e) {
    if (e instanceof FormatError) throw new FeaturePause(e.message);
    throw e;
  }
}

/** A `nurbs` row's shape (8.1): its poles are sketch points; degree, weights and knots are shape values. */
function nurbsGeometry(c: Json, read: CurveReader): { shape: CurveShape; anchors: CurveAnchors } {
  const poleIds = c.poles as string[];
  const degree = read.number(c.degree, INTEGER);
  const weights = (c.weights as Json[]).map((w) => read.number(w, RATIO));
  const knots = (c.knots as Json[]).map((k) => read.number(k, RATIO));
  const multiplicities = c.multiplicities as number[];
  const periodic = read.number(c.periodic, FLAG) === 1;
  const last = multiplicities[multiplicities.length - 1] ?? 0;
  const flat = multiplicities.reduce((s, m) => s + m, 0) - (periodic ? last : 0);
  if (!(degree >= 1) || poleIds.length < 2 || weights.some((w) => !(w > 0))) {
    throw new FeaturePause('a nurbs curve has too few poles or a weight that is not positive');
  }
  if (knots.some((k, i) => i > 0 && !(k > (knots[i - 1] as number))))
    throw new FeaturePause('nurbs knots do not increase');
  if (
    multiplicities.some((m) => m > degree + 1) ||
    flat !== (periodic ? poleIds.length : poleIds.length + degree + 1)
  ) {
    throw new FeaturePause('nurbs knots do not fit its poles and degree');
  }
  const shape: CurveShape = {
    kind: 'nurbs',
    degree,
    poles: poleIds.map(read.point),
    weights,
    knots,
    multiplicities,
    periodic,
  };
  const clamped = !periodic && multiplicities[0] === degree + 1 && last === degree + 1;
  const anchors: CurveAnchors = periodic
    ? { kind: 'none' }
    : clamped
      ? { kind: 'points', start: poleIds[0] as string, end: poleIds[poleIds.length - 1] as string }
      : { kind: 'extremities' };
  return { shape, anchors };
}

/**
 * The solved shape of a curve row and how its ends are named; null for a
 * `point` or `external` row, which bounds no region here. A spline, bezier and
 * conic become the NURBS they stand for.
 */
export function curveGeometry(c: Json, read: CurveReader): { shape: CurveShape; anchors: CurveAnchors } | null {
  const id = c.id as string;
  const pt = read.point;
  const ends: CurveAnchors = { kind: 'points', start: c.start as string, end: c.end as string };
  switch (c.kind) {
    case 'line':
      return { shape: { kind: 'line', start: pt(c.start), end: pt(c.end) }, anchors: ends };
    case 'arc':
      return { shape: { kind: 'arc', center: pt(c.center), start: pt(c.start), end: pt(c.end) }, anchors: ends };
    case 'circle':
      return {
        shape: { kind: 'circle', center: pt(c.center), radius: read.variable(id) ?? (c.radius as number) },
        anchors: { kind: 'none' },
      };
    case 'ellipse':
    case 'ellipticalArc': {
      const minorRadius = read.variable(id) ?? (c.minorRadius as number);
      const [center, majorEnd] = [pt(c.center), pt(c.majorEnd)];
      if (c.kind === 'ellipse')
        return { shape: { kind: 'ellipse', center, majorEnd, minorRadius }, anchors: { kind: 'none' } };
      return {
        shape: { kind: 'ellipticalArc', center, majorEnd, minorRadius, start: pt(c.start), end: pt(c.end) },
        anchors: ends,
      };
    }
    case 'spline': {
      const through = c.through as string[];
      const shape = equivalent(() => splineShape(through.map(pt)));
      const anchors: CurveAnchors = {
        kind: 'points',
        start: through[0] as string,
        end: through[through.length - 1] as string,
        through: through.slice(1, -1),
      };
      return { shape, anchors };
    }
    case 'bezier':
      return { shape: bezierShape(pt(c.start), pt(c.c1), pt(c.c2), pt(c.end)), anchors: ends };
    case 'conic':
      return {
        shape: equivalent(() => conicShape(pt(c.start), pt(c.apex), pt(c.end), read.number(c.rho, RATIO))),
        anchors: ends,
      };
    case 'nurbs':
      return nurbsGeometry(c, read);
    case 'point':
    case 'external':
      return null;
    default:
      throw new FeaturePause(`sketch curves of kind ${String(c.kind)} are not built yet`);
  }
}

/** Reads curve rows against solved (or stored) point positions and the document's values. */
export function curveReader(
  values: ValueEvaluator,
  points: ReadonlyMap<string, P2>,
  variable: (curve: string) => number | undefined,
): CurveReader {
  return {
    point: (id) => {
      const p = points.get(id as string);
      if (!p) throw new FeaturePause(`point ${String(id)} is missing`);
      return p;
    },
    number: (v, target) =>
      target.type === 'boolean' ? (values.literal(v, target) === true ? 1 : 0) : values.number(v, target),
    variable,
  };
}

/** The sketch points that define a curve row: what holds it in place. */
export function definingPoints(c: Json): string[] {
  switch (c.kind) {
    case 'line':
      return [c.start, c.end] as string[];
    case 'circle':
      return [c.center] as string[];
    case 'arc':
      return [c.center, c.start, c.end] as string[];
    case 'ellipse':
      return [c.center, c.majorEnd] as string[];
    case 'ellipticalArc':
      return [c.center, c.majorEnd, c.start, c.end] as string[];
    case 'spline':
      return c.through as string[];
    case 'bezier':
      return [c.start, c.c1, c.c2, c.end] as string[];
    case 'nurbs':
      return c.poles as string[];
    case 'conic':
      return [c.start, c.apex, c.end] as string[];
    case 'point':
      return [c.at] as string[];
    default:
      return [];
  }
}

/** A curve row's control points in order, for the kinds that are B-splines over sketch points. */
export function polesOf(c: Json): string[] | null {
  switch (c.kind) {
    case 'bezier':
      return [c.start, c.c1, c.c2, c.end] as string[];
    case 'conic':
      return [c.start, c.apex, c.end] as string[];
    case 'nurbs':
      return c.poles as string[];
    default:
      return null;
  }
}

/**
 * Relations and dimensions as constraint rows (8.2).
 *
 * Imported geometry does not move. A constraint is proposed only when the
 * geometry already satisfies it; the worker then solves the sketch and takes
 * out whatever the solver cannot hold still. Coincident points are one shared
 * point by the time rows are written, so coincidence writes no row.
 */
import type { F3dDimension, F3dRelation, F3dRelationKind } from './parser/types';
import { ANGLE, LENGTH, type ParameterPlan } from './parameters';
import { deg, mm } from './placement';
import type { Json, Writer } from './writer';

const LENGTH_TOLERANCE_MM = 1e-4;
const ANGLE_TOLERANCE_RAD = 1e-6;

export type SkipReason = 'noCounterpart' | 'notSatisfied' | 'unsupportedGeometry' | 'merged';

export type Pt = { id: string; x: number; y: number };
export type Line = { id: string; a: Pt; b: Pt };
export type Round = { id: string; center: Pt; radius: number };
export type Locus = { kind: 'point'; point: Pt } | { kind: 'line'; line: Line } | { kind: 'round'; round: Round };

export interface ConstraintContext {
  w: Writer;
  plan: ParameterPlan;
  /** A file point or curve, as it was written. */
  locus(fileId: number): Locus | null;
}

type Outcome = { rows: Json[] } | { skip: SkipReason };
const skip = (reason: SkipReason): Outcome => ({ skip: reason });

const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const direction = (l: Line): [number, number] => {
  const length = distance(l.a, l.b) || 1;
  return [(l.b.x - l.a.x) / length, (l.b.y - l.a.y) / length];
};
const distanceToLine = (p: Pt, l: Line): number => {
  const [dx, dy] = direction(l);
  return Math.abs((p.x - l.a.x) * dy - (p.y - l.a.y) * dx);
};
const cross = (a: [number, number], b: [number, number]): number => a[0] * b[1] - a[1] * b[0];
const dotOf = (a: [number, number], b: [number, number]): number => a[0] * b[0] + a[1] * b[1];
const near = (a: number, b: number, tolerance = LENGTH_TOLERANCE_MM): boolean => Math.abs(a - b) <= tolerance;

function reflect(p: Pt, l: Line): { x: number; y: number } {
  const [dx, dy] = direction(l);
  const t = (p.x - l.a.x) * dx + (p.y - l.a.y) * dy;
  const fx = l.a.x + t * dx;
  const fy = l.a.y + t * dy;
  return { x: 2 * fx - p.x, y: 2 * fy - p.y };
}

const P = (p: Pt): Json => ({ point: { id: p.id } });
const K = (c: { id: string }): Json => ({ curve: { id: c.id } });

function row(ctx: ConstraintContext, kind: string, fields: Json): Json {
  return { id: ctx.w.ids('con'), kind, active: ctx.w.flag(true), ...fields };
}

function symmetric(ctx: ConstraintContext, loci: Locus[]): Outcome {
  const lines = loci.filter((l): l is Extract<Locus, { kind: 'line' }> => l.kind === 'line');
  const axis = lines[lines.length - 1];
  if (!axis) return skip('notSatisfied');
  const rest = loci.filter((l) => l !== axis);
  if (rest.length !== 2) return skip('unsupportedGeometry');
  const [a, b] = rest as [Locus, Locus];
  const mirrorOf = (p: Pt, q: Pt): boolean => {
    const m = reflect(p, axis.line);
    return near(m.x, q.x) && near(m.y, q.y);
  };
  const pair = (p: Pt, q: Pt): Json | null =>
    p.id !== q.id && mirrorOf(p, q) ? row(ctx, 'symmetric', { a: P(p), b: P(q), axis: K(axis.line) }) : null;

  if (a.kind === 'point' && b.kind === 'point') {
    const c = pair(a.point, b.point);
    return c ? { rows: [c] } : skip('notSatisfied');
  }
  if (a.kind === 'line' && b.kind === 'line') {
    const straight = [pair(a.line.a, b.line.a), pair(a.line.b, b.line.b)];
    const crossed = [pair(a.line.a, b.line.b), pair(a.line.b, b.line.a)];
    const chosen = straight.every(Boolean) ? straight : crossed.every(Boolean) ? crossed : null;
    return chosen ? { rows: chosen as Json[] } : skip('notSatisfied');
  }
  if (a.kind === 'round' && b.kind === 'round') {
    const c = pair(a.round.center, b.round.center);
    if (!c || !near(a.round.radius, b.round.radius)) return skip('notSatisfied');
    return { rows: [c, row(ctx, 'equal', { a: K(a.round), b: K(b.round) })] };
  }
  return skip('unsupportedGeometry');
}

function tangent(ctx: ConstraintContext, loci: Locus[]): Outcome {
  const [a, b] = loci as [Locus, Locus];
  const lineAndRound =
    a.kind === 'line' && b.kind === 'round'
      ? ([a.line, b.round] as const)
      : a.kind === 'round' && b.kind === 'line'
        ? ([b.line, a.round] as const)
        : null;
  if (lineAndRound) {
    const [line, round] = lineAndRound;
    if (!near(distanceToLine(round.center, line), round.radius)) return skip('notSatisfied');
    return { rows: [row(ctx, 'tangent', { a: K(line), b: K(round), internal: ctx.w.flag(false) })] };
  }
  if (a.kind === 'round' && b.kind === 'round') {
    const d = distance(a.round.center, b.round.center);
    const external = near(d, a.round.radius + b.round.radius);
    if (!external && !near(d, Math.abs(a.round.radius - b.round.radius))) return skip('notSatisfied');
    return { rows: [row(ctx, 'tangent', { a: K(a.round), b: K(b.round), internal: ctx.w.flag(!external) })] };
  }
  return skip('unsupportedGeometry');
}

function coincident(ctx: ConstraintContext, loci: Locus[]): Outcome {
  const [a, b] = loci as [Locus, Locus];
  if (a.kind === 'point' && b.kind === 'point')
    return a.point.id === b.point.id ? skip('merged') : skip('notSatisfied');
  const point = a.kind === 'point' ? a.point : b.kind === 'point' ? b.point : null;
  const curve = a.kind === 'point' ? b : a;
  if (!point) return skip('unsupportedGeometry');
  if (curve.kind === 'line') {
    if (point.id === curve.line.a.id || point.id === curve.line.b.id) return skip('merged');
    return near(distanceToLine(point, curve.line), 0)
      ? { rows: [row(ctx, 'pointOnCurve', { point: P(point), curve: K(curve.line) })] }
      : skip('notSatisfied');
  }
  if (curve.kind === 'round') {
    return near(distance(point, curve.round.center), curve.round.radius)
      ? { rows: [row(ctx, 'pointOnCurve', { point: P(point), curve: K(curve.round) })] }
      : skip('notSatisfied');
  }
  return skip('unsupportedGeometry');
}

function orientation(ctx: ConstraintContext, loci: Locus[], kind: 'horizontal' | 'vertical'): Outcome {
  const [a, b] = loci as [Locus, Locus | undefined];
  if (a.kind === 'line') {
    const [dx, dy] = direction(a.line);
    return near(kind === 'horizontal' ? dy : dx, 0, ANGLE_TOLERANCE_RAD)
      ? { rows: [row(ctx, kind, { of: K(a.line) })] }
      : skip('notSatisfied');
  }
  if (a.kind === 'point' && b?.kind === 'point') {
    if (a.point.id === b.point.id) return skip('merged');
    const level = kind === 'horizontal' ? near(a.point.y, b.point.y) : near(a.point.x, b.point.x);
    return level
      ? { rows: [row(ctx, kind, { of: { points: { a: P(a.point), b: P(b.point) } } })] }
      : skip('notSatisfied');
  }
  return skip('unsupportedGeometry');
}

function byKind(ctx: ConstraintContext, kind: F3dRelationKind, loci: Locus[]): Outcome {
  const [a, b] = loci as [Locus, Locus | undefined];
  switch (kind) {
    case 'coincident':
      return loci.length === 2 ? coincident(ctx, loci) : skip('unsupportedGeometry');
    case 'horizontal':
    case 'vertical':
      return orientation(ctx, loci, kind);
    case 'tangent':
      return loci.length === 2 ? tangent(ctx, loci) : skip('unsupportedGeometry');
    case 'symmetric':
      return symmetric(ctx, loci);
    case 'parallel':
    case 'perpendicular': {
      if (a.kind !== 'line' || b?.kind !== 'line') return skip('unsupportedGeometry');
      const [da, db] = [direction(a.line), direction(b.line)];
      if (!near(kind === 'parallel' ? cross(da, db) : dotOf(da, db), 0, ANGLE_TOLERANCE_RAD))
        return skip('notSatisfied');
      return { rows: [row(ctx, kind, { a: K(a.line), b: K(b.line) })] };
    }
    case 'collinear': {
      if (a.kind !== 'line' || b?.kind !== 'line') return skip('unsupportedGeometry');
      if (!near(distanceToLine(b.line.a, a.line), 0) || !near(distanceToLine(b.line.b, a.line), 0))
        return skip('notSatisfied');
      return { rows: [row(ctx, 'collinear', { a: K(a.line), b: K(b.line) })] };
    }
    case 'concentric': {
      if (a.kind !== 'round' || b?.kind !== 'round') return skip('unsupportedGeometry');
      if (a.round.center.id === b.round.center.id) return skip('merged');
      if (!near(distance(a.round.center, b.round.center), 0)) return skip('notSatisfied');
      return { rows: [row(ctx, 'concentric', { a: K(a.round), b: K(b.round) })] };
    }
    case 'equal': {
      if (a.kind === 'line' && b?.kind === 'line') {
        if (!near(distance(a.line.a, a.line.b), distance(b.line.a, b.line.b))) return skip('notSatisfied');
        return { rows: [row(ctx, 'equal', { a: K(a.line), b: K(b.line) })] };
      }
      if (a.kind === 'round' && b?.kind === 'round') {
        if (!near(a.round.radius, b.round.radius)) return skip('notSatisfied');
        return { rows: [row(ctx, 'equal', { a: K(a.round), b: K(b.round) })] };
      }
      return skip('unsupportedGeometry');
    }
    case 'midpoint': {
      const point = a.kind === 'point' ? a.point : b?.kind === 'point' ? b.point : null;
      const line = a.kind === 'line' ? a.line : b?.kind === 'line' ? b.line : null;
      if (!point || !line) return skip('unsupportedGeometry');
      const middle = near(point.x, (line.a.x + line.b.x) / 2) && near(point.y, (line.a.y + line.b.y) / 2);
      return middle ? { rows: [row(ctx, 'midpoint', { point: P(point), curve: K(line) })] } : skip('notSatisfied');
    }
  }
}

function resolved(ctx: ConstraintContext, ids: readonly number[]): Locus[] | null {
  const loci: Locus[] = [];
  for (const id of ids) {
    const locus = ctx.locus(id);
    if (!locus) return null;
    loci.push(locus);
  }
  return loci.length > 0 ? loci : null;
}

export function convertRelation(ctx: ConstraintContext, relation: F3dRelation): Outcome {
  if (relation.kind === 'unknown') return skip('noCounterpart');
  const loci = resolved(ctx, relation.loci);
  return loci ? byKind(ctx, relation.kind, loci) : skip('unsupportedGeometry');
}

function dimensioned(
  ctx: ConstraintContext,
  dimension: F3dDimension,
  kind: string,
  operands: Json,
  shown: number,
): Json {
  const target = kind === 'angle' ? ANGLE : LENGTH;
  const fallback = kind === 'angle' ? deg(shown) : mm(shown);
  return row(ctx, kind, {
    ...operands,
    value: ctx.plan.value(dimension.parameter, fallback, target),
    solved: shown,
    label: { auto: {} },
  });
}

function linear(ctx: ConstraintContext, dimension: F3dDimension, loci: Locus[], value: number): Outcome {
  const axis = dimension.direction === 'aligned' ? null : dimension.direction === 'horizontal' ? 'x' : 'y';
  const kind = axis === 'x' ? 'distanceX' : 'distanceY';

  const between = (a: Pt, b: Pt): Outcome => {
    if (a.id === b.id) return skip('merged');
    if (axis === null) {
      if (!near(distance(a, b), value)) return skip('notSatisfied');
      return { rows: [dimensioned(ctx, dimension, 'distance', { a: P(a), b: P(b) }, value)] };
    }
    const signed = axis === 'x' ? b.x - a.x : b.y - a.y;
    if (!near(Math.abs(signed), value)) return skip('notSatisfied');
    // Written from the lower point, so the value stays positive, as an expression's is.
    const [from, to] = signed >= 0 ? [a, b] : [b, a];
    return { rows: [dimensioned(ctx, dimension, kind, { a: P(from), b: P(to) }, value)] };
  };

  const [a, b] = loci as [Locus, Locus | undefined];
  if (a.kind === 'point' && b?.kind === 'point') return between(a.point, b.point);
  if (a.kind === 'line' && b === undefined) {
    if (axis !== null) return between(a.line.a, a.line.b);
    if (!near(distance(a.line.a, a.line.b), value)) return skip('notSatisfied');
    return { rows: [dimensioned(ctx, dimension, 'length', { curve: K(a.line) }, value)] };
  }
  // A distance to a line.
  const lineThen = (line: Line, point: Pt): Outcome => {
    if (!near(distanceToLine(point, line), value)) return skip('notSatisfied');
    return { rows: [dimensioned(ctx, dimension, 'distance', { a: P(point), b: K(line) }, value)] };
  };
  if (a.kind === 'line' && b?.kind === 'point') return lineThen(a.line, b.point);
  if (a.kind === 'point' && b?.kind === 'line') return lineThen(b.line, a.point);
  if (a.kind === 'line' && b?.kind === 'line') return lineThen(a.line, b.line.a);
  return skip('unsupportedGeometry');
}

export function convertDimension(ctx: ConstraintContext, dimension: F3dDimension): Outcome {
  const parameter = dimension.parameter;
  if (!parameter) return skip('noCounterpart');
  const loci = resolved(ctx, dimension.loci);
  if (!loci) return skip('unsupportedGeometry');
  const [a, b] = loci as [Locus, Locus | undefined];

  switch (dimension.kind) {
    case 'linear':
      return linear(ctx, dimension, loci, parameter.value * 10);
    case 'radial':
    case 'diameter': {
      if (a.kind !== 'round') return skip('unsupportedGeometry');
      const size = parameter.value * 10;
      if (!near(a.round.radius, dimension.kind === 'diameter' ? size / 2 : size)) return skip('notSatisfied');
      return {
        rows: [
          dimensioned(
            ctx,
            dimension,
            dimension.kind === 'diameter' ? 'diameter' : 'radius',
            { curve: K(a.round) },
            size,
          ),
        ],
      };
    }
    case 'angular': {
      if (a.kind !== 'line' || b?.kind !== 'line') return skip('unsupportedGeometry');
      const [da, db] = [direction(a.line), direction(b.line)];
      const measured = Math.atan2(cross(da, db), dotOf(da, db));
      const size = Math.abs(measured);
      // Written from the line that makes the angle positive, as an expression's is.
      const operands = measured >= 0 ? { a: K(a.line), b: K(b.line) } : { a: K(b.line), b: K(a.line) };
      if (near(size, parameter.value, ANGLE_TOLERANCE_RAD))
        return { rows: [dimensioned(ctx, dimension, 'angle', operands, (size * 180) / Math.PI)] };
      // The dimension can measure the other side of the corner, which only the number can say.
      if (near(Math.PI - size, parameter.value, ANGLE_TOLERANCE_RAD)) {
        const shown = (size * 180) / Math.PI;
        return {
          rows: [row(ctx, 'angle', { ...operands, value: ctx.w.val(deg(shown)), solved: shown, label: { auto: {} } })],
        };
      }
      return skip('notSatisfied');
    }
  }
}

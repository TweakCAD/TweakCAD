/**
 * Geometric constraints from the selection: each palette button reads the
 * selected points and curves and writes the constraint rows of 8.2. Coincidence is a shared
 * point (8.1), so "coincident" on points merges them into one. The sketch's
 * origin and axes can be picked too (`sketchStandard`, 8.2): a point made
 * coincident with the origin is held by horizontal and vertical against it.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Change } from './change';
import type { SketchGeometry } from './geometry';
import {
  curvePoints,
  namedIds,
  operandOf,
  standardName,
  standardOf,
  standardOperand,
  table,
  type Json,
  type Operand,
  type RowMaker,
} from './rows';

export type ConstraintKind =
  | 'coincident'
  | 'pointOnLine'
  | 'pointOnCircle'
  | 'hv'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'collinear'
  | 'equal'
  | 'tangent'
  | 'concentric'
  | 'midpoint'
  | 'symmetric'
  | 'fix';

export const CONSTRAINT_KINDS: readonly ConstraintKind[] = [
  'coincident',
  'pointOnLine',
  'pointOnCircle',
  'hv',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'collinear',
  'equal',
  'tangent',
  'concentric',
  'midpoint',
  'symmetric',
  'fix',
];

export const CONSTRAINT_LABELS: Record<ConstraintKind, string> = {
  coincident: 'Coincident',
  pointOnLine: 'Point on line',
  pointOnCircle: 'Point on circle',
  hv: 'H / V',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  collinear: 'Collinear',
  equal: 'Equal',
  tangent: 'Tangent',
  concentric: 'Concentric',
  midpoint: 'Midpoint',
  symmetric: 'Symmetric',
  fix: 'Fix',
};

/** The operand a picked id stands for: a sketch point or curve, an external curve, or the sketch's origin or an axis. */
export function operandFor(geometry: SketchGeometry, id: string): Operand {
  const name = standardName(id);
  if (name) return standardOperand(name);
  if (geometry.points.has(id)) return { point: { id } };
  if (geometry.curves.get(id)?.kind === 'external') return { external: { id } };
  return { curve: { id } };
}

/** The selection sorted by what it is, in selection order. */
export interface Picked {
  points: string[];
  lines: string[];
  /** Circles and arcs. */
  round: string[];
  /** Ellipses and elliptical arcs. */
  elliptic: string[];
  curves: string[];
  /** How many of the picks are the sketch's own origin or axes. */
  standard: number;
}

export function sortSelection(geometry: SketchGeometry, selection: readonly string[]): Picked {
  const out: Picked = { points: [], lines: [], round: [], elliptic: [], curves: [], standard: 0 };
  for (const id of selection) {
    const name = standardName(id);
    if (name) {
      out.standard++;
      if (name === 'origin') out.points.push(id);
      else {
        out.lines.push(id);
        out.curves.push(id);
      }
      continue;
    }
    if (geometry.points.has(id)) out.points.push(id);
    const c = geometry.curves.get(id);
    if (!c) continue;
    if (c.kind === 'point') {
      out.points.push(c.row.at as string);
      continue;
    }
    out.curves.push(id);
    const kind = c.kind === 'external' ? c.shape?.kind : c.kind;
    if (kind === 'line') out.lines.push(id);
    if (kind === 'circle' || kind === 'arc') out.round.push(id);
    if (kind === 'ellipse' || kind === 'ellipticalArc') out.elliptic.push(id);
  }
  return out;
}

const isStandard = (id: string) => standardName(id) !== null;
const own = (p: Picked) => p.points.length + p.curves.length - p.standard;

/** Two points, or two circles or arcs, symmetric about a line picked last. */
function symmetricPicks(p: Picked): { a: string; b: string; axis: string } | null {
  if (p.lines.length < 1) return null;
  const axis = p.lines[p.lines.length - 1] as string;
  const others = p.curves.filter((id) => id !== axis);
  if (p.points.length === 2 && others.length === 0) return { a: p.points[0] as string, b: p.points[1] as string, axis };
  if (p.points.length === 0 && others.length === 2 && others.every((id) => p.round.includes(id))) {
    return { a: others[0] as string, b: others[1] as string, axis };
  }
  return null;
}

function ok(p: Picked): Record<ConstraintKind, boolean> {
  const mine = own(p) > 0;
  const noStandard = p.standard === 0;
  const lineOnly = p.lines.length === p.curves.length;
  const hvLines = p.lines.length >= 1 && lineOnly && p.points.length === 0 && p.lines.every((id) => !isStandard(id));
  const hvPoints = p.points.length === 2 && p.curves.length === 0;
  return {
    coincident: mine && (p.points.length >= 2 || (p.points.length >= 1 && p.curves.length === 1)),
    pointOnLine: mine && p.points.length >= 1 && p.curves.length === 1 && p.lines.length === 1,
    pointOnCircle: mine && p.points.length >= 1 && p.curves.length === 1 && p.round.length === 1,
    hv: mine && (hvLines || hvPoints),
    horizontal: mine && (hvLines || hvPoints),
    vertical: mine && (hvLines || hvPoints),
    parallel: mine && p.lines.length >= 2 && lineOnly && p.points.length === 0,
    perpendicular: mine && p.lines.length === 2 && p.curves.length === 2 && p.points.length === 0,
    collinear: mine && p.lines.length >= 2 && lineOnly && p.points.length === 0,
    equal:
      noStandard &&
      p.points.length === 0 &&
      ((p.lines.length >= 2 && lineOnly) ||
        (p.round.length >= 2 && p.round.length === p.curves.length) ||
        (p.elliptic.length >= 2 && p.elliptic.length === p.curves.length)),
    tangent: mine && p.curves.length === 2 && p.points.length === 0 && p.round.length + p.elliptic.length >= 1,
    concentric:
      noStandard &&
      p.points.length === 0 &&
      p.curves.length >= 2 &&
      p.round.length + p.elliptic.length === p.curves.length,
    midpoint:
      mine &&
      p.points.length >= 1 &&
      p.curves.length === 1 &&
      p.lines.length + p.round.length === 1 &&
      !p.curves.some(isStandard),
    symmetric: mine && symmetricPicks(p) !== null,
    fix: noStandard && p.points.length + p.curves.length >= 1,
  };
}

/** Which constraints the selection fits. */
export function fittingConstraints(picked: Picked): Record<ConstraintKind, boolean> {
  return ok(picked);
}

/** The most picks each constraint takes when it is chosen before the geometry. */
const MOST_PICKS: Record<ConstraintKind, number> = {
  coincident: 2,
  pointOnLine: 2,
  pointOnCircle: 2,
  hv: 2,
  horizontal: 2,
  vertical: 2,
  parallel: 2,
  perpendicular: 2,
  collinear: 2,
  equal: 2,
  tangent: 2,
  concentric: 2,
  midpoint: 2,
  symmetric: 3,
  fix: 1,
};

/** Constraints that take curves only, so a click by a curve's end picks the curve. */
export const CURVE_CONSTRAINTS: ReadonlySet<ConstraintKind> = new Set([
  'parallel',
  'perpendicular',
  'collinear',
  'equal',
  'tangent',
  'concentric',
]);

/** What a constraint chosen first asks to be clicked. */
export const CONSTRAINT_PROMPTS: Record<ConstraintKind, string> = {
  coincident: 'Click a point, then a point or curve',
  pointOnLine: 'Click a point, then a line',
  pointOnCircle: 'Click a point, then a circle or arc',
  hv: 'Click a line, or two points',
  horizontal: 'Click a line, or two points',
  vertical: 'Click a line, or two points',
  parallel: 'Click two lines',
  perpendicular: 'Click two lines',
  collinear: 'Click two lines',
  equal: 'Click two lines, circles or arcs',
  tangent: 'Click a circle or arc, and a line or curve',
  concentric: 'Click two circles or arcs',
  midpoint: 'Click a point, then a line or arc',
  symmetric: 'Click two points or circles, then the line between them',
  fix: 'Click a point or curve to fix or unfix',
};

/**
 * For a constraint chosen before the geometry: whether the picks so far
 * make it (`apply`), may still make it with another pick (`more`), or
 * cannot (`refuse`).
 */
export function constraintPickStep(kind: ConstraintKind, picked: Picked, count: number): 'apply' | 'more' | 'refuse' {
  if (ok(picked)[kind]) return 'apply';
  return count < MOST_PICKS[kind] ? 'more' : 'refuse';
}

/** Why a selection does not make a constraint. */
export function constraintReason(kind: ConstraintKind): string {
  return REASONS[kind];
}

const REASONS: Readonly<Record<ConstraintKind, string>> = {
  coincident: 'Select two or more points, or points and one curve',
  pointOnLine: 'Select points and one line',
  pointOnCircle: 'Select points and one circle or arc',
  hv: 'Select lines, or two points',
  horizontal: 'Select lines, or two points',
  vertical: 'Select lines, or two points',
  parallel: 'Select two or more lines',
  perpendicular: 'Select two lines',
  collinear: 'Select two or more lines',
  equal: 'Select two or more lines, circles and arcs, or ellipses',
  tangent: 'Select a circle, arc or ellipse and a line or another curve',
  concentric: 'Select two or more circles, arcs or ellipses',
  midpoint: 'Select points and one line or arc',
  symmetric: 'Select two points, or two circles or arcs, then the line between them',
  fix: 'Select points or curves',
};

export interface ConstraintContext {
  inputs: Json;
  geometry: SketchGeometry;
  make: RowMaker;
  /** Whether a constraint row is active. */
  active: (row: Json) => boolean;
}

export type ConstraintPlan = { ok: true; change: Change } | { ok: false; message: string };

/**
 * The edit that applies `kind` to the selection; refused with the reason
 * when the selection does not fit.
 */
export function planConstraint(
  kind: ConstraintKind,
  selection: readonly string[],
  ctx: ConstraintContext,
): ConstraintPlan {
  const picked = sortSelection(ctx.geometry, selection);
  if (!ok(picked)[kind])
    return {
      ok: false,
      message: picked.standard > 0 && own(picked) === 0 ? 'Select sketch geometry as well' : REASONS[kind],
    };
  const { make } = ctx;
  const ref = (id: string) => operandFor(ctx.geometry, id);
  const added: Json[] = [];
  const label = `Constrain ${kind === 'fix' ? 'fixed' : kind === 'hv' ? 'horizontal or vertical' : kind === 'pointOnLine' || kind === 'pointOnCircle' ? 'point on curve' : kind}`;
  const add = (c: Json) => added.push(c);
  const done = (): ConstraintPlan => ({ ok: true, change: { label, add: { constraints: added } } });

  switch (kind) {
    case 'pointOnLine':
    case 'pointOnCircle':
    case 'coincident':
      if (picked.curves.length === 1) {
        const curve = picked.curves[0] as string;
        const onIt = new Set(curvePoints(ctx.geometry.curves.get(curve)?.row ?? {}));
        for (const p of picked.points)
          if (!onIt.has(p)) add(make.geometric('pointOnCurve', { point: ref(p), curve: ref(curve) }));
        if (added.length === 0) return { ok: false, message: 'Those points are already on that curve' };
        return done();
      }
      if (picked.points.some(isStandard)) {
        // The origin is no sketch point: each point is held on it by horizontal and vertical against it.
        for (const p of picked.points.filter((q) => !isStandard(q))) {
          for (const k of ['horizontal', 'vertical'])
            add(make.geometric(k, { of: { points: { a: standardOperand('origin'), b: ref(p) } } }));
        }
        return done();
      }
      return mergePoints(picked.points, ctx);
    case 'hv':
    case 'horizontal':
    case 'vertical': {
      const axisOf = (dx: number, dy: number) =>
        kind === 'hv' ? (Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical') : kind;
      if (picked.lines.length > 0) {
        for (const l of picked.lines) {
          const d = ctx.geometry.direction(l) ?? [1, 0];
          add(make.geometric(axisOf(d[0], d[1]), { of: { curve: { id: l } } }));
        }
      } else {
        const [a, b] = picked.points as [string, string];
        const [pa, pb] = [ctx.geometry.operandPoint(ref(a)) ?? [0, 0], ctx.geometry.operandPoint(ref(b)) ?? [0, 0]];
        add(make.geometric(axisOf(pb[0] - pa[0], pb[1] - pa[1]), { of: { points: { a: ref(a), b: ref(b) } } }));
      }
      return done();
    }
    case 'parallel':
    case 'collinear':
    case 'equal':
    case 'concentric': {
      const list =
        kind === 'concentric'
          ? picked.curves
          : picked.lines.length >= 2
            ? picked.lines
            : picked.round.length >= 2
              ? picked.round
              : picked.elliptic;
      // A sketch axis goes first, so every row holds a line to it.
      const ordered = [...list.filter(isStandard), ...list.filter((id) => !isStandard(id))];
      const first = ordered[0] as string;
      for (const other of ordered.slice(1)) add(make.geometric(kind, { a: ref(first), b: ref(other) }));
      return done();
    }
    case 'perpendicular':
      add(make.geometric(kind, { a: ref(picked.lines[0] as string), b: ref(picked.lines[1] as string) }));
      return done();
    case 'tangent': {
      const [a, b] = picked.curves as [string, string];
      add({
        ...make.geometric('tangent', { a: ref(a), b: ref(b) }),
        internal: make.flag(internalTangent(ctx.geometry, a, b)),
      });
      return done();
    }
    case 'midpoint': {
      const curve = picked.curves[0] as string;
      for (const p of picked.points) add(make.geometric('midpoint', { point: ref(p), curve: ref(curve) }));
      return done();
    }
    case 'symmetric': {
      const s = symmetricPicks(picked);
      if (!s) return { ok: false, message: REASONS.symmetric };
      add(make.geometric('symmetric', { a: ref(s.a), b: ref(s.b), axis: ref(s.axis) }));
      return done();
    }
    case 'fix':
      return planFix(picked, ctx);
  }
}

/**
 * Inside when one round curve's centre lies within the other's disc, as
 * the drawing shows it.
 */
function internalTangent(geometry: SketchGeometry, a: string, b: string): boolean {
  const ca = geometry.curves.get(a)?.shape;
  const cb = geometry.curves.get(b)?.shape;
  const center = (s: typeof ca) => (s && (s.kind === 'circle' || s.kind === 'arc') ? s.center : undefined);
  const [pa, pb] = [center(ca), center(cb)];
  const [ra, rb] = [geometry.radius(a), geometry.radius(b)];
  if (!pa || !pb || ra === undefined || rb === undefined) return false;
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < Math.max(ra, rb);
}

/**
 * The point a horizontal or vertical row holds on the sketch origin, when
 * it is one: the rows a point placed on the origin gets.
 */
function originHeld(row: Json): string | null {
  if (row.kind !== 'horizontal' && row.kind !== 'vertical') return null;
  const of = row.of;
  if (!isPlainObject(of) || !isPlainObject(of.points)) return null;
  const { a, b } = of.points;
  const point = standardOf(a) === 'origin' ? operandOf(b) : standardOf(b) === 'origin' ? operandOf(a) : null;
  return point?.point ? point.id : null;
}

/**
 * The horizontal and vertical rows that together hold one point on the
 * sketch origin, which the editor shows and deletes as one Coincident: each
 * row's id to its partner's. Only active rows pair.
 */
export function originPairs(constraints: readonly Json[], active: (row: Json) => boolean): Map<string, string> {
  const held = new Map<string, { horizontal?: string; vertical?: string }>();
  for (const c of constraints) {
    const point = active(c) ? originHeld(c) : null;
    if (!point) continue;
    const entry = held.get(point) ?? {};
    entry[c.kind as 'horizontal' | 'vertical'] ??= c.id as string;
    held.set(point, entry);
  }
  const pairs = new Map<string, string>();
  for (const { horizontal, vertical } of held.values()) {
    if (!horizontal || !vertical) continue;
    pairs.set(horizontal, vertical);
    pairs.set(vertical, horizontal);
  }
  return pairs;
}

/**
 * The offset rows one Offset wrote, which the editor shows and deletes as one
 * constraint: by the row whose distance is named (the first copy), every row
 * whose distance refers to that value.
 */
export function offsetGroups(constraints: readonly Json[]): Map<string, string[]> {
  const heads = new Map<string, string>();
  for (const c of constraints) {
    const distance = c.distance;
    if (c.kind === 'offset' && isPlainObject(distance) && typeof distance.name === 'string')
      heads.set(distance.id as string, c.id as string);
  }
  const groups = new Map<string, string[]>();
  for (const c of constraints) {
    if (c.kind !== 'offset') continue;
    const def = isPlainObject(c.distance) ? c.distance.def : undefined;
    const refs =
      isPlainObject(def) && isPlainObject(def.expr) && isPlainObject(def.expr.refs) ? Object.values(def.expr.refs) : [];
    const target =
      refs.length === 1 && isPlainObject(refs[0]) && isPlainObject(refs[0].value)
        ? heads.get(refs[0].value.id as string)
        : undefined;
    const head = heads.get((c.distance as Json).id as string) ?? target;
    if (!head) continue;
    groups.set(head, [...(groups.get(head) ?? []), c.id as string]);
  }
  return groups;
}

/** Fix toggles (Fix/Unfix): points get `fixed` and curves `block`, or lose them when all have them. */
function planFix(picked: Picked, ctx: ConstraintContext): ConstraintPlan {
  const holds = (kind: string, field: string, id: string) =>
    table(ctx.inputs, 'constraints').filter((c) => c.kind === kind && ctx.active(c) && operandOf(c[field])?.id === id);
  const targets = [
    ...picked.points.map((id) => ['fixed', 'point', id] as const),
    ...picked.curves.map((id) => ['block', 'curve', id] as const),
  ];
  const held = targets.map(([kind, field, id]) => holds(kind, field, id));
  if (held.every((h) => h.length > 0)) {
    return { ok: true, change: { label: 'Unfix', remove: held.flat().map((c) => c.id as string) } };
  }
  const constraints = targets
    .filter((_, i) => (held[i] as Json[]).length === 0)
    .map(([kind, field, id]) => ctx.make.geometric(kind, { [field]: operandFor(ctx.geometry, id) }));
  return { ok: true, change: { label: 'Constrain fixed', add: { constraints } } };
}

/** Replaces point ids in a row's point fields and operands. */
function rewrite(value: unknown, from: ReadonlySet<string>, to: string): unknown {
  if (typeof value === 'string') return from.has(value) ? to : value;
  if (Array.isArray(value)) return value.map((v) => rewrite(v, from, to));
  if (!isPlainObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value))
    out[k] = k === 'extensions' || k === 'value' || k === 'active' ? v : rewrite(v, from, to);
  return out;
}

/**
 * Merges points into the first one: `editSketch` makes every row that used
 * the others use it (8.1). Constraints that would then hold a point to
 * itself go.
 */
export function mergePoints(points: readonly string[], ctx: Pick<ConstraintContext, 'inputs'>): ConstraintPlan {
  const unique = [...new Set(points)];
  const keep = unique[0] as string;
  const gone = new Set(unique.slice(1));
  for (const c of table(ctx.inputs, 'curves')) {
    const used = curvePoints(c);
    if (used.includes(keep) && used.some((p) => gone.has(p)) && c.kind !== 'spline' && c.kind !== 'nurbs') {
      return { ok: false, message: 'Those points are on one curve: merging them would collapse it' };
    }
  }
  return {
    ok: true,
    change: {
      label: 'Constrain coincident',
      merge: [...gone].map((from) => ({ from, into: keep })),
      remove: selfHeld(ctx.inputs, gone, keep),
    },
  };
}

/** The constraints that would hold a point to itself once `gone` are merged into `keep`. */
export function selfHeld(inputs: Json, gone: ReadonlySet<string>, keep: string): string[] {
  const drop: string[] = [];
  for (const c of table(inputs, 'constraints')) {
    if (![...namedIds(c)].some((id) => gone.has(id))) continue;
    const next = rewrite(c, gone, keep) as Json;
    const operandPoints = ['a', 'b', 'point']
      .map((f) => operandOf(next[f]))
      .filter((o) => o?.point)
      .map((o) => o?.id);
    const ofPoints =
      isPlainObject(next.of) && isPlainObject(next.of.points)
        ? [operandOf(next.of.points.a)?.id, operandOf(next.of.points.b)?.id]
        : [];
    if ([operandPoints, ofPoints].some((list) => list.length === 2 && list[0] !== undefined && list[0] === list[1]))
      drop.push(c.id as string);
  }
  return drop;
}

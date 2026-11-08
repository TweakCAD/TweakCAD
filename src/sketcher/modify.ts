/**
 * The sketch modify tools on the version-2 tables: trim, extend, fillet,
 * offset and mirror. Each plans
 * one edit; the session solves and writes it as one command.
 *
 * - Trim cuts a curve where other curves cross it and drops the piece under
 *   the pointer. The pieces left are new curves made from it (`origin.from`),
 *   and it is retired with fate `split`, so references to it follow (8).
 * - Extend moves a free end of a line or arc to the nearest curve it meets.
 * - Fillet rounds the corner two lines share with a tangent arc of a radius,
 *   held by a radius dimension.
 * - Offset copies a chain of lines and arcs (or a circle) to one side, each
 *   copy held by an `offset` constraint whose distances share one value.
 * - Mirror copies curves across a line, each copied point held by
 *   `symmetric` against its original.
 */
import { contactsBetween, prepareCurve, type Curve, type CurveShape } from '@tweakcad/format';
import type { Change, RowUpdate } from './change';
import { operandFor } from './constraints';
import type { SketchGeometry } from './geometry';
import { curvePoints, operandOf, pointOperand, standardName, table, type Json, type P2, type RowMaker } from './rows';

export interface ModifyContext {
  inputs: Json;
  geometry: SketchGeometry;
  make: RowMaker;
  /** Whether a constraint row is active. */
  active: (row: Json) => boolean;
  /** Millimetres per screen pixel. */
  pixel: number;
}

export type ModifyPlan = { ok: true; change: Change } | { ok: false; message: string };

const fail = (message: string): ModifyPlan => ({ ok: false, message });
const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const left = (a: P2): P2 => [-a[1], a[0]];
const unit = (a: P2): P2 | null => {
  const n = Math.hypot(a[0], a[1]);
  return n > 1e-12 ? [a[0] / n, a[1] / n] : null;
};

/** A row's fields without some keys. */
function without(row: Json, keys: readonly string[]): Json {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
}

/** Tolerance for geometry meeting, relative to the sketch's size. */
function toleranceOf(geometry: SketchGeometry): number {
  let extent = 1;
  for (const p of geometry.points.values()) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  return 1e-7 * extent;
}

/** The live curves other than `id` a cut or an extension may meet: every drawn curve with a shape. */
function others(geometry: SketchGeometry, id: string): { id: string; curve: Curve; row: Json }[] {
  const out: { id: string; curve: Curve; row: Json }[] = [];
  for (const c of geometry.curves.values())
    if (c.id !== id && c.kind !== 'point' && c.curve) out.push({ id: c.id, curve: c.curve, row: c.row });
  return out;
}

/** The curves that use a point, other than `except`. */
function usersOf(inputs: Json, point: string, except?: string): Json[] {
  return table(inputs, 'curves').filter((c) => c.id !== except && curvePoints(c).includes(point));
}

/** A curve's operand fields, by where they sit in its constraint row. */
function curveFields(row: Json): { field: string; id: string }[] {
  const out: { field: string; id: string }[] = [];
  for (const f of ['a', 'b', 'curve', 'axis']) {
    const o = operandOf(row[f]);
    if (o && !o.point) out.push({ field: f, id: o.id });
  }
  const of = row.of as Json | undefined;
  if (of && 'curve' in of) out.push({ field: 'of', id: (of.curve as Json).id as string });
  return out;
}

/** The row with each operand naming `from` naming `to` instead: only the fields that changed. */
function repointed(row: Json, from: string, to: string): Json {
  const set: Json = {};
  for (const { field, id } of curveFields(row)) {
    if (id !== from) continue;
    if (field === 'of') set.of = { curve: { id: to } };
    else set[field] = { curve: { id: to } };
  }
  return set;
}

// ---- trim ----

interface Piece {
  id: string;
  /** The piece's parameter range on the trimmed curve. */
  t0: number;
  t1: number;
  start: string;
  end: string;
}

/** Constraints a trimmed or split curve hands on to its pieces. */
function transferConstraints(
  ctx: ModifyContext,
  original: Json,
  curve: Curve,
  pieces: Piece[],
): { update: RowUpdate[]; add: Json[]; remove: string[] } {
  const update: RowUpdate[] = [];
  const added: Json[] = [];
  const remove: string[] = [];
  const id = original.id as string;
  const first = pieces[0] as Piece;
  const pieceAt = (p: P2 | undefined): Piece | undefined => {
    if (!p) return undefined;
    const hit = curve.closest(p as [number, number])[0];
    if (!hit) return undefined;
    return pieces.find((q) =>
      q.t0 <= q.t1 ? hit.t >= q.t0 - 1e-9 && hit.t <= q.t1 + 1e-9 : hit.t >= q.t0 - 1e-9 || hit.t <= q.t1 + 1e-9,
    );
  };
  for (const c of table(ctx.inputs, 'constraints')) {
    const on = curveFields(c).some((f) => f.id === id);
    if (!on) continue;
    const kind = c.kind as string;
    const cid = c.id as string;
    switch (kind) {
      case 'horizontal':
      case 'vertical':
      case 'parallel':
      case 'perpendicular':
      case 'collinear': {
        // Every piece of a line keeps its direction.
        update.push({ id: cid, set: repointed(c, id, first.id) });
        for (const p of pieces.slice(1)) {
          const fields = without(c, ['id', 'active']);
          added.push(ctx.make.geometric(kind, { ...fields, ...repointed(c, id, p.id) }));
        }
        break;
      }
      case 'length':
      case 'midpoint':
      case 'block':
        remove.push(cid);
        break;
      case 'pointOnCurve': {
        const piece = pieceAt(ctx.geometry.operandPoint(c.point));
        if (piece) update.push({ id: cid, set: repointed(c, id, piece.id) });
        else remove.push(cid);
        break;
      }
      case 'tangent':
      case 'normal': {
        const other = curveFields(c).find((f) => f.id !== id)?.id;
        const row = other ? ctx.geometry.curves.get(other)?.row : undefined;
        const shared = row ? curvePoints(row) : [];
        const piece = pieces.find((p) => shared.includes(p.start) || shared.includes(p.end)) ?? first;
        update.push({ id: cid, set: repointed(c, id, piece.id) });
        break;
      }
      default:
        update.push({ id: cid, set: repointed(c, id, first.id) });
    }
  }
  return { update, add: added, remove };
}

/**
 * Trims the curve under the pointer back to the curves crossing it either
 * side of the pointer; a curve nothing crosses is deleted. A click right
 * on a crossing is refused: it is on neither side.
 */
export function planTrim(ctx: ModifyContext, id: string, at: P2): ModifyPlan {
  const c = ctx.geometry.curves.get(id);
  if (!c || !c.curve || !c.shape) return fail('Pick a curve to trim');
  if (c.kind !== 'line' && c.kind !== 'arc' && c.kind !== 'circle')
    return fail('Trim works on lines, arcs and circles');
  const curve = c.curve;
  const tol = toleranceOf(ctx.geometry);
  const span = curve.tMax - curve.tMin;
  const cuts: { t: number; at: P2; other: string; point: string | null }[] = [];
  for (const o of others(ctx.geometry, id)) {
    for (const [ta] of contactsBetween(curve, o.curve, tol)) {
      if (!curve.closed && (Math.abs(ta - curve.tMin) <= 1e-9 * span || Math.abs(ta - curve.tMax) <= 1e-9 * span))
        continue;
      const p = curve.point(ta) as P2;
      const existing = curvePoints(o.row).find((q) => {
        const qp = ctx.geometry.point(q);
        return qp !== undefined && near(qp, p) <= Math.max(tol, 1e-6);
      });
      cuts.push({ t: ta, at: p, other: o.id, point: existing ?? null });
    }
  }
  cuts.sort((a, b) => a.t - b.t);
  const unique = cuts.filter((cut, i) => i === 0 || cut.t - (cuts[i - 1] as (typeof cuts)[number]).t > 1e-9 * span);
  if (unique.length === 0 || (curve.closed && unique.length < 2))
    return { ok: true, change: { label: 'Trim', remove: [id] } };
  const hit = curve.closest(at as [number, number])[0];
  if (!hit) return fail('Pick a curve to trim');
  const tc = hit.t;
  // A click on a crossing is on neither side of it.
  const onCut = unique.some(
    (cut) => Math.abs(cut.t - tc) <= 1e-9 * span || near(cut.at, curve.point(tc) as P2) <= Math.max(tol, 1e-6),
  );
  if (onCut) return fail('Click the part of the curve to remove, beside the crossing');
  const row = c.row;
  const construction = c.construction;
  const points: Json[] = [];
  const constraints: Json[] = [];
  const optional = new Set<string>();
  const cutPoint = (cut: (typeof unique)[number]): string => {
    if (cut.point) return cut.point;
    const p = ctx.make.point(cut.at[0], cut.at[1]);
    points.push(p);
    const con = ctx.make.geometric('pointOnCurve', {
      point: pointOperand(p.id as string),
      curve: operandFor(ctx.geometry, cut.other),
    });
    constraints.push(con);
    optional.add(con.id as string);
    return p.id as string;
  };
  const from = { from: { id } };
  const curves: Json[] = [];
  const pieces: Piece[] = [];
  const piece = (start: string, end: string, t0: number, t1: number) => {
    const made =
      c.kind === 'line'
        ? ctx.make.line(start, end, construction)
        : ctx.make.arc(row.center as string, start, end, construction);
    made.origin = from;
    curves.push(made);
    pieces.push({ id: made.id as string, t0, t1, start, end });
  };
  if (!curve.closed) {
    const before = unique.filter((cut) => cut.t < tc);
    const after = unique.filter((cut) => cut.t > tc);
    const lo = before[before.length - 1];
    const hi = after[0];
    if (lo) piece(row.start as string, cutPoint(lo), curve.tMin, lo.t);
    if (hi) piece(cutPoint(hi), row.end as string, hi.t, curve.tMax);
  } else {
    // A circle keeps the arc from the cut after the pointer round to the cut before it.
    const after = unique.find((cut) => cut.t > tc) ?? (unique[0] as (typeof unique)[number]);
    const before =
      [...unique].reverse().find((cut) => cut.t < tc) ?? (unique[unique.length - 1] as (typeof unique)[number]);
    piece(cutPoint(after), cutPoint(before), after.t, before.t);
  }
  const moved = transferConstraints(ctx, row, curve, pieces);
  return {
    ok: true,
    change: {
      label: 'Trim',
      retire: [{ id, fate: 'split' }],
      remove: moved.remove,
      add: { points, curves, constraints: [...constraints, ...moved.add] },
      update: moved.update,
      optional,
    },
  };
}

// ---- extend ----

/** Moves the free end of a line or arc nearest the pointer to the first curve it meets going on. */
export function planExtend(ctx: ModifyContext, id: string, at: P2): ModifyPlan {
  const c = ctx.geometry.curves.get(id);
  if (!c || !c.shape) return fail('Pick a line or arc to extend');
  const row = c.row;
  if (c.kind !== 'line' && c.kind !== 'arc') return fail('Extend works on lines and arcs');
  const [s, e] = [ctx.geometry.point(row.start as string), ctx.geometry.point(row.end as string)];
  if (!s || !e) return fail('Pick a line or arc to extend');
  const atEnd = near(at, e) <= near(at, s);
  const end = (atEnd ? row.end : row.start) as string;
  if (usersOf(ctx.inputs, end, id).length > 0) return fail('That end is joined to another curve');
  const tol = toleranceOf(ctx.geometry);
  let reach: CurveShape;
  let extent = 1000;
  for (const p of ctx.geometry.points.values()) extent = Math.max(extent, 4 * (Math.abs(p[0]) + Math.abs(p[1])));
  const from = atEnd ? e : s;
  if (c.kind === 'line') {
    const u = unit(atEnd ? sub(e, s) : sub(s, e));
    if (!u) return fail('Pick a line or arc to extend');
    reach = { kind: 'line', start: from, end: add(from, scale(u, extent)) };
  } else {
    // The gap of the arc's circle, from its end round to its start.
    const center = ctx.geometry.point(row.center as string) as P2;
    reach = { kind: 'arc', center, start: e, end: s };
  }
  const ray = prepareCurve(reach, false);
  if (!ray) return fail('Pick a line or arc to extend');
  let best: { t: number; at: P2; other: string; point: string | null } | null = null;
  const fromStart = c.kind === 'line' || atEnd;
  for (const o of others(ctx.geometry, id)) {
    for (const [t] of contactsBetween(ray, o.curve, tol)) {
      const along = fromStart ? t - ray.tMin : ray.tMax - t;
      if (along <= 1e-9 * (ray.tMax - ray.tMin)) continue;
      if (best && along >= (fromStart ? best.t - ray.tMin : ray.tMax - best.t)) continue;
      const p = ray.point(t) as P2;
      const point = curvePoints(o.row).find((q) => {
        const qp = ctx.geometry.point(q);
        return qp !== undefined && near(qp, p) <= Math.max(tol, 1e-6);
      });
      best = { t, at: p, other: o.id, point: point ?? null };
    }
  }
  if (!best) return fail('Nothing to extend to');
  if (best.point) return { ok: true, change: { label: 'Extend', merge: [{ from: end, into: best.point }] } };
  const on = ctx.make.geometric('pointOnCurve', {
    point: pointOperand(end),
    curve: operandFor(ctx.geometry, best.other),
  });
  return {
    ok: true,
    change: {
      label: 'Extend',
      update: [{ id: end, set: { x: best.at[0], y: best.at[1] } }],
      add: { constraints: [on] },
      optional: new Set([on.id as string]),
    },
  };
}

// ---- fillet ----

/** The corner two lines share, from a picked point or two picked lines. */
export function filletCorner(
  ctx: ModifyContext,
  picks: readonly string[],
): { corner: string; lines: [string, string] } | string {
  const lineRows = (ids: readonly string[]) =>
    ids.map((id) => ctx.geometry.curves.get(id)?.row).filter((r): r is Json => r?.kind === 'line');
  if (picks.length === 1) {
    const corner = ctx.geometry.points.has(picks[0] as string) ? (picks[0] as string) : null;
    if (!corner) return 'Pick a corner, or two lines';
    const users = usersOf(ctx.inputs, corner).filter((u) => u.kind !== 'point');
    const lines = users.filter((u) => u.kind === 'line');
    if (users.length === 2 && lines.length === 2)
      return { corner, lines: [lines[0]?.id as string, lines[1]?.id as string] };
    // Construction curves ending there too (a centre rectangle's diagonal) stay out of it.
    const drawn = users.filter((u) => !ctx.geometry.curves.get(u.id as string)?.construction);
    if (drawn.length === 2 && drawn.every((u) => u.kind === 'line'))
      return { corner, lines: [drawn[0]?.id as string, drawn[1]?.id as string] };
    return users.length > 2
      ? 'More than two curves meet there: click the two lines to round'
      : 'A fillet rounds the corner of two lines';
  }
  const rows = lineRows(picks);
  if (rows.length !== 2) return 'A fillet rounds the corner of two lines';
  const [a, b] = rows as [Json, Json];
  const shared = [a.start, a.end].find((p) => p === b.start || p === b.end) as string | undefined;
  if (!shared) return 'Those lines do not meet at a corner';
  return { corner: shared, lines: [a.id as string, b.id as string] };
}

/** Rounds the corner of two lines with an arc of `radius` tangent to both, its radius held by a dimension. */
export function planFillet(
  ctx: ModifyContext,
  picks: readonly string[],
  radius: number,
  dimension: { name: string; text: string },
): ModifyPlan {
  const found = filletCorner(ctx, picks);
  if (typeof found === 'string') return fail(found);
  if (!(radius > 0)) return fail('A fillet radius is more than 0 mm');
  const { corner, lines } = found;
  const c = ctx.geometry.point(corner) as P2;
  const legs = lines.map((id) => {
    const row = ctx.geometry.curves.get(id)?.row as Json;
    const far = (row.start === corner ? row.end : row.start) as string;
    const p = ctx.geometry.point(far) as P2;
    return { id, row, far, length: near(c, p), u: unit(sub(p, c)) };
  });
  const [l1, l2] = legs as [(typeof legs)[number], (typeof legs)[number]];
  if (!l1.u || !l2.u) return fail('A fillet rounds the corner of two lines');
  const cos = Math.max(-1, Math.min(1, dot(l1.u, l2.u)));
  const angle = Math.acos(cos);
  if (angle < 1e-6 || Math.PI - angle < 1e-6) return fail('Those lines run straight on: there is no corner to round');
  const t = radius / Math.tan(angle / 2);
  if (t >= l1.length || t >= l2.length) return fail('That radius does not fit the corner');
  const bisector = unit(add(l1.u, l2.u)) as P2;
  const center = add(c, scale(bisector, radius / Math.sin(angle / 2)));
  const [t1, t2] = [add(c, scale(l1.u, t)), add(c, scale(l2.u, t))];
  const points = [ctx.make.point(t1[0], t1[1]), ctx.make.point(t2[0], t2[1]), ctx.make.point(center[0], center[1])];
  const [p1, p2, pc] = points.map((p) => p.id as string) as [string, string, string];
  // Counter-clockwise from the tangent point the turn leaves first.
  const ccw = cross(sub(t1, center), sub(t2, center)) > 0;
  const construction = ctx.geometry.curves.get(l1.id)?.construction ?? false;
  const arc = ccw ? ctx.make.arc(pc, p1, p2, construction) : ctx.make.arc(pc, p2, p1, construction);
  const tangent = (line: string) => {
    const row = ctx.make.geometric('tangent', { a: { curve: { id: line } }, b: { curve: { id: arc.id as string } } });
    row.internal = ctx.make.flag(false);
    return row;
  };
  const value = ctx.make.value(dimension.text, dimension.name);
  const dim = ctx.make.dimension('radius', { curve: { curve: { id: arc.id as string } } }, value, radius);
  const field = (leg: (typeof legs)[number]) => (leg.row.start === corner ? 'start' : 'end');
  const otherUsers = usersOf(ctx.inputs, corner).filter((u) => !lines.includes(u.id as string));
  // A corner other curves still end on stays where the two lines would meet, held on both.
  const held =
    otherUsers.length > 0
      ? lines.map((line) =>
          ctx.make.geometric('pointOnCurve', { point: pointOperand(corner), curve: { curve: { id: line } } }),
        )
      : [];
  // The corner goes when nothing else uses it; a point a region row still names stays, and only what held it goes.
  const named = [...table(ctx.inputs, 'regions'), ...table(ctx.inputs, 'retired')].some((r) =>
    JSON.stringify(r).includes(`"${corner}"`),
  );
  const holding = table(ctx.inputs, 'constraints')
    .filter((con) => JSON.stringify(con).includes(`"${corner}"`))
    .map((con) => con.id as string);
  return {
    ok: true,
    change: {
      label: 'Fillet',
      add: { points, curves: [arc], constraints: [tangent(l1.id), tangent(l2.id), dim, ...held] },
      update: [
        { id: l1.id, set: { [field(l1)]: p1 } },
        { id: l2.id, set: { [field(l2)]: p2 } },
      ],
      remove: otherUsers.length > 0 ? [] : named ? holding : [corner],
    },
  };
}

// ---- offset ----

interface Oriented {
  id: string;
  row: Json;
  /** Walking against the curve's own direction. */
  reversed: boolean;
}

/** The chain of lines and arcs through `id`, joined end to end where exactly two of them share a point; in walking order. */
export function chainOf(ctx: ModifyContext, id: string): { pieces: Oriented[]; closed: boolean } | null {
  const rowOf = (cid: string) => ctx.geometry.curves.get(cid)?.row;
  const start = rowOf(id);
  if (!start || (start.kind !== 'line' && start.kind !== 'arc')) return null;
  const chainable = (r: Json) => (r.kind === 'line' || r.kind === 'arc') && r.start !== r.end;
  const next = (point: string, from: string): Json | null => {
    const users = usersOf(ctx.inputs, point).filter((u) => u.id !== from && u.kind !== 'point');
    const all = usersOf(ctx.inputs, point).filter((u) => u.kind !== 'point');
    if (all.length !== 2 || users.length !== 1) return null;
    const u = users[0] as Json;
    return chainable(u) && (u.start === point || u.end === point) && u.center !== point ? u : null;
  };
  const pieces: Oriented[] = [{ id, row: start, reversed: false }];
  const seen = new Set([id]);
  // Forward from the start's end.
  let at = start.end as string;
  let from = id;
  let closed = false;
  for (;;) {
    const n = next(at, from);
    if (!n) break;
    if (seen.has(n.id as string)) {
      closed = n.id === id;
      break;
    }
    const reversed = n.end === at;
    pieces.push({ id: n.id as string, row: n, reversed });
    seen.add(n.id as string);
    from = n.id as string;
    at = (reversed ? n.start : n.end) as string;
  }
  if (!closed) {
    // Backward from the start's start.
    at = start.start as string;
    from = id;
    for (;;) {
      const n = next(at, from);
      if (!n || seen.has(n.id as string)) break;
      const reversed = n.start === at;
      pieces.unshift({ id: n.id as string, row: n, reversed });
      seen.add(n.id as string);
      from = n.id as string;
      at = (reversed ? n.end : n.start) as string;
    }
  }
  return { pieces, closed };
}

type Carrier = { kind: 'line'; p: P2; u: P2 } | { kind: 'circle'; c: P2; r: number };

/** Where two carriers meet, nearest `hint`. */
function meetNear(a: Carrier, b: Carrier, hint: P2): P2 | null {
  const lineCircle = (l: { p: P2; u: P2 }, c: { c: P2; r: number }): P2[] => {
    const f = sub(l.p, c.c);
    const bq = dot(f, l.u);
    const disc = bq * bq - (dot(f, f) - c.r * c.r);
    if (disc < -1e-9) return [];
    const s = Math.sqrt(Math.max(0, disc));
    return [add(l.p, scale(l.u, -bq - s)), add(l.p, scale(l.u, -bq + s))];
  };
  let hits: P2[] = [];
  if (a.kind === 'line' && b.kind === 'line') {
    const d = cross(a.u, b.u);
    if (Math.abs(d) < 1e-12) return null;
    const t = cross(sub(b.p, a.p), b.u) / d;
    hits = [add(a.p, scale(a.u, t))];
  } else if (a.kind === 'line' && b.kind === 'circle') hits = lineCircle(a, b);
  else if (a.kind === 'circle' && b.kind === 'line') hits = lineCircle(b, a);
  else if (a.kind === 'circle' && b.kind === 'circle') {
    const d = near(a.c, b.c);
    if (d < 1e-12) return null;
    const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    const h2 = a.r * a.r - x * x;
    if (h2 < -1e-9) return null;
    const u = scale(sub(b.c, a.c), 1 / d);
    const m = add(a.c, scale(u, x));
    const h = Math.sqrt(Math.max(0, h2));
    hits = [add(m, scale(left(u), h)), sub(m, scale(left(u), h))];
  }
  let best: P2 | null = null;
  for (const h of hits) if (!best || near(h, hint) < near(best, hint)) best = h;
  return best;
}

/** The distance of an offset's first copy: a new named value, or a reference to another offset's. */
export type OffsetValue = { name: string; text: string } | { of: { name: string; id: string } };

/**
 * The side of the curve `id` (or of the chain through it) a point lies on:
 * for a circle 1 outside and -1 inside, for a chain 1 left of its walking
 * direction and -1 right, on the piece nearest the point.
 */
export function offsetSide(ctx: ModifyContext, id: string, at: P2): 1 | -1 | null {
  const g = ctx.geometry;
  const picked = g.curves.get(id);
  if (!picked) return null;
  if (picked.kind === 'circle') {
    const center = g.point(picked.row.center as string) as P2;
    return near(at, center) > (picked.row.radius as number) ? 1 : -1;
  }
  const chain = chainOf(ctx, id);
  if (!chain) return null;
  let side: 1 | -1 = 1;
  let nearest = Infinity;
  for (const p of chain.pieces) {
    const curve = g.curves.get(p.id)?.curve;
    const hit = curve?.closest(at as [number, number])[0];
    if (!curve || !hit || hit.distance >= nearest) continue;
    nearest = hit.distance;
    const tangent = unit(curve.derivative(hit.t) as P2) ?? [1, 0];
    const walk = p.reversed ? scale(tangent, -1) : tangent;
    side = cross(walk, sub(at, curve.point(hit.t) as P2)) >= 0 ? 1 : -1;
  }
  return side;
}

/**
 * Offsets the chain through `id` (or a circle) by `distance` to the side
 * of `at`, or to `side` as `offsetSide` counts it. Joints where the copies
 * part are joined where the copies' lines and circles meet, so a
 * rectangle's copy is a rectangle.
 */
export function planOffset(
  ctx: ModifyContext,
  id: string,
  at: P2 | 1 | -1,
  distance: number,
  value: OffsetValue,
): ModifyPlan {
  if (!(distance > 0)) return fail('An offset distance is more than 0 mm');
  const g = ctx.geometry;
  const picked = g.curves.get(id);
  if (!picked) return fail('Pick a curve to offset');
  const reference = (of: { name: string; id: string }): Json => ({
    id: ctx.make.id('val'),
    def: { expr: { text: of.name, grammar: 1, refs: { [of.name]: { value: { id: of.id } } } } },
  });
  const first = 'of' in value ? reference(value.of) : ctx.make.value(value.text, value.name);
  const named = 'of' in value ? value.of : { name: value.name, id: first.id as string };
  const distanceOf = (n: number) => (n === 0 ? first : reference(named));
  const offsetRow = (a: string, b: string, n: number) =>
    ctx.make.geometric('offset', { a: { curve: { id: a } }, b: { curve: { id: b } }, distance: distanceOf(n) });
  const side = typeof at === 'number' ? at : offsetSide(ctx, id, at);
  if (picked.kind === 'circle') {
    const r = picked.row.radius as number;
    const radius = side === 1 ? r + distance : r - distance;
    if (!(radius > 1e-6)) return fail('That offset is larger than the circle');
    const copy = ctx.make.circle(picked.row.center as string, radius, picked.construction);
    return {
      ok: true,
      change: { label: 'Offset', add: { curves: [copy], constraints: [offsetRow(id, copy.id as string, 0)] } },
    };
  }
  const chain = chainOf(ctx, id);
  if (!chain || side === null) return fail('Offset works on lines, arcs and circles');
  const k = side * distance;
  // Each piece's copy: a line moved to the left of the walk by k, an arc's radius changed by it.
  const copies = chain.pieces.map((p) => {
    const row = p.row;
    const [s, e] = [g.point(row.start as string) as P2, g.point(row.end as string) as P2];
    const [ws, we] = p.reversed ? [e, s] : [s, e];
    if (row.kind === 'line') {
      const u = unit(sub(we, ws)) as P2;
      const n = left(u);
      const carrier: Carrier = { kind: 'line', p: add(ws, scale(n, k)), u };
      return { piece: p, carrier, from: add(ws, scale(n, k)), to: add(we, scale(n, k)) };
    }
    const center = g.point(row.center as string) as P2;
    const r = near(center, s);
    // Walking counter-clockwise, the left is towards the centre.
    const radius = p.reversed ? r + k : r - k;
    const carrier: Carrier = { kind: 'circle', c: center, r: radius };
    const toward = (q: P2) => add(center, scale(unit(sub(q, center)) as P2, radius));
    return { piece: p, carrier, from: toward(ws), to: toward(we), radius };
  });
  if (copies.some((c) => 'radius' in c && !((c.radius as number) > 1e-6)))
    return fail('That offset is larger than an arc of the chain');
  // The joints: where consecutive copies meet.
  const n = copies.length;
  const joints: P2[] = [];
  const jointCount = chain.closed ? n : n - 1;
  /** Joints where the copies run on into each other: held tangent there, as the originals meet. */
  const smooth = new Set<number>();
  for (let i = 0; i < jointCount; i++) {
    const a = copies[i] as (typeof copies)[number];
    const b = copies[(i + 1) % n] as (typeof copies)[number];
    if (near(a.to, b.from) <= 1e-9 * Math.max(1, distance)) {
      joints.push(a.to);
      if (a.piece.row.kind === 'arc' || b.piece.row.kind === 'arc') smooth.add(i);
      continue;
    }
    const meet = meetNear(a.carrier, b.carrier, scale(add(a.to, b.from), 0.5));
    if (!meet) return fail('That chain cannot be offset so far');
    joints.push(meet);
  }
  const points: Json[] = [];
  const newPoint = (p: P2) => {
    const row = ctx.make.point(p[0], p[1]);
    points.push(row);
    return row.id as string;
  };
  const jointIds = joints.map(newPoint);
  const startOf = (i: number) =>
    i === 0
      ? chain.closed
        ? (jointIds[n - 1] as string)
        : newPoint((copies[0] as (typeof copies)[number]).from)
      : (jointIds[i - 1] as string);
  const endOf = (i: number) =>
    i === n - 1 && !chain.closed ? newPoint((copies[n - 1] as (typeof copies)[number]).to) : (jointIds[i] as string);
  const curves: Json[] = [];
  const constraints: Json[] = [];
  copies.forEach((c, i) => {
    const [ws, we] = [startOf(i), endOf(i)];
    const [s, e] = c.piece.reversed ? [we, ws] : [ws, we];
    const construction = g.curves.get(c.piece.id)?.construction ?? false;
    const row =
      c.piece.row.kind === 'line'
        ? ctx.make.line(s, e, construction)
        : ctx.make.arc(c.piece.row.center as string, s, e, construction);
    curves.push(row);
    constraints.push(offsetRow(c.piece.id, row.id as string, i));
  });
  for (const i of smooth) {
    const [a, b] = [curves[i] as Json, curves[(i + 1) % n] as Json];
    const tangent = ctx.make.geometric('tangent', {
      a: { curve: { id: a.id as string } },
      b: { curve: { id: b.id as string } },
    });
    // Two arcs meeting smoothly touch from inside when their centres lie on one side of the joint.
    const centers = [a, b].filter((r) => r.kind === 'arc').map((r) => g.point(r.center as string) as P2);
    let internal = false;
    if (centers.length === 2) {
      const j = joints[i] as P2;
      const [ca, cb] = centers as [P2, P2];
      internal = dot(sub(ca, j), sub(cb, j)) > 0;
    }
    tangent.internal = ctx.make.flag(internal);
    constraints.push(tangent);
  }
  // The first copy's offset holds the chain; the solve leaves out what the others repeat.
  const optional = new Set(constraints.slice(1).map((c) => c.id as string));
  // A copy line that turned round has gone past its neighbours.
  for (const row of curves) {
    if (row.kind !== 'line') continue;
    const orig = copies[curves.indexOf(row)]?.piece.row as Json;
    const p = (rid: string) =>
      (points.find((q) => q.id === rid)
        ? [points.find((q) => q.id === rid)?.x, points.find((q) => q.id === rid)?.y]
        : g.point(rid)) as P2;
    const [os, oe] = [g.point(orig.start as string) as P2, g.point(orig.end as string) as P2];
    if (dot(sub(p(row.end as string), p(row.start as string)), sub(oe, os)) <= 0)
      return fail('That chain cannot be offset so far');
  }
  return { ok: true, change: { label: 'Offset', add: { points, curves, constraints }, optional } };
}

/** The Offset dialog's Direction: one side, a distance each side, or one distance both sides. */
export type OffsetDirection = 'one' | 'two' | 'symmetric';

/**
 * Offsets the chain through `id` (or a circle) as the Offset dialog sets
 * it: to `side` by the first distance, and with Two sides or Symmetric to
 * the other side too, by the second distance or by the first one's value.
 * Each side's first copy names its distance (`names`); the other side of
 * Symmetric refers to the first name, so one value drives both.
 */
export function planOffsets(
  ctx: ModifyContext,
  id: string,
  side: 1 | -1,
  direction: OffsetDirection,
  distances: readonly [number, number],
  names: readonly [string, string],
  format: (n: number) => string,
): ModifyPlan {
  const one = planOffset(ctx, id, side, distances[0], { name: names[0], text: format(distances[0]) });
  if (!one.ok || direction === 'one') return one;
  const first = one.change.add?.constraints?.[0]?.distance as Json | undefined;
  const value: OffsetValue =
    direction === 'symmetric'
      ? { of: { name: names[0], id: first?.id as string } }
      : { name: names[1], text: format(distances[1]) };
  const other = planOffset(
    ctx,
    id,
    side === 1 ? -1 : 1,
    direction === 'symmetric' ? distances[0] : distances[1],
    value,
  );
  if (!other.ok) return other;
  const [a, b] = [one.change, other.change];
  return {
    ok: true,
    change: {
      label: 'Offset',
      add: {
        points: [...(a.add?.points ?? []), ...(b.add?.points ?? [])],
        curves: [...(a.add?.curves ?? []), ...(b.add?.curves ?? [])],
        constraints: [...(a.add?.constraints ?? []), ...(b.add?.constraints ?? [])],
      },
      optional: new Set([...(a.optional ?? []), ...(b.optional ?? [])]),
    },
  };
}

// ---- mirror ----

/** Mirrors the selected curves across a line: new curves on mirrored points, each held symmetric to its original. */
export function planMirror(ctx: ModifyContext, selection: readonly string[], axis: string): ModifyPlan {
  const g = ctx.geometry;
  const standard = standardName(axis);
  const axisRow = g.curves.get(axis);
  if (!(standard === 'x' || standard === 'y' || axisRow?.kind === 'line'))
    return fail('Pick the line to mirror across');
  const [a, b]: [P2, P2] =
    standard === 'x'
      ? [
          [0, 0],
          [1, 0],
        ]
      : standard === 'y'
        ? [
            [0, 0],
            [0, 1],
          ]
        : [g.point(axisRow?.row.start as string) as P2, g.point(axisRow?.row.end as string) as P2];
  const u = unit(sub(b, a));
  if (!u) return fail('Pick the line to mirror across');
  const reflect = (p: P2): P2 => {
    const d = sub(p, a);
    const along = scale(u, dot(d, u));
    return add(a, sub(scale(along, 2), d));
  };
  const curves = selection.filter((id) => id !== axis && g.curves.has(id) && g.curves.get(id)?.kind !== 'external');
  if (curves.length === 0) return fail('Select the curves to mirror, then pick the line');
  const tol = Math.max(1e-6, toleranceOf(g));
  const axisPoints = new Set(axisRow ? curvePoints(axisRow.row) : []);
  const map = new Map<string, string>();
  const points: Json[] = [];
  const constraints: Json[] = [];
  const axisOperand = operandFor(g, axis);
  const mirrorOf = (p: string): string => {
    const known = map.get(p);
    if (known) return known;
    const at = g.point(p) as P2;
    const image = reflect(at);
    // A point on the axis is its own image.
    if (axisPoints.has(p) || near(image, at) <= tol) {
      map.set(p, p);
      return p;
    }
    const row = ctx.make.point(image[0], image[1]);
    points.push(row);
    map.set(p, row.id as string);
    constraints.push(
      ctx.make.geometric('symmetric', { a: pointOperand(p), b: pointOperand(row.id as string), axis: axisOperand }),
    );
    return row.id as string;
  };
  const made: Json[] = [];
  for (const id of curves) {
    const c = g.curves.get(id);
    if (!c) continue;
    const row = c.row;
    const fields = without(row, ['id', 'origin', 'construction']);
    const copy: Json = { ...ctx.make.curve(row.kind as string, c.construction), ...fields };
    switch (row.kind) {
      case 'line':
        copy.start = mirrorOf(row.start as string);
        copy.end = mirrorOf(row.end as string);
        break;
      case 'circle':
        copy.center = mirrorOf(row.center as string);
        constraints.push(
          ctx.make.geometric('equal', { a: { curve: { id } }, b: { curve: { id: copy.id as string } } }),
        );
        break;
      case 'arc':
        // A mirror turns an arc round: the image of its end is the copy's start.
        copy.center = mirrorOf(row.center as string);
        copy.start = mirrorOf(row.end as string);
        copy.end = mirrorOf(row.start as string);
        break;
      case 'point':
        copy.at = mirrorOf(row.at as string);
        break;
      case 'spline':
        copy.through = (row.through as string[]).map(mirrorOf);
        break;
      case 'ellipse':
        copy.center = mirrorOf(row.center as string);
        copy.majorEnd = mirrorOf(row.majorEnd as string);
        constraints.push(
          ctx.make.geometric('equal', { a: { curve: { id } }, b: { curve: { id: copy.id as string } } }),
        );
        break;
      default:
        return fail(`Mirror does not copy ${String(row.kind)} curves yet`);
    }
    made.push(copy);
  }
  return { ok: true, change: { label: 'Mirror', add: { points, curves: made, constraints } } };
}

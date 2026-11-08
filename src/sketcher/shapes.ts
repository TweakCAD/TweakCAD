/**
 * The shape tools that take a fixed run of clicks: centre rectangle, circle
 * by two or three points, centre-point arc, tangent arc, the inscribed,
 * circumscribed and edge polygons, slot, ellipse, and the spline, which
 * takes clicks until it is finished. A shape
 * is lines, arcs and curves plus constraints (invariant 11), never an entity
 * of its own: each builder fills a `Draft` with the rows it makes.
 */
import type { Draft } from './change';
import type { PreviewShape } from './draw';
import type { SketchGeometry } from './geometry';
import { curveOperand, pointOperand, type Json, type P2 } from './rows';
import { inferAxis, type Snap } from './snap';

export type ShapeTool =
  | 'centerRectangle'
  | 'circle2'
  | 'circle3'
  | 'arcCenter'
  | 'tangentArc'
  | 'polygon'
  | 'polygonCircumscribed'
  | 'polygonEdge'
  | 'slot'
  | 'ellipse'
  | 'spline';

export const SHAPE_TOOLS: readonly ShapeTool[] = [
  'centerRectangle',
  'circle2',
  'circle3',
  'arcCenter',
  'tangentArc',
  'polygon',
  'polygonCircumscribed',
  'polygonEdge',
  'slot',
  'ellipse',
  'spline',
];

export interface ShapeContext {
  geometry: SketchGeometry;
  construction: boolean;
  /** Millimetres per pixel, for inference. */
  pixel: number;
  /** Polygon sides. */
  sides: number;
  /** The centre-point arc's sweep as the pointer turned it, in radians; its sign picks the way round. */
  sweep: number;
}

export interface ShapeSpec {
  /** Clicks the shape takes; the spline takes any number and is finished by the user. */
  clicks: number;
  label: string;
  /** What shows while placing: the clicks so far and the pointer. */
  preview(at: readonly P2[], cursor: P2, ctx: ShapeContext, snaps: readonly Snap[]): PreviewShape[];
  /** Fills the draft; a message when the clicks make no shape. */
  build(d: Draft, snaps: readonly Snap[], ctx: ShapeContext): string | null;
  /** Whether a first click may start the shape; a message when it may not. */
  start?(snap: Snap, ctx: ShapeContext): string | null;
}

const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const left = (a: P2): P2 => [-a[1], a[0]];
const unit = (a: P2): P2 | null => {
  const n = Math.hypot(a[0], a[1]);
  return n > 1e-12 ? [a[0] / n, a[1] / n] : null;
};
const TINY = 1e-6;

/** The circle through three points, or null when they are on one line. */
export function circumcircle(a: P2, b: P2, c: P2): { center: P2; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const size = Math.max(near(a, b), near(b, c), near(a, c));
  if (!(Math.abs(d) > 1e-9 * size * size)) return null;
  const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const x = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const y = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  return { center: [x, y], radius: near([x, y], a) };
}

/** Whether going counter-clockwise about `center` from `start` to `end` passes `through`. */
export function passesCounterClockwise(center: P2, start: P2, through: P2, end: P2): boolean {
  const angle = (p: P2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const turn = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return turn(angle(through) - angle(start)) < turn(angle(end) - angle(start));
}

const ring = (center: P2, radius: number): PreviewShape => ({ kind: 'circle', center, radius });
const segment = (a: P2, b: P2): PreviewShape => ({ kind: 'polyline', points: [a, b] });
const path = (points: P2[]): PreviewShape => ({ kind: 'polyline', points });

/** The corners of a rectangle centred on `c` with one corner at `corner`, in drawing order from the opposite corner. */
function centeredCorners(c: P2, corner: P2): [P2, P2, P2, P2] {
  const p0: P2 = [2 * c[0] - corner[0], 2 * c[1] - corner[1]];
  return [p0, [corner[0], p0[1]], corner, [p0[0], corner[1]]];
}

/** A shared point keeps the new circle on it, written as an optional point-on-curve. */
function onCircle(d: Draft, snaps: readonly Snap[], circle: string): void {
  for (const s of snaps)
    if (s.kind === 'point')
      d.constrain('pointOnCurve', { point: pointOperand(s.id), curve: curveOperand(circle) }, true);
}

/** The vertices of a regular polygon about `c` with one at `v`. */
function polygonVertices(c: P2, v: P2, sides: number): P2[] {
  const r = near(c, v);
  const a0 = Math.atan2(v[1] - c[1], v[0] - c[0]);
  return Array.from({ length: sides }, (_, i) => {
    const t = a0 + (2 * Math.PI * i) / sides;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as P2;
  });
}

/** The corners of a regular polygon about `c` whose side has its middle at `m`, and the radius of its corners. */
function circumscribedVertices(c: P2, m: P2, sides: number): { vertices: P2[]; radius: number } {
  const radius = near(c, m) / Math.cos(Math.PI / sides);
  const a0 = Math.atan2(m[1] - c[1], m[0] - c[0]) - Math.PI / sides;
  return { vertices: polygonVertices(c, [c[0] + radius * Math.cos(a0), c[1] + radius * Math.sin(a0)], sides), radius };
}

/** The centre and corners of a regular polygon on the side from `a` to `b`, built on the side of `toward`. */
function edgePolygon(a: P2, b: P2, toward: P2, sides: number): { center: P2; vertices: P2[] } | null {
  const u = unit(sub(b, a));
  if (!u) return null;
  const s = near(a, b);
  const n = left(u);
  const side = dot(sub(toward, a), n) < 0 ? -1 : 1;
  const center = add(scale(add(a, b), 0.5), scale(n, (side * s) / (2 * Math.tan(Math.PI / sides))));
  return { center, vertices: polygonVertices(center, a, sides) };
}

/**
 * The rows of a regular polygon: lines through `vertices` (the ones `placed`
 * gives standing for snapped clicks), each corner on a construction circle
 * about `center` and every side equal.
 */
function polygonRows(
  d: Draft,
  center: string,
  radius: number,
  vertices: readonly P2[],
  placed: ReadonlyMap<number, string>,
  construction: boolean,
): { lines: Json[] } {
  const ids = vertices.map((p, i) => placed.get(i) ?? d.point(p));
  const lines = ids.map((p, i) => d.make.line(p, ids[(i + 1) % ids.length] as string, construction));
  d.curves.push(...lines);
  const circle = d.make.circle(center, radius, true);
  d.curves.push(circle);
  for (const p of ids)
    d.constrain('pointOnCurve', { point: pointOperand(p), curve: curveOperand(circle.id as string) }, false);
  for (const l of lines.slice(1))
    d.constrain('equal', { a: curveOperand(lines[0]?.id as string), b: curveOperand(l.id as string) }, false);
  return { lines };
}

/** The slot's half width from the third click, measured square to the axis. */
function slotFrame(a: P2, b: P2, w: P2): { u: P2; n: P2; half: number } | null {
  const u = unit(sub(b, a));
  if (!u || near(a, b) < 0.01) return null;
  const n = left(u);
  return { u, n, half: Math.max(0.25, Math.abs(dot(sub(w, a), n))) };
}

function slotOutline(a: P2, b: P2, w: P2): PreviewShape[] {
  const f = slotFrame(a, b, w);
  if (!f) return [segment(a, b)];
  const { n, half } = f;
  const [a1, b1, b2, a2] = [
    add(a, scale(n, half)),
    add(b, scale(n, half)),
    sub(b, scale(n, half)),
    sub(a, scale(n, half)),
  ];
  return [
    segment(a2, b2),
    { kind: 'arc', center: b, radius: half, from: b2, to: b1 },
    segment(b1, a1),
    { kind: 'arc', center: a, radius: half, from: a1, to: a2 },
  ];
}

/** The ellipse from its centre, the end of one axis and a point giving the other; the longer axis is the major one. */
function ellipseAxes(c: P2, m: P2, p: P2): { majorEnd: P2; minor: number } | null {
  const u = unit(sub(m, c));
  if (!u || near(c, m) < 0.01) return null;
  const major = near(c, m);
  const n = left(u);
  const minor = Math.max(0.01, Math.abs(dot(sub(p, c), n)));
  return minor <= major ? { majorEnd: m, minor } : { majorEnd: add(c, scale(n, minor)), minor: major };
}

function ellipsePolyline(c: P2, majorEnd: P2, minor: number): P2[] {
  const u = unit(sub(majorEnd, c)) ?? [1, 0];
  const major = near(c, majorEnd);
  const n = left(u);
  return Array.from({ length: 65 }, (_, i) => {
    const t = (2 * Math.PI * i) / 64;
    return add(c, add(scale(u, major * Math.cos(t)), scale(n, minor * Math.sin(t))));
  });
}

/**
 * Where an arc tangent to a curve leaves its end `p`: the curve's direction
 * there, pointing away from the curve. Lines and arcs only.
 */
export function leavingDirection(
  geometry: SketchGeometry,
  p: string,
): { curve: string; direction: P2; round: P2 | null } | null {
  for (const c of geometry.curves.values()) {
    const row = c.row;
    if (c.kind === 'line' && (row.start === p || row.end === p)) {
      const [a, b] = [geometry.point(row.start as string), geometry.point(row.end as string)];
      if (!a || !b) continue;
      const dir = unit(row.end === p ? sub(b, a) : sub(a, b));
      if (dir) return { curve: c.id, direction: dir, round: null };
    }
    if (c.kind === 'arc' && (row.start === p || row.end === p) && row.start !== row.end) {
      const [o, q] = [geometry.point(row.center as string), geometry.point(p)];
      if (!o || !q) continue;
      // Counter-clockwise along the arc at its end; back against it at its start.
      const ccw = unit(left(sub(q, o)));
      if (ccw) return { curve: c.id, direction: row.end === p ? ccw : scale(ccw, -1), round: o };
    }
  }
  return null;
}

/** The arc leaving `s` along `t` and ending at `e`: its centre, and whether it turns counter-clockwise. */
function tangentArcThrough(s: P2, t: P2, e: P2): { center: P2; radius: number; ccw: boolean } | null {
  const d = sub(e, s);
  const n = left(t);
  const k = dot(n, d);
  if (Math.abs(k) < 1e-9 * Math.max(1, dot(d, d))) return null;
  const r = dot(d, d) / (2 * k);
  return { center: add(s, scale(n, r)), radius: Math.abs(r), ccw: r > 0 };
}

export const SHAPES: Record<ShapeTool, ShapeSpec> = {
  centerRectangle: {
    clicks: 2,
    label: 'Draw rectangle',
    preview: ([c], cursor) => {
      if (!c) return [];
      const [p0, p1, p2, p3] = centeredCorners(c, cursor);
      return [path([p0, p1, p2, p3, p0]), segment(p0, p2)];
    },
    build(d, [center, corner], ctx) {
      if (!center || !corner) return null;
      const [p0, p1, p2, p3] = centeredCorners(center.at, corner.at);
      if (Math.abs(p2[0] - p0[0]) < TINY || Math.abs(p2[1] - p0[1]) < TINY)
        return 'A rectangle has a width and a height';
      const c = d.place(center);
      const ids = [d.point(p0), d.point(p1), d.place(corner), d.point(p3)];
      const lines = ids.map((p, i) => d.make.line(p, ids[(i + 1) % 4] as string, ctx.construction));
      d.curves.push(...lines);
      lines.forEach((l, i) =>
        d.constrain(i % 2 === 0 ? 'horizontal' : 'vertical', { of: { curve: { id: l.id } } }, true),
      );
      // The centre holds the middle of a construction diagonal.
      const diagonal = d.make.line(ids[0] as string, ids[2] as string, true);
      d.curves.push(diagonal);
      d.constrain('midpoint', { point: pointOperand(c), curve: curveOperand(diagonal.id as string) }, false);
      return null;
    },
  },
  circle2: {
    clicks: 2,
    label: 'Draw circle',
    preview: ([a], cursor) => (a ? [ring(scale(add(a, cursor), 0.5), near(a, cursor) / 2), segment(a, cursor)] : []),
    build(d, snaps, ctx) {
      const [a, b] = snaps as [Snap, Snap];
      const radius = near(a.at, b.at) / 2;
      if (radius < TINY) return 'A circle has a radius';
      const circle = d.make.circle(d.point(scale(add(a.at, b.at), 0.5)), radius, ctx.construction);
      d.curves.push(circle);
      onCircle(d, snaps, circle.id as string);
      return null;
    },
  },
  circle3: {
    clicks: 3,
    label: 'Draw circle',
    preview: ([a, b], cursor) => {
      if (!a) return [];
      if (!b) return [segment(a, cursor)];
      const circle = circumcircle(a, b, cursor);
      return circle ? [ring(circle.center, circle.radius)] : [path([a, b, cursor])];
    },
    build(d, snaps, ctx) {
      const [a, b, c] = snaps as [Snap, Snap, Snap];
      const circle = circumcircle(a.at, b.at, c.at);
      if (!circle) return 'Those three points are on one line';
      const row = d.make.circle(d.point(circle.center), circle.radius, ctx.construction);
      d.curves.push(row);
      onCircle(d, snaps, row.id as string);
      return null;
    },
  },
  arcCenter: {
    clicks: 3,
    label: 'Draw arc',
    preview: ([c, s], cursor, ctx) => {
      if (!c) return [];
      if (!s) return [segment(c, cursor), ring(c, near(c, cursor))];
      const r = near(c, s);
      const dir = unit(sub(cursor, c));
      if (!dir || r < TINY) return [segment(c, s)];
      const e = add(c, scale(dir, r));
      const [from, to] = ctx.sweep >= 0 ? [s, e] : [e, s];
      return [segment(c, s), { kind: 'arc', center: c, radius: r, from, to }];
    },
    build(d, [c, s, e], ctx) {
      if (!c || !s || !e) return null;
      const r = near(c.at, s.at);
      const dir = unit(sub(e.at, c.at));
      if (r < TINY || !dir) return 'An arc has a radius';
      const end = add(c.at, scale(dir, r));
      if (near(end, s.at) < TINY) return 'An arc has a sweep';
      const center = d.place(c);
      const start = d.place(s);
      const finish = e.kind === 'point' ? e.id : d.point(end);
      d.curves.push(
        ctx.sweep >= 0
          ? d.make.arc(center, start, finish, ctx.construction)
          : d.make.arc(center, finish, start, ctx.construction),
      );
      return null;
    },
  },
  tangentArc: {
    clicks: 2,
    label: 'Draw tangent arc',
    start(snap, ctx) {
      if (snap.kind !== 'point' || !leavingDirection(ctx.geometry, snap.id))
        return 'Start a tangent arc at the end of a line or arc';
      return null;
    },
    preview: ([s], cursor, ctx, snaps) => {
      const first = snaps[0];
      if (!s || first?.kind !== 'point') return [];
      const leave = leavingDirection(ctx.geometry, first.id);
      const arc = leave ? tangentArcThrough(s, leave.direction, cursor) : null;
      if (!arc) return [segment(s, cursor)];
      const [from, to] = arc.ccw ? [s, cursor] : [cursor, s];
      return [{ kind: 'arc', center: arc.center, radius: arc.radius, from, to }];
    },
    build(d, [s, e], ctx) {
      if (!s || !e || s.kind !== 'point') return null;
      const leave = leavingDirection(ctx.geometry, s.id);
      if (!leave) return 'Start a tangent arc at the end of a line or arc';
      const arc = tangentArcThrough(s.at, leave.direction, e.at);
      if (!arc) return 'That arc would be a straight line';
      const center = d.point(arc.center);
      const end = d.place(e);
      if (end === s.id) return 'An arc has a sweep';
      const row = arc.ccw
        ? d.make.arc(center, s.id, end, ctx.construction)
        : d.make.arc(center, end, s.id, ctx.construction);
      d.curves.push(row);
      // Touching from inside when both centres lie on one side of the shared tangent.
      const n = left(leave.direction);
      const internal =
        leave.round !== null && Math.sign(dot(n, sub(leave.round, s.at))) === Math.sign(dot(n, sub(arc.center, s.at)));
      const tangent = d.constrain(
        'tangent',
        { a: curveOperand(leave.curve), b: curveOperand(row.id as string) },
        false,
      );
      tangent.internal = d.make.flag(internal);
      return null;
    },
  },
  polygon: {
    clicks: 2,
    label: 'Draw polygon',
    preview: ([c], cursor, ctx) => {
      if (!c) return [];
      const v = polygonVertices(c, cursor, ctx.sides);
      return [path([...v, v[0] as P2]), ring(c, near(c, cursor))];
    },
    build(d, [c, v], ctx) {
      if (!c || !v) return null;
      const r = near(c.at, v.at);
      if (r < TINY) return 'A polygon has a size';
      const center = d.place(c);
      polygonRows(d, center, r, polygonVertices(c.at, v.at, ctx.sides), new Map([[0, d.place(v)]]), ctx.construction);
      return null;
    },
  },
  polygonCircumscribed: {
    clicks: 2,
    label: 'Draw polygon',
    preview: ([c], cursor, ctx) => {
      if (!c) return [];
      const { vertices } = circumscribedVertices(c, cursor, ctx.sides);
      return [path([...vertices, vertices[0] as P2]), ring(c, near(c, cursor))];
    },
    build(d, [c, m], ctx) {
      if (!c || !m) return null;
      const r = near(c.at, m.at);
      if (r < TINY) return 'A polygon has a size';
      const center = d.place(c);
      const { vertices, radius } = circumscribedVertices(c.at, m.at, ctx.sides);
      const { lines } = polygonRows(d, center, radius, vertices, new Map(), ctx.construction);
      // Its sides touch a construction circle about the same centre, which sizes it across the flats.
      const inner = d.make.circle(center, r, true);
      d.curves.push(inner);
      const tangent = d.constrain(
        'tangent',
        { a: curveOperand(lines[0]?.id as string), b: curveOperand(inner.id as string) },
        false,
      );
      tangent.internal = d.make.flag(false);
      return null;
    },
  },
  polygonEdge: {
    clicks: 3,
    label: 'Draw polygon',
    preview: ([a, b], cursor, ctx) => {
      if (!a) return [];
      if (!b) return [segment(a, cursor)];
      const made = edgePolygon(a, b, cursor, ctx.sides);
      return made ? [path([...made.vertices, made.vertices[0] as P2])] : [segment(a, b)];
    },
    build(d, [a, b, toward], ctx) {
      if (!a || !b || !toward) return null;
      const made = edgePolygon(a.at, b.at, toward.at, ctx.sides);
      if (!made || near(a.at, b.at) < TINY) return 'A polygon has a size';
      // The second click is the corner next to the first, one way round or the other.
      const next = made.vertices.reduce(
        (best, p, i) => (i > 0 && near(p, b.at) < near(made.vertices[best] as P2, b.at) ? i : best),
        1,
      );
      const placed = new Map([
        [0, d.place(a)],
        [next, d.place(b)],
      ]);
      polygonRows(d, d.point(made.center), near(made.center, a.at), made.vertices, placed, ctx.construction);
      return null;
    },
  },
  slot: {
    clicks: 3,
    label: 'Draw slot',
    preview: ([a, b], cursor) => {
      if (!a) return [];
      if (!b) return [segment(a, cursor)];
      return slotOutline(a, b, cursor);
    },
    build(d, [sa, sb, sw], ctx) {
      if (!sa || !sb || !sw) return null;
      const f = slotFrame(sa.at, sb.at, sw.at);
      if (!f) return 'A slot has a length';
      const { n, half } = f;
      const [a, b] = [d.place(sa), d.place(sb)];
      if (a === b) return 'A slot has a length';
      const offset = (p: P2, k: number) => d.point(add(p, scale(n, k * half)));
      const [a1, b1, b2, a2] = [offset(sa.at, 1), offset(sb.at, 1), offset(sb.at, -1), offset(sa.at, -1)];
      const bottom = d.make.line(a2, b2, ctx.construction);
      const capB = d.make.arc(b, b2, b1, ctx.construction);
      const top = d.make.line(b1, a1, ctx.construction);
      const capA = d.make.arc(a, a1, a2, ctx.construction);
      const axis = d.make.line(a, b, true);
      d.curves.push(bottom, capB, top, capA, axis);
      const id = (row: Json) => row.id as string;
      for (const [x, y] of [
        [bottom, capB],
        [capB, top],
        [top, capA],
        [capA, bottom],
      ] as const) {
        const t = d.constrain('tangent', { a: curveOperand(id(x)), b: curveOperand(id(y)) }, false);
        t.internal = d.make.flag(false);
      }
      d.constrain('equal', { a: curveOperand(id(capA)), b: curveOperand(id(capB)) }, false);
      const along = inferAxis(sa.at, sb.at, ctx.pixel);
      if (along && sa.kind !== 'point' && sb.kind !== 'point')
        d.constrain(along, { of: { curve: { id: id(axis) } } }, true);
      return null;
    },
  },
  ellipse: {
    clicks: 3,
    label: 'Draw ellipse',
    preview: ([c, m], cursor) => {
      if (!c) return [];
      if (!m) return [segment(c, cursor)];
      const axes = ellipseAxes(c, m, cursor);
      return axes ? [path(ellipsePolyline(c, axes.majorEnd, axes.minor)), segment(c, m)] : [segment(c, m)];
    },
    build(d, [c, m, p], ctx) {
      if (!c || !m || !p) return null;
      const axes = ellipseAxes(c.at, m.at, p.at);
      if (!axes) return 'An ellipse has a size';
      const center = d.place(c);
      const majorEnd = axes.majorEnd === m.at ? d.place(m) : d.point(axes.majorEnd);
      if (majorEnd === center) return 'An ellipse has a size';
      d.curves.push(d.make.ellipse(center, majorEnd, axes.minor, ctx.construction));
      return null;
    },
  },
  spline: {
    clicks: Infinity,
    label: 'Draw spline',
    preview: (at, cursor) => (at.length === 0 ? [] : [path([...at, cursor])]),
    build(d, snaps, ctx) {
      const through: string[] = [];
      for (const s of snaps) {
        const id = d.place(s);
        if (through[through.length - 1] !== id) through.push(id);
      }
      if (through.length < 2) return 'A spline passes two or more points';
      d.curves.push(d.make.spline(through, ctx.construction));
      return null;
    },
  },
};

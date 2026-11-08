/**
 * Solves a version-2 sketch (spec 8.1, 8.2) with planegcs: stored point
 * positions are the starting state, and dimensions' values drive. Coincidence
 * is a shared point, so it needs no constraint. A sketch that does not solve
 * pauses, and so does one with a constraint the solver cannot express.
 *
 * An ellipse is held by a focus point of the solver's own: the major end lies
 * on the ellipse and the focus on the line from the centre to it, which makes
 * the major end a vertex. A bezier, conic and NURBS are B-splines over their
 * sketch points; a spline's curve follows its through points, which the
 * solver cannot express, so constraints on the spline curve itself pause.
 * Where curves share an end, tangency and normality are angles between the
 * solver's normals there, which converge as closely as any other constraint.
 *
 * External curves are fixed geometry: each stands in the solve as a curve of
 * its built kind over points of its own, held where it was built, so
 * constraints can use it and never move it. The sketch's own origin and axes
 * (`sketchStandard` operands) are fixed the same way: a held point at (0, 0)
 * and held lines from it along +x and +y.
 */
import { Algorithm, SolveStatus, type GcsWrapper, type SketchPrimitive } from '@salusoft89/planegcs';
import { prepareCurve, type CurveShape, type ValueEvaluator } from '@tweakcad/format';
import { curveGeometry, curveReader, definingPoints, polesOf } from './sketchCurves';
import type { ExternalCurve } from './sketchExternal';

type Json = Record<string, unknown>;
type P2 = readonly [number, number];

export class SketchSolvePause extends Error {}

export interface SolvedPositions {
  points: Map<string, { x: number; y: number }>;
  /** Solver variables of curves: a circle's or arc's radius, an ellipse's or elliptical arc's minor radius. */
  radii: Map<string, number>;
}

const LENGTH = { type: 'number', quantity: 'length' } as const;
const ANGLE = { type: 'number', quantity: 'angle' } as const;
const FLAG = { type: 'boolean' } as const;

const ROUND = ['circle', 'arc'];
const ELLIPTIC = ['ellipse', 'ellipticalArc'];
const POLED = ['bezier', 'nurbs', 'conic'];

interface Curve {
  id: string;
  kind: string;
  row: Json;
  /** The curve at the stored positions. */
  shape: CurveShape | null;
  /** Control points of a B-spline over sketch points. */
  poles: string[] | null;
}

/** The sketch points at a curve's two ends, when it has them. */
function endsOf(c: Curve): string[] {
  switch (c.kind) {
    case 'line':
    case 'arc':
    case 'ellipticalArc':
    case 'bezier':
    case 'conic':
      return [c.row.start, c.row.end] as string[];
    case 'nurbs': {
      const poles = c.poles ?? [];
      const shape = c.shape;
      const clamped =
        shape?.kind === 'nurbs' &&
        !shape.periodic &&
        shape.multiplicities[0] === shape.degree + 1 &&
        shape.multiplicities[shape.multiplicities.length - 1] === shape.degree + 1;
      return clamped ? [poles[0] as string, poles[poles.length - 1] as string] : [];
    }
    default:
      return [];
  }
}

/**
 * An external curve as a row of its built kind over points of its own (named
 * after the row), with those points' positions.
 */
function externalRow(e: ExternalCurve): { row: Json; points: [string, P2][]; poles: string[] | null } {
  const s = e.shape;
  const pt = (name: string) => `${e.id}:at:${name}`;
  const base = { id: e.id, kind: s.kind };
  switch (s.kind) {
    case 'line':
      return {
        row: { ...base, start: pt('start'), end: pt('end') },
        points: [
          [pt('start'), s.start],
          [pt('end'), s.end],
        ],
        poles: null,
      };
    case 'circle':
      return {
        row: { ...base, center: pt('center'), radius: s.radius },
        points: [[pt('center'), s.center]],
        poles: null,
      };
    case 'arc':
      return {
        row: { ...base, center: pt('center'), start: pt('start'), end: pt('end') },
        points: [
          [pt('center'), s.center],
          [pt('start'), s.start],
          [pt('end'), s.end],
        ],
        poles: null,
      };
    case 'ellipse':
      return {
        row: { ...base, center: pt('center'), majorEnd: pt('major'), minorRadius: s.minorRadius },
        points: [
          [pt('center'), s.center],
          [pt('major'), s.majorEnd],
        ],
        poles: null,
      };
    case 'ellipticalArc':
      return {
        row: {
          ...base,
          center: pt('center'),
          majorEnd: pt('major'),
          minorRadius: s.minorRadius,
          start: pt('start'),
          end: pt('end'),
        },
        points: [
          [pt('center'), s.center],
          [pt('major'), s.majorEnd],
          [pt('start'), s.start],
          [pt('end'), s.end],
        ],
        poles: null,
      };
    case 'nurbs': {
      const poles = s.poles.map((_, i) => pt(`pole${i}`));
      return { row: { ...base, poles }, points: s.poles.map((p, i) => [poles[i] as string, p]), poles };
    }
    default:
      throw new SketchSolvePause(`an external ${s.kind} is not solved`);
  }
}

type Operand = { kind: 'point' | 'curve'; id: string };

const pairKey = (p: string, q: string) => (p < q ? `${p} ${q}` : `${q} ${p}`);
/** A solver variable of a curve, as a constraint takes it. */
const param = (o_id: string, prop: 'start_angle' | 'end_angle' | 'radius') => ({ o_id, prop });

/**
 * Which points and curves the active constraints hold as mirror images of
 * each other, so a mirrored copy's equations that the original's already
 * imply are left out: planegcs counts those as redundant.
 *
 * Point pairs are held mirrored by a `symmetric` of two points, or for two
 * arcs held `symmetric` their centres and crossed ends. A point is its own
 * image across a line it is held on: an end of the line, a point on it or at
 * its middle, or a point level with (plumb with) the sketch origin for the
 * sketch's x (y) axis.
 */
class MirrorTies {
  /** Each tied point pair, keyed by `pairKey`, with the axes it is mirrored across. */
  private readonly ties = new Map<string, Set<string>>();
  /** The points each point is tied to. */
  private readonly partners = new Map<string, Set<string>>();
  /** `pairKey(point, line)` for each point held on a line. */
  private readonly onLine = new Set<string>();

  constructor(
    private readonly curves: ReadonlyMap<string, Curve>,
    active: readonly Json[],
    operand: (v: unknown) => Operand,
    origin: string,
    axes: { x: string; y: string },
  ) {
    const read = (v: unknown): Operand | null => {
      try {
        return operand(v);
      } catch {
        return null;
      }
    };
    for (const c of active) {
      if (c.kind === 'symmetric') {
        const [a, b, axis] = [read(c.a), read(c.b), read(c.axis)];
        if (!a || !b || !axis) continue;
        if (a.kind === 'point' && b.kind === 'point') this.tie(a.id, b.id, axis.id);
        else {
          const [ca, cb] = [curves.get(a.id), curves.get(b.id)];
          if (ca?.kind !== 'arc' || cb?.kind !== 'arc') continue;
          // A mirrored arc runs the other way: each one's start mirrors the other's end.
          this.tie(ca.row.center as string, cb.row.center as string, axis.id);
          this.tie(ca.row.start as string, cb.row.end as string, axis.id);
          this.tie(ca.row.end as string, cb.row.start as string, axis.id);
        }
      } else if (c.kind === 'pointOnCurve' || c.kind === 'midpoint') {
        const [p, on] = [read(c.point), read(c.curve)];
        if (p?.kind === 'point' && on?.kind === 'curve') this.onLine.add(pairKey(p.id, on.id));
      } else if ((c.kind === 'horizontal' || c.kind === 'vertical') && 'points' in (c.of as Json)) {
        const pts = (c.of as Json).points as Json;
        const [a, b] = [read(pts.a), read(pts.b)];
        const other = a?.id === origin ? b : b?.id === origin ? a : null;
        if (other) this.onLine.add(pairKey(other.id, c.kind === 'horizontal' ? axes.x : axes.y));
      }
    }
  }

  private tie(p: string, q: string, axis: string): void {
    const key = pairKey(p, q);
    this.ties.set(key, (this.ties.get(key) ?? new Set()).add(axis));
    this.partners.set(p, (this.partners.get(p) ?? new Set()).add(q));
    this.partners.set(q, (this.partners.get(q) ?? new Set()).add(p));
  }

  /** The points tied to `p`. */
  tiedTo(p: string): ReadonlySet<string> {
    return this.partners.get(p) ?? new Set();
  }

  /** Whether `q` is held as `p`'s mirror image across `axis`. */
  private mirrors(p: string, q: string, axis: string): boolean {
    if (this.ties.get(pairKey(p, q))?.has(axis)) return true;
    if (p !== q) return false;
    const line = this.curves.get(axis)?.row;
    return line?.start === p || line?.end === p || this.onLine.has(pairKey(p, axis));
  }

  /** Whether each pair's second point is the first itself, or each is held as the first's mirror image across one axis. */
  reflected(pairs: readonly (readonly [string, string])[]): boolean {
    if (pairs.every(([p, q]) => p === q)) return true;
    const axes = new Set<string>();
    for (const [p, q] of pairs) for (const axis of this.ties.get(pairKey(p, q)) ?? []) axes.add(axis);
    return [...axes].some((axis) => pairs.every(([p, q]) => this.mirrors(p, q, axis)));
  }

  /** Whether arc `b` is held as arc `a` reflected, centre to centre and end to end, either way round. */
  arcImage(a: Curve, b: Curve): boolean {
    const [ac, as, ae] = [a.row.center, a.row.start, a.row.end] as [string, string, string];
    const [bc, bs, be] = [b.row.center, b.row.start, b.row.end] as [string, string, string];
    return (
      this.reflected([
        [ac, bc],
        [as, be],
        [ae, bs],
      ]) ||
      this.reflected([
        [ac, bc],
        [as, bs],
        [ae, be],
      ])
    );
  }
}

/**
 * The arcs whose rule |centre − end| = radius the others imply. Arcs held as
 * mirror images of one another (or on the same three points) have their
 * centres as far from their ends together, so in each group of them only one
 * keeps the rule: the first held arc, or else the first.
 */
function impliedArcRules(
  curves: ReadonlyMap<string, Curve>,
  ties: MirrorTies,
  isHeld: (c: Curve) => boolean,
): Set<string> {
  const arcs = [...curves.values()].filter((c) => c.kind === 'arc');
  const byCenter = new Map<string, Curve[]>();
  for (const c of arcs) {
    const center = c.row.center as string;
    byCenter.set(center, [...(byCenter.get(center) ?? []), c]);
  }
  const parent = new Map(arcs.map((c) => [c.id, c.id]));
  const root = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(id, r);
    return r;
  };
  for (const b of arcs) {
    const center = b.row.center as string;
    for (const q of [center, ...ties.tiedTo(center)]) {
      for (const a of byCenter.get(q) ?? []) {
        if (a.id === b.id || root(a.id) === root(b.id) || !ties.arcImage(a, b)) continue;
        parent.set(root(b.id), root(a.id));
      }
    }
  }
  const keeper = new Map<string, string>();
  for (const c of arcs) {
    const r = root(c.id);
    const kept = keeper.get(r);
    if (kept === undefined || (isHeld(c) && !isHeld(curves.get(kept) as Curve))) keeper.set(r, c.id);
  }
  return new Set(arcs.filter((c) => keeper.get(root(c.id)) !== c.id).map((c) => c.id));
}

/**
 * Largest system handed to planegcs, as unknowns × equations. Its solve holds a
 * dense matrix in a WASM heap that cannot grow past a fixed size, and running
 * out aborts the module for good: every later solve in the session would fail
 * too. Measured on a fresh module with a chain of lines: 1,000 unknowns × 500
 * equations solves, 1,300 × 650 aborts.
 */
export const MAX_SOLVER_SYSTEM_SIZE = 400_000;

/** Unknowns × equations for a sketch. Each arc adds three unknowns of its own and the rules that hold it together. */
export function solverSystemSize(inputs: Json): number {
  let unknowns = (inputs.points as Json[]).length * 2;
  let equations = (inputs.constraints as Json[]).length;
  for (const c of inputs.curves as Json[]) {
    if (c.kind === 'circle') unknowns += 1;
    else if (ROUND.includes(c.kind as string)) {
      unknowns += 3;
      equations += 4;
    } else if (ELLIPTIC.includes(c.kind as string)) {
      unknowns += 5;
      equations += 4;
    }
  }
  return unknowns * equations;
}

export function solveSketchPositions(
  inputs: Json,
  values: ValueEvaluator,
  gcs: GcsWrapper,
  externals: readonly ExternalCurve[] = [],
): SolvedPositions {
  gcs.clear_data();
  // Too big to solve: it stays as stored, rather than the solver being lost.
  if (solverSystemSize(inputs) > MAX_SOLVER_SYSTEM_SIZE) {
    return {
      points: new Map((inputs.points as Json[]).map((p) => [p.id as string, { x: p.x as number, y: p.y as number }])),
      radii: new Map(),
    };
  }
  const push = (p: SketchPrimitive) => gcs.push_primitive(p);
  const active = (inputs.constraints as Json[]).filter((c) => values.literal(c.active, FLAG) === true);

  const position = new Map<string, P2>();
  for (const p of inputs.points as Json[]) position.set(p.id as string, [p.x as number, p.y as number]);
  const own = new Set(position.keys());
  const at = (id: string): P2 => {
    const p = position.get(id);
    if (!p) throw new SketchSolvePause(`point ${id} is missing`);
    return p;
  };
  const stored = curveReader(values, position, () => undefined);

  const curves = new Map<string, Curve>();
  for (const row of inputs.curves as Json[]) {
    const id = row.id as string;
    const kind = row.kind as string;
    if (kind === 'external') continue;
    const geometry = kind === 'point' ? null : curveGeometry(row, stored);
    curves.set(id, { id, kind, row, shape: geometry?.shape ?? null, poles: polesOf(row) });
  }
  // External curves are held where they were built: their points fixed, their variables blocked.
  const fixedCurves: Curve[] = [];
  for (const e of externals) {
    const { row, points, poles } = externalRow(e);
    for (const [id, p] of points) position.set(id, p);
    const c: Curve = { id: e.id, kind: e.shape.kind, row, shape: e.shape, poles };
    curves.set(e.id, c);
    fixedCurves.push(c);
  }

  // The sketch's origin and axes, when a constraint uses them.
  const STANDARD = { origin: 'sketch:origin', x: 'sketch:x', y: 'sketch:y' } as const;
  const standardHeld: string[] = [];
  if (active.some((c) => JSON.stringify(c).includes('"sketchStandard"'))) {
    const ends: [string, P2][] = [
      [STANDARD.origin, [0, 0]],
      ['sketch:x:end', [1, 0]],
      ['sketch:y:end', [0, 1]],
    ];
    for (const [id, p] of ends) {
      position.set(id, p);
      standardHeld.push(id);
    }
    for (const axis of ['x', 'y'] as const) {
      const id = STANDARD[axis];
      const end = axis === 'x' ? 'sketch:x:end' : 'sketch:y:end';
      curves.set(id, {
        id,
        kind: 'line',
        row: { id, kind: 'line', start: STANDARD.origin, end },
        shape: { kind: 'line', start: [0, 0], end: position.get(end) as P2 },
        poles: null,
      });
    }
  }

  const operand = (v: unknown): { kind: 'point' | 'curve'; id: string } => {
    const o = v as Json;
    if ('sketchStandard' in o) {
      const name = (o.sketchStandard as Json).name;
      if (name === 'origin') return { kind: 'point', id: STANDARD.origin };
      if (name === 'x' || name === 'y') return { kind: 'curve', id: STANDARD[name] };
      throw new SketchSolvePause(`unknown sketchStandard name ${String(name)}`);
    }
    if ('point' in o) return { kind: 'point', id: (o.point as Json).id as string };
    if ('curve' in o) return { kind: 'curve', id: (o.curve as Json).id as string };
    if ('external' in o) return { kind: 'curve', id: (o.external as Json).id as string };
    throw new SketchSolvePause('a constraint operand of an unknown form');
  };
  const isPoint = (v: unknown) => operand(v).kind === 'point';
  const point = (v: unknown) => {
    const o = operand(v);
    if (o.kind !== 'point') throw new SketchSolvePause('expected a point operand');
    return o.id;
  };
  const curve = (v: unknown, ...kinds: string[]): Curve => {
    const o = operand(v);
    const found = curves.get(o.id);
    if (o.kind !== 'curve' || !found) throw new SketchSolvePause('expected a curve operand');
    if (found.kind === 'spline') {
      throw new SketchSolvePause(
        'constraints on a spline curve itself are not solved yet: its curve follows its through points',
      );
    }
    if (kinds.length > 0 && !kinds.includes(found.kind))
      throw new SketchSolvePause(`expected ${kinds.join(' or ')} operand`);
    return found;
  };

  // Points held where they are: fixed points, and the points of blocked curves. An arc's
  // ends follow its centre, so a blocked arc holds its end by its direction from the centre.
  const held = new Set<string>();
  const blocked: Curve[] = [];
  const aimed: [string, string][] = [];
  for (const c of active) {
    if (c.kind === 'fixed') {
      const p = (c.point as Json).point as Json | undefined;
      if (p) held.add(p.id as string);
    } else if (c.kind === 'block') {
      const o = operand(c.curve);
      const found = curves.get(o.id);
      if (o.kind !== 'curve' || !found) throw new SketchSolvePause('block takes a curve');
      const row = found.row;
      if (found.kind === 'arc') {
        held.add(row.center as string).add(row.start as string);
        aimed.push([row.center as string, row.end as string]);
      } else if (found.kind === 'ellipticalArc') {
        held.add(row.center as string).add(row.majorEnd as string);
        aimed.push([row.center as string, row.start as string], [row.center as string, row.end as string]);
      } else for (const p of definingPoints(row)) held.add(p);
      blocked.push(found);
    }
  }
  for (const c of fixedCurves) {
    for (const p of definingPoints(c.row)) held.add(p);
    blocked.push(c);
  }
  for (const id of standardHeld) held.add(id);
  const ties = new MirrorTies(curves, active, operand, STANDARD.origin, STANDARD);
  const impliedArcs = impliedArcRules(curves, ties, (c) =>
    ['center', 'start', 'end'].every((f) => held.has(c.row[f] as string)),
  );
  for (const [id, [x, y]] of position) push({ type: 'point', id, x, y, fixed: held.has(id) });
  aimed.forEach(([from, to], n) => {
    if (held.has(to)) return;
    const [o, q] = [at(from), at(to)];
    push({
      type: 'p2p_angle',
      id: `${to}:aim:${n}`,
      p1_id: from,
      p2_id: to,
      angle: Math.atan2(q[1] - o[1], q[0] - o[0]),
    });
  });
  /** An arc whose centre and ends are all held is held already, and its rules would over-determine it: its variables are bound where they are instead. */
  const boundArcs = new Set<string>();
  const bound = (c: Curve, fields: string[], values: Record<string, number>) => {
    if (!fields.every((f) => held.has(c.row[f] as string))) return false;
    boundArcs.add(c.id);
    for (const [prop, v] of Object.entries(values)) {
      push({ type: 'equal', id: `${c.id}:bound:${prop}`, param1: { o_id: c.id, prop: prop as 'radius' }, param2: v });
    }
    return true;
  };
  // The stored focus of each ellipse, for its normal.
  const foci = new Map<string, P2>();

  for (const c of curves.values()) {
    const { id, row } = c;
    switch (c.kind) {
      case 'line':
        push({ type: 'line', id, p1_id: row.start as string, p2_id: row.end as string });
        break;
      case 'circle':
        push({ type: 'circle', id, c_id: row.center as string, radius: row.radius as number });
        break;
      case 'arc': {
        const [o, s, e] = [at(row.center as string), at(row.start as string), at(row.end as string)];
        push({
          type: 'arc',
          id,
          c_id: row.center as string,
          start_id: row.start as string,
          end_id: row.end as string,
          radius: Math.hypot(s[0] - o[0], s[1] - o[1]),
          start_angle: Math.atan2(s[1] - o[1], s[0] - o[0]),
          end_angle: Math.atan2(e[1] - o[1], e[0] - o[0]),
        });
        // |center − start| = |center − end| is intrinsic to an arc (8.1).
        const radius = Math.hypot(s[0] - o[0], s[1] - o[1]);
        const angles = {
          start_angle: Math.atan2(s[1] - o[1], s[0] - o[0]),
          end_angle: Math.atan2(e[1] - o[1], e[0] - o[0]),
        };
        if (bound(c, ['center', 'start', 'end'], { radius, ...angles })) break;
        if (impliedArcs.has(id)) {
          // The rules but |centre − end| = radius, which the arc this one mirrors implies.
          const [center, start, end] = [row.center, row.start, row.end] as [string, string, string];
          push({
            type: 'p2p_angle',
            id: `${id}:rules:0`,
            p1_id: center,
            p2_id: start,
            angle: param(id, 'start_angle'),
          });
          push({ type: 'p2p_angle', id: `${id}:rules:1`, p1_id: center, p2_id: end, angle: param(id, 'end_angle') });
          push({
            type: 'p2p_distance',
            id: `${id}:rules:2`,
            p1_id: center,
            p2_id: start,
            distance: param(id, 'radius'),
          });
        } else push({ type: 'arc_rules', id: `${id}:rules`, a_id: id });
        break;
      }
      case 'ellipse':
      case 'ellipticalArc': {
        const [o, m] = [at(row.center as string), at(row.majorEnd as string)];
        const major = Math.hypot(m[0] - o[0], m[1] - o[1]);
        if (!(major > 0)) throw new SketchSolvePause('an ellipse has no major radius');
        const minor = row.minorRadius as number;
        // The solver's ellipse has its major axis the longer; one drawn the other way is not solved.
        if (!(minor > 0) || minor > major)
          throw new SketchSolvePause(
            'an ellipse whose minor radius is not between 0 and its major radius is not solved',
          );
        const u: P2 = [(m[0] - o[0]) / major, (m[1] - o[1]) / major];
        const f = Math.sqrt(Math.max(0, major * major - minor * minor));
        const focus = `${id}:focus`;
        push({ type: 'point', id: focus, x: o[0] + u[0] * f, y: o[1] + u[1] * f, fixed: false });
        foci.set(id, [o[0] + u[0] * f, o[1] + u[1] * f]);
        if (c.kind === 'ellipse') {
          push({ type: 'ellipse', id, c_id: row.center as string, focus1_id: focus, radmin: minor });
        } else {
          // Eccentric angles from the major axis, counter-clockwise from start to end.
          const angle = (p: P2) => {
            const [dx, dy] = [p[0] - o[0], p[1] - o[1]];
            return Math.atan2((-dx * u[1] + dy * u[0]) / minor, (dx * u[0] + dy * u[1]) / major);
          };
          const start = angle(at(row.start as string));
          const sweep = angle(at(row.end as string)) - start;
          const end = start + (sweep > 0 ? sweep : sweep + 2 * Math.PI);
          push({
            type: 'arc_of_ellipse',
            id,
            c_id: row.center as string,
            focus1_id: focus,
            start_id: row.start as string,
            end_id: row.end as string,
            start_angle: start,
            end_angle: end,
            radmin: minor,
          });
          // The arc's ends lie on its ellipse, as an arc's do on its circle.
          if (
            !bound(c, ['center', 'majorEnd', 'start', 'end'], { start_angle: start, end_angle: end, radmin: minor })
          ) {
            push({ type: 'arc_of_ellipse_rules', id: `${id}:rules`, a_id: id });
          }
        }
        push({ type: 'point_on_ellipse', id: `${id}:major`, p_id: row.majorEnd as string, e_id: id });
        push({
          type: 'point_on_line_ppp',
          id: `${id}:axis`,
          p_id: focus,
          lp1_id: row.center as string,
          lp2_id: row.majorEnd as string,
        });
        break;
      }
      case 'bezier':
      case 'nurbs':
      case 'conic': {
        const shape = c.shape;
        if (shape?.kind !== 'nurbs' || !c.poles) throw new SketchSolvePause('a B-spline curve has no shape');
        push({
          type: 'bspline',
          id,
          pole_ids: c.poles,
          weights: [...shape.weights],
          knots: [...shape.knots],
          mult: [...shape.multiplicities],
          degree: shape.degree,
          periodic: shape.periodic,
        });
        break;
      }
      case 'spline':
      case 'point':
      case 'external':
        break;
      default:
        throw new SketchSolvePause(`solving sketches with ${c.kind} curves is not built yet`);
    }
  }

  for (const c of blocked) {
    if (c.kind === 'circle') {
      push({
        type: 'equal',
        id: `${c.id}:block`,
        param1: { o_id: c.id, prop: 'radius' },
        param2: c.row.radius as number,
      });
    } else if (ELLIPTIC.includes(c.kind) && !boundArcs.has(c.id)) {
      push({
        type: 'equal',
        id: `${c.id}:block`,
        param1: { o_id: c.id, prop: 'radmin' },
        param2: c.row.minorRadius as number,
      });
    }
  }

  /** The end of a curve at sketch point `p`, with the next control point in from it, for a B-spline over sketch points. */
  const poleEnd = (c: Curve, p: string): string | null => {
    const poles = c.poles;
    if (!poles || !endsOf(c).includes(p)) return null;
    return (p === poles[0] ? poles[1] : poles[poles.length - 2]) ?? null;
  };
  const sharedEnd = (a: Curve, b: Curve): string | undefined => endsOf(a).find((p) => endsOf(b).includes(p));
  const centersMeet = (id: string, a: Curve, b: Curve) => {
    if (a.row.center !== b.row.center)
      push({ type: 'p2p_coincident', id, p1_id: a.row.center as string, p2_id: b.row.center as string });
  };
  const equalRadius = (id: string, a: Curve, b: Curve) => {
    if (a.kind === 'circle' && b.kind === 'circle') push({ type: 'equal_radius_cc', id, c1_id: a.id, c2_id: b.id });
    else if (a.kind === 'arc' && b.kind === 'arc') push({ type: 'equal_radius_aa', id, a1_id: a.id, a2_id: b.id });
    else if (a.kind === 'circle') push({ type: 'equal_radius_ca', id, c1_id: a.id, a2_id: b.id });
    else push({ type: 'equal_radius_ca', id, c1_id: b.id, a2_id: a.id });
  };
  interface Carrier {
    id: string;
    /** The solver's normal there at the stored positions: a line's to its left, a circle's and an ellipse's inward. */
    normal: P2;
  }
  const leftOf = (a: P2, b: P2): P2 => [a[1] - b[1], b[0] - a[0]];
  const toward = (from: P2, to: P2): P2 => {
    const [x, y] = [to[0] - from[0], to[1] - from[1]];
    const n = Math.hypot(x, y);
    return n > 0 ? [x / n, y / n] : [0, 0];
  };
  /**
   * What carries a curve's tangent at its end `p`: the curve itself, or for a
   * B-spline end a line of the solver's own through the next control point.
   */
  const carrier = (id: string, c: Curve, p: string): Carrier => {
    const q = at(p);
    const next = poleEnd(c, p);
    if (next) {
      push({ type: 'line', id, p1_id: p, p2_id: next });
      return { id, normal: leftOf(q, at(next)) };
    }
    if (c.kind === 'line') return { id: c.id, normal: leftOf(at(c.row.start as string), at(c.row.end as string)) };
    if (ROUND.includes(c.kind)) return { id: c.id, normal: toward(q, at(c.row.center as string)) };
    const focus = foci.get(c.id);
    if (ELLIPTIC.includes(c.kind) && focus) {
      const o = at(c.row.center as string);
      const [a, b] = [toward(q, focus), toward(q, [2 * o[0] - focus[0], 2 * o[1] - focus[1]])];
      return { id: c.id, normal: [a[0] + b[0], a[1] + b[1]] };
    }
    throw new SketchSolvePause(`${c.kind} curves meet other curves at an angle only at a shared end`);
  };
  /**
   * Two curves meet at their shared end `p` with the angle `angle` from one's
   * normal to the other's there, or `angle` + π when `either` and the stored
   * positions are nearer that.
   */
  const meet = (id: string, a: Curve, b: Curve, p: string, angle: number, either: boolean) => {
    const [ca, cb] = [carrier(`${id}:a`, a, p), carrier(`${id}:b`, b, p)];
    const [n1, n2] = [ca.normal, cb.normal];
    const stored = Math.atan2(n1[0] * n2[1] - n1[1] * n2[0], n1[0] * n2[0] + n1[1] * n2[1]);
    const off = Math.abs(Math.atan2(Math.sin(stored - angle), Math.cos(stored - angle)));
    const target = either && off > Math.PI / 2 ? angle + Math.PI : angle;
    push({ type: 'angle_via_point', id, crv1_id: ca.id, crv2_id: cb.id, p_id: p, angle: target });
  };
  const collinear = (id: string, a: Curve, b: Curve) => {
    const own = endsOf(a);
    ([b.row.start, b.row.end] as string[]).forEach((p, n) => {
      if (!own.includes(p)) push({ type: 'point_on_line_pl', id: `${id}:${n}`, p_id: p, l_id: a.id });
    });
  };
  // Parameters of points held on B-splines, checked against the curve's ends after the solve.
  const onSplines: { param: string; curve: Curve }[] = [];

  for (const c of active) {
    const id = c.id as string;
    // A dimension whose value is measured is driven: it reports and never drives.
    const valueDef = (c.value as Json | undefined)?.def as Json | undefined;
    if (valueDef && 'measure' in valueDef) continue;
    const length = () => values.number(c.value, LENGTH);
    const part = (n: number) => `${id}:${n}`;
    switch (c.kind) {
      case 'horizontal':
      case 'vertical': {
        const of = c.of as Json;
        if ('curve' in of) {
          const line = curve(of, 'line');
          push({ type: c.kind === 'horizontal' ? 'horizontal_l' : 'vertical_l', id, l_id: line.id });
        } else {
          const pts = of.points as Json;
          const prop = c.kind === 'horizontal' ? 'y' : 'x';
          push({ type: 'equal', id, param1: { o_id: point(pts.a), prop }, param2: { o_id: point(pts.b), prop } });
        }
        break;
      }
      case 'parallel':
        push({ type: 'parallel', id, l1_id: curve(c.a, 'line').id, l2_id: curve(c.b, 'line').id });
        break;
      case 'perpendicular':
        push({ type: 'perpendicular_ll', id, l1_id: curve(c.a, 'line').id, l2_id: curve(c.b, 'line').id });
        break;
      case 'collinear':
        collinear(id, curve(c.a, 'line'), curve(c.b, 'line'));
        break;
      case 'equal': {
        const [a, b] = [curve(c.a), curve(c.b)];
        if (a.kind === 'line' && b.kind === 'line') push({ type: 'equal_length', id, l1_id: a.id, l2_id: b.id });
        else if (ROUND.includes(a.kind) && ROUND.includes(b.kind)) equalRadius(id, a, b);
        else if (ELLIPTIC.includes(a.kind) && ELLIPTIC.includes(b.kind)) {
          // Equal minor radii, and equal major radii as equal centre-to-major-end lengths.
          push({
            type: 'equal',
            id: part(0),
            param1: { o_id: a.id, prop: 'radmin' },
            param2: { o_id: b.id, prop: 'radmin' },
          });
          // Ellipses whose centres and major ends are held mirrored have equal major radii already.
          const mirrored = ties.reflected([
            [a.row.center as string, b.row.center as string],
            [a.row.majorEnd as string, b.row.majorEnd as string],
          ]);
          if (mirrored) break;
          for (const e of [a, b])
            push({ type: 'line', id: `${id}:${e.id}`, p1_id: e.row.center as string, p2_id: e.row.majorEnd as string });
          push({ type: 'equal_length', id: part(1), l1_id: `${id}:${a.id}`, l2_id: `${id}:${b.id}` });
        } else throw new SketchSolvePause('equal needs two lines, two round curves or two ellipses');
        break;
      }
      case 'concentric': {
        const kinds = [...ROUND, ...ELLIPTIC];
        centersMeet(id, curve(c.a, ...kinds), curve(c.b, ...kinds));
        break;
      }
      case 'coradial': {
        const [a, b] = [curve(c.a, ...ROUND), curve(c.b, ...ROUND)];
        centersMeet(part(0), a, b);
        equalRadius(part(1), a, b);
        break;
      }
      case 'tangent': {
        const [a, b] = [curve(c.a), curve(c.b)];
        const internal = values.literal(c.internal, FLAG) === true;
        if (ROUND.includes(a.kind) && ROUND.includes(b.kind)) {
          const p = sharedEnd(a, b);
          if (p !== undefined) {
            // Touching from inside, both normals point the same way; from outside, opposite ways.
            meet(id, a, b, p, internal ? 0 : Math.PI, false);
          } else if (internal) {
            push({
              type: 'tangent_circumf',
              id,
              p1_id: a.row.center as string,
              p2_id: b.row.center as string,
              rd1: { o_id: a.id, prop: 'radius' },
              rd2: { o_id: b.id, prop: 'radius' },
              internal: true,
            });
          } else push({ type: 'tangent_cc', id, c1_id: a.id, c2_id: b.id });
          break;
        }
        if (internal) throw new SketchSolvePause('internal tangency is for two round curves');
        if (a.kind === 'line' && b.kind === 'line') {
          // Two tangent lines are collinear.
          collinear(id, a, b);
          break;
        }
        // At a shared end, the normals there are parallel; elsewhere the curves touch.
        const p = sharedEnd(a, b);
        if (p !== undefined) {
          meet(id, a, b, p, 0, true);
          break;
        }
        const [line, other] = a.kind === 'line' ? [a, b] : [b, a];
        if (line.kind === 'line' && other.kind === 'circle')
          push({ type: 'tangent_lc', id, l_id: line.id, c_id: other.id });
        else if (line.kind === 'line' && other.kind === 'arc')
          push({ type: 'tangent_la', id, l_id: line.id, a_id: other.id });
        else if (line.kind === 'line' && ELLIPTIC.includes(other.kind))
          push({ type: 'tangent_le', id, l_id: line.id, e_id: other.id });
        else
          throw new SketchSolvePause(
            'tangency to a B-spline, or of an ellipse to a curve not a line, is solved only at a shared end',
          );
        break;
      }
      case 'normal': {
        const [a, b] = [curve(c.a), curve(c.b)];
        const [line, other] = a.kind === 'line' ? [a, b] : [b, a];
        if (line.kind === 'line' && other.kind === 'line')
          push({ type: 'perpendicular_ll', id, l1_id: line.id, l2_id: other.id });
        else if (line.kind === 'line' && ROUND.includes(other.kind)) {
          push({ type: 'point_on_line_pl', id, p_id: other.row.center as string, l_id: line.id });
        } else {
          // At a shared end, the normals there are square to each other.
          const p = sharedEnd(a, b);
          if (p === undefined)
            throw new SketchSolvePause(
              'a curve normal to an ellipse, an arc or a B-spline is solved only at a shared end',
            );
          meet(id, a, b, p, Math.PI / 2, true);
        }
        break;
      }
      case 'curvature':
        throw new SketchSolvePause('curvature continuity is not solved: planegcs has no curvature constraint');
      case 'pointOnCurve': {
        const p = point(c.point);
        const on = curve(c.curve);
        if (on.kind === 'line') push({ type: 'point_on_line_pl', id, p_id: p, l_id: on.id });
        else if (on.kind === 'circle') push({ type: 'point_on_circle', id, p_id: p, c_id: on.id });
        else if (on.kind === 'arc') push({ type: 'point_on_arc', id, p_id: p, a_id: on.id });
        else if (ELLIPTIC.includes(on.kind)) push({ type: 'point_on_ellipse', id, p_id: p, e_id: on.id });
        else if (POLED.includes(on.kind)) {
          const shaped = on.shape && prepareCurve(on.shape, false);
          const hit = shaped?.closest(at(p))[0];
          if (!hit) throw new SketchSolvePause('a curve has no extent');
          const param = `${id}:u`;
          gcs.push_sketch_param(param, hit.t, false);
          push({ type: 'point_on_bspline', id, p_id: p, b_id: on.id, pointparam: param });
          onSplines.push({ param, curve: on });
        } else throw new SketchSolvePause(`points on ${on.kind} curves are not solved yet`);
        break;
      }
      case 'midpoint': {
        const p = point(c.point);
        const on = curve(c.curve, 'line', 'arc');
        if (on.kind === 'line') {
          push({ type: 'p2p_symmetric_ppp', id, p1_id: on.row.start as string, p2_id: on.row.end as string, p_id: p });
        } else {
          // On the arc's circle and as far from both ends: the stored state picks the arc's middle.
          push({ type: 'point_on_arc', id: part(0), p_id: p, a_id: on.id });
          push({
            type: 'point_on_perp_bisector_ppp',
            id: part(1),
            p_id: p,
            lp1_id: on.row.start as string,
            lp2_id: on.row.end as string,
          });
        }
        break;
      }
      case 'symmetric': {
        const axis = curve(c.axis, 'line');
        const ends = { l2p1_id: axis.row.start as string, l2p2_id: axis.row.end as string };
        const mirrored = (n: number, a: string, b: string) => {
          push({ type: 'midpoint_on_line_pppp', id: part(n), l1p1_id: a, l1p2_id: b, ...ends });
          push({ type: 'perpendicular_pppp', id: part(n + 1), l1p1_id: a, l1p2_id: b, ...ends });
        };
        if (isPoint(c.a) && isPoint(c.b)) mirrored(0, point(c.a), point(c.b));
        else if (!isPoint(c.a) && !isPoint(c.b)) {
          const [a, b] = [curve(c.a), curve(c.b)];
          if (!ROUND.includes(a.kind) || a.kind !== b.kind) {
            throw new SketchSolvePause('symmetric curves are solved for two circles or two arcs');
          }
          mirrored(0, a.row.center as string, b.row.center as string);
          if (a.kind === 'circle') equalRadius(part(2), a, b);
          else {
            // A mirrored arc runs the other way: each one's start mirrors the other's end.
            mirrored(2, a.row.start as string, b.row.end as string);
            mirrored(4, a.row.end as string, b.row.start as string);
          }
        } else throw new SketchSolvePause('symmetric takes two points or two curves');
        break;
      }
      case 'fixed':
      case 'block':
        // Held by the points' `fixed` flags and the blocked curves' variables.
        break;
      case 'offset': {
        const [a, b] = [curve(c.a), curve(c.b)];
        const d = values.number(c.distance, LENGTH);
        if (d < 0) throw new SketchSolvePause('an offset distance is not negative');
        if (a.kind === 'line' && b.kind === 'line') {
          // Parallel at the distance, on the side the stored positions put it.
          push({ type: 'parallel', id: part(0), l1_id: a.id, l2_id: b.id });
          push({ type: 'p2l_distance', id: part(1), p_id: b.row.start as string, l_id: a.id, distance: d });
        } else if (ROUND.includes(a.kind) && ROUND.includes(b.kind)) {
          const radius = (e: Curve) => {
            if (e.shape?.kind === 'circle') return e.shape.radius;
            const [o, s] = [at(e.row.center as string), at(e.row.start as string)];
            return Math.hypot(s[0] - o[0], s[1] - o[1]);
          };
          centersMeet(part(0), a, b);
          // Outside or inside, as the stored positions have it.
          const outside = radius(b) >= radius(a);
          push({
            type: 'difference',
            id: part(1),
            param1: { o_id: a.id, prop: 'radius' },
            param2: { o_id: b.id, prop: 'radius' },
            difference: outside ? d : -d,
          });
        } else
          throw new SketchSolvePause(
            'offsets are solved for lines, circles and arcs: an ellipse or B-spline has no offset of its kind',
          );
        break;
      }
      case 'distance': {
        if (isPoint(c.a) && isPoint(c.b)) {
          push({ type: 'p2p_distance', id, p1_id: point(c.a), p2_id: point(c.b), distance: length() });
          break;
        }
        const [p, on] = isPoint(c.a) ? [point(c.a), curve(c.b)] : [point(c.b), curve(c.a)];
        if (on.kind === 'line') push({ type: 'p2l_distance', id, p_id: p, l_id: on.id, distance: length() });
        else if (ROUND.includes(on.kind)) push({ type: 'p2cdistance', id, p_id: p, c_id: on.id, distance: length() });
        else throw new SketchSolvePause('distances are solved from a point to a point, a line, a circle or an arc');
        break;
      }
      case 'distanceX':
      case 'distanceY': {
        const prop = c.kind === 'distanceX' ? 'x' : 'y';
        push({
          type: 'difference',
          id,
          param1: { o_id: point(c.a), prop },
          param2: { o_id: point(c.b), prop },
          difference: length(),
        });
        break;
      }
      case 'length': {
        const on = curve(c.curve, 'line', 'arc');
        if (on.kind === 'line') {
          push({
            type: 'p2p_distance',
            id,
            p1_id: on.row.start as string,
            p2_id: on.row.end as string,
            distance: length(),
          });
        } else push({ type: 'arc_length', id, a_id: on.id, dist: length() });
        break;
      }
      case 'radius':
      case 'diameter': {
        const r = c.kind === 'radius' ? length() : length() / 2;
        const on = curve(c.curve, ...ROUND);
        push(
          on.kind === 'circle'
            ? { type: 'circle_radius', id, c_id: on.id, radius: r }
            : { type: 'arc_radius', id, a_id: on.id, radius: r },
        );
        break;
      }
      case 'angle': {
        const radians = (values.number(c.value, ANGLE) * Math.PI) / 180;
        let other: string;
        if ('sketchX' in (c.b as Json)) {
          // The sketch x axis as a held line of the solver's own.
          other = `${id}:x`;
          push({ type: 'point', id: `${other}0`, x: 0, y: 0, fixed: true });
          push({ type: 'point', id: `${other}1`, x: 1, y: 0, fixed: true });
          push({ type: 'line', id: other, p1_id: `${other}0`, p2_id: `${other}1` });
        } else other = curve(c.b, 'line').id;
        push({ type: 'l2l_angle_ll', id, l1_id: curve(c.a, 'line').id, l2_id: other, angle: radians });
        break;
      }
      default:
        throw new SketchSolvePause(`solving ${String(c.kind)} constraints is not built yet`);
    }
  }

  // A sketch DogLeg does not solve is tried again with Levenberg-Marquardt, then BFGS;
  // only a solution that meets every constraint counts, not one that merely minimizes their error.
  const solves = (algorithm: Algorithm) => gcs.solve(algorithm) === SolveStatus.Success;
  if (![Algorithm.DogLeg, Algorithm.LevenbergMarquardt, Algorithm.BFGS].some(solves)) {
    throw new SketchSolvePause('the sketch does not solve with these values');
  }
  gcs.apply_solution();
  if (gcs.get_gcs_conflicting_constraints().length > 0) {
    throw new SketchSolvePause('the sketch has conflicting constraints');
  }
  for (const { param, curve: on } of onSplines) {
    const u = gcs.get_sketch_param_value(param);
    const shape = on.shape;
    if (u === undefined || shape?.kind !== 'nurbs' || shape.periodic) continue;
    const [first, last] = [shape.knots[0] as number, shape.knots[shape.knots.length - 1] as number];
    const slack = 1e-9 * (last - first);
    if (u < first - slack || u > last + slack) throw new SketchSolvePause('a point held on a curve is past its end');
  }

  const solved: SolvedPositions = { points: new Map(), radii: new Map() };
  for (const id of own) {
    const p = gcs.sketch_index.get_primitive(id);
    if (p && p.type === 'point') solved.points.set(id, { x: p.x, y: p.y });
  }
  for (const id of curves.keys()) {
    if (externals.some((e) => e.id === id)) continue;
    const g = gcs.sketch_index.get_primitive(id);
    if (g && (g.type === 'circle' || g.type === 'arc')) solved.radii.set(id, g.radius);
    if (g && (g.type === 'ellipse' || g.type === 'arc_of_ellipse')) solved.radii.set(id, g.radmin);
  }
  return solved;
}

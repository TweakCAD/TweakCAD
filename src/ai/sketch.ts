/**
 * The sketch tools: a new sketch on a plane or face, drawing, constraints
 * and dimensions, the modify tools (trim, extend, fillet, offset, mirror),
 * moving points, construction curves, deleting rows, and reading a sketch
 * back with its regions. Shapes are lines, arcs and curves
 * with constraints (invariant 11), drawn as the sketch editor draws them;
 * every edit is solved and written as one command (`sketchWrite.ts`).
 */
import { isPlainObject } from '@tweakcad/format';
import { bindExpression, freeValueName, withDefaultUnit, type Json } from '@tweakcad/editor';
import type { SketchDisplay, Vec3 } from '@tweakcad/worker/src/v2/service/types';
import { findFeature } from '../app/features';
import { addSketch } from '../app/modeling/sketch';
import { sketchesOf } from '../app/modeling/profiles';
import { Draft, type Change, type RowUpdate } from '../sketcher/change';
import { CONSTRAINT_KINDS, planConstraint, type ConstraintKind } from '../sketcher/constraints';
import { planDimension, valueText, type DimensionMode } from '../sketcher/dimensions';
import { SketchGeometry, flagOn } from '../sketcher/geometry';
import {
  planExtend,
  planFillet,
  planMirror,
  planOffset,
  planTrim,
  type ModifyContext,
  type ModifyPlan,
} from '../sketcher/modify';
import {
  DIMENSION_KINDS,
  RowMaker,
  STANDARD_IDS,
  curvePoints,
  curveOperand,
  pointOperand,
  table,
  type P2,
} from '../sketcher/rows';
import { externalRows } from '../sketcher/externals';
import { externalShapes } from '../sketcher/solve';
import { WorkingValues } from '../sketcher/values';
import {
  currentKey,
  entryOf,
  exprArg,
  handleOf,
  optBool,
  planeOrAxis,
  round,
  str,
  strings,
  vec2,
  type Args,
} from './common';
import { ToolError, checkCanEdit, invalid, partArg, settledDisplay, type AiContext } from './context';
import { commitSketch, externalsOf, sketchAt, solvedSketch, type SketchAt } from './sketchWrite';
import { isPickedRegion } from '../app/picking';

const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Where new rows' points come from: given ids, points of the sketch within a tolerance, or new points. */
class Pen {
  readonly make: RowMaker;
  readonly draft: Draft;
  private readonly at = new Map<string, P2>();
  readonly made: string[] = [];

  /** `solved` holds the sketch's rows at the positions they solve to now, which positions given are matched against. */
  constructor(
    ctx: AiContext,
    readonly sketch: SketchAt,
    solved: Json,
    private readonly tolerance: number,
    readonly construction: boolean,
  ) {
    this.make = new RowMaker((kind) => ctx.services.editor.newId(kind));
    this.draft = new Draft(this.make);
    for (const p of table(solved, 'points'))
      if (typeof p.x === 'number' && typeof p.y === 'number') this.at.set(p.id as string, [p.x, p.y]);
  }

  /** The point id for an argument: `[x, y]` or a point id. A new point at the origin is held there. */
  point(v: unknown, field: string): string {
    if (typeof v === 'string') {
      if (!this.at.has(v)) throw new ToolError('NOT_FOUND', `${v} is not a point of this sketch`);
      return v;
    }
    const p = vec2(v, field);
    for (const [id, q] of this.at) if (near(p, q) <= this.tolerance) return id;
    const id = p[0] === 0 && p[1] === 0 ? this.draft.place({ kind: 'origin', at: [0, 0] }) : this.draft.point(p);
    this.at.set(id, p);
    this.made.push(id);
    return id;
  }

  /** A new point that no other point is taken for. */
  fresh(p: P2): string {
    const id = this.draft.point(p);
    this.at.set(id, p);
    this.made.push(id);
    return id;
  }

  position(id: string): P2 {
    return this.at.get(id) as P2;
  }

  curve(row: Json): string {
    this.draft.curves.push(row);
    return row.id as string;
  }

  constrain(kind: string, fields: Json, optional = true): Json {
    return this.draft.constrain(kind, fields, optional);
  }
}

async function penFor(ctx: AiContext, args: Args): Promise<Pen> {
  checkCanEdit(ctx);
  const at = sketchAt(ctx.services.editor.document, args.sketch);
  const tolerance = args.tolerance === undefined ? 1e-6 : (args.tolerance as number);
  if (typeof tolerance !== 'number' || !(tolerance >= 0)) throw invalid('`tolerance` is a number of mm, not negative');
  return new Pen(ctx, at, await solvedRows(ctx, at), tolerance, optBool(args, 'construction') ?? false);
}

/**
 * The sketch's rows at the positions they solve to with the values the
 * document has now (the stored positions are where that solve starts), as
 * the display draws it; the stored rows when it does not solve.
 */
async function solvedRows(ctx: AiContext, at: SketchAt): Promise<Json> {
  return solvedSketch(
    ctx.services.editor.document,
    await ctx.solver(),
    at,
    externalsOf(ctx.services.display.getState().display, at),
  ).inputs;
}

/** Solves and writes one sketch edit, its external curves held as the shown display built them. */
async function write(ctx: AiContext, at: SketchAt, change: Change): Promise<{ dof: number }> {
  const externals = externalsOf(ctx.services.display.getState().display, at);
  return commitSketch(ctx.services.editor, await ctx.solver(), at, change, externals);
}

/** The sketch's rows as geometry at the positions they solve to now, with its external curves. */
async function geometryOf(ctx: AiContext, at: SketchAt, values: WorkingValues): Promise<SketchGeometry> {
  return new SketchGeometry(
    await solvedRows(ctx, at),
    values,
    externalShapes(externalsOf(ctx.services.display.getState().display, at)),
  );
}

async function commit(ctx: AiContext, pen: Pen, label: string, out: Json): Promise<Json> {
  const { dof } = await write(ctx, pen.sketch, pen.draft.change(label));
  return { ...out, dof };
}

export async function sketchCreate(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const part = partArg(ctx, args.part);
  const support = planeOrAxis(ctx, args.on, ['face', 'construction'], 'on');
  const added = addSketch(editor, part, support);
  if (!added.ok) throw new ToolError('REFUSED', added.message);
  const display = await settledDisplay(ctx);
  const shown = sketchesOf(display, part).find((s) => s.feature === added.feature);
  const name = findFeature(editor.document, added.feature)?.name;
  const paused = display.pauses.find((p) => p.feature === added.feature);
  return {
    sketch: added.feature,
    name,
    ...(shown ? { frame: frameOut(shown.frame) } : {}),
    ...(paused ? { status: 'paused', message: paused.message } : {}),
  };
}

function frameOut(f: { origin: Vec3; x: Vec3; y: Vec3; normal: Vec3 }): Json {
  const r = (v: Vec3) => v.map((n) => round(n, 6));
  return { origin: r(f.origin), x: r(f.x), y: r(f.y), normal: r(f.normal) };
}

export async function drawLine(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const list = args.points;
  if (!Array.isArray(list) || list.length < 2) throw invalid('`points` lists two or more points');
  const ids = list.map((p, i) => pen.point(p, `points[${i}]`));
  const closed = optBool(args, 'closed') ?? false;
  if (closed && ids.length < 3) throw invalid('A closed chain needs three or more points');
  const curves: string[] = [];
  const ends = closed ? ids.length : ids.length - 1;
  for (let i = 0; i < ends; i++) {
    const a = ids[i] as string;
    const b = ids[(i + 1) % ids.length] as string;
    if (a === b) throw invalid(`points ${i} and ${(i + 1) % ids.length} are the same point`);
    curves.push(pen.curve(pen.make.line(a, b, pen.construction)));
  }
  return commit(ctx, pen, curves.length === 1 ? 'Draw line' : 'Draw lines', { curves, points: ids });
}

export async function drawRectangle(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const p0 = pen.point(args.from, 'from');
  const p2 = pen.point(args.to, 'to');
  const [x1, y1] = pen.position(p0);
  const [x2, y2] = pen.position(p2);
  if (Math.abs(x2 - x1) < 1e-6 || Math.abs(y2 - y1) < 1e-6)
    throw invalid('The corners make no rectangle: they share an x or a y');
  const p1 = pen.point([x2, y1], 'corner');
  const p3 = pen.point([x1, y2], 'corner');
  const corners = [p0, p1, p2, p3];
  const curves = corners.map((p, i) => pen.curve(pen.make.line(p, corners[(i + 1) % 4] as string, pen.construction)));
  curves.forEach((l, i) => pen.constrain(i % 2 === 0 ? 'horizontal' : 'vertical', { of: { curve: { id: l } } }));
  return commit(ctx, pen, 'Draw rectangle', { curves, points: corners });
}

export async function drawCircle(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const radius = args.radius;
  if (typeof radius !== 'number' || !(radius > 0)) throw invalid('`radius` is more than 0');
  const center = pen.point(args.center, 'center');
  const curve = pen.curve(pen.make.circle(center, radius, pen.construction));
  return commit(ctx, pen, 'Draw circle', { curve, center });
}

/** The circle through three points, or null when they lie on a line. */
function circumcircle(a: P2, b: P2, c: P2): { center: P2; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const scale = Math.max(near(a, b), near(b, c), near(a, c));
  if (!(Math.abs(d) > 1e-9 * scale * scale)) return null;
  const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const x = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const y = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  return { center: [x, y], radius: near([x, y], a) };
}

function counterClockwise(center: P2, start: P2, through: P2, end: P2): boolean {
  const angle = (p: P2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const turn = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return turn(angle(through) - angle(start)) < turn(angle(end) - angle(start));
}

export async function drawArc(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  if ((args.through === undefined) === (args.center === undefined))
    throw invalid('Give `through` (a three-point arc) or `center` (a center arc)');
  const s = pen.point(args.start, 'start');
  if (args.through !== undefined) {
    const e = pen.point(args.end, 'end');
    const through = vec2(args.through, 'through');
    const circle = circumcircle(pen.position(s), through, pen.position(e));
    if (!circle) throw invalid('The three points lie on a line');
    const center = pen.fresh(circle.center);
    const ccw = counterClockwise(circle.center, pen.position(s), through, pen.position(e));
    const curve = pen.curve(
      ccw ? pen.make.arc(center, s, e, pen.construction) : pen.make.arc(center, e, s, pen.construction),
    );
    return commit(ctx, pen, 'Draw arc', { curve, points: { center, start: ccw ? s : e, end: ccw ? e : s } });
  }
  const center = pen.point(args.center, 'center');
  const c = pen.position(center);
  const start = pen.position(s);
  const radius = near(c, start);
  if (!(radius > 1e-9)) throw invalid('The start is at the center');
  let e: string;
  if (typeof args.end === 'string') e = pen.point(args.end, 'end');
  else {
    const end = vec2(args.end, 'end');
    const d = near(c, end);
    if (!(d > 1e-9)) throw invalid('The end is at the center');
    e = pen.point([c[0] + ((end[0] - c[0]) * radius) / d, c[1] + ((end[1] - c[1]) * radius) / d], 'end');
  }
  if (e === s) throw invalid('The arc starts and ends at one point; draw a circle');
  const curve = pen.curve(pen.make.arc(center, s, e, pen.construction));
  return commit(ctx, pen, 'Draw arc', { curve, points: { center, start: s, end: e } });
}

export async function drawSlot(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const c1 = vec2(args.from, 'from');
  const c2 = vec2(args.to, 'to');
  const width = args.width;
  if (typeof width !== 'number' || !(width > 0)) throw invalid('`width` is more than 0');
  const length = near(c1, c2);
  if (!(length > 1e-9)) throw invalid('`from` and `to` are one point; draw a circle');
  const r = width / 2;
  const d: P2 = [(c2[0] - c1[0]) / length, (c2[1] - c1[1]) / length];
  const n: P2 = [-d[1], d[0]];
  const off = (c: P2, s: number): P2 => [c[0] + n[0] * r * s, c[1] + n[1] * r * s];
  const center1 = pen.fresh(c1);
  const center2 = pen.fresh(c2);
  const a1 = pen.point(off(c1, 1), 'corner');
  const a2 = pen.point(off(c2, 1), 'corner');
  const b1 = pen.point(off(c1, -1), 'corner');
  const b2 = pen.point(off(c2, -1), 'corner');
  const bottom = pen.curve(pen.make.line(b1, b2, pen.construction));
  const end2 = pen.curve(pen.make.arc(center2, b2, a2, pen.construction));
  const top = pen.curve(pen.make.line(a2, a1, pen.construction));
  const end1 = pen.curve(pen.make.arc(center1, a1, b1, pen.construction));
  for (const [line, arc] of [
    [bottom, end2],
    [top, end2],
    [top, end1],
    [bottom, end1],
  ] as const) {
    pen.constrain('tangent', { a: curveOperand(line), b: curveOperand(arc), internal: pen.make.flag(false) });
  }
  pen.constrain('equal', { a: curveOperand(end1), b: curveOperand(end2) });
  return commit(ctx, pen, 'Draw slot', {
    curves: [bottom, end2, top, end1],
    points: [b1, b2, a2, a1, center1, center2],
  });
}

export async function drawPolygon(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const c = vec2(args.center, 'center');
  const first = vec2(args.corner, 'corner');
  const sides = args.sides;
  if (typeof sides !== 'number' || !Number.isInteger(sides) || sides < 3 || sides > 64)
    throw invalid('`sides` is a whole number from 3 to 64');
  const radius = near(c, first);
  if (!(radius > 1e-9)) throw invalid('The corner is at the center');
  const start = Math.atan2(first[1] - c[1], first[0] - c[0]);
  const corners: string[] = [];
  for (let i = 0; i < sides; i++) {
    const t = start + (2 * Math.PI * i) / sides;
    corners.push(pen.point([c[0] + radius * Math.cos(t), c[1] + radius * Math.sin(t)], 'corner'));
  }
  const curves = corners.map((p, i) =>
    pen.curve(pen.make.line(p, corners[(i + 1) % sides] as string, pen.construction)),
  );
  // A construction circle through the corners.
  const center = pen.point(c, 'center');
  const circle = pen.curve(pen.make.circle(center, radius, true));
  for (const p of corners) pen.constrain('pointOnCurve', { point: pointOperand(p), curve: curveOperand(circle) });
  for (const l of curves.slice(1)) pen.constrain('equal', { a: curveOperand(curves[0] as string), b: curveOperand(l) });
  return commit(ctx, pen, 'Draw polygon', { curves, points: corners, circle, center });
}

export async function drawEllipse(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const minor = args.minorRadius;
  if (typeof minor !== 'number' || !(minor > 0)) throw invalid('`minorRadius` is more than 0');
  const center = pen.point(args.center, 'center');
  const majorEnd = pen.point(args.majorEnd, 'majorEnd');
  const major = near(pen.position(center), pen.position(majorEnd));
  if (!(major > 1e-9)) throw invalid('The major axis end is at the center');
  if (minor > major)
    throw invalid('`minorRadius` is no more than the major radius; put the major end on the longer axis');
  const curve = pen.curve({
    id: pen.make.id('crv'),
    kind: 'ellipse',
    construction: pen.make.flag(pen.construction),
    origin: { drawn: {} },
    center,
    majorEnd,
    minorRadius: minor,
  });
  return commit(ctx, pen, 'Draw ellipse', { curve, points: { center, majorEnd } });
}

export async function drawSpline(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const list = args.points;
  if (!Array.isArray(list) || list.length < 2) throw invalid('`points` lists two or more points');
  const ids = list.map((p, i) => pen.point(p, `points[${i}]`));
  const closed = optBool(args, 'closed') ?? false;
  if (closed && ids.length < 3) throw invalid('A closed spline needs three or more points');
  const through = closed ? [...ids, ids[0] as string] : ids;
  const curve = pen.curve({
    id: pen.make.id('crv'),
    kind: 'spline',
    construction: pen.make.flag(pen.construction),
    origin: { drawn: {} },
    through,
  });
  return commit(ctx, pen, 'Draw spline', { curve, points: ids });
}

export async function drawPoint(ctx: AiContext, args: Args): Promise<Json> {
  const pen = await penFor(ctx, args);
  const point = pen.point(args.at, 'at');
  const curve = pen.curve(pen.make.pointCurve(point, pen.construction));
  return commit(ctx, pen, 'Draw point', { curve, point });
}

const GEOMETRIC = new Set<string>(CONSTRAINT_KINDS);
/** The names the tools give the sketch's own origin and axes. */
const STANDARD: Record<string, string> = { origin: STANDARD_IDS.origin, xAxis: STANDARD_IDS.x, yAxis: STANDARD_IDS.y };
const DIMENSION_MODES: Record<string, DimensionMode> = { dimension: 'free', dimensionX: 'x', dimensionY: 'y' };
const LENGTH = { type: 'number', quantity: 'length' } as const;
const ANGLE = { type: 'number', quantity: 'angle' } as const;

export async function sketchConstrain(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const doc = editor.document;
  const at = sketchAt(doc, args.sketch);
  const kind = str(args, 'kind');
  const entities = (strings(args, 'entities') as string[]).map((id) => STANDARD[id] ?? id);
  const values = new WorkingValues(doc);
  const geometry = await geometryOf(ctx, at, values);
  for (const id of entities) {
    if (!geometry.points.has(id) && !geometry.curves.has(id) && !Object.values(STANDARD).includes(id))
      throw new ToolError('NOT_FOUND', `${id} is not a point or curve of this sketch`);
  }
  const make = new RowMaker((k) => editor.newId(k));
  let change: Change;
  let made: string[];
  if (GEOMETRIC.has(kind)) {
    const plan = planConstraint(kind as ConstraintKind, entities, {
      inputs: at.inputs,
      geometry,
      make,
      active: (c) => flagOn(values, c.active),
    });
    if (!plan.ok) throw new ToolError('REFUSED', plan.message);
    change = plan.change;
    made = (change.add?.constraints ?? []).map((c) => c.id as string);
  } else if (kind in DIMENSION_MODES) {
    const plan = planDimension(geometry, entities, DIMENSION_MODES[kind] as DimensionMode);
    if (!plan)
      throw new ToolError(
        'REFUSED',
        entities.length === 1 ? 'That cannot be dimensioned alone' : 'Those cannot be dimensioned together',
      );
    const angle = plan.kind === 'angle';
    const name = freeValueName(doc, at.part, 'd');
    const value = make.value(valueText(plan.value, angle), name);
    const overrides = new Map<string, Json>();
    if (args.value !== undefined) {
      const text = exprArg(args, 'value', angle ? 'deg' : 'mm');
      const bound = bindExpression(
        doc,
        { part: at.part, feature: at.feature, self: value.id as string },
        text,
        angle ? ANGLE : LENGTH,
      );
      if (!bound.ok) throw invalid(bound.message);
      checkDimension(plan.kind, bound.stored);
      value.def = bound.def;
      overrides.set(value.id as string, bound.def);
    }
    const row = make.dimension(plan.kind, plan.fields, value, plan.value);
    change = { label: 'Add dimension', add: { constraints: [row] }, overrides };
    made = [row.id as string];
    const { dof } = await write(ctx, at, change);
    return { constraints: made, kind: plan.kind, name, dof };
  } else throw invalid(`\`kind\` is one of ${[...GEOMETRIC, ...Object.keys(DIMENSION_MODES)].join(', ')}`);
  const { dof } = await write(ctx, at, change);
  return {
    constraints: made,
    ...(change.merge?.length ? { merged: change.merge } : {}),
    ...(change.remove?.length ? { removed: change.remove } : {}),
    dof,
  };
}

function checkDimension(kind: string, stored: unknown): void {
  const signed = kind === 'distanceX' || kind === 'distanceY' || kind === 'angle';
  if (!signed && typeof stored === 'number' && !(stored > 0)) throw invalid('A length is more than 0 mm');
}

/** A dimension's new value, solved as the sketch editor solves an edited dimension. */
export async function setSketchDimension(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const doc = editor.document;
  const at = sketchAt(doc, args.sketch);
  const id = str(args, 'constraint');
  const row = table(at.inputs, 'constraints').find((c) => c.id === id);
  if (!row || !DIMENSION_KINDS.has(row.kind as string))
    throw new ToolError('NOT_FOUND', `There is no dimension ${id} in this sketch`);
  const value = row.value as Json;
  const angle = row.kind === 'angle';
  const text = exprArg(args, 'value', angle ? 'deg' : 'mm');
  const bound = bindExpression(
    doc,
    { part: at.part, feature: at.feature, self: value.id as string },
    withDefaultUnit(text, angle ? 'deg' : 'mm'),
    angle ? ANGLE : LENGTH,
  );
  if (!bound.ok) throw invalid(bound.message);
  checkDimension(row.kind as string, bound.stored);
  const next = { ...value, def: bound.def };
  const change: Change = {
    label: 'Edit dimension',
    update: [{ id, set: { value: next } }],
    overrides: new Map([[value.id as string, bound.def]]),
  };
  const { dof } = await write(ctx, at, change);
  return { dof };
}

export async function movePoints(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const at = sketchAt(ctx.services.editor.document, args.sketch);
  const moves = args.moves;
  if (!Array.isArray(moves) || moves.length === 0) throw invalid('`moves` lists {point, to}');
  const update: RowUpdate[] = moves.map((m, i) => {
    if (!isPlainObject(m) || typeof m.point !== 'string') throw invalid(`moves[${i}] is {point, to}`);
    if (!table(at.inputs, 'points').some((p) => p.id === m.point))
      throw new ToolError('NOT_FOUND', `${m.point} is not a point of this sketch`);
    const [x, y] = vec2(m.to, `moves[${i}].to`);
    return { id: m.point, set: { x, y } };
  });
  const { dof } = await write(ctx, at, { label: 'Move points', update });
  return { dof };
}

export async function setConstruction(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const doc = ctx.services.editor.document;
  const at = sketchAt(doc, args.sketch);
  const on = optBool(args, 'construction');
  if (on === undefined) throw invalid('`construction` is true or false');
  const values = new WorkingValues(doc);
  const update: RowUpdate[] = [];
  for (const id of strings(args, 'curves') as string[]) {
    const c = table(at.inputs, 'curves').find((r) => r.id === id);
    if (!c) throw new ToolError('NOT_FOUND', `${id} is not a curve of this sketch`);
    if (flagOn(values, c.construction) === on) continue;
    update.push({
      id,
      set: {
        construction: {
          ...(c.construction as Json),
          def: { expr: { text: on ? 'true' : 'false', grammar: 1, refs: {} } },
        },
      },
    });
  }
  if (update.length === 0) return { changed: false };
  const { dof } = await write(ctx, at, { label: on ? 'Make construction' : 'Make normal', update });
  return { changed: true, dof };
}

export async function sketchDelete(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const at = sketchAt(ctx.services.editor.document, args.sketch);
  const remove = new Set<string>();
  const curves = table(at.inputs, 'curves');
  for (const id of strings(args, 'ids') as string[]) {
    if (curves.some((c) => c.id === id) || table(at.inputs, 'constraints').some((c) => c.id === id)) remove.add(id);
    else if (table(at.inputs, 'points').some((p) => p.id === id)) {
      const users = curves.filter((c) => curvePoints(c).includes(id));
      if (users.length === 0) remove.add(id);
      for (const c of users) remove.add(c.id as string);
    } else throw new ToolError('NOT_FOUND', `${id} is not a row of this sketch`);
  }
  const { dof } = await write(ctx, at, { label: 'Delete', remove: [...remove] });
  return { removed: [...remove], dof };
}

// ---- Modify ----

async function modifyContext(ctx: AiContext, at: SketchAt): Promise<ModifyContext> {
  const values = new WorkingValues(ctx.services.editor.document);
  return {
    inputs: at.inputs,
    geometry: await geometryOf(ctx, at, values),
    make: new RowMaker((k) => ctx.services.editor.newId(k)),
    active: (c) => flagOn(values, c.active),
    pixel: 0.01,
  };
}

async function applied(ctx: AiContext, at: SketchAt, plan: ModifyPlan, out: Json = {}): Promise<Json> {
  if (!plan.ok) throw new ToolError('REFUSED', plan.message);
  const { dof } = await write(ctx, at, plan.change);
  return { ...out, dof };
}

function curveArg(m: ModifyContext, args: Args, field: string): string {
  const id = str(args, field);
  if (!m.geometry.curves.has(id)) throw new ToolError('NOT_FOUND', `${id} is not a curve of this sketch`);
  return id;
}

/** How far from the given point `sketch_pick_geometry` looks by default (mm). */
const PICK_TOLERANCE = 2;

/** The point, or else the nearest curve, of a sketch within a tolerance of a position. */
export async function sketchPickGeometry(ctx: AiContext, args: Args): Promise<Json> {
  await settledDisplay(ctx);
  const at = sketchAt(ctx.services.editor.document, args.sketch);
  const p = vec2(args.at, 'at');
  const tolerance = args.tolerance === undefined ? PICK_TOLERANCE : args.tolerance;
  if (typeof tolerance !== 'number' || !(tolerance > 0)) throw invalid('`tolerance` is more than 0');
  const geometry = await geometryOf(ctx, at, new WorkingValues(ctx.services.editor.document));
  let best: { id: string; kind: string; distance: number } | null = null;
  for (const id of geometry.used) {
    const q = geometry.points.get(id);
    if (!q) continue;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d <= tolerance && (!best || d < best.distance)) best = { id, kind: 'point', distance: d };
  }
  if (!best) {
    for (const c of geometry.curves.values()) {
      if (c.kind === 'point') continue;
      const d = geometry.distanceToCurve(c.id, p);
      if (d <= tolerance && (!best || d < best.distance)) best = { id: c.id, kind: c.kind, distance: d };
    }
  }
  return best ? { id: best.id, kind: best.kind, distance: round(best.distance, 6) } : { id: null };
}

export async function sketchTrim(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const at = sketchAt(ctx.services.editor.document, args.sketch);
  const m = await modifyContext(ctx, at);
  return applied(ctx, at, planTrim(m, curveArg(m, args, 'curve'), vec2(args.at, 'at')));
}

export async function sketchExtend(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const at = sketchAt(ctx.services.editor.document, args.sketch);
  const m = await modifyContext(ctx, at);
  return applied(ctx, at, planExtend(m, curveArg(m, args, 'curve'), vec2(args.at, 'at')));
}

export async function sketchFillet(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const doc = ctx.services.editor.document;
  const at = sketchAt(doc, args.sketch);
  const m = await modifyContext(ctx, at);
  const radius = args.radius;
  if (typeof radius !== 'number' || !(radius > 0)) throw invalid('`radius` is more than 0');
  if ((args.corner === undefined) === (args.lines === undefined))
    throw invalid('Give `corner` (a point id) or `lines` (two line ids)');
  const picks = args.corner !== undefined ? [str(args, 'corner')] : (strings(args, 'lines') as string[]);
  const name = freeValueName(doc, at.part, 'd');
  return applied(ctx, at, planFillet(m, picks, radius, { name, text: valueText(radius, false) }), { name });
}

export async function sketchOffset(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const doc = ctx.services.editor.document;
  const at = sketchAt(doc, args.sketch);
  const m = await modifyContext(ctx, at);
  const distance = args.distance;
  if (typeof distance !== 'number' || !(distance > 0)) throw invalid('`distance` is more than 0');
  const name = freeValueName(doc, at.part, 'd');
  return applied(
    ctx,
    at,
    planOffset(m, curveArg(m, args, 'curve'), vec2(args.side, 'side'), distance, {
      name,
      text: valueText(distance, false),
    }),
    { name },
  );
}

export async function sketchMirror(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const at = sketchAt(ctx.services.editor.document, args.sketch);
  const m = await modifyContext(ctx, at);
  const curves = strings(args, 'curves') as string[];
  for (const id of curves)
    if (!m.geometry.curves.has(id)) throw new ToolError('NOT_FOUND', `${id} is not a curve of this sketch`);
  const axisArg = str(args, 'axis');
  const axis = STANDARD[axisArg] ?? axisArg;
  if (!Object.values(STANDARD).includes(axis) && m.geometry.curves.get(axis)?.kind !== 'line')
    throw invalid('`axis` is a line id, or xAxis or yAxis');
  return applied(ctx, at, planMirror(m, curves, axis));
}

export async function sketchProject(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const at = sketchAt(editor.document, args.sketch);
  const mode = args.mode === undefined ? 'project' : args.mode;
  if (mode !== 'project' && mode !== 'intersect') throw invalid("`mode` is 'project' or 'intersect'");
  const e = entryOf(ctx, args.entity, mode === 'project' ? ['edge'] : ['face', 'body'], 'entity');
  const display = await settledDisplay(ctx);
  const frame = sketchesOf(display, at.part).find((s) => s.feature === at.feature)?.frame;
  if (!frame)
    throw new ToolError(
      'REFUSED',
      'The sketch is not shown (past the rollback marker, or paused), so its plane is not known',
    );
  const key = await currentKey(ctx, e, display);
  const shapes = await ctx.client.externalCurves(key, mode, frame);
  if ('pause' in shapes) throw new ToolError('REFUSED', shapes.pause);
  if (shapes.shapes.length === 0)
    throw new ToolError(
      'REFUSED',
      mode === 'project' ? 'That edge has nothing to project' : 'The sketch plane does not cut that',
    );
  // The reference is written against the part as it is before the sketch.
  const picked = await ctx.services.pick({ key }, { before: at.feature });
  if (!picked || isPickedRegion(picked)) throw new ToolError('REFUSED', 'That is not in the model before this sketch');
  const { rows, shapes: built } = externalRows(
    new RowMaker((k) => editor.newId(k)),
    picked.reference,
    mode,
    shapes.shapes,
  );
  const externals = [...externalsOf(display, at), ...built];
  const { dof } = commitSketch(
    editor,
    await ctx.solver(),
    at,
    { label: mode === 'project' ? 'Project' : 'Intersect', add: { curves: rows }, names: picked.names },
    externals,
  );
  return { curves: rows.map((r) => r.id), dof };
}

// ---- Reading a sketch ----

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A loop of the display, in sketch coordinates. */
function loop2d(points: Float32Array, frame: SketchDisplay['frame']): P2[] {
  const out: P2[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const d = sub([points[i] as number, points[i + 1] as number, points[i + 2] as number], frame.origin);
    out.push([dot(d, frame.x), dot(d, frame.y)]);
  }
  return out;
}

function signedArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as P2;
    const q = poly[(i + 1) % poly.length] as P2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function inside(p: P2, poly: readonly P2[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as P2;
    const b = poly[j] as P2;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** A point inside the outer loop and outside every hole: the middle of the widest span on a few lines across it. */
function pointInside(outer: readonly P2[], holes: readonly P2[][]): P2 | null {
  const ys = outer.map((p) => p[1]);
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  let best: { at: P2; width: number } | null = null;
  for (const f of [0.5, 0.3, 0.7, 0.15, 0.85, 0.4, 0.6]) {
    const y = y0 + (y1 - y0) * f;
    const xs: number[] = [];
    for (const poly of [outer, ...holes]) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i] as P2;
        const b = poly[j] as P2;
        if (a[1] > y !== b[1] > y) xs.push(((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]);
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = (xs[i + 1] as number) - (xs[i] as number);
      const at: P2 = [((xs[i] as number) + (xs[i + 1] as number)) / 2, y];
      if (width > (best?.width ?? 0) && inside(at, outer) && !holes.some((h) => inside(at, h))) best = { at, width };
    }
  }
  return best?.at ?? null;
}

/** The curve ids of a loop's uses. */
function loopCurves(loop: unknown): string[] {
  if (!Array.isArray(loop)) return [];
  return loop.flatMap((use) => {
    const u = isPlainObject(use) ? ((use.open ?? use.closed) as Json | undefined) : undefined;
    const key = u?.curve as Json | undefined;
    const drawn =
      key && isPlainObject(key.drawn) ? key.drawn.id : key && isPlainObject(key.external) ? key.external.id : undefined;
    return typeof drawn === 'string' ? [drawn] : [];
  });
}

/** An operand or field of a constraint as the model reads it: ids for points and curves. */
function operandText(v: unknown): unknown {
  if (!isPlainObject(v)) return v;
  for (const tag of ['point', 'curve', 'external'])
    if (isPlainObject(v[tag]) && typeof (v[tag] as Json).id === 'string') return (v[tag] as Json).id;
  if (isPlainObject(v.sketchStandard)) return `sketch ${String(v.sketchStandard.name)}`;
  if (isPlainObject(v.sketchX)) return 'sketch x';
  if (isPlainObject(v.points)) return [operandText(v.points.a), operandText(v.points.b)];
  if (isPlainObject(v.def) && isPlainObject(v.def.expr)) return v.def.expr.text;
  return v;
}

export async function getSketch(ctx: AiContext, args: Args): Promise<Json> {
  const display = await settledDisplay(ctx);
  const doc = ctx.services.editor.document;
  const at = sketchAt(doc, args.sketch);
  const values = new WorkingValues(doc);
  const shown = sketchesOf(display, at.part).find((s) => s.feature === at.feature);
  const handleOfKey = async (key: number, kind: 'curve' | 'point' | 'region') =>
    (await handleOf(ctx, display, at.part, key, kind, at.feature)) ?? undefined;
  const curveKeys = new Map((shown?.curves ?? []).map((c) => [c.root, c.key]));
  const pointKeys = new Map((shown?.points ?? []).map((p) => [p.id, p.key]));
  // The stored positions are where the solve starts; what is read is the sketch solved with the values the document has now.
  const solve = solvedSketch(doc, await ctx.solver(), at, externalsOf(display, at));
  const solved = solve.inputs;

  const points: Json[] = [];
  for (const p of table(solved, 'points')) {
    const key = pointKeys.get(p.id as string);
    points.push({
      id: p.id,
      x: round(p.x as number, 6),
      y: round(p.y as number, 6),
      ...(key !== undefined ? { handle: await handleOfKey(key, 'point') } : {}),
    });
  }
  const curves: Json[] = [];
  for (const c of table(solved, 'curves')) {
    const out: Json = { id: c.id, kind: c.kind };
    for (const [k, v] of Object.entries(c)) {
      if (k === 'id' || k === 'kind' || k === 'origin' || k === 'construction' || k === 'extensions') continue;
      out[k] = isPlainObject(v) ? operandText(v) : v;
    }
    if (flagOn(values, c.construction)) out.construction = true;
    const key = curveKeys.get(c.id as string);
    if (key !== undefined) out.handle = await handleOfKey(key, 'curve');
    curves.push(out);
  }
  const constraints = table(solved, 'constraints').map((c) => {
    const out: Json = { id: c.id, kind: c.kind };
    for (const [k, v] of Object.entries(c)) {
      if (k === 'id' || k === 'kind' || k === 'active' || k === 'label' || k === 'extensions') continue;
      if (k === 'value' && isPlainObject(v)) {
        out.value = { id: v.id, ...(typeof v.name === 'string' ? { name: v.name } : {}), expression: operandText(v) };
        continue;
      }
      out[k] = operandText(v);
    }
    if (!flagOn(values, c.active)) out.active = false;
    return out;
  });
  const regionRows = new Map(table(at.inputs, 'regions').map((r) => [r.id as string, r]));
  const regions: Json[] = [];
  for (const r of shown?.regions ?? []) {
    const handle = await handleOfKey(r.key, 'region');
    const entry = handle ? ctx.handles.get(handle) : undefined;
    const picked = entry?.picked;
    const row = r.row ? regionRows.get(r.row) : undefined;
    const loop = picked && 'region' in picked ? picked.region.loop : row?.loop;
    const holes = picked && 'region' in picked ? picked.region.holes : row?.holes;
    const holeLoops = isPlainObject(holes) && Array.isArray(holes.set) ? holes.set : [];
    const [outer, ...rest] = r.loops.map((l) => loop2d(l, shown?.frame as SketchDisplay['frame']));
    const area = Math.abs(signedArea(outer ?? [])) - rest.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    const point = outer ? pointInside(outer, rest) : null;
    regions.push({
      handle,
      area: round(area, 3),
      ...(point ? { inside: [round(point[0], 3), round(point[1], 3)] } : {}),
      curves: loopCurves(loop),
      ...(holeLoops.length > 0 ? { holes: holeLoops.map(loopCurves) } : {}),
    });
  }
  const paused = display.pauses.find((p) => p.feature === at.feature);
  return {
    sketch: at.feature,
    part: at.part,
    ...(shown ? { frame: frameOut(shown.frame) } : { shown: false }),
    points,
    curves,
    constraints,
    dof: solve.dof,
    ...(solve.message ? { solveMessage: solve.message } : {}),
    regions,
    ...(paused ? { status: 'paused', message: paused.message } : {}),
  };
}

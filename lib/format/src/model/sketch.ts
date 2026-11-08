import { isPlainObject } from '../collections';
import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { readReference } from './references';
import { SKETCH_STANDARD_NAMES } from './registries';
import {
  ANGLE,
  FLAG,
  INTEGER,
  LENGTH,
  LIBRARY,
  RATIO,
  TEXT,
  choice,
  readAttachedFrame,
  readPoint2,
  value,
  valueList,
  type InputContext,
} from './shapes';
import type { Scope, ValueIndex } from './values';

/** `core.sketch` (chapter 8), typeVersion 1. */

const SOLVERS: readonly number[] = [1];

const CURVE_FIELDS: Record<string, readonly string[]> = {
  line: ['start', 'end'],
  circle: ['center', 'radius'],
  arc: ['center', 'start', 'end'],
  ellipse: ['center', 'majorEnd', 'minorRadius'],
  ellipticalArc: ['center', 'majorEnd', 'minorRadius', 'start', 'end'],
  spline: ['through'],
  bezier: ['start', 'c1', 'c2', 'end'],
  nurbs: ['degree', 'poles', 'weights', 'knots', 'multiplicities', 'periodic'],
  conic: ['start', 'end', 'apex', 'rho'],
  point: ['at'],
  external: ['source', 'defining', 'mode'],
};

const TEXT_FIELDS = ['string', 'font', 'size', 'frame', 'path'];

/** The fields of a text row (8), live or retired. */
function textFields(c: InputContext, ids: SketchIds, t: Json, tp: string): void {
  const { r } = c;
  value(c, t.string, child(tp, 'string'), TEXT);
  value(c, t.font, child(tp, 'font'), LIBRARY);
  value(c, t.size, child(tp, 'size'), LENGTH);
  readAttachedFrame(c, t.frame, child(tp, 'frame'));
  const along = r.union(t.path, child(tp, 'path'), ['straight', 'along']);
  if (along?.tag === 'straight') r.object(along.payload, along.path, { required: [] });
  else if (along?.tag === 'along') {
    const a = r.object(along.payload, along.path, { required: ['curves'] });
    if (a && r.list(a.curves, child(along.path, 'curves'))) {
      a.curves.forEach((id, j) => {
        const ip = child(child(along.path, 'curves'), j);
        if (r.idShape(id, ip, 'crv')) ids.uses.push({ kind: 'crv', id, path: ip });
      });
    }
  }
}

/** Constraint kinds and their operand fields (8.2). */
const GEOMETRIC: Record<string, readonly string[]> = {
  horizontal: ['of'],
  vertical: ['of'],
  parallel: ['a', 'b'],
  perpendicular: ['a', 'b'],
  equal: ['a', 'b'],
  concentric: ['a', 'b'],
  collinear: ['a', 'b'],
  coradial: ['a', 'b'],
  tangent: ['a', 'b'],
  curvature: ['a', 'b'],
  normal: ['a', 'b'],
  pointOnCurve: ['point', 'curve'],
  midpoint: ['point', 'curve'],
  symmetric: ['a', 'b', 'axis'],
  fixed: ['point'],
  block: ['curve'],
  offset: ['a', 'b'],
};

const DIMENSIONAL: Record<string, readonly string[]> = {
  distance: ['a', 'b'],
  distanceX: ['a', 'b'],
  distanceY: ['a', 'b'],
  length: ['curve'],
  radius: ['curve'],
  diameter: ['curve'],
  angle: ['a', 'b'],
};

interface SketchIds {
  points: Set<string>;
  curves: Set<string>;
  regions: Set<string>;
  texts: Set<string>;
  externals: Set<string>;
  /** Curve or region id → the id it descends from. */
  curveOrigin: Map<string, string>;
  regionOrigin: Map<string, string>;
  mergedInto: Map<string, string>;
  uses: { kind: 'pt' | 'crv' | 'reg' | 'txt' | 'ext'; id: string; path: string }[];
}

function pointRef(ids: SketchIds, r: Reader, v: unknown, path: string): void {
  if (r.idShape(v, path, 'pt')) ids.uses.push({ kind: 'pt', id: v, path });
}

const ORIGIN = ['origin'];
const AXES = ['x', 'y'];
const ANY = ['origin', 'x', 'y'];

/**
 * The sketch's own geometry each constraint field takes (8.2): the origin where
 * a point goes, an axis where a line goes. Fields not listed take neither.
 */
const STANDARD_OPERANDS: Record<string, Record<string, readonly string[]>> = {
  horizontal: { a: ORIGIN, b: ORIGIN },
  vertical: { a: ORIGIN, b: ORIGIN },
  parallel: { a: AXES, b: AXES },
  perpendicular: { a: AXES, b: AXES },
  collinear: { a: AXES, b: AXES },
  tangent: { a: AXES, b: AXES },
  normal: { a: AXES, b: AXES },
  offset: { a: AXES, b: AXES },
  pointOnCurve: { point: ORIGIN, curve: AXES },
  midpoint: { point: ORIGIN },
  symmetric: { a: ORIGIN, b: ORIGIN, axis: AXES },
  distance: { a: ANY, b: ANY },
  distanceX: { a: ORIGIN, b: ORIGIN },
  distanceY: { a: ORIGIN, b: ORIGIN },
  angle: { a: AXES, b: AXES },
};

/** Reads one operand; true when it is the sketch's own geometry (`sketchStandard` or `sketchX`). */
function operand(
  ids: SketchIds,
  r: Reader,
  v: unknown,
  path: string,
  standard: readonly string[],
  allowSketchX = false,
): boolean {
  const tags = ['point', 'curve', 'external', 'sketchStandard'];
  const u = r.union(v, path, allowSketchX ? [...tags, 'sketchX'] : tags);
  if (!u) return false;
  if (u.tag === 'sketchX') {
    r.object(u.payload, u.path, { required: [] });
    return true;
  }
  if (u.tag === 'sketchStandard') {
    const o = r.object(u.payload, u.path, { required: ['name'] });
    if (!o || !r.string(o.name, child(u.path, 'name'))) return true;
    if (!SKETCH_STANDARD_NAMES.includes(o.name)) {
      r.diagnostics.pause('unknown-variant', child(u.path, 'name'), `unknown sketchStandard name "${o.name}"`);
    } else if (!standard.includes(o.name)) {
      const what = o.name === 'origin' ? 'the sketch origin' : `the sketch ${o.name} axis`;
      r.diagnostics.refuse('bad-value', u.path, `${what} is not an operand this field takes`);
    }
    return true;
  }
  const o = r.object(u.payload, u.path, { required: ['id'] });
  if (!o) return false;
  const kind = u.tag === 'point' ? 'pt' : 'crv';
  if (r.idShape(o.id, child(u.path, 'id'), kind)) {
    ids.uses.push({ kind: u.tag === 'external' ? 'ext' : kind, id: o.id, path: child(u.path, 'id') });
  }
  return false;
}

function readCurve(c: InputContext, ids: SketchIds, row: Json, path: string, kind: string): void {
  const { r } = c;
  const p = (f: string) => child(path, f);
  switch (kind) {
    case 'circle':
      pointRef(ids, r, row.center, p('center'));
      r.number(row.radius, p('radius'));
      return;
    case 'ellipse':
    case 'ellipticalArc':
      pointRef(ids, r, row.center, p('center'));
      pointRef(ids, r, row.majorEnd, p('majorEnd'));
      r.number(row.minorRadius, p('minorRadius'));
      if (kind === 'ellipticalArc') {
        pointRef(ids, r, row.start, p('start'));
        pointRef(ids, r, row.end, p('end'));
      }
      return;
    case 'spline':
      if (r.list(row.through, p('through'))) {
        if (row.through.length < 2)
          r.diagnostics.refuse('bad-value', p('through'), 'a spline passes two or more points');
        row.through.forEach((pt, i) => pointRef(ids, r, pt, child(p('through'), i)));
      }
      return;
    case 'nurbs': {
      value(c, row.degree, p('degree'), INTEGER);
      let poles = 0;
      if (r.list(row.poles, p('poles'))) {
        poles = row.poles.length;
        row.poles.forEach((pt, i) => pointRef(ids, r, pt, child(p('poles'), i)));
      }
      valueList(c, row.weights, p('weights'), RATIO);
      if (Array.isArray(row.weights) && row.weights.length !== poles) {
        r.diagnostics.refuse('bad-value', p('weights'), 'one weight per pole');
      }
      valueList(c, row.knots, p('knots'), RATIO);
      if (r.list(row.multiplicities, p('multiplicities'))) {
        row.multiplicities.forEach((m, i) => r.integer(m, child(p('multiplicities'), i), 1));
        if (Array.isArray(row.knots) && row.knots.length !== row.multiplicities.length) {
          r.diagnostics.refuse('bad-value', p('multiplicities'), 'one multiplicity per knot');
        }
      }
      value(c, row.periodic, p('periodic'), FLAG);
      return;
    }
    case 'conic':
      for (const f of ['start', 'end', 'apex']) pointRef(ids, r, row[f], p(f));
      value(c, row.rho, p('rho'), RATIO);
      return;
    case 'point':
      pointRef(ids, r, row.at, p('at'));
      return;
    case 'external': {
      readReference(r, row.source, p('source'));
      value(c, row.defining, p('defining'), FLAG);
      value(c, row.mode, p('mode'), choice('project', 'intersect', 'silhouette'));
      // `index`, `count` and `near` go together, for `intersect` and `silhouette` only.
      const extras = ['index', 'count', 'near'].filter((f) => row[f] !== undefined);
      if (extras.length !== 0 && extras.length !== 3) {
        r.diagnostics.refuse('missing-field', path, 'index, count and near are written together');
      }
      if (row.index !== undefined) r.integer(row.index, p('index'), 0);
      if (row.count !== undefined) r.integer(row.count, p('count'), 1);
      if (row.near !== undefined) readPoint2(r, row.near, p('near'));
      return;
    }
    default:
      // line, arc, bezier: point fields only.
      for (const f of CURVE_FIELDS[kind] ?? []) pointRef(ids, r, row[f], p(f));
  }
}

const CURVE_KEY = ['drawn', 'glyph'];

function curveKey(ids: SketchIds, r: Reader, v: unknown, path: string): void {
  const u = r.union(v, path, CURVE_KEY);
  if (!u) return;
  if (u.tag === 'drawn') {
    const o = r.object(u.payload, u.path, { required: ['id'] });
    if (o && r.idShape(o.id, child(u.path, 'id'), 'crv'))
      ids.uses.push({ kind: 'crv', id: o.id, path: child(u.path, 'id') });
    return;
  }
  const o = r.object(u.payload, u.path, { required: ['text', 'glyph', 'contour'] });
  if (!o) return;
  if (r.idShape(o.text, child(u.path, 'text'), 'txt'))
    ids.uses.push({ kind: 'txt', id: o.text, path: child(u.path, 'text') });
  r.integer(o.glyph, child(u.path, 'glyph'), 0);
  r.integer(o.contour, child(u.path, 'contour'), 0);
}

function useEnd(ids: SketchIds, r: Reader, v: unknown, path: string): void {
  const u = r.union(v, path, ['point', 'cross', 'extremity']);
  if (!u) return;
  if (u.tag === 'point') {
    const o = r.object(u.payload, u.path, { required: ['id'] });
    if (o) pointRef(ids, r, o.id, child(u.path, 'id'));
  } else if (u.tag === 'cross') {
    const o = r.object(u.payload, u.path, { required: ['with', 'sense', 'k', 'kWith'] });
    if (!o) return;
    curveKey(ids, r, o.with, child(u.path, 'with'));
    if (o.sense !== 1 && o.sense !== -1 && o.sense !== 0) {
      r.diagnostics.refuse('bad-value', child(u.path, 'sense'), 'sense is 1, -1 or 0');
    }
    r.integer(o.k, child(u.path, 'k'), 0);
    r.integer(o.kWith, child(u.path, 'kWith'), 0);
  } else {
    const o = r.object(u.payload, u.path, { required: ['which'] });
    if (o && o.which !== 'start' && o.which !== 'end') {
      r.diagnostics.refuse('bad-value', child(u.path, 'which'), 'which is "start" or "end"');
    }
  }
}

function loop(ids: SketchIds, r: Reader, v: unknown, path: string): void {
  if (!r.list(v, path)) return;
  if (v.length === 0) r.diagnostics.refuse('bad-value', path, 'a loop has at least one use');
  v.forEach((use, i) => {
    const up = child(path, i);
    const u = r.union(use, up, ['open', 'closed']);
    if (!u) return;
    if (u.tag === 'open') {
      const o = r.object(u.payload, u.path, { required: ['curve', 'from', 'to', 'reversed'] });
      if (!o) return;
      curveKey(ids, r, o.curve, child(u.path, 'curve'));
      useEnd(ids, r, o.from, child(u.path, 'from'));
      useEnd(ids, r, o.to, child(u.path, 'to'));
      r.boolean(o.reversed, child(u.path, 'reversed'));
    } else {
      const o = r.object(u.payload, u.path, { required: ['curve'] });
      if (o) curveKey(ids, r, o.curve, child(u.path, 'curve'));
    }
  });
}

/** A region row's fields (8.3), with or without its id. */
function regionFields(ids: SketchIds, r: Reader, o: Json, path: string, id: string | undefined): void {
  loop(ids, r, o.loop, child(path, 'loop'));
  const holes = r.set(o.holes, child(path, 'holes'));
  holes?.forEach((h, i) => loop(ids, r, h, child(child(child(path, 'holes'), 'set'), i)));
  const origin = r.union(o.origin, child(path, 'origin'), ['detected', 'from']);
  if (origin?.tag === 'detected') r.object(origin.payload, origin.path, { required: [] });
  else if (origin?.tag === 'from') {
    const f = r.object(origin.payload, origin.path, { required: ['id'] });
    if (f && r.idShape(f.id, child(origin.path, 'id'), 'reg')) {
      ids.uses.push({ kind: 'reg', id: f.id, path: child(origin.path, 'id') });
      if (id) ids.regionOrigin.set(id, f.id);
    }
  }
}

function curveRow(c: InputContext, ids: SketchIds, row: unknown, path: string, id: string | undefined): void {
  const { r } = c;
  if (!isPlainObject(row) || typeof row.kind !== 'string') {
    r.diagnostics.refuse('wrong-type', path, 'a curve row has a kind');
    return;
  }
  const kind = row.kind;
  const fields = CURVE_FIELDS[kind];
  if (!fields) {
    r.diagnostics.pause('unknown-variant', child(path, 'kind'), `unknown curve kind "${kind}"`);
    return;
  }
  const required = ['kind', 'construction', 'origin', ...fields];
  const optional = kind === 'external' ? ['index', 'count', 'near'] : [];
  if (id !== undefined) required.unshift('id');
  const o = r.object(row, path, { required, optional });
  if (!o) return;
  value(c, o.construction, child(path, 'construction'), FLAG);
  const origin = r.union(o.origin, child(path, 'origin'), ['drawn', 'from']);
  if (origin?.tag === 'drawn') r.object(origin.payload, origin.path, { required: [] });
  else if (origin?.tag === 'from') {
    const f = r.object(origin.payload, origin.path, { required: ['id'] });
    if (f && r.idShape(f.id, child(origin.path, 'id'), 'crv')) {
      ids.uses.push({ kind: 'crv', id: f.id, path: child(origin.path, 'id') });
      if (id) ids.curveOrigin.set(id, f.id);
    }
  }
  if (kind === 'external' && id) ids.externals.add(id);
  readCurve(c, ids, o, path, kind);
}

function readConstraint(c: InputContext, ids: SketchIds, row: unknown, path: string): void {
  const { r } = c;
  if (!isPlainObject(row) || typeof row.kind !== 'string') {
    r.diagnostics.refuse('wrong-type', path, 'a constraint row has a kind');
    return;
  }
  const kind = row.kind;
  const geometric = GEOMETRIC[kind];
  const dimensional = DIMENSIONAL[kind];
  if (!geometric && !dimensional) {
    r.diagnostics.pause('unknown-variant', child(path, 'kind'), `unknown constraint kind "${kind}"`);
    return;
  }
  const extra = kind === 'tangent' ? ['internal'] : kind === 'offset' ? ['distance'] : [];
  const required = ['id', 'kind', 'active', ...(geometric ?? dimensional ?? []), ...extra];
  if (dimensional) required.push('value', 'solved', 'label');
  const o = r.object(row, path, { required });
  if (!o || !r.define(o.id, child(path, 'id'), 'con')) return;
  value(c, o.active, child(path, 'active'), FLAG);
  const standard = STANDARD_OPERANDS[kind] ?? {};
  // Whether each operand is the sketch's own fixed geometry.
  const own: boolean[] = [];
  if (kind === 'horizontal' || kind === 'vertical') {
    const u = r.union(o.of, child(path, 'of'), ['curve', 'points']);
    if (u?.tag === 'curve') own.push(operand(ids, r, { curve: u.payload }, child(path, 'of'), []));
    else if (u?.tag === 'points') {
      const pts = r.object(u.payload, u.path, { required: ['a', 'b'] });
      if (pts) {
        own.push(operand(ids, r, pts.a, child(u.path, 'a'), standard.a ?? []));
        own.push(operand(ids, r, pts.b, child(u.path, 'b'), standard.b ?? []));
      }
    }
  } else {
    for (const f of geometric ?? dimensional ?? []) {
      own.push(operand(ids, r, o[f], child(path, f), standard[f] ?? [], kind === 'angle' && f === 'b'));
    }
  }
  if (own.length > 1 && own.every(Boolean)) {
    r.diagnostics.refuse('bad-value', path, "a constraint on the sketch's origin and axes alone holds nothing");
  }
  if (kind === 'tangent') value(c, o.internal, child(path, 'internal'), FLAG);
  if (kind === 'offset') value(c, o.distance, child(path, 'distance'), LENGTH);
  if (dimensional) {
    value(c, o.value, child(path, 'value'), kind === 'angle' ? ANGLE : LENGTH);
    r.number(o.solved, child(path, 'solved'));
    const label = r.union(o.label, child(path, 'label'), ['auto', 'at']);
    if (label?.tag === 'auto') r.object(label.payload, label.path, { required: [] });
    else if (label?.tag === 'at') {
      const a = r.object(label.payload, label.path, { required: ['p'] });
      if (a) readPoint2(r, a.p, child(label.path, 'p'));
    }
  }
}

function hasCycle(edges: Map<string, string>, start: string): boolean {
  const seen = new Set<string>();
  let at: string | undefined = start;
  while (at !== undefined) {
    if (seen.has(at)) return true;
    seen.add(at);
    at = edges.get(at);
  }
  return false;
}

export function readSketchInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, {
    required: ['frame', 'points', 'curves', 'constraints', 'regions', 'retired', 'text'],
    optional: ['solver'],
  });
  if (!o) return;
  const ids: SketchIds = {
    points: new Set(),
    curves: new Set(),
    regions: new Set(),
    texts: new Set(),
    externals: new Set(),
    curveOrigin: new Map(),
    regionOrigin: new Map(),
    mergedInto: new Map(),
    uses: [],
  };
  const p = (f: string) => child(path, f);

  readAttachedFrame(c, o.frame, p('frame'));
  if (o.solver !== undefined && r.integer(o.solver, p('solver'), 1) && !SOLVERS.includes(o.solver)) {
    r.diagnostics.pause('unknown-version', p('solver'), `unknown sketch solver ${o.solver}`);
  }

  if (r.list(o.points, p('points'))) {
    o.points.forEach((pt, i) => {
      const pp = child(p('points'), i);
      const po = r.object(pt, pp, { required: ['id', 'x', 'y'] });
      if (!po || !r.define(po.id, child(pp, 'id'), 'pt')) return;
      ids.points.add(po.id);
      r.number(po.x, child(pp, 'x'));
      r.number(po.y, child(pp, 'y'));
    });
  }

  if (r.list(o.curves, p('curves'))) {
    o.curves.forEach((row, i) => {
      const cp = child(p('curves'), i);
      if (isPlainObject(row) && r.define(row.id, child(cp, 'id'), 'crv')) ids.curves.add(row.id);
      curveRow(c, ids, row, cp, isPlainObject(row) && typeof row.id === 'string' ? row.id : undefined);
    });
  }

  if (r.list(o.text, p('text'))) {
    o.text.forEach((row, i) => {
      const tp = child(p('text'), i);
      const t = r.object(row, tp, { required: ['id', ...TEXT_FIELDS] });
      if (!t || !r.define(t.id, child(tp, 'id'), 'txt')) return;
      ids.texts.add(t.id);
      textFields(c, ids, t, tp);
    });
  }

  if (r.list(o.regions, p('regions'))) {
    o.regions.forEach((row, i) => {
      const rp = child(p('regions'), i);
      const ro = r.object(row, rp, { required: ['id', 'loop', 'holes', 'origin'] });
      if (!ro || !r.define(ro.id, child(rp, 'id'), 'reg')) return;
      ids.regions.add(ro.id);
      regionFields(ids, r, ro, rp, ro.id);
    });
  }

  if (r.list(o.retired, p('retired'))) {
    o.retired.forEach((row, i) => {
      const rp = child(p('retired'), i);
      const ro = r.object(row, rp, { required: ['id', 'was', 'fate'] });
      if (!ro) return;
      const was = r.union(ro.was, child(rp, 'was'), ['curve', 'region', 'text']);
      const kind = was?.tag === 'region' ? 'reg' : was?.tag === 'text' ? 'txt' : 'crv';
      if (!r.define(ro.id, child(rp, 'id'), kind)) return;
      if (was?.tag === 'curve') {
        ids.curves.add(ro.id);
        curveRow(c, ids, was.payload, was.path, undefined);
        const origin = was.payload.origin;
        if (isPlainObject(origin) && isPlainObject(origin.from) && typeof origin.from.id === 'string') {
          ids.curveOrigin.set(ro.id, origin.from.id);
        }
      } else if (was?.tag === 'text') {
        // A text row a live or retired region still names (8.3).
        ids.texts.add(ro.id);
        const to = r.object(was.payload, was.path, { required: TEXT_FIELDS });
        if (to) textFields(c, ids, to, was.path);
      } else if (was?.tag === 'region') {
        ids.regions.add(ro.id);
        const fo = r.object(was.payload, was.path, { required: ['loop', 'holes', 'origin'] });
        if (fo) regionFields(ids, r, fo, was.path, ro.id);
      }
      const fate = r.union(ro.fate, child(rp, 'fate'), ['split', 'merged', 'deleted']);
      if (kind === 'txt' && fate && fate.tag !== 'deleted')
        r.diagnostics.refuse('bad-value', fate.path, 'a retired text row is deleted');
      if (fate?.tag === 'merged') {
        if (kind !== 'reg') r.diagnostics.refuse('bad-value', fate.path, 'only regions merge');
        const into = r.object(fate.payload, fate.path, { required: ['into'] });
        const target = into ? r.object(into.into, child(fate.path, 'into'), { required: ['id'] }) : null;
        if (target && r.idShape(target.id, child(child(fate.path, 'into'), 'id'), 'reg')) {
          ids.uses.push({ kind: 'reg', id: target.id, path: child(child(fate.path, 'into'), 'id') });
          ids.mergedInto.set(ro.id, target.id);
        }
      } else if (fate) {
        r.object(fate.payload, fate.path, { required: [] });
      }
    });
  }

  if (r.list(o.constraints, p('constraints'))) {
    o.constraints.forEach((row, i) => readConstraint(c, ids, row, child(p('constraints'), i)));
  }

  // Sketch ids that must exist resolve within this sketch.
  const known: Record<string, Set<string>> = {
    pt: ids.points,
    crv: ids.curves,
    reg: ids.regions,
    txt: ids.texts,
    ext: ids.externals,
  };
  for (const use of ids.uses) {
    if (!known[use.kind]?.has(use.id)) {
      const what = use.kind === 'ext' ? 'external curve' : `${use.kind}_ id`;
      r.diagnostics.refuse('dangling', use.path, `${use.id} is not a ${what} of this sketch`);
    }
  }
  for (const id of ids.curveOrigin.keys()) {
    if (hasCycle(ids.curveOrigin, id)) {
      r.diagnostics.refuse('cycle', p('curves'), `curve ancestry of ${id} forms a cycle`);
      break;
    }
  }
  for (const id of ids.regionOrigin.keys()) {
    if (hasCycle(ids.regionOrigin, id)) {
      r.diagnostics.refuse('cycle', p('regions'), `region ancestry of ${id} forms a cycle`);
      break;
    }
  }
  for (const id of ids.mergedInto.keys()) {
    if (hasCycle(ids.mergedInto, id)) {
      r.diagnostics.refuse('cycle', p('retired'), `region merge fates of ${id} form a cycle`);
      break;
    }
  }
}

registerFeatureType('core.sketch', { versions: [1], readInputs: readSketchInputs });

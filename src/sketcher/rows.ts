/**
 * The rows of a `core.sketch` feature (spec chapter 8) as the sketch editor
 * reads and builds them. Rows are plain JSON; a working copy is a new inputs
 * object, never an edit of the document's frozen one.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';

export type { Json };
export type P2 = readonly [number, number];

/** The sketch feature's inputs in `doc`, or null when the part or feature is gone. */
export function sketchInputs(doc: Doc, part: string, feature: string): Json | null {
  const parts = Array.isArray(doc.parts) ? (doc.parts as Json[]) : [];
  const row = parts.find((p) => p.id === part);
  const timeline = row && Array.isArray(row.timeline) ? (row.timeline as Json[]) : [];
  const found = findFeature(timeline, feature);
  if (!found || found.type !== 'core.sketch' || !isPlainObject(found.inputs)) return null;
  return found.inputs;
}

function findFeature(rows: Json[], id: string): Json | undefined {
  for (const f of rows) {
    if (f.id === id) return f;
    if (Array.isArray(f.children)) {
      const inner = findFeature(f.children as Json[], id);
      if (inner) return inner;
    }
  }
  return undefined;
}

export const table = (inputs: Json, name: string): Json[] =>
  Array.isArray(inputs[name]) ? (inputs[name] as Json[]) : [];

export function rowById(inputs: Json, name: string, id: string): Json | undefined {
  return table(inputs, name).find((r) => r.id === id);
}

export function pointAt(inputs: Json, id: string): P2 | undefined {
  const p = rowById(inputs, 'points', id);
  return p && typeof p.x === 'number' && typeof p.y === 'number' ? [p.x, p.y] : undefined;
}

/** The point fields of each curve kind the editor draws or moves. */
export const POINT_FIELDS: Record<string, readonly string[]> = {
  line: ['start', 'end'],
  circle: ['center'],
  arc: ['center', 'start', 'end'],
  ellipse: ['center', 'majorEnd'],
  ellipticalArc: ['center', 'majorEnd', 'start', 'end'],
  bezier: ['start', 'c1', 'c2', 'end'],
  conic: ['start', 'apex', 'end'],
  point: ['at'],
};

/** The sketch points a curve row uses, in field order. */
export function curvePoints(curve: Json): string[] {
  if (curve.kind === 'spline') return [...((curve.through as string[] | undefined) ?? [])];
  if (curve.kind === 'nurbs') return [...((curve.poles as string[] | undefined) ?? [])];
  return (POINT_FIELDS[curve.kind as string] ?? [])
    .map((f) => curve[f])
    .filter((v): v is string => typeof v === 'string');
}

/** The ends of an open curve with sketch points there. */
export function curveEnds(curve: Json): [string, string] | null {
  if (
    curve.kind === 'line' ||
    curve.kind === 'arc' ||
    curve.kind === 'ellipticalArc' ||
    curve.kind === 'bezier' ||
    curve.kind === 'conic'
  ) {
    return [curve.start as string, curve.end as string];
  }
  return null;
}

/** Every id a row names, at any depth (operands, point fields, loops). */
export function namedIds(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) for (const v of value) namedIds(v, out);
  else if (isPlainObject(value))
    for (const [k, v] of Object.entries(value))
      if (k !== 'extensions' && k !== 'value' && k !== 'active') namedIds(v, out);
  return out;
}

/** The literal text of a value object's expression, when it is a plain expression. */
export function exprText(value: unknown): string | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.def) || !isPlainObject(value.def.expr)) return undefined;
  const text = value.def.expr.text;
  return typeof text === 'string' ? text : undefined;
}

export const isMeasured = (value: unknown): boolean =>
  isPlainObject(value) && isPlainObject(value.def) && 'measure' in value.def;

export const DIMENSION_KINDS = new Set(['distance', 'distanceX', 'distanceY', 'length', 'radius', 'diameter', 'angle']);

export type StandardName = 'origin' | 'x' | 'y';

export type Operand =
  | { point: { id: string } }
  | { curve: { id: string } }
  | { external: { id: string } }
  | { sketchX: Json }
  | { sketchStandard: { name: StandardName } };

export const pointOperand = (id: string): Operand => ({ point: { id } });
/** The sketch's own origin or x or y axis as an operand (8.2). */
export const standardOperand = (name: StandardName): Operand => ({ sketchStandard: { name } });

/** The sketch origin or axis an operand names, if it names one. */
export function standardOf(v: unknown): StandardName | null {
  if (!isPlainObject(v) || !isPlainObject(v.sketchStandard)) return null;
  const name = v.sketchStandard.name;
  return name === 'origin' || name === 'x' || name === 'y' ? name : null;
}
export const curveOperand = (id: string): Operand => ({ curve: { id } });

/**
 * The selection ids that stand for the sketch's own origin and axes, which
 * the select and dimension tools pick by hand (8.2 `sketchStandard`).
 */
export const STANDARD_IDS = { origin: 'std:origin', x: 'std:x', y: 'std:y' } as const;

/** The standard name a selection id stands for, if it stands for one. */
export function standardName(id: string): StandardName | null {
  return id === STANDARD_IDS.origin ? 'origin' : id === STANDARD_IDS.x ? 'x' : id === STANDARD_IDS.y ? 'y' : null;
}

/** The operand for a picked point: a sketch point, or the sketch origin. */
export function pointRef(id: string): Operand {
  const name = standardName(id);
  return name ? standardOperand(name) : pointOperand(id);
}

/** The operand for a picked curve: a sketch curve, an external curve, or a sketch axis. */
export function curveRef(id: string, external = false): Operand {
  const name = standardName(id);
  if (name) return standardOperand(name);
  return external ? { external: { id } } : curveOperand(id);
}

/** The id an operand names, and whether it is a point. */
export function operandOf(v: unknown): { id: string; point: boolean } | null {
  if (!isPlainObject(v)) return null;
  for (const tag of ['point', 'curve', 'external'] as const) {
    const o = v[tag];
    if (isPlainObject(o) && typeof o.id === 'string') return { id: o.id, point: tag === 'point' };
  }
  return null;
}

/** Makes new rows with ids from the editor. */
export class RowMaker {
  constructor(private readonly newId: (kind: string) => string) {}

  id(kind: string): string {
    return this.newId(kind);
  }

  /** A value object holding an expression with no names. */
  value(text: string, name?: string): Json {
    return { id: this.newId('val'), ...(name ? { name } : {}), def: { expr: { text, grammar: 1, refs: {} } } };
  }

  flag(on: boolean): Json {
    return this.value(on ? 'true' : 'false');
  }

  point(x: number, y: number): Json {
    return { id: this.newId('pt'), x, y };
  }

  /** A curve row of `kind` with its common fields; the caller adds the kind's own. */
  curve(kind: string, construction: boolean, fields: Json = {}): Json {
    return { id: this.newId('crv'), kind, construction: this.flag(construction), origin: { drawn: {} }, ...fields };
  }

  line(start: string, end: string, construction = false): Json {
    return this.curve('line', construction, { start, end });
  }

  circle(center: string, radius: number, construction = false): Json {
    return this.curve('circle', construction, { center, radius });
  }

  /** Counter-clockwise from `start` to `end` about `center` (8.1). */
  arc(center: string, start: string, end: string, construction = false): Json {
    return this.curve('arc', construction, { center, start, end });
  }

  /** `minorRadius` no more than |majorEnd − center|: the solver solves only that way round. */
  ellipse(center: string, majorEnd: string, minorRadius: number, construction = false): Json {
    return this.curve('ellipse', construction, { center, majorEnd, minorRadius });
  }

  /** The cubic B-spline through the points in order (8.1). */
  spline(through: readonly string[], construction = false): Json {
    return this.curve('spline', construction, { through: [...through] });
  }

  pointCurve(at: string, construction = false): Json {
    return this.curve('point', construction, { at });
  }

  geometric(kind: string, fields: Json): Json {
    return { id: this.newId('con'), kind, active: this.flag(true), ...fields };
  }

  dimension(kind: string, fields: Json, value: Json, solved: number, label: Json = { auto: {} }): Json {
    return { id: this.newId('con'), kind, active: this.flag(true), ...fields, value, solved, label };
  }
}

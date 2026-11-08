/**
 * Expression text typed by a user, bound to what it names (6.3, 6.4): the
 * parameters of the part (or assembly) and the document, and the named
 * values of its timeline's features up to and including the feature being
 * edited. The result
 * is a value `def` an edit command can store.
 */
import {
  ExprError,
  GRAMMAR,
  ValueEvaluator,
  ValuePause,
  compileExpression,
  isPlainObject,
  toStored,
  type ExprRef,
  type JsonValue,
  type ValueTarget,
} from '@tweakcad/format';
import type { Doc, Json } from './rows';

/** Where an expression is evaluated. */
export interface ExpressionScope {
  /** The part, or the assembly, whose parameters and timeline are visible. */
  part: string;
  /** The feature the value belongs to: its own named values and earlier features' are visible. */
  feature: string;
  /** A value id left out of scope: the value being edited, which cannot name itself. */
  self?: string;
}

/**
 * A bound expression: the `def` to store and its stored literal; `stored`
 * is null when the expression reads a measured value (6.3), whose result
 * only an evaluation of the geometry gives, so it is checked there.
 */
export type BoundExpression = { ok: true; def: Json; stored: JsonValue } | { ok: false; message: string };

function parametersOf(tables: unknown, out: Map<string, ExprRef>): void {
  if (!Array.isArray(tables)) return;
  for (const table of tables) {
    if (!isPlainObject(table) || !Array.isArray(table.parameters)) continue;
    for (const p of table.parameters) {
      if (isPlainObject(p) && typeof p.name === 'string' && typeof p.id === 'string')
        out.set(p.name, { parameter: { id: p.id } });
    }
  }
}

function namedValuesOf(value: unknown, self: string | undefined, out: Map<string, ExprRef>): void {
  if (Array.isArray(value)) {
    for (const item of value) namedValuesOf(item, self, out);
    return;
  }
  if (!isPlainObject(value)) return;
  if (
    typeof value.id === 'string' &&
    value.id.startsWith('val_') &&
    'def' in value &&
    typeof value.name === 'string' &&
    value.id !== self
  ) {
    out.set(value.name, { value: { id: value.id } });
  }
  for (const [key, item] of Object.entries(value)) if (key !== 'extensions') namedValuesOf(item, self, out);
}

/** The part or assembly with that id. */
function ownerOf(doc: Doc, id: string): Json | undefined {
  const rows = [
    ...(Array.isArray(doc.parts) ? doc.parts : []),
    ...(Array.isArray(doc.assemblies) ? doc.assemblies : []),
  ];
  return rows.find((p): p is Json => isPlainObject(p) && p.id === id);
}

/** Every name an expression in `scope` can use, with what it binds to; inner scopes shadow outer ones. */
export function visibleNames(doc: Doc, scope: ExpressionScope): Map<string, ExprRef> {
  const out = new Map<string, ExprRef>();
  parametersOf(doc.parameters, out);
  const part = ownerOf(doc, scope.part);
  if (!part) return out;
  parametersOf(part.parameters, out);
  const timeline = Array.isArray(part.timeline) ? (part.timeline as Json[]) : [];
  const last = timeline.findIndex((f) => f.id === scope.feature);
  for (const feature of last < 0 ? [] : timeline.slice(0, last + 1)) namedValuesOf(feature, scope.self, out);
  return out;
}

/**
 * Binds `text` in `scope` and evaluates it against `target`: the `def`
 * to store and its stored literal, or a plain message saying why not.
 */
export function bindExpression(doc: Doc, scope: ExpressionScope, text: string, target: ValueTarget): BoundExpression {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'Type a value' };
  const visible = visibleNames(doc, scope);
  const refs: Record<string, ExprRef> = {};
  // Each pass binds the first unbound name the compiler reports.
  for (let pass = 0; ; pass++) {
    try {
      compileExpression({ text: trimmed, grammar: GRAMMAR, refs });
      break;
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      const unbound = e.kind === 'name' ? /^([A-Za-z_][A-Za-z0-9_]*) is not in refs$/.exec(e.detail)?.[1] : undefined;
      const ref = unbound === undefined ? undefined : visible.get(unbound);
      if (unbound === undefined || pass > 1000) return { ok: false, message: e.detail };
      if (!ref) return { ok: false, message: `${unbound} is not a parameter or named value here` };
      refs[unbound] = ref;
    }
  }
  const def: Json = { expr: { text: trimmed, grammar: GRAMMAR, refs } };
  const evaluator = new ValueEvaluator(doc);
  try {
    const result = evaluator.evaluateDefinition(def, 'the value', target);
    return { ok: true, def, stored: toStored(result, target) };
  } catch (e) {
    if (e instanceof ValuePause && isPlainObject(evaluator.definition(e.valueId)?.measure))
      return { ok: true, def, stored: null };
    if (e instanceof ValuePause || e instanceof ExprError)
      return { ok: false, message: e instanceof ExprError ? e.detail : e.message };
    throw e;
  }
}

/** The first name `prefix` + n (n from 1) that no parameter or value of the part or the document uses, nor any of `also`. */
export function freeValueName(doc: Doc, part: string, prefix: string, also: Iterable<string> = []): string {
  const taken = new Set<string>(also);
  const parameters = new Map<string, ExprRef>();
  parametersOf(doc.parameters, parameters);
  const row = ownerOf(doc, part);
  if (row) {
    parametersOf(row.parameters, parameters);
    const values = new Map<string, ExprRef>();
    namedValuesOf(row, undefined, values);
    for (const name of values.keys()) taken.add(name);
  }
  for (const name of parameters.keys()) taken.add(name);
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/**
 * Text a user typed into a field with a unit beside it: a bare number is in
 * that unit (as the field says), anything else is taken as written.
 */
export function withDefaultUnit(text: string, unit: string): string {
  const t = text.trim();
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? `${t} ${unit}` : t;
}

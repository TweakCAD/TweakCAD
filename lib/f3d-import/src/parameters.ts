/**
 * The file's parameters as part parameters and value objects.
 *
 * A parameter comes across when something uses it: every user parameter, and
 * any dimension another expression names. A formula is kept only if it
 * evaluates here to the value the file solved; otherwise the solved value
 * stands in, so an imported number is never wrong.
 */
import { RESERVED_WORDS, ValueEvaluator, toStored, type ExprRef, type ValueTarget } from '@tweakcad/format';
import type { F3dParameter } from './parser/types';
import { deg, mm, numberText } from './placement';
import type { Json, Writer } from './writer';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORD = /[\p{L}_][\p{L}\p{N}_]*/gu;
const LENGTH_UNITS = new Set(['mm', 'cm', 'm', 'in', 'ft']);
const ANGLE_UNITS = new Set(['deg', 'rad']);
const MATCH_TOLERANCE = 1e-6;
const MAX_PASSES = 8;

export const LENGTH: ValueTarget = { type: 'number', quantity: 'length' };
export const ANGLE: ValueTarget = { type: 'number', quantity: 'angle' };
const RATIO: ValueTarget = { type: 'number', quantity: 'ratio' };

const usable = (name: string): boolean => NAME.test(name) && !RESERVED_WORDS.has(name);

function targetOf(p: F3dParameter): ValueTarget | undefined {
  if (LENGTH_UNITS.has(p.unit)) return LENGTH;
  if (ANGLE_UNITS.has(p.unit)) return ANGLE;
  return p.unit === '' ? RATIO : undefined;
}

/** A solved value in stored units: millimetres, degrees, or a plain number. */
function solved(p: F3dParameter, target: ValueTarget): number {
  if (target === LENGTH) return p.value * 10;
  if (target === ANGLE) return (p.value * 180) / Math.PI;
  return p.value;
}

function literal(p: F3dParameter, target: ValueTarget): string {
  const v = solved(p, target);
  return target === LENGTH ? mm(v) : target === ANGLE ? deg(v) : numberText(v);
}

const matches = (got: number, want: number): boolean =>
  Math.abs(got - want) <= MATCH_TOLERANCE * Math.max(1, Math.abs(want));

/** Whether an evaluation gives the number the file solved; one that fails does not. */
function reproduces(evaluate: () => unknown, want: number): boolean {
  try {
    const got = evaluate();
    return typeof got === 'number' && matches(got, want);
  } catch {
    return false;
  }
}

/** The file's expression in this grammar. */
const textOf = (expression: string): string => expression.trim().replace(/\bPI\b/g, 'pi');

export interface ParameterPlan {
  /** The part's parameter rows. */
  rows: Json[];
  /** A value object for a parameter's use: its name, a formula naming others, or `fallback`. */
  value(p: F3dParameter | null, fallback: string, target: ValueTarget): Json;
}

export function planParameters(parameters: readonly F3dParameter[], w: Writer): ParameterPlan {
  const byName = new Map(parameters.filter((p) => usable(p.name) && targetOf(p)).map((p) => [p.name, p]));
  const named = (text: string): F3dParameter[] =>
    [...new Set(text.match(WORD) ?? [])].flatMap((n) => byName.get(n) ?? []);

  const needed = new Set<F3dParameter>();
  const need = (p: F3dParameter): void => {
    if (needed.has(p)) return;
    needed.add(p);
    named(textOf(p.expression)).forEach(need);
  };
  for (const p of parameters) {
    if (p.isUser && byName.get(p.name) === p) need(p);
    named(textOf(p.expression))
      .filter((q) => q !== p)
      .forEach(need);
  }

  const rowOf = new Map<F3dParameter, Json>();
  const refsOf = (text: string): Record<string, ExprRef> => {
    const refs: Record<string, ExprRef> = {};
    for (const q of named(text)) {
      const row = rowOf.get(q);
      if (row) refs[q.name] = { parameter: { id: row.id as string } };
    }
    return refs;
  };
  for (const p of needed) {
    const target = targetOf(p) as ValueTarget;
    rowOf.set(p, {
      id: w.ids('par'),
      name: p.name,
      type: 'number',
      quantity: target.type === 'number' ? target.quantity : 'ratio',
      value: {},
      range: { unbounded: {} },
      public: false,
      published: false,
      description: '',
    });
  }
  for (const [p, row] of rowOf) {
    const text = textOf(p.expression);
    row.value = w.val(text, refsOf(text));
  }

  const scratch = (): ValueEvaluator =>
    new ValueEvaluator({
      parts: [{ parameters: [{ parameters: [...rowOf.values()] }], configurations: [] }],
      assemblies: [],
    });
  // A formula that fails takes its row to the solved value, which can settle those naming it.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const values = scratch();
    let changed = false;
    for (const [p, row] of rowOf) {
      const target = targetOf(p) as ValueTarget;
      const good = reproduces(() => toStored(values.parameter(row.id as string), target), solved(p, target));
      const fixed = literal(p, target);
      const def = (row.value as Json).def as { expr: { text: string } };
      if (!good && def.expr.text !== fixed) {
        row.value = w.val(fixed);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const values = scratch();
  const value = (p: F3dParameter | null, fallback: string, target: ValueTarget): Json => {
    if (!p) return w.val(fallback);
    const row = rowOf.get(p);
    if (row && targetOf(p) === target) return w.val(p.name, { [p.name]: { parameter: { id: row.id as string } } });
    const text = textOf(p.expression);
    const refs = refsOf(text);
    if (Object.keys(refs).length > 0 && targetOf(p) === target) {
      const def = { expr: { text, grammar: 1, refs } };
      if (reproduces(() => toStored(values.evaluateDefinition(def, p.name, target), target), solved(p, target)))
        return w.val(text, refs);
    }
    return w.val(fallback);
  };

  return { rows: [...rowOf.values()], value };
}

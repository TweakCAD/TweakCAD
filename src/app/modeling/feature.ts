/**
 * What every feature panel's model shares, apart from its React side: the
 * feature it writes (a new one at the rollback marker, or an existing one
 * being edited), value objects that keep their ids from one build of the
 * form to the next, expressions bound in the feature's scope, writing the
 * built inputs as one undo step, and the candidate document a preview
 * evaluates.
 */
import {
  ExprError,
  GRAMMAR,
  ValueEvaluator,
  compileExpression,
  isPlainObject,
  makeSet,
  type ExprRef,
  type ExprValue,
  type ValueTarget,
} from '@tweakcad/format';
import {
  CommandError,
  Editor,
  bindExpression,
  formatRefusals,
  visibleNames,
  withDefaultUnit,
  type CommandResult,
  type Doc,
  type ExpressionScope,
  type Json,
} from '@tweakcad/editor';
import { featureHidden, setVisible } from '../attributes';
import { findFeature, partOfFeature } from '../features';
import { featureBefore, featureRow, insertionPoint, nextFeatureName } from './common';

/** Which feature a panel writes: a new one, or an existing one. */
export interface FeatureTarget {
  part: string;
  /** The feature's id: the new one's, or the one being edited. */
  feature: string;
  /** The new feature's name; absent when editing. */
  name?: string;
  /** Where a new feature goes (absent: the end). */
  before?: string;
  /** The inputs of the feature being edited; their value ids and the parts the form does not cover are kept. */
  base?: Json;
}

/** A region row a write adds to a sketch first, for a detected region a profile names. */
export interface NewRegion {
  sketch: string;
  row: string;
  loop: Json;
  holes: Json;
}

export type Built =
  | {
      ok: true;
      inputs: Json;
      names: Json;
      regions?: NewRegion[];
      /** The sketches a new feature takes its profiles from, hidden when it is added. */ sketches?: string[];
    }
  | {
      ok: false;
      message: string;
      field?: string;
      /** A pick still to make: the preview waits without showing it as an error. */ quiet?: boolean;
    };

/** A refusal for a pick the form still needs. */
export const needsPick = (message: string, field: string): Built => ({ ok: false, message, field, quiet: true });

export const LENGTH: ValueTarget = { type: 'number', quantity: 'length' };
export const ANGLE: ValueTarget = { type: 'number', quantity: 'angle' };
export const INTEGER: ValueTarget = { type: 'integer' };

/** A new feature of `type` in `part`: its id, its name as the part's next one, at the rollback marker. */
export function newTarget(editor: Editor, part: string, baseName: string): FeatureTarget {
  const doc = editor.document;
  const before = insertionPoint(doc, part);
  return {
    part,
    feature: editor.newId('feat'),
    name: nextFeatureName(doc, part, baseName),
    ...(before ? { before } : {}),
  };
}

/** The target that edits `feature` of `type` in `part`, or null when it is not one. */
export function editTarget(doc: Doc, part: string, feature: string, type: string): FeatureTarget | null {
  const row = findFeature(doc, feature);
  if (!row || row.type !== type || !isPlainObject(row.inputs)) return null;
  return { part, feature, base: row.inputs };
}

/** The value at a path of JSON, or undefined. */
export function at(root: unknown, ...path: (string | number)[]): unknown {
  let v = root;
  for (const k of path) {
    if (Array.isArray(v) && typeof k === 'number') v = v[k];
    else if (isPlainObject(v) && typeof k === 'string') v = v[k];
    else return undefined;
  }
  return v;
}

/** A value object's expression text, or ''. */
export function exprText(value: unknown): string {
  if (!isPlainObject(value) || !isPlainObject(value.def) || !isPlainObject(value.def.expr)) return '';
  return String(value.def.expr.text);
}

/** A choice value's literal without its quotes. */
export function choiceText(value: unknown): string {
  return exprText(value)
    .trim()
    .replace(/^"(.*)"$/, '$1');
}

/** A value stored as an expression rather than a plain literal: its text, and what it comes to in the document, when it evaluates. */
export interface BoundValue {
  text: string;
  value: ExprValue | undefined;
}

const PLAIN_LITERAL = /^(?:"(?:[^"\\]|\\.)*"|true|false)$/;

/** The evaluator of `doc`, or null when the document's values cannot be collected. */
function evaluatorOf(doc: Doc): ValueEvaluator | null {
  try {
    return new ValueEvaluator(doc);
  } catch {
    return null;
  }
}

/** What a value object comes to, its configuration applied: by its id when the document holds it, else its own definition. */
function evaluateValue(evaluator: ValueEvaluator | null, value: Json): ExprValue | undefined {
  if (!evaluator) return undefined;
  if (typeof value.id === 'string') {
    try {
      return evaluator.value(value.id);
    } catch {
      // Not in the document, or it pauses: its own definition is tried next.
    }
  }
  try {
    return evaluator.evaluateDefinition(value.def as Json, 'the value');
  } catch {
    return undefined;
  }
}

/** A text or boolean result as a field option: the text, or `true` / `false`; '' for anything else. */
export function optionOf(value: ExprValue | undefined): string {
  return value?.kind === 'text' ? value.value : value?.kind === 'boolean' ? String(value.value) : '';
}

function sameValue(a: ExprValue, b: ExprValue): boolean {
  if (a.kind === 'scalar' && b.kind === 'scalar')
    return (
      JSON.stringify(a.dim) === JSON.stringify(b.dim) &&
      Math.abs(a.value - b.value) <= 1e-9 * Math.max(1, Math.abs(a.value), Math.abs(b.value))
    );
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Choice, text and flag values as the fields of a panel show them: what each
 * comes to in `doc`, its selected configuration applied. A value written as
 * a plain literal reads as that literal; one written as an expression (a
 * size a parameter sets) reads as what it evaluates to, and `bound` gives
 * its expression.
 */
export interface FieldReader {
  /** A choice or text value's option; '' when it has none. */
  choice(value: unknown): string;
  flag(value: unknown): boolean;
  /** The expression of a value that is not a plain literal; null for a literal or no value. */
  bound(value: unknown): BoundValue | null;
}

export function fieldReader(doc: Doc): FieldReader {
  let evaluator: ValueEvaluator | null | undefined;
  const bound = (value: unknown): BoundValue | null => {
    const text = exprText(value).trim();
    if (text === '' || PLAIN_LITERAL.test(text)) return null;
    evaluator ??= evaluatorOf(doc);
    return { text, value: evaluateValue(evaluator, value as Json) };
  };
  return {
    choice: (value) => {
      const b = bound(value);
      return b ? optionOf(b.value) : choiceText(value);
    },
    flag: (value) => {
      const b = bound(value);
      return b ? b.value?.kind === 'boolean' && b.value.value : exprText(value).trim() === 'true';
    },
    bound,
  };
}

/** Expression text as a length field shows it: a plain millimetre value without its unit, as the unit sits beside the field. */
export function fieldText(text: string, unit = 'mm'): string {
  const m = new RegExp(`^\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)\\s*${unit}\\s*$`, 'i').exec(text);
  return m ? (m[1] as string) : text;
}

/**
 * Value objects by their place in the inputs. A place the edited feature
 * has keeps its value's id and name; a new place gets an id once, so the
 * same form builds the same ids every time.
 */
export class ValueSlots {
  private readonly made = new Map<string, string>();
  private reader: FieldReader | undefined;
  /**
   * With `doc`, the document the edited feature's inputs (`base`) come
   * from, a place whose stored value is an expression keeps it while the
   * form writes what it comes to: a size a parameter sets stays bound
   * until the user picks another.
   */
  constructor(
    private readonly newId: () => string,
    private readonly base?: Json,
    private readonly doc?: Doc,
  ) {}

  /** The expression the edited feature stores at `path`, when it is not a plain literal; null without a document. */
  bound(path: (string | number)[]): BoundValue | null {
    if (!this.doc) return null;
    this.reader ??= fieldReader(this.doc);
    return this.reader.bound(at(this.base, ...path));
  }

  /** The expression a field at `path` shows beside it: the stored one's text while the field holds what it comes to (`shown`), else null. */
  boundText(path: (string | number)[], shown: string | boolean): string | null {
    const b = this.bound(path);
    return b && b.value !== undefined && optionOf(b.value) === String(shown) ? b.text : null;
  }

  /** A value object at `path` with definition `def`. */
  value(path: (string | number)[], def: Json): Json {
    const old = at(this.base, ...path);
    if (isPlainObject(old) && typeof old.id === 'string' && 'def' in old) {
      return { ...old, def };
    }
    const key = path.join('/');
    let id = this.made.get(key);
    if (!id) {
      id = this.newId();
      this.made.set(key, id);
    }
    return { id, def };
  }

  /** A value object at `path` written as `text`; a stored expression that comes to the same is kept instead. */
  literal(path: (string | number)[], text: string): Json {
    const def = { expr: { text, grammar: 1, refs: {} } };
    const b = this.bound(path);
    if (b?.value !== undefined) {
      const written = evaluateValue(evaluatorOf(this.doc as Doc), { def } as Json);
      const old = at(this.base, ...path) as Json;
      if (written && sameValue(b.value, written)) return this.value(path, structuredClone(old.def as Json));
    }
    return this.value(path, def);
  }

  /** A choice value: the option in quotes. */
  choice(path: (string | number)[], option: string): Json {
    return this.literal(path, `"${option}"`);
  }

  flag(path: (string | number)[], on: boolean): Json {
    return this.literal(path, String(on));
  }
}

/** The scope a target's expressions are bound in: the edited feature's, or the feature before the new one. */
export function scopeOf(doc: Doc, target: FeatureTarget): { part: string; feature: string } {
  return target.base
    ? { part: target.part, feature: target.feature }
    : { part: target.part, feature: featureBefore(doc, target.part, target.before) ?? '' };
}

export type Bound = { ok: true; value: Json; stored: unknown } | { ok: false; message: string; field: string };

/**
 * Binds the text of a field as the value object at `path`: a bare number
 * takes `unit`, names resolve in the target's scope. `field` names the
 * field a refusal belongs to.
 */
export function bindValue(
  doc: Doc,
  target: FeatureTarget,
  values: ValueSlots,
  path: (string | number)[],
  text: string,
  valueTarget: ValueTarget,
  field: string,
  unit?: string,
): Bound {
  const slot = values.value(path, { expr: { text: '0', grammar: 1, refs: {} } });
  const bound = bindExpression(
    doc,
    { ...scopeOf(doc, target), self: slot.id as string },
    unit ? withDefaultUnit(text, unit) : text,
    valueTarget,
  );
  if (!bound.ok) return { ok: false, message: bound.message, field };
  return { ok: true, value: { ...slot, def: bound.def }, stored: bound.stored };
}

/**
 * `text` as a value definition with the names it uses bound in `scope`, not
 * evaluated: what it comes to is checked where the definition is written.
 * A name the scope does not have stays unbound, for that check to refuse.
 */
export function namesBound(doc: Doc, scope: ExpressionScope, text: string): Json {
  const visible = visibleNames(doc, scope);
  const refs: Record<string, ExprRef> = {};
  for (let pass = 0; pass < 1000; pass++) {
    try {
      compileExpression({ text, grammar: GRAMMAR, refs });
      break;
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      const name = e.kind === 'name' ? /^([A-Za-z_][A-Za-z0-9_]*) is not in refs$/.exec(e.detail)?.[1] : undefined;
      const ref = name === undefined ? undefined : visible.get(name);
      if (name === undefined || !ref) break;
      refs[name] = ref;
    }
  }
  return { expr: { text, grammar: GRAMMAR, refs } } as unknown as Json;
}

/** True when a bound value reads a measured value, so its number is known only to an evaluation of the geometry. */
export const measured = (...bound: { stored: unknown }[]): boolean => bound.some((b) => b.stored === null);

/** A length field, more than 0 unless `allowZero`, or not negative with `allowZero`. */
export function boundLength(
  doc: Doc,
  target: FeatureTarget,
  values: ValueSlots,
  path: (string | number)[],
  text: string,
  field: string,
  label: string,
  o: { allowZero?: boolean; allowNegative?: boolean } = {},
): Bound {
  const b = bindValue(doc, target, values, path, text, LENGTH, field, 'mm');
  if (!b.ok) return b;
  const n = b.stored as number | null;
  // A measured value is checked when the geometry is evaluated.
  if (o.allowNegative || n === null) return b;
  if (o.allowZero ? !(n >= 0) : !(n > 0))
    return { ok: false, message: `${label} must ${o.allowZero ? 'not be negative' : 'be positive'}`, field };
  return b;
}

/** An angle field in degrees. */
export function boundAngle(
  doc: Doc,
  target: FeatureTarget,
  values: ValueSlots,
  path: (string | number)[],
  text: string,
  field: string,
): Bound {
  return bindValue(doc, target, values, path, text, ANGLE, field, 'deg');
}

/** An integer field of at least `min`. */
export function boundCount(
  doc: Doc,
  target: FeatureTarget,
  values: ValueSlots,
  path: (string | number)[],
  text: string,
  field: string,
  label: string,
  min = 1,
): Bound {
  const b = bindValue(doc, target, values, path, text, INTEGER, field);
  if (!b.ok) return b;
  if (b.stored !== null && !((b.stored as number) >= min))
    return {
      ok: false,
      message: min === 1 ? `${label} must be a positive integer` : `${label} must be at least ${min}`,
      field,
    };
  return b;
}

/** A set of references, or a refusal when one is picked twice. */
export function referenceSet(
  refs: readonly Json[],
  field: string,
  label = 'A pick',
): { ok: true; set: Json } | { ok: false; message: string; field: string } {
  try {
    return { ok: true, set: makeSet(refs) as unknown as Json };
  } catch {
    return { ok: false, message: `${label} is picked twice`, field };
  }
}

/**
 * The operation input (7.3): `op`; the target bodies picked in the form
 * (none: all bodies), or without a form's picks the edited feature's
 * targets kept, or all bodies.
 */
export function operationInput(values: ValueSlots, base: unknown, op: string, targets?: readonly PickedRef[]): Json {
  const old = isPlainObject(base) ? base : undefined;
  return {
    op: values.choice(['operation', 'op'], op),
    targets: targets
      ? targetsInput(targets)
      : old && old.targets !== undefined
        ? structuredClone(old.targets as Json)
        : { all: {} },
    keepTools: old && isPlainObject(old.keepTools) ? old.keepTools : values.flag(['operation', 'keepTools'], false),
  };
}

/** An operation's `targets` (7.3): the picked bodies as `{"bodies": set}`, or all bodies with none picked. */
export function targetsInput(targets: readonly PickedRef[]): Json {
  const unique = targets.filter((t, i) => targets.findIndex((u) => sameReference(u.reference, t.reference)) === i);
  return unique.length === 0 ? { all: {} } : { bodies: makeSet(unique.map((t) => t.reference)) as unknown as Json };
}

/** The target bodies an operation input names, as picks; empty for all bodies. */
export function readTargets(operation: unknown): PickedRef[] {
  return picksOf(at(operation, 'targets', 'bodies'), 'Body');
}

/** Writes built inputs to `target` as one undo step: new region rows, then the feature added or its inputs replaced. */
export function writeFeature(
  editor: Editor,
  target: FeatureTarget,
  type: string,
  built: Extract<Built, { ok: true }>,
  baseName = 'Feature',
): CommandResult {
  const label = target.base
    ? `Edit ${String(findFeature(editor.document, target.feature)?.name ?? baseName)}`
    : `Add ${target.name ?? baseName}`;
  const check = (r: CommandResult): void => {
    if (!r.ok) throw new CommandError(r.error.code, r.error.message);
  };
  try {
    return editor.transaction(label, () => {
      for (const r of built.regions ?? []) {
        check(
          editor.dispatch({
            type: 'pickRegion',
            sketch: r.sketch,
            region: { id: r.row, loop: r.loop, holes: r.holes } as unknown as Json,
          }),
        );
      }
      if (target.base) {
        const r = editor.dispatch({
          type: 'replaceInput',
          feature: target.feature,
          pointer: '',
          with: built.inputs,
          names: built.names,
        });
        check(r);
        return r;
      }
      const row = featureRow(editor, target.feature, type, target.name ?? baseName, built.inputs);
      const r = editor.dispatch({
        type: 'addFeature',
        container: target.part,
        feature: row,
        names: built.names,
        ...(target.before ? { before: target.before } : {}),
      });
      check(r);
      hideSketches(editor, target.part, built.sketches ?? []);
      return r;
    });
  } catch (e) {
    if (e instanceof CommandError) return { ok: false, error: e.toFailure() };
    throw e;
  }
}

/**
 * Hides `sketches` of `part` as a new feature that takes its profiles
 * from them is added, inside the caller's transaction; a sketch already
 * hidden is left as it is.
 */
export function hideSketches(editor: Editor, part: string, sketches: readonly string[]): void {
  for (const sketch of new Set(sketches)) {
    const doc = editor.document;
    if (
      findFeature(doc, sketch)?.type !== 'core.sketch' ||
      partOfFeature(doc, sketch) !== part ||
      featureHidden(doc, part, sketch)
    )
      continue;
    const r = setVisible(editor, part, { feature: sketch }, false);
    if (!r.ok) throw new CommandError(r.error.code, r.error.message);
  }
}

/**
 * The document with the feature written, for a preview, without touching
 * the editor's; null with why when it could not be written or would be
 * refused.
 */
export function candidateFeature(
  doc: Doc,
  target: FeatureTarget,
  type: string,
  built: Extract<Built, { ok: true }>,
  newId: (kind: string) => string,
): { ok: true; doc: Doc } | { ok: false; message: string } {
  const scratch = new Editor(doc, { validate: () => [], ids: newId });
  const r = writeFeature(scratch, target, type, built);
  if (!r.ok) return { ok: false, message: r.error.message };
  const refusals = formatRefusals(scratch.document);
  if (refusals.length > 0) return { ok: false, message: (refusals[0] as { message: string }).message };
  return { ok: true, doc: scratch.document };
}

/** A reference a panel holds: what to write, the names it needs, and how the panel lists it. */
export interface PickedRef {
  reference: Json;
  names: Json;
  label: string;
  /** A stored reference that lands on nothing in the state the feature starts from. */
  missing?: boolean;
}

/** Name-table entries of several picks, merged. */
export function namesOf(picks: readonly (PickedRef | null | undefined)[]): Json {
  const out: Json = {};
  for (const p of picks) if (p) Object.assign(out, p.names);
  return out;
}

/** The references of a set input as picks a panel lists, labelled `label n`. */
export function picksOf(set: unknown, label: string): PickedRef[] {
  const members = (at(set, 'set') as Json[] | undefined) ?? [];
  return members.map((reference, i) => ({ reference, names: {}, label: `${label} ${i + 1}` }));
}

/**
 * Whether two references name the same thing: entity records by their
 * finest name (two picks of one edge agree there even when written from
 * different evaluations), anything else by its JSON.
 */
export function sameReference(a: Json, b: Json): boolean {
  const fa = (at(a, 'entity', 'id') as unknown[] | undefined)?.at(-1);
  const fb = (at(b, 'entity', 'id') as unknown[] | undefined)?.at(-1);
  if (typeof fa === 'string' || typeof fb === 'string') return fa === fb;
  return JSON.stringify(a) === JSON.stringify(b);
}

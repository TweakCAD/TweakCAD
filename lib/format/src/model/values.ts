import { isPlainObject } from '../collections';
import type { ValueTarget } from '../expr';
import { isContentHash } from '../hash';
import { child } from './diagnostics';
import { readInstancePath, readReference } from './references';
import type { Json, Reader } from './reader';
import {
  GRAMMARS,
  MEASURE_KINDS,
  NAME_PATTERN,
  QUANTITIES,
  QUANTITY_TYPES,
  RESERVED_WORDS,
  VALUE_TYPES,
} from './registries';

/** Where a parameter or value lives, for name scoping and visibility (6.3, 6.4). */
export interface Scope {
  /** `doc_…`, `part_…` or `asm_…` id of the owning row. */
  owner: string;
  /** The feature a value belongs to, when it is a feature input. */
  feature?: string | undefined;
  /** Set for a feature's `suppressed` flag, which sees no value of its own feature (7.2). */
  suppressed?: boolean | undefined;
  /** Set for values inside an `input` override's `with` (6.3). */
  insideWith?: boolean | undefined;
}

export interface ParameterInfo {
  id: string;
  name: string;
  path: string;
  scope: Scope;
  type: string;
  quantity?: string | undefined;
  options?: string[] | undefined;
  value: Json | null;
  public: boolean;
}

export interface ValueInfo {
  /** What the value must evaluate to, when the schema around it says. */
  target?: ValueTarget | undefined;
  id: string;
  name?: string | undefined;
  path: string;
  scope: Scope;
  def: Json;
  public: boolean;
}

/** What the reader learns about values, for the integrity pass. */
export class ValueIndex {
  readonly parameters: ParameterInfo[] = [];
  readonly values: ValueInfo[] = [];
  /** Value ids that hold a parameter's value or range bound, to that parameter's id. */
  readonly parameterOf = new Map<string, string>();
  /**
   * The definitions of `value` overrides outside configurations: a host's
   * insertion overrides (6.4, 11.1, 12.1) and a pattern's `vary` overrides,
   * evaluated where they are written.
   */
  readonly hostDefs: { def: Json; path: string; scope: Scope; vary: boolean; target?: string | undefined }[] = [];
}

/** Ids of everything one expression's `refs` names. */
export interface ExprRefs {
  parameters: string[];
  values: string[];
  library: string[];
  tables: string[];
  published: number;
}

/**
 * Reads `refs` targets out of a value `def`; empty for measures. Targets that
 * are not well formed are skipped: the reader has refused them already.
 */
export function exprRefs(def: Json): ExprRefs {
  const out: ExprRefs = { parameters: [], values: [], library: [], tables: [], published: 0 };
  const expr = def.expr;
  if (!isPlainObject(expr) || !isPlainObject(expr.refs)) return out;
  for (const target of Object.values(expr.refs)) {
    if (!isPlainObject(target)) continue;
    const tag = Object.keys(target)[0];
    const payload = tag ? target[tag] : undefined;
    if (!isPlainObject(payload)) continue;
    if (tag === 'published') out.published++;
    const id = tag === 'table' ? payload.asset : payload.id;
    if (typeof id !== 'string') continue;
    if (tag === 'parameter') out.parameters.push(id);
    else if (tag === 'value') out.values.push(id);
    else if (tag === 'library') out.library.push(id);
    else if (tag === 'table') out.tables.push(id);
  }
  return out;
}

/** Whether an `expr` def has the shape appendix B's checks can compile: anything else is refused where it is read. */
export function isWellFormedExpr(expr: unknown): boolean {
  return (
    isPlainObject(expr) &&
    typeof expr.text === 'string' &&
    typeof expr.grammar === 'number' &&
    isPlainObject(expr.refs) &&
    Object.values(expr.refs).every((target) => {
      if (!isPlainObject(target)) return false;
      const keys = Object.keys(target);
      return keys.length === 1 && isPlainObject(target[keys[0] as string]);
    })
  );
}

function checkName(r: Reader, name: unknown, path: string): name is string {
  if (!r.string(name, path)) return false;
  if (!NAME_PATTERN.test(name)) {
    r.diagnostics.refuse('bad-name', path, `"${name}" is not a valid name`);
    return false;
  }
  if (RESERVED_WORDS.has(name)) {
    r.diagnostics.refuse('reserved-name', path, `"${name}" is a reserved word`);
    return false;
  }
  return true;
}

/** A value `def` (6.3). */
export function readDef(r: Reader, value: unknown, path: string): void {
  const u = r.union(value, path, ['expr', 'measure']);
  if (!u) return;
  if (u.tag === 'expr') {
    const e = r.object(u.payload, u.path, { required: ['text', 'grammar', 'refs'] });
    if (!e) return;
    r.string(e.text, child(u.path, 'text'));
    if (r.integer(e.grammar, child(u.path, 'grammar'), 1) && !GRAMMARS.includes(e.grammar)) {
      r.diagnostics.pause('unknown-version', child(u.path, 'grammar'), `unknown grammar ${e.grammar}`);
    }
    const rp = child(u.path, 'refs');
    if (!r.map(e.refs, rp)) return;
    for (const [name, target] of Object.entries(e.refs)) {
      const np = child(rp, name);
      checkName(r, name, np);
      const t = r.union(target, np, ['parameter', 'value', 'table', 'library', 'published']);
      if (!t) continue;
      switch (t.tag) {
        case 'parameter':
          r.idRef(t.payload, t.path, 'par');
          break;
        case 'value':
          r.idRef(t.payload, t.path, 'val');
          break;
        case 'library':
          r.idRef(t.payload, t.path, 'lib');
          break;
        case 'table': {
          const o = r.object(t.payload, t.path, { required: ['asset'] });
          if (!o) break;
          if (isContentHash(o.asset)) r.assetUses.push({ id: o.asset, path: child(t.path, 'asset') });
          else r.diagnostics.refuse('bad-hash', child(t.path, 'asset'), 'malformed asset hash');
          break;
        }
        case 'published': {
          // Ids pointing into another document are reference-class (2.4).
          const o = r.object(t.payload, t.path, { required: ['instance', 'id'] });
          if (!o) break;
          readInstancePath(r, o.instance, child(t.path, 'instance'));
          r.label(o.id, child(t.path, 'id'));
          break;
        }
      }
    }
    return;
  }
  const m = r.object(u.payload, u.path, { required: ['kind', 'of'] });
  if (!m) return;
  if (r.string(m.kind, child(u.path, 'kind')) && !MEASURE_KINDS.includes(m.kind)) {
    r.diagnostics.pause('unknown-variant', child(u.path, 'kind'), `unknown measure kind "${m.kind}"`);
  }
  if (r.list(m.of, child(u.path, 'of'))) {
    m.of.forEach((ref, i) => readReference(r, ref, child(child(u.path, 'of'), i)));
  }
}

/** A value object (6.3). */
export function readValue(
  r: Reader,
  index: ValueIndex,
  value: unknown,
  path: string,
  scope: Scope,
  target?: ValueTarget,
): void {
  const o = r.object(value, path, { required: ['id', 'def'], optional: ['name', 'public', 'published'] });
  if (!o) return;
  if (!r.define(o.id, child(path, 'id'), 'val')) return;
  let name: string | undefined;
  if (o.name !== undefined) {
    if (scope.insideWith) {
      r.diagnostics.refuse('bad-name', child(path, 'name'), 'a value inside an override has no name');
    } else if (checkName(r, o.name, child(path, 'name'))) {
      name = o.name;
    }
  }
  if (o.public !== undefined) r.boolean(o.public, child(path, 'public'));
  if (o.published !== undefined) r.boolean(o.published, child(path, 'published'));
  readDef(r, o.def, child(path, 'def'));
  index.values.push({
    id: o.id,
    name,
    path,
    scope,
    def: isPlainObject(o.def) ? o.def : {},
    public: o.public === true,
    target,
  });
}

/** A parameter (6.2). */
export function readParameter(r: Reader, index: ValueIndex, value: unknown, path: string, owner: string): void {
  const o = r.object(value, path, {
    required: ['id', 'name', 'type', 'value', 'range', 'public', 'published', 'description'],
    optional: ['quantity', 'options'],
  });
  if (!o) return;
  if (!r.define(o.id, child(path, 'id'), 'par')) return;
  const nameOk = checkName(r, o.name, child(path, 'name'));
  let type = '';
  if (r.string(o.type, child(path, 'type'))) {
    type = o.type;
    if (!(VALUE_TYPES as readonly string[]).includes(type)) {
      r.diagnostics.pause('unknown-variant', child(path, 'type'), `unknown value type "${type}"`);
    }
  }
  // What a type allows is known only for known types; an unknown one already pauses (18, 19).
  const known = (VALUE_TYPES as readonly string[]).includes(type);
  const needsQuantity = QUANTITY_TYPES.includes(type);
  if (needsQuantity && o.quantity === undefined) {
    r.diagnostics.refuse('missing-field', child(path, 'quantity'), `a ${type} parameter has a quantity`);
  } else if (!needsQuantity && o.quantity !== undefined && known) {
    r.diagnostics.refuse('bad-value', child(path, 'quantity'), `a ${type} parameter has no quantity`);
  } else if (o.quantity !== undefined && r.string(o.quantity, child(path, 'quantity'))) {
    if (!(QUANTITIES as readonly string[]).includes(o.quantity)) {
      r.diagnostics.pause('unknown-variant', child(path, 'quantity'), `unknown quantity "${o.quantity}"`);
    }
  }
  if (type === 'choice') {
    if (o.options === undefined) {
      r.diagnostics.refuse('missing-field', child(path, 'options'), 'a choice parameter has options');
    } else if (r.list(o.options, child(path, 'options'))) {
      const seen = new Set<string>();
      o.options.forEach((opt, i) => {
        const op = child(child(path, 'options'), i);
        if (!r.string(opt, op)) return;
        if (seen.has(opt)) r.diagnostics.refuse('bad-value', op, `duplicate option "${opt}"`);
        seen.add(opt);
      });
    }
  } else if (o.options !== undefined && known) {
    r.diagnostics.refuse('bad-value', child(path, 'options'), 'only choice parameters have options');
  }
  const range = r.union(o.range, child(path, 'range'), ['unbounded', 'between']);
  if (range?.tag === 'between') {
    const b = r.object(range.payload, range.path, { required: ['min', 'max'] });
    if (b) {
      readValue(r, index, b.min, child(range.path, 'min'), { owner });
      readValue(r, index, b.max, child(range.path, 'max'), { owner });
      for (const bound of [b.min, b.max]) {
        if (isPlainObject(bound) && typeof bound.id === 'string') index.parameterOf.set(bound.id, o.id);
      }
    }
  } else if (range) {
    r.object(range.payload, range.path, { required: [] });
  }
  r.boolean(o.public, child(path, 'public'));
  r.boolean(o.published, child(path, 'published'));
  r.string(o.description, child(path, 'description'));
  readValue(r, index, o.value, child(path, 'value'), { owner });
  if (isPlainObject(o.value) && typeof o.value.id === 'string') index.parameterOf.set(o.value.id, o.id);
  if (nameOk) {
    index.parameters.push({
      id: o.id,
      name: o.name as string,
      path,
      scope: { owner },
      type,
      quantity: typeof o.quantity === 'string' ? o.quantity : undefined,
      options: Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined,
      value: (o.value ?? null) as Json | null,
      public: o.public === true,
    });
  }
}

/** A list of parameter tables (6.1). */
export function readParameterTables(r: Reader, index: ValueIndex, value: unknown, path: string, owner: string): void {
  if (!r.list(value, path)) return;
  value.forEach((table, i) => {
    const tp = child(path, i);
    const t = r.object(table, tp, { required: ['id', 'name', 'parameters'] });
    if (!t) return;
    r.define(t.id, child(tp, 'id'), 'tbl');
    r.string(t.name, child(tp, 'name'));
    if (r.list(t.parameters, child(tp, 'parameters'))) {
      t.parameters.forEach((p, j) => readParameter(r, index, p, child(child(tp, 'parameters'), j), owner));
    }
  });
}

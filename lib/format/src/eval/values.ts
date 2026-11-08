import { isPlainObject } from '../collections';
import {
  compileExpression,
  evaluateExpression,
  ExprError,
  parseLookupTable,
  toStored,
  type EvaluationContext,
  type ExprRef,
  type ExprValue,
  type ExpressionJson,
  type LookupTable,
  type ValueTarget,
} from '../expr';
import type { JsonValue } from '../canonical';
import { decodeBase64 } from '../model/storage';

type Json = Record<string, unknown>;

/** Why a value has no result in this build: what uses it pauses (9.6, appendix B). */
export class ValuePause extends Error {
  constructor(
    readonly valueId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValuePause';
  }
}

interface Parameter {
  id: string;
  name?: string | undefined;
  value: Json;
  target?: ValueTarget | undefined;
  /** The bounds of a `between` range, value objects (6.2). */
  range?: { min: Json; max: Json } | undefined;
}

/** A document's parameters, value objects and feature `suppressed` flags, by id. */
function collect(doc: Json): {
  parameters: Map<string, Parameter>;
  values: Map<string, Json>;
  suppressed: Map<string, string>;
} {
  const parameters = new Map<string, Parameter>();
  const values = new Map<string, Json>();
  const suppressed = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!isPlainObject(v)) return;
    if (typeof v.id === 'string' && v.id.startsWith('par_') && isPlainObject(v.value)) {
      const target: ValueTarget | undefined =
        typeof v.type === 'string'
          ? {
              type: v.type as ValueTarget['type'],
              ...(typeof v.quantity === 'string' ? { quantity: v.quantity } : {}),
              ...(Array.isArray(v.options) ? { options: v.options as string[] } : {}),
            }
          : undefined;
      const between = isPlainObject(v.range) && isPlainObject(v.range.between) ? v.range.between : undefined;
      const range =
        between && isPlainObject(between.min) && isPlainObject(between.max)
          ? { min: between.min, max: between.max }
          : undefined;
      const name = typeof v.name === 'string' ? v.name : undefined;
      parameters.set(v.id, { id: v.id, name, value: v.value, target, range });
    }
    if (typeof v.id === 'string' && v.id.startsWith('val_') && 'def' in v) values.set(v.id, v);
    if (
      typeof v.id === 'string' &&
      v.id.startsWith('feat_') &&
      isPlainObject(v.suppressed) &&
      typeof v.suppressed.id === 'string'
    ) {
      suppressed.set(v.id, v.suppressed.id);
    }
    for (const [key, item] of Object.entries(v)) if (key !== 'extensions') walk(item);
  };
  // A library document has ids of its own scope (2.4); it is evaluated on its own.
  for (const [key, item] of Object.entries(doc)) if (key !== 'library' && key !== 'extensions') walk(item);
  return { parameters, values, suppressed };
}

export interface ValueEvaluatorOptions {
  /**
   * The asset table lookup tables are read from; absent: the document's own.
   * An embedded library document's rows carry no bytes, so its host passes its
   * own table (11).
   */
  assets?: Json | undefined;
  /**
   * An instance's published parameter or value (6.4), for a host that
   * evaluates the instance's document. Absent: published refs pause.
   */
  published?: ((instance: unknown, id: string) => ExprValue) | undefined;
}

/**
 * Evaluates a document's values (chapter 10, steps 1 and 2.3): configuration
 * rows are selected by their input parameters, value overrides replace their
 * targets' definitions, and every expression is evaluated once, on demand.
 */
export class ValueEvaluator {
  private readonly parameters: Map<string, Parameter>;
  private readonly values: Map<string, Json>;
  /** A parameter's own value object id → the parameter's id. */
  private readonly parameterOfValue = new Map<string, string>();
  /** Value or parameter id → the definition a selected configuration row gives it. */
  private readonly overrides = new Map<string, Json>();
  /**
   * Value or parameter id → why the configuration that can override it has no
   * row in this build (7.4). A feature an `input` override of such a
   * configuration targets is listed by its `suppressed` flag, the first value
   * its build reads (10, step 2.1), so the whole feature pauses.
   */
  private readonly unresolved = new Map<string, string>();
  private readonly results = new Map<string, ExprValue>();
  private readonly busy = new Set<string>();
  /** Why a measured value has no result in this build. */
  private readonly unmeasured = new Map<string, string>();
  /** What each value was last asked to be, by id. */
  private readonly targets = new Map<string, ValueTarget>();
  /** Parameters and values a host's insertion overrides set (6.4). */
  private readonly inserted = new Set<string>();
  private readonly assets: Json;
  private readonly tables = new Map<string, LookupTable>();
  private readonly published: ValueEvaluatorOptions['published'];

  /**
   * @param insertion results a host's insertion overrides give, by parameter
   * or value id, evaluated in the host. They apply before row selection, and
   * no configuration row of this document changes them (6.4).
   */
  constructor(doc: Json, insertion: ReadonlyMap<string, ExprValue> = new Map(), options: ValueEvaluatorOptions = {}) {
    const { parameters, values, suppressed } = collect(doc);
    this.parameters = parameters;
    this.values = values;
    this.assets = options.assets ?? (isPlainObject(doc.assets) ? doc.assets : {});
    this.published = options.published;
    for (const p of parameters.values()) {
      if (typeof p.value.id === 'string') this.parameterOfValue.set(p.value.id, p.id);
    }
    for (const [id, result] of insertion) {
      const parameter = this.parameters.get(id);
      this.inserted.add(id);
      this.results.set(parameter ? (parameter.value.id as string) : id, result);
    }
    this.applyConfigurations(doc, suppressed);
  }

  /** The `input` overrides of the selected configuration rows, for the feature builders. */
  readonly inputOverrides: { feature: string; pointer: string; with: JsonValue }[] = [];

  private applyConfigurations(doc: Json, suppressed: ReadonlyMap<string, string>): void {
    const owners = [...((doc.parts as Json[]) ?? []), ...((doc.assemblies as Json[]) ?? [])];
    for (const owner of owners) {
      for (const config of (owner.configurations as Json[]) ?? []) {
        const inputId = (config.input as Json).id as string;
        const rows = (config.rows as Json[]) ?? [];
        let row: Json | undefined;
        let pause: string;
        try {
          const selected = this.storedValue(inputId, 'parameter');
          row = rows.find((r) => ((r.option as Json).equals as Json).literal === selected);
          pause = `configuration ${String(config.id)} has no row for ${JSON.stringify(selected)}`;
        } catch (e) {
          if (!(e instanceof ValuePause)) throw e;
          pause = `the input of configuration ${String(config.id)} does not evaluate: ${e.message}`;
        }
        if (row) {
          for (const o of (row.overrides as Json[]) ?? []) {
            if (isPlainObject(o.value)) {
              const id = overrideTarget(o.value);
              if (this.inserted.has(id)) continue;
              this.overrides.set(id, o.value.def as Json);
              this.unresolved.delete(id);
            } else if (isPlainObject(o.input)) {
              this.inputOverrides.push({
                feature: (o.input.feature as Json).id as string,
                pointer: o.input.pointer as string,
                with: o.input.with as JsonValue,
              });
            }
          }
          continue;
        }
        // No row for the input's value: everything any row could change pauses (7.4).
        for (const r of rows) {
          for (const o of (r.overrides as Json[]) ?? []) {
            let id: string | undefined;
            if (isPlainObject(o.value)) id = overrideTarget(o.value);
            else if (isPlainObject(o.input)) id = suppressed.get((o.input.feature as Json).id as string);
            if (id === undefined || this.inserted.has(id)) continue;
            this.overrides.delete(id);
            this.unresolved.set(id, pause);
          }
        }
      }
    }
  }

  /** A configuration input's stored literal (a choice text, boolean or integer). */
  private storedValue(id: string, kind: 'parameter' | 'value'): JsonValue {
    const result = kind === 'parameter' ? this.parameter(id) : this.value(id);
    switch (result.kind) {
      case 'scalar':
      case 'boolean':
      case 'text':
        return result.value as JsonValue;
      default:
        throw new ValuePause(id, 'a configuration input is a choice, boolean or integer');
    }
  }

  /**
   * A parameter's result: its value object, or the definition a selected row
   * gives it, checked against its `range` wherever it came from (6.2).
   */
  parameter(id: string): ExprValue {
    const p = this.parameters.get(id);
    if (!p) throw new ValuePause(id, `parameter ${id} does not exist`);
    const paused = this.unresolved.get(id);
    if (paused !== undefined) throw new ValuePause(id, paused);
    const def = this.overrides.get(id);
    const result = this.evaluate(p.value.id as string, def ?? (p.value.def as Json), p.target);
    const target = p.target;
    if (p.range && target && (target.type === 'number' || target.type === 'integer')) {
      const bound = (v: Json): number => this.stored(p.id, this.value(idOf(v), target), target) as number;
      const range = { min: bound(p.range.min), max: bound(p.range.max) };
      try {
        toStored(result, { ...target, range });
      } catch (e) {
        if (e instanceof ExprError) throw new ValuePause(p.id, `${p.name ?? id} is outside its range: ${e.message}`);
        throw e;
      }
    }
    return result;
  }

  /** A value object's result, by id. A parameter's own value object answers as its parameter. */
  value(id: string, target?: ValueTarget): ExprValue {
    const parameter = this.parameterOfValue.get(id);
    if (parameter !== undefined) {
      if (target) this.targets.set(id, target);
      return this.parameter(parameter);
    }
    const v = this.values.get(id);
    if (!v) throw new ValuePause(id, `value ${id} does not exist`);
    const paused = this.unresolved.get(id);
    if (paused !== undefined) throw new ValuePause(id, paused);
    return this.evaluate(id, this.overrides.get(id) ?? (v.def as Json), target);
  }

  /**
   * A definition evaluated in this document's scope and kept nowhere: an
   * insertion override's, which is evaluated in the host (6.4). `label` names
   * it in a pause.
   */
  evaluateDefinition(def: Json, label: string, target?: ValueTarget): ExprValue {
    if (!isPlainObject(def.expr)) throw new ValuePause(label, 'a measured insertion override is not built yet');
    try {
      const compiled = compileExpression(def.expr as unknown as ExpressionJson);
      const result = evaluateExpression(compiled, this.context());
      if (target) toStored(result, target);
      return result;
    } catch (e) {
      if (e instanceof ExprError) throw new ValuePause(label, e.message);
      throw e;
    }
  }

  /** A value's definition in this build: the selected configuration row's, or its own. */
  definition(id: string): Json | undefined {
    const v = this.values.get(id);
    return v && (this.overrides.get(id) ?? (v.def as Json));
  }

  /**
   * Gives a value its result from outside the expressions: a measured value
   * after its feature's build, or a frozen feature's stored literal (10, 7.2).
   */
  supply(id: string, result: ExprValue): void {
    this.unmeasured.delete(id);
    this.results.set(id, result);
  }

  /** A measured value that could not be measured in this build: what uses it pauses with `message`. */
  withhold(id: string, message: string): void {
    this.results.delete(id);
    this.unmeasured.set(id, message);
  }

  /** What a value was last asked to be, when a builder asked with a target. */
  targetOf(id: string): ValueTarget | undefined {
    return this.targets.get(id);
  }

  /** A value object's result as a stored number, in its quantity's base unit. */
  number(v: unknown, target: ValueTarget): number {
    const result = this.value(idOf(v), target);
    const stored = this.stored(idOf(v), result, target);
    if (typeof stored !== 'number') throw new ValuePause(idOf(v), 'expected a number');
    return stored;
  }

  /** A value object's result as a stored literal of `target`. */
  literal(v: unknown, target: ValueTarget): JsonValue {
    return this.stored(idOf(v), this.value(idOf(v), target), target);
  }

  private stored(id: string, result: ExprValue, target: ValueTarget): JsonValue {
    try {
      return toStored(result, target);
    } catch (e) {
      if (e instanceof ExprError) throw new ValuePause(id, e.message);
      throw e;
    }
  }

  private evaluate(id: string, def: Json, target: ValueTarget | undefined): ExprValue {
    if (target) this.targets.set(id, target);
    const done = this.results.get(id);
    if (done) return done;
    if (this.busy.has(id)) throw new ValuePause(id, 'values depend on each other in a cycle');
    if (!isPlainObject(def.expr)) {
      throw new ValuePause(
        id,
        this.unmeasured.get(id) ?? 'the value is measured, and is not measured yet at this point',
      );
    }
    this.busy.add(id);
    try {
      const compiled = compileExpression(def.expr as unknown as ExpressionJson);
      const result = evaluateExpression(compiled, this.context());
      if (target) this.stored(id, result, target);
      this.results.set(id, result);
      return result;
    } catch (e) {
      if (e instanceof ExprError) throw new ValuePause(id, e.message);
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }

  private context(): EvaluationContext {
    return { read: (_name, ref) => this.read(ref), table: (asset) => this.table(asset) };
  }

  private read(ref: ExprRef): ExprValue {
    if ('parameter' in ref) return this.parameter(ref.parameter.id);
    if ('value' in ref) return this.value(ref.value.id);
    if ('published' in ref && this.published) return this.published(ref.published.instance, ref.published.id);
    throw new ExprError('unknown', 'published values of instances are not evaluated here');
  }

  /** A lookup table: a CSV asset, read once (appendix B). */
  private table(asset: string): LookupTable {
    const known = this.tables.get(asset);
    if (known) return known;
    const row = this.assets[asset];
    if (!isPlainObject(row)) throw new ExprError('table', `lookup table ${asset} is not in assets`);
    const name = typeof row.name === 'string' ? row.name : asset;
    const data = row.data;
    const inline = isPlainObject(data) && isPlainObject(data.inline) ? data.inline : undefined;
    if (!inline) throw new ExprError('table', `lookup table ${name} is not loaded`);
    const bytes = typeof inline.base64 === 'string' ? decodeBase64(inline.base64) : null;
    if (!bytes) throw new ExprError('table', `lookup table ${name} is not base64`);
    const table = parseLookupTable(bytes);
    this.tables.set(asset, table);
    return table;
  }
}

/** The parameter or value id a `value` override targets. */
function overrideTarget(o: Json): string {
  const target = o.target as Json;
  return ((target.parameter ?? target.value) as Json).id as string;
}

function idOf(v: unknown): string {
  if (isPlainObject(v) && typeof v.id === 'string') return v.id;
  throw new Error('expected a value object');
}

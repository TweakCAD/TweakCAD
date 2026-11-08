/**
 * Values for solving a working copy of a sketch: the document's values, plus
 * value objects the working copy holds that the document does not have yet
 * (the flags of a curve being drawn, a dimension being added), plus new
 * definitions for values it does have (a dimension being edited, a curve
 * made construction, a text row rewritten).
 */
import { ValueEvaluator, isPlainObject, toStored, type JsonValue, type ValueTarget } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';

export class WorkingValues extends ValueEvaluator {
  /** Value objects new rows hold that other new values name, by id. */
  private readonly locals = new Map<string, Json>();

  /**
   * @param overrides new definitions of values the document has, by value id;
   * what depends on them reads the new results.
   * @param rows new rows whose value objects others may name, as an offset's
   * copies name the first copy's distance.
   * @param updated new definitions an edit writes into rows the document
   * has, by value id; one that cannot be evaluated yet (it names a library
   * entry the edit adds first) is withheld, so what reads it pauses.
   */
  constructor(
    doc: Doc,
    overrides: ReadonlyMap<string, Json> = new Map(),
    rows: readonly unknown[] = [],
    updated: ReadonlyMap<string, Json> = new Map(),
  ) {
    super(doc);
    for (const [id, def] of overrides) this.supply(id, this.evaluateDefinition(def, id));
    for (const [id, def] of updated) {
      if (overrides.has(id)) continue;
      try {
        this.supply(id, this.evaluateDefinition(def, id));
      } catch (e) {
        this.withhold(id, e instanceof Error ? e.message : String(e));
      }
    }
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (isPlainObject(v)) {
        if (
          typeof v.id === 'string' &&
          v.id.startsWith('val_') &&
          isPlainObject(v.def) &&
          this.definition(v.id) === undefined
        )
          this.locals.set(v.id, v.def);
        for (const [k, inner] of Object.entries(v)) if (k !== 'def') visit(inner);
      }
    };
    visit(rows);
  }

  override value(id: string, target?: ValueTarget): ReturnType<ValueEvaluator['value']> {
    const def = this.locals.get(id);
    return def ? this.evaluateDefinition(def, id, target) : super.value(id, target);
  }

  /** A value object the document does not hold: evaluated from its own definition. */
  private isLocal(v: unknown): v is Json & { id: string; def: Json } {
    return isPlainObject(v) && typeof v.id === 'string' && isPlainObject(v.def) && this.definition(v.id) === undefined;
  }

  override number(v: unknown, target: ValueTarget): number {
    if (!this.isLocal(v)) return super.number(v, target);
    const stored = toStored(this.evaluateDefinition(v.def, v.id, target), target);
    if (typeof stored !== 'number') throw new Error('expected a number');
    return stored;
  }

  override literal(v: unknown, target: ValueTarget): JsonValue {
    if (!this.isLocal(v)) return super.literal(v, target);
    return toStored(this.evaluateDefinition(v.def, v.id, target), target);
  }
}

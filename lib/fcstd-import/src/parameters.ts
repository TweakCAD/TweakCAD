/**
 * FreeCAD's spreadsheets and VarSets as parameter tables, and expressions as
 * value definitions: an expression may read a parameter, or a dimension or
 * property of an earlier feature of its Body, which becomes a named value (6.4).
 * FreeCAD keeps the value it computed beside each expression, so every bound
 * value is checked against it once the document is whole: one that does not
 * evaluate to it stays the plain number.
 */
import {
  GRAMMAR,
  RESERVED_WORDS,
  ValueEvaluator,
  compileExpression,
  readDocument,
  type ExprRef,
} from '@tweakcad/format';
import type { ImportNote } from './convert';
import type { FcDocument, FcObject } from './document';
import type { Json, Writer } from './writer';
import { findChild, findChildren } from './xml';

type Quantity = 'length' | 'angle' | 'ratio';

interface Parameter {
  id: string;
  name: string;
  quantity: Quantity;
}

/** Where a value lies: its part, and its object's place in that part's order. */
export interface ValueScope {
  part: string;
  order: number;
}

interface Bound {
  value: Json;
  expression: string;
  scope: ValueScope;
  quantity: Quantity;
  /** The number FreeCAD holds, in mm or degrees. */
  number: number;
  literal: string;
}

/** Units a parameter's text may carry, by the quantity they make. */
const LENGTH_UNITS = /^(mm|cm|dm|m|km|um|in|ft|thou|mil|yd)$/;
const ANGLE_UNITS = /^(deg|rad|gon|°)$/;
/** Words the expression grammar shares with FreeCAD's. */
const KNOWN = new Set([
  'sqrt',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'abs',
  'min',
  'max',
  'floor',
  'ceil',
  'round',
  'pow',
  'pi',
  'mm',
  'cm',
  'm',
  'in',
  'ft',
  'deg',
  'rad',
  'um',
  'km',
]);
const REFERENCE = /(<<[^>]*>>|[A-Za-z_][A-Za-z0-9_]*)\.((?:Constraints\.)?[A-Za-z_][A-Za-z0-9_]*)/g;

function quantityOf(text: string): Quantity | undefined {
  const m = /^-?[\d.]+(?:e-?\d+)?\s*([^\s\d].*)?$/.exec(text.trim());
  if (!m) return undefined;
  const unit = m[1]?.trim();
  if (!unit) return 'ratio';
  if (LENGTH_UNITS.test(unit)) return 'length';
  if (ANGLE_UNITS.test(unit)) return 'angle';
  return undefined;
}

/** Whether the expression grammar reads `text` with `refs`. */
function readable(text: string, refs: Json = {}): boolean {
  try {
    compileExpression({ text, grammar: GRAMMAR, refs: refs as Record<string, ExprRef> });
    return true;
  } catch {
    return false;
  }
}

export class Parameters {
  readonly tables: Json[] = [];
  /** Parameters left out of the tables, and why. */
  readonly notes: ImportNote[] = [];
  /** `Sheet.alias` and `<<Label>>.alias` as a parameter. */
  private readonly known = new Map<string, Parameter>();
  private readonly engines = new Map<string, Map<string, string>>();
  private readonly bound: Bound[] = [];
  /** Values by `Object.Path` and `<<Label>>.Path`, for the expressions that read them. */
  private readonly values = new Map<string, { value: Json; scope: ValueScope; suggest: string }>();
  /** How many expressions were bound, and how many stayed the number FreeCAD computed. */
  carried = 0;
  dropped = 0;

  constructor(
    private readonly w: Writer,
    doc: FcDocument,
  ) {
    for (const o of doc.objects) {
      if (o.type === 'Spreadsheet::Sheet') this.sheet(o);
      else if (o.type === 'App::VarSet') this.varSet(o);
    }
  }

  private nameFor(raw: string): string {
    let name = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_');
    for (let i = 2; RESERVED_WORDS.has(name) || this.w.valueNames.has(name); i++)
      name = `${raw.replace(/[^A-Za-z0-9_]/g, '_')}_${i}`;
    this.w.valueNames.add(name);
    return name;
  }

  private row(p: Parameter, text: string, refs: Json = {}): Json {
    const quantity = p.quantity;
    return {
      id: p.id,
      name: p.name,
      type: 'number',
      quantity,
      value: { id: this.w.ids('val'), def: { expr: { text, grammar: GRAMMAR, refs } } },
      range: { unbounded: {} },
      public: false,
      published: false,
      description: '',
    };
  }

  private remember(o: FcObject, key: string, p: Parameter): void {
    this.known.set(`${o.name}.${key}`, p);
    this.known.set(`<<${o.label}>>.${key}`, p);
  }

  private sheet(o: FcObject): void {
    const cells = o.props.get('cells');
    const list = cells && findChild(cells, 'Cells');
    const aliased = (list ? findChildren(list, 'Cell') : []).filter((c) => c.attrs.alias && c.attrs.content);
    const local = new Map<string, Parameter>();
    const plain: { p: Parameter; text: string }[] = [];
    const formulas: { alias: string; text: string }[] = [];
    for (const c of aliased) {
      const content = (c.attrs.content as string).replace(/^=/, '');
      const quantity = quantityOf(content);
      if (quantity && !readable(content.trim())) {
        this.leftOut(o, `its ${c.attrs.alias as string} is not a number here, so it was left out`);
      } else if (quantity) {
        const p: Parameter = { id: this.w.ids('par'), name: this.nameFor(c.attrs.alias as string), quantity };
        plain.push({ p, text: content.trim() });
        local.set(c.attrs.alias as string, p);
      } else formulas.push({ alias: c.attrs.alias as string, text: content });
    }
    const rows = plain.map(({ p, text }) => this.row(p, text));
    // Formulas of the sheet's own aliases, as far as their inputs are known.
    const unreadable = new Set<string>();
    for (let again = true; again;) {
      again = false;
      for (const f of formulas) {
        if (local.has(f.alias) || unreadable.has(f.alias)) continue;
        const words = [...f.text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
        if (!words.every((x) => local.has(x) || KNOWN.has(x))) continue;
        const refs: Json = {};
        let unit: Quantity = 'ratio';
        const text = f.text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
          const p = local.get(word);
          if (!p) return word;
          refs[p.name] = { parameter: { id: p.id } };
          if (p.quantity !== 'ratio') unit = p.quantity;
          return p.name;
        });
        if (!readable(text, refs)) {
          unreadable.add(f.alias);
          this.leftOut(o, `its ${f.alias} is not an expression read here, so it was left out`);
          continue;
        }
        const p: Parameter = { id: this.w.ids('par'), name: this.nameFor(f.alias), quantity: unit };
        rows.push(this.row(p, text, refs));
        local.set(f.alias, p);
        again = true;
      }
    }
    if (rows.length === 0) return;
    for (const [alias, p] of local) this.remember(o, alias, p);
    this.tables.push({ id: this.w.ids('tbl'), name: o.label, parameters: rows });
  }

  private varSet(o: FcObject): void {
    const rows: Json[] = [];
    for (const [name, prop] of o.props) {
      const type = prop.attrs.type ?? '';
      const quantity: Quantity | undefined = /PropertyLength|PropertyDistance/.test(type)
        ? 'length'
        : /PropertyAngle/.test(type)
          ? 'angle'
          : /PropertyFloat$|PropertyInteger$/.test(type)
            ? 'ratio'
            : undefined;
      if (!quantity || name === 'Label') continue;
      const raw = prop.children[0]?.attrs.value;
      if (raw === undefined) continue;
      const text = quantity === 'length' ? `${raw} mm` : quantity === 'angle' ? `${raw} deg` : raw;
      if (raw.trim() === '' || !Number.isFinite(Number(raw)) || !readable(text)) {
        this.leftOut(o, `its ${name} is not a number, so it was left out`);
        continue;
      }
      const p: Parameter = { id: this.w.ids('par'), name: this.nameFor(name), quantity };
      rows.push(this.row(p, text));
      this.remember(o, name, p);
    }
    if (rows.length > 0) this.tables.push({ id: this.w.ids('tbl'), name: o.label, parameters: rows });
  }

  private leftOut(o: FcObject, message: string): void {
    this.notes.push({ severity: 'info', object: o.label, message });
  }

  /** The object's expressions by the path they drive. */
  private engine(o: FcObject): Map<string, string> {
    const had = this.engines.get(o.name);
    if (had) return had;
    const map = new Map<string, string>();
    const prop = o.props.get('ExpressionEngine');
    const list = prop && findChild(prop, 'ExpressionEngine');
    for (const e of list ? findChildren(list, 'Expression') : []) {
      if (e.attrs.path && e.attrs.expression) map.set(e.attrs.path.replace(/^\./, ''), e.attrs.expression);
    }
    this.engines.set(o.name, map);
    return map;
  }

  /** Whether an expression drives `path` of `o`. */
  drives(o: FcObject, path: string): boolean {
    return this.engine(o).has(path);
  }

  /** FreeCAD's expression in this document's terms, or undefined when it reads what is not a parameter. */
  private translate(text: string, scope: ValueScope): { text: string; refs: Json } | undefined {
    const refs: Json = {};
    let ok = true;
    const swapped = text.replace(REFERENCE, (whole, object: string, key: string) => {
      const p = this.known.get(`${object}.${key}`);
      if (p) {
        refs[p.name] = { parameter: { id: p.id } };
        return p.name;
      }
      const v = this.values.get(`${object}.${key}`);
      // A value is read only by what comes after it in its own part.
      if (!v || v.scope.part !== scope.part || v.scope.order > scope.order) {
        ok = false;
        return whole;
      }
      v.value.name ??= this.nameFor(v.suggest);
      const name = v.value.name as string;
      refs[name] = { value: { id: v.value.id } };
      return name;
    });
    if (!ok || Object.keys(refs).length === 0) return undefined;
    const left = swapped.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => (word in refs || KNOWN.has(word) ? '' : word));
    if (!/^[\s\d.eE+\-*/^()%,]*$/.test(left)) return undefined;
    return { text: swapped, refs };
  }

  /**
   * The value object of a property: the expression FreeCAD binds to `path` of
   * `o` when it reads parameters, else the literal. `number` is what FreeCAD
   * computed, in mm or degrees.
   */
  value(
    o: FcObject,
    path: string,
    literal: string,
    number: number,
    quantity: Quantity,
    scope: ValueScope,
    name?: string,
    alias?: string,
  ): Json {
    const expression = this.engine(o).get(path);
    const value = this.w.val(literal, name);
    const suggest = `${o.name}_${(alias ?? path).replace(/^Constraints\./, '').replace(/[^A-Za-z0-9_]/g, '_')}`;
    for (const key of [path, ...(alias ? [alias] : [])]) {
      this.values.set(`${o.name}.${key}`, { value, scope, suggest });
      this.values.set(`<<${o.label}>>.${key}`, { value, scope, suggest });
    }
    if (expression) this.bound.push({ value, expression, scope, quantity, number, literal });
    return value;
  }

  /**
   * Checks every bound value once the document is whole. FreeCAD lets a plain
   * number drive a length, which a quantity here does not; such a value gets
   * its unit, and one that still differs goes back to its literal.
   */
  settle(document: Json): void {
    const named: Bound[] = [];
    for (const b of this.bound) {
      const translated = this.translate(b.expression, b.scope);
      if (!translated) {
        this.dropped++;
        continue;
      }
      (b.value.def as Json).expr = { text: translated.text, grammar: GRAMMAR, refs: translated.refs };
      named.push(b);
    }
    this.bound.length = 0;
    this.bound.push(...named);
    const targetOf = (b: Bound) => ({ type: 'number', quantity: b.quantity }) as const;
    const failing = (): Bound[] => {
      const values = new ValueEvaluator(document);
      return this.bound.filter((b) => {
        try {
          return Math.abs(values.number(b.value, targetOf(b)) - b.number) > 1e-6 * Math.max(1, Math.abs(b.number));
        } catch {
          return true;
        }
      });
    };
    for (const b of failing()) {
      const expr = (b.value.def as Json).expr as Json;
      if (b.quantity !== 'ratio') expr.text = `(${String(expr.text)}) * 1 ${b.quantity === 'length' ? 'mm' : 'deg'}`;
    }
    const bad = new Set(failing());
    for (const b of bad) (b.value.def as Json).expr = { text: b.literal, grammar: GRAMMAR, refs: {} };
    this.carried = this.bound.length - bad.size;
    this.dropped += bad.size;
    // A document the reader would not take is worth less than its expressions.
    if (readDocument(document).refused) {
      for (const b of this.bound) (b.value.def as Json).expr = { text: b.literal, grammar: GRAMMAR, refs: {} };
      this.dropped += this.carried;
      this.carried = 0;
    }
  }
}

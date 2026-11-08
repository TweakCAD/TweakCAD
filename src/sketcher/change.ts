/**
 * One sketch edit as the session builds it before solving: the rows it adds,
 * removes and updates, and which of its constraints it may drop. A tool fills
 * a `Draft`; the session solves the result and turns it into one
 * `editSketch` command.
 */
import { isPlainObject } from '@tweakcad/format';
import type { EditorCommand } from '@tweakcad/editor';
import type { Snap } from './snap';
import {
  namedIds,
  pointOperand,
  curveOperand,
  standardOperand,
  table,
  type Json,
  type P2,
  type RowMaker,
} from './rows';

export interface RowUpdate {
  id: string;
  set?: Json;
  unset?: string[];
}

export interface Change {
  /** The undo label. */
  label: string;
  add?: { points?: Json[]; curves?: Json[]; constraints?: Json[]; text?: Json[] };
  /** Commands run first, in the same undo step: a library entry the new text's font needs. */
  before?: EditorCommand[];
  /** Name-table entries the new rows' references use. */
  names?: Json;
  /** Points made one (8.1): every row naming `from` names `into`, and `from` goes. Merges come first. */
  merge?: { from: string; into: string }[];
  remove?: string[];
  /** Curves moved to `retired` (8): `split` for one that trimming replaced by pieces made from it. */
  retire?: { id: string; fate: 'split' | 'deleted' }[];
  update?: RowUpdate[];
  /** New definitions of values the document has, by value id, for the solve. */
  overrides?: ReadonlyMap<string, Json>;
  /**
   * Constraints the edit may leave out when they over-constrain the sketch:
   * the ones snapping and inference wrote. Every other new constraint that
   * over-constrains refuses the edit.
   */
  optional?: ReadonlySet<string>;
}

/** The inputs after `change`, as `editSketch` leaves them, for solving and drawing. */
export function applyLocally(given: Json, change: Change): Json {
  const inputs =
    change.merge && change.merge.length > 0 ? merged(given, new Map(change.merge.map((m) => [m.from, m.into]))) : given;
  const retiring = new Map((change.retire ?? []).map((r) => [r.id, r.fate]));
  const removed = new Set([...(change.remove ?? []), ...retiring.keys()]);
  const geometry = new Set(
    [...(change.remove ?? [])].filter(
      (id) => table(inputs, 'points').some((p) => p.id === id) || table(inputs, 'curves').some((c) => c.id === id),
    ),
  );
  const keep = (row: Json) => !removed.has(row.id as string);
  const constraints = table(inputs, 'constraints').filter(
    (c) => keep(c) && ![...namedIds(c)].some((id) => geometry.has(id)),
  );
  const updates = new Map<string, RowUpdate[]>();
  for (const u of change.update ?? []) updates.set(u.id, [...(updates.get(u.id) ?? []), u]);
  const edit = (row: Json): Json => {
    const list = updates.get(row.id as string);
    if (!list) return row;
    const next: Json = { ...row };
    for (const u of list) {
      Object.assign(next, u.set ?? {});
      for (const key of u.unset ?? []) Reflect.deleteProperty(next, key);
    }
    return next;
  };
  const retired = [...table(inputs, 'retired')];
  for (const c of table(inputs, 'curves')) {
    const fate = retiring.get(c.id as string);
    if (!fate) continue;
    const { id, ...was } = c;
    retired.push({ id, was: { curve: was }, fate: { [fate]: {} } });
  }
  return {
    ...inputs,
    retired,
    points: [...table(inputs, 'points').filter(keep), ...(change.add?.points ?? [])].map(edit),
    curves: [...table(inputs, 'curves').filter(keep), ...(change.add?.curves ?? [])].map(edit),
    constraints: [...constraints, ...(change.add?.constraints ?? [])].map(edit),
    text: [...table(inputs, 'text').filter(keep), ...(change.add?.text ?? [])].map(edit),
  };
}

/** Every string under `value` that `ids` maps, replaced. */
function replaced(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaced(v, ids));
  if (!isPlainObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === 'extensions' ? v : replaced(v, ids);
  return out;
}

/** The inputs with points merged, as `editSketch` merges them. */
function merged(inputs: Json, merges: ReadonlyMap<string, string>): Json {
  const out: Json = { ...inputs, points: table(inputs, 'points').filter((p) => !merges.has(p.id as string)) };
  for (const name of ['curves', 'constraints', 'text', 'regions', 'retired'])
    out[name] = replaced(table(inputs, name), merges);
  return out;
}

/** The change without some of its new constraints. */
export function withoutConstraints(change: Change, drop: ReadonlySet<string>): Change {
  const constraints = (change.add?.constraints ?? []).filter((c) => !drop.has(c.id as string));
  return { ...change, add: { ...change.add, constraints } };
}

/** Rows a tool adds, with the points its snaps stand for. */
export class Draft {
  readonly points: Json[] = [];
  readonly curves: Json[] = [];
  readonly constraints: Json[] = [];
  readonly optional = new Set<string>();

  constructor(readonly make: RowMaker) {}

  point(at: P2): string {
    const p = this.make.point(at[0], at[1]);
    this.points.push(p);
    return p.id as string;
  }

  constrain(kind: string, fields: Json, optional: boolean): Json {
    const c = this.make.geometric(kind, fields);
    this.constraints.push(c);
    if (optional) this.optional.add(c.id as string);
    return c;
  }

  /** The point a snap stands for, with the constraint it writes. */
  place(snap: Snap): string {
    switch (snap.kind) {
      case 'point':
        return snap.id;
      case 'origin': {
        // At the origin: horizontal and vertical against it, as the origin is no sketch point.
        const id = this.point([0, 0]);
        for (const kind of ['horizontal', 'vertical']) {
          this.constrain(kind, { of: { points: { a: standardOperand('origin'), b: pointOperand(id) } } }, true);
        }
        return id;
      }
      case 'midpoint': {
        const id = this.point(snap.at);
        this.constrain('midpoint', { point: pointOperand(id), curve: curveOperand(snap.curve) }, true);
        return id;
      }
      case 'axisX':
      case 'axisY': {
        const id = this.point(snap.at);
        this.constrain(
          'pointOnCurve',
          { point: pointOperand(id), curve: standardOperand(snap.kind === 'axisX' ? 'x' : 'y') },
          true,
        );
        return id;
      }
      default:
        return this.point(snap.at);
    }
  }

  change(label: string): Change {
    return {
      label,
      add: { points: this.points, curves: this.curves, constraints: this.constraints },
      optional: this.optional,
    };
  }
}

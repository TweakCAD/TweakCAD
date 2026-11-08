import {
  ExprError,
  isContentHash,
  isPlainObject,
  nameHash,
  renameInExpression,
  type ExpressionJson,
} from '@tweakcad/format';
import { CommandError } from '../errors';
import type { IdGenerator } from '../ids';
import {
  arrayAt,
  eachObject,
  findRow,
  insertionIndex,
  objectAt,
  type Doc,
  type Json,
  type Path,
  type RowAt,
} from '../rows';
import type { CommandOf, CommandType } from './types';

/** What a command runs against: the document before it, and the draft it edits. */
export interface RunContext {
  readonly doc: Doc;
  readonly draft: Doc;
  /** New ids for rows the command makes itself; recorded in its log entry. */
  readonly newId: IdGenerator;
}

export interface Handler<T extends CommandType> {
  /** The short label the undo menu shows. */
  label(command: CommandOf<T>, doc: Doc): string;
  run(command: CommandOf<T>, ctx: RunContext): void;
}

export type Handlers<T extends CommandType> = { [K in T]: Handler<K> };

export const FEATURE_TABLES = ['timeline', 'children'] as const;

export function featureAt(doc: Doc, id: string): RowAt {
  return findRow(doc, id, 'feature', FEATURE_TABLES);
}

/** A row's `name`, for labels. */
export function nameOf(row: Json | undefined, fallback: string): string {
  return row && typeof row.name === 'string' && row.name !== '' ? row.name : fallback;
}

/** A row's name by id, for labels; the fallback when it is not found. */
export function rowName(doc: Doc, id: string, fallback: string): string {
  try {
    return nameOf(findRow(doc, id, fallback).row, fallback);
  } catch {
    return fallback;
  }
}

export function requireRow(value: unknown, kind: string, what: string): Json {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !value.id.startsWith(`${kind}_`)) {
    throw new CommandError('bad-argument', `a ${what} is an object with a ${kind}_ id`);
  }
  return value;
}

/** Inserts a row into the array at `table`. */
export function insertRow(ctx: RunContext, table: Path, row: Json, before: string | undefined, what: string): void {
  const rows = arrayAt(ctx.draft, table);
  rows.splice(insertionIndex(rows, before, what), 0, row);
}

export function removeRow(ctx: RunContext, at: RowAt): void {
  arrayAt(ctx.draft, at.table).splice(at.index, 1);
}

/** A literal definition: an expression with no names. */
export function literalDef(text: string): Json {
  return { expr: { text, grammar: 1, refs: {} } };
}

/**
 * Merges name-table entries a reference brings (9.8). Each entry must hash
 * to its key; an entry already present is the same object, by its hash.
 */
export function mergeNames(ctx: RunContext, names: Json | undefined): void {
  if (names === undefined) return;
  if (!isPlainObject(names)) throw new CommandError('bad-argument', 'names is a map from name hash to name object');
  const table = objectAt(ctx.draft, ['names']);
  for (const [hash, entry] of Object.entries(names)) {
    if (nameHash(entry) !== hash) throw new CommandError('bad-argument', `name entry ${hash} does not hash to its key`);
    if (!(hash in table)) table[hash] = entry;
  }
}

/**
 * Adds asset rows (13.1) keyed by content hash. A row already present under
 * the same key keeps its bytes; it must describe the same file.
 */
export function mergeAssets(ctx: RunContext, assets: Json | undefined): void {
  if (assets === undefined) return;
  if (!isPlainObject(assets)) throw new CommandError('bad-argument', 'assets is a map from content hash to asset row');
  const table = objectAt(ctx.draft, ['assets']);
  for (const [hash, row] of Object.entries(assets)) {
    if (!isContentHash(hash)) throw new CommandError('bad-argument', `${hash} is not a content hash`);
    if (!isPlainObject(row)) throw new CommandError('bad-argument', `asset ${hash} is not an asset row`);
    const known = table[hash];
    if (isPlainObject(known)) {
      if (known.size !== row.size)
        throw new CommandError('bad-argument', `asset ${hash} is already a file of another size`);
      continue;
    }
    table[hash] = row;
  }
}

/** An expression's refs target, as `{parameter: {id}}` or `{value: {id}}`. */
export type RefTarget = { parameter: { id: string } } | { value: { id: string } };

function sameTarget(ref: unknown, target: RefTarget): boolean {
  if (!isPlainObject(ref)) return false;
  if ('parameter' in target)
    return isPlainObject(ref.parameter) && ref.parameter.id === target.parameter.id && Object.keys(ref).length === 1;
  return isPlainObject(ref.value) && ref.value.id === target.value.id && Object.keys(ref).length === 1;
}

/** Every definition (a value's `def`, an override's `def`) whose expression names `target`, with the names it uses. */
export function usesOf(doc: Doc, target: RefTarget): { path: Path; names: string[] }[] {
  const out: { path: Path; names: string[] }[] = [];
  eachObject(doc, (o, path) => {
    const expr = o.expr;
    if (!isPlainObject(expr) || !isPlainObject(expr.refs) || typeof expr.text !== 'string') return;
    const names = Object.entries(expr.refs)
      .filter(([, ref]) => sameTarget(ref, target))
      .map(([name]) => name);
    if (names.length > 0) out.push({ path, names });
  });
  return out;
}

/**
 * Renaming rewrites every expression that names the target by its old name
 * and re-keys its `refs` entry, keeping the target (6.3).
 */
export function renameUses(ctx: RunContext, target: RefTarget, from: string, to: string): void {
  if (from === to) return;
  for (const use of usesOf(ctx.doc, target)) {
    if (!use.names.includes(from)) continue;
    const holder = objectAt(ctx.draft, use.path);
    try {
      holder.expr = renameInExpression(
        objectAt(ctx.doc, use.path).expr as unknown as ExpressionJson,
        from,
        to,
      ) as unknown as Json;
    } catch (e) {
      if (e instanceof ExprError) {
        throw new CommandError('not-allowed', `cannot rename ${from} to ${to} at /${use.path.join('/')}: ${e.message}`);
      }
      throw e;
    }
  }
}

/** Every path in the document that holds `{"<key>": {"id": id}}`, such as a must-exist id wrapper. */
export function wrappersOf(doc: Doc, key: string, id: string): Path[] {
  const out: Path[] = [];
  eachObject(doc, (o, path) => {
    const inner = o[key];
    if (Object.keys(o).length === 1 && isPlainObject(inner) && inner.id === id) out.push(path);
  });
  return out;
}

/** Ids of every value object under a JSON subtree. */
export function valueIdsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => valueIdsIn(v, out));
  else if (isPlainObject(value)) {
    if (typeof value.id === 'string' && value.id.startsWith('val_') && 'def' in value) out.push(value.id);
    for (const [k, v] of Object.entries(value)) if (k !== 'extensions') valueIdsIn(v, out);
  }
  return out;
}

/** Ids of every row (array member with an id) under a JSON subtree, the subtree itself included. */
export function rowIdsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isPlainObject(item) && typeof item.id === 'string') out.add(item.id);
      rowIdsIn(item, out);
    }
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) if (k !== 'extensions') rowIdsIn(v, out);
  }
  return out;
}

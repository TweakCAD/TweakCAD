import { isPlainObject } from '@tweakcad/format';
import { CommandError } from './errors';

export type Json = Record<string, unknown>;
/** A version-2 document as plain JSON. */
export type Doc = Json;
export type Path = readonly (string | number)[];

/** Top-level fields whose ids are not this document's rows: embedded documents keep their own scope. */
const OUTSIDE = new Set(['library', 'names', 'assets']);

const indexes = new WeakMap<object, Map<string, Path>>();

/**
 * Every id this document defines, with where: table rows (array members
 * with an `id`) and value objects (an object with a `val_` id and a
 * `def`). Embedded library documents, the name table and the assets are
 * left out. Cached per document object, which the store never mutates.
 */
export function idIndex(doc: Doc): Map<string, Path> {
  const cached = indexes.get(doc);
  if (cached) return cached;
  const out = new Map<string, Path>();
  const walk = (value: unknown, path: (string | number)[], inArray: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...path, i], true));
      return;
    }
    if (!isPlainObject(value)) return;
    const id = value.id;
    if (typeof id === 'string' && !out.has(id) && (inArray || (id.startsWith('val_') && 'def' in value))) {
      out.set(id, path);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'extensions' || (path.length === 0 && OUTSIDE.has(key))) continue;
      walk(item, [...path, key], false);
    }
  };
  walk(doc, [], false);
  if (Object.isFrozen(doc)) indexes.set(doc, out);
  return out;
}

export function getAt(root: unknown, path: Path): unknown {
  let at = root;
  for (const step of path) {
    if (Array.isArray(at) && typeof step === 'number') at = at[step];
    else if (isPlainObject(at) && typeof step === 'string') at = at[step];
    else return undefined;
  }
  return at;
}

export function objectAt(root: unknown, path: Path): Json {
  const at = getAt(root, path);
  if (!isPlainObject(at)) throw new Error(`no object at /${path.join('/')}`);
  return at;
}

export function arrayAt(root: unknown, path: Path): unknown[] {
  const at = getAt(root, path);
  if (!Array.isArray(at)) throw new Error(`no array at /${path.join('/')}`);
  return at;
}

/** The kind of an id (`feat` for `feat_…`). */
export function kindOf(id: string): string {
  return id.slice(0, Math.max(0, id.indexOf('_')));
}

/** A located row: its path, the table holding it and its position there. */
export interface RowAt {
  id: string;
  path: Path;
  /** Path of the array holding the row. */
  table: Path;
  /** The field name of that array (`timeline`, `points`, `instances`). */
  field: string;
  index: number;
  row: Json;
}

/** Finds a table row by id; throws `not-found` when there is none of the expected kind. */
export function findRow(doc: Doc, id: string, what: string, fields?: readonly string[]): RowAt {
  const path = idIndex(doc).get(id);
  const index = path?.[path.length - 1];
  const field = path?.[path.length - 2];
  if (!path || typeof index !== 'number' || typeof field !== 'string' || (fields && !fields.includes(field))) {
    throw new CommandError('not-found', `no ${what} ${id}`);
  }
  return { id, path, table: path.slice(0, -1), field, index, row: objectAt(doc, path) };
}

/** The owner of a path: the document, or the part or assembly it lies in. */
export function ownerOf(doc: Doc, path: Path): { id: string; path: Path } {
  if ((path[0] === 'parts' || path[0] === 'assemblies') && typeof path[1] === 'number') {
    const owner = objectAt(doc, path.slice(0, 2));
    return { id: owner.id as string, path: path.slice(0, 2) };
  }
  return { id: doc.id as string, path: [] };
}

/** The document, a part or an assembly by id: the rows that own tables, configurations and properties. */
export function findOwner(doc: Doc, id: string, kinds: readonly ('doc' | 'part' | 'asm')[]): Path {
  if (kinds.includes('doc') && id === doc.id) return [];
  const kind = kindOf(id);
  if ((kind === 'part' && kinds.includes('part')) || (kind === 'asm' && kinds.includes('asm'))) {
    return findRow(doc, id, kind === 'part' ? 'part' : 'assembly', [kind === 'part' ? 'parts' : 'assemblies']).path;
  }
  throw new CommandError(
    'not-found',
    `no ${kinds.map((k) => (k === 'asm' ? 'assembly' : k === 'doc' ? 'document' : k)).join(' or ')} ${id}`,
  );
}

/** Where to insert into an array: before the row with id `before`, or at the end. */
export function insertionIndex(table: readonly unknown[], before: string | undefined, what: string): number {
  if (before === undefined) return table.length;
  const index = table.findIndex((row) => isPlainObject(row) && row.id === before);
  if (index < 0) throw new CommandError('not-found', `no ${what} ${before} to insert before`);
  return index;
}

/**
 * Visits every object in a document outside the library, the name table and
 * the assets, with its path.
 */
export function eachObject(doc: Doc, visit: (value: Json, path: Path) => void): void {
  const walk = (value: unknown, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, [...path, i]));
      return;
    }
    if (!isPlainObject(value)) return;
    visit(value, path);
    for (const [key, item] of Object.entries(value)) {
      if (key === 'extensions' || (path.length === 0 && OUTSIDE.has(key))) continue;
      walk(item, [...path, key]);
    }
  };
  walk(doc, []);
}

/** Shallow-merges fields into a row, keeping its other keys and extensions (chapter 18). */
export function mergeFields(
  row: Json,
  set: Json | undefined,
  unset: readonly string[] | undefined,
  keep: readonly string[] = ['id'],
): void {
  for (const key of keep) {
    if (set && key in set && set[key] !== row[key])
      throw new CommandError('bad-argument', `"${key}" cannot be changed`);
    if (unset?.includes(key)) throw new CommandError('bad-argument', `"${key}" cannot be removed`);
  }
  for (const [key, value] of Object.entries(set ?? {})) {
    if (value === undefined || value === null)
      throw new CommandError('bad-argument', `"${key}" has no value; list it in unset to remove it`);
    row[key] = value;
  }
  for (const key of unset ?? []) Reflect.deleteProperty(row, key);
}

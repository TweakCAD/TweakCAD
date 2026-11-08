import { canonicalBytes, type JsonValue } from './canonical';

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/** Byte-wise comparison of two UTF-8 serializations. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortedByCanonical<T>(items: readonly T[], key: (item: T) => unknown): T[] {
  return items
    .map((item) => ({ item, bytes: canonicalBytes(key(item)) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes))
    .map((entry) => entry.item);
}

export interface JsonSet<T = JsonValue> {
  set: T[];
}

/** Builds a set: members sorted by their canonical UTF-8 bytes; duplicates are an error. */
export function makeSet<T>(members: readonly T[]): JsonSet<T> {
  const encoded = members
    .map((item) => ({ item, bytes: canonicalBytes(item) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes));
  encoded.forEach((entry, i) => {
    const previous = encoded[i - 1];
    if (previous && compareBytes(previous.bytes, entry.bytes) === 0) {
      throw new FormatError('set has a duplicate member');
    }
  });
  return { set: encoded.map((entry) => entry.item) };
}

/** Reads a set, requiring the exact shape, strict order and no duplicates. */
export function readSet(value: unknown): unknown[] {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !Array.isArray(value.set)) {
    throw new FormatError('a set must be {"set": [...]}');
  }
  const members = value.set;
  let previous: Uint8Array | null = null;
  for (const member of members) {
    const bytes = canonicalBytes(member);
    if (previous !== null) {
      const order = compareBytes(previous, bytes);
      if (order === 0) throw new FormatError('set has a duplicate member');
      if (order > 0) throw new FormatError('set members are not in canonical order');
    }
    previous = bytes;
  }
  return members;
}

export interface CountedItem<T = JsonValue> {
  item: T;
  count: number;
}

/** Builds a counted set from items that may repeat. */
export function makeCountedSet<T>(items: readonly T[]): JsonSet<CountedItem<T>> {
  const groups: CountedItem<T>[] = [];
  const sorted = items
    .map((item) => ({ item, bytes: canonicalBytes(item) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes));
  let previous: Uint8Array | null = null;
  let last: CountedItem<T> | undefined;
  for (const entry of sorted) {
    if (last && previous !== null && compareBytes(previous, entry.bytes) === 0) {
      last.count++;
    } else {
      last = { item: entry.item, count: 1 };
      groups.push(last);
    }
    previous = entry.bytes;
  }
  return { set: groups };
}

/** Reads a counted set: entries `{item, count}`, items unique and sorted, counts integers ≥ 1. */
export function readCountedSet(value: unknown): CountedItem<unknown>[] {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !Array.isArray(value.set)) {
    throw new FormatError('a counted set must be {"set": [...]}');
  }
  const entries: CountedItem<unknown>[] = [];
  let previous: Uint8Array | null = null;
  for (const entry of value.set) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 2 || !('item' in entry)) {
      throw new FormatError('a counted set entry must be {"item", "count"}');
    }
    const { count } = entry;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      throw new FormatError('a counted set count must be an integer of at least 1');
    }
    const bytes = canonicalBytes(entry.item);
    if (previous !== null) {
      const order = compareBytes(previous, bytes);
      if (order === 0) throw new FormatError('counted set has a duplicate item');
      if (order > 0) throw new FormatError('counted set items are not in canonical order');
    }
    previous = bytes;
    entries.push({ item: entry.item, count });
  }
  return entries;
}

/** Re-sorts arbitrary members into canonical set order without the duplicate check. */
export function canonicalOrder<T>(members: readonly T[]): T[] {
  return sortedByCanonical(members, (m) => m);
}

export interface Tagged {
  tag: string;
  payload: Record<string, unknown>;
}

/** Reads a tagged union: exactly one key, whose value is an object. */
export function readUnion(value: unknown, allowed?: readonly string[]): Tagged {
  if (!isPlainObject(value)) throw new FormatError('a tagged union must be an object');
  const keys = Object.keys(value);
  const tag = keys[0];
  if (keys.length !== 1 || tag === undefined) {
    throw new FormatError(`a tagged union must have exactly one key, found ${keys.length}`);
  }
  if (allowed && !allowed.includes(tag)) throw new FormatError(`unknown variant "${tag}"`);
  const payload = value[tag];
  if (!isPlainObject(payload)) throw new FormatError(`variant "${tag}" must hold an object`);
  return { tag, payload };
}

/** Checks that a table is an array of objects with unique `id` fields; returns the ids. */
export function readTableIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new FormatError('a table must be an array');
  const seen = new Set<string>();
  for (const row of value) {
    if (!isPlainObject(row) || typeof row.id !== 'string') {
      throw new FormatError('every table row must be an object with a string id');
    }
    if (seen.has(row.id)) throw new FormatError(`duplicate row id ${row.id}`);
    seen.add(row.id);
  }
  return [...seen];
}

/** An integer as the format allows it: integral and within ±2⁵³. */
export function isFormatInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2 ** 53;
}

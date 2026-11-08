import { isPlainObject } from '@tweakcad/format';
import { CommandError } from './errors';

/**
 * RFC 6901 pointers under a feature's inputs, with the format's rule for
 * steps into arrays (7.3): a step into a table (an array whose members are
 * rows with an `id`) is the row's id, never a position; a step into any
 * other array is a position. `-` as the last step names the end of an
 * array, for appending.
 */

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!/^(\/([^~/]|~[01])*)+$/.test(pointer)) {
    throw new CommandError('bad-argument', `"${pointer}" is not a JSON pointer`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => `/${t.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** A table: every member is an object with a string `id`. An empty array counts as both. */
export function isTable(value: readonly unknown[]): boolean {
  return value.every((item) => isPlainObject(item) && typeof item.id === 'string');
}

/** The index a step names in an array, or -1 for the end (`-`); throws when it names nothing. */
export function arrayStep(array: readonly unknown[], token: string, pointer: string, allowEnd: boolean): number {
  if (token === '-') {
    if (allowEnd) return -1;
    throw new CommandError('bad-argument', `"-" in ${pointer} names no member`);
  }
  if (array.length > 0 && isTable(array)) {
    const index = array.findIndex((row) => (row as { id: string }).id === token);
    if (index < 0) throw new CommandError('not-found', `no row ${token} at ${pointer}`);
    return index;
  }
  if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= array.length) {
    throw new CommandError('not-found', `no position ${token} at ${pointer}`);
  }
  return Number(token);
}

/** Walks all but the last step; returns the container the last step is in. */
export function parentAt(root: unknown, tokens: readonly string[], pointer: string): unknown {
  let at = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(at)) at = at[arrayStep(at, token, pointer, false)];
    else if (isPlainObject(at) && Object.prototype.hasOwnProperty.call(at, token)) at = at[token];
    else throw new CommandError('not-found', `${pointer} does not resolve`);
  }
  return at;
}

/** The value a pointer names; throws when it does not resolve. */
export function valueAt(root: unknown, tokens: readonly string[], pointer: string): unknown {
  if (tokens.length === 0) return root;
  const parent = parentAt(root, tokens, pointer);
  const last = tokens[tokens.length - 1] as string;
  if (Array.isArray(parent)) return parent[arrayStep(parent, last, pointer, false)];
  if (isPlainObject(parent) && Object.prototype.hasOwnProperty.call(parent, last)) return parent[last];
  throw new CommandError('not-found', `${pointer} does not resolve`);
}

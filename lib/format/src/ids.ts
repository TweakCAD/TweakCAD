import { base32Encode } from './base32';
import { isNameHash } from './hash';

/**
 * Id kinds in use. A kind is a label for readers; ids of other kinds are still
 * well-formed (new kinds are additions).
 */
export const ID_KINDS = [
  'doc',
  'part',
  'asm',
  'feat',
  'cmd',
  'pt',
  'crv',
  'con',
  'reg',
  'txt',
  'tbl',
  'par',
  'val',
  'inst',
  'jor',
  'jnt',
  'rel',
  'grp',
  'set',
  'fld',
  'attr',
  'view',
  'note',
  'pos',
  'exp',
  'cfg',
  'ctx',
  'sec',
  'hp',
  'lib',
  'stp',
] as const;

export type IdKind = (typeof ID_KINDS)[number];

/** Source of the 16 random bytes behind an id. */
export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const KIND = /^[a-z]+$/;

/** A new global id `<kind>_<26 characters>` from 128 random bits. */
export function newId(kind: string, random: RandomBytes = cryptoRandomBytes): string {
  if (!KIND.test(kind)) throw new Error(`invalid id kind "${kind}"`);
  const bytes = random(16);
  if (bytes.length !== 16) throw new Error('id source must supply 16 bytes');
  return `${kind}_${base32Encode(bytes)}`;
}

/** Splits a well-formed id into kind and body; null when malformed. */
export function parseId(text: unknown): { kind: string; body: string } | null {
  if (typeof text !== 'string') return null;
  const sep = text.indexOf('_');
  if (sep <= 0) return null;
  const kind = text.slice(0, sep);
  const body = text.slice(sep + 1);
  if (!KIND.test(kind) || !isNameHash(body)) return null;
  return { kind, body };
}

/** True when `text` is a well-formed id, of `kind` when given. */
export function isId(text: unknown, kind?: string): text is string {
  const parsed = parseId(text);
  return parsed !== null && (kind === undefined || parsed.kind === kind);
}

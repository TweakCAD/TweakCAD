import { base32Decode, base32Encode } from './base32';
import { canonicalBytes } from './canonical';
import { sha256, toHex } from './sha256';

/** Length of a name hash: 16 bytes in unpadded base32. */
export const NAME_HASH_LENGTH = 26;

/** Content hash of an asset: SHA-256 of its bytes, 64 lower-case hex digits. */
export function contentHash(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

/** Name hash of a JSON value: the first 16 bytes of SHA-256 of its canonical form, base32. */
export function nameHash(value: unknown): string {
  return base32Encode(sha256(canonicalBytes(value)).subarray(0, 16));
}

/** Name hashes found well-formed lately: a document holds thousands, read again on every edit. */
const wellFormed = new Set<string>();
const WELL_FORMED_KEPT = 500_000;

/** True when `text` is a well-formed name hash (26 canonical base32 characters). */
export function isNameHash(text: unknown): text is string {
  if (typeof text !== 'string' || text.length !== NAME_HASH_LENGTH) return false;
  if (wellFormed.has(text)) return true;
  const bytes = base32Decode(text);
  if (bytes === null || bytes.length !== 16) return false;
  if (wellFormed.size >= WELL_FORMED_KEPT) wellFormed.clear();
  wellFormed.add(text);
  return true;
}

/** Name hashes of objects hashed lately: a document's name table shares its entries with the one before an edit. */
const hashedEntries = new WeakMap<object, string>();

/** `nameHash` of a value, worked out once per object while it lives; objects must not change once hashed. */
export function nameHashOnce(value: unknown): string {
  if (typeof value !== 'object' || value === null) return nameHash(value);
  let hash = hashedEntries.get(value);
  if (hash === undefined) hashedEntries.set(value, (hash = nameHash(value)));
  return hash;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** True when `text` is a well-formed content hash. */
export function isContentHash(text: unknown): text is string {
  return typeof text === 'string' && HEX64.test(text);
}

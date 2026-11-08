import { cryptoRandomBytes, newId, type RandomBytes } from '@tweakcad/format';

/**
 * Makes a new global id of a kind (spec 2.4): `<kind>_<26 base32 characters>`,
 * 128 random bits, never derived from content, position or time.
 */
export type IdGenerator = (kind: string) => string;

/** Ids from the platform's cryptographic random source. */
export function randomIds(random: RandomBytes = cryptoRandomBytes): IdGenerator {
  return (kind) => newId(kind, random);
}

/**
 * Deterministic ids for tests and replays: the same seed gives the same
 * sequence. The bits come from a seeded xorshift generator, so they are
 * well-formed ids but carry no randomness.
 */
export function seededIds(seed: number): IdGenerator {
  let state = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const random: RandomBytes = (length) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = next() & 0xff;
    return bytes;
  };
  return (kind) => newId(kind, random);
}

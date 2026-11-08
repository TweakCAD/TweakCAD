/**
 * RFC 4648 §6 base32, lower case, without padding. Decoding is strict: only
 * the lower-case alphabet, a length no padded encoding could shorten to, and
 * zero in the last character's unused bits, so every byte string has exactly
 * one encoding.
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Characters left after the final full 8-character group, per trailing byte count. */
const VALID_REMAINDERS = new Set([0, 2, 4, 5, 7]);

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Decodes canonical lower-case unpadded base32; returns null for anything else. */
export function base32Decode(text: string): Uint8Array | null {
  if (!VALID_REMAINDERS.has(text.length % 8)) return null;
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const c of text) {
    const v = VALUE.get(c);
    if (v === undefined) return null;
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (buffer >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  // Unused low bits of the last character must be zero.
  if (buffer !== 0) return null;
  return out;
}

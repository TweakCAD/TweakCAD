import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from './base32';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('base32', () => {
  it('matches the RFC 4648 §10 vectors, lower case without padding', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(ascii(plain))).toBe(encoded);
      expect(base32Decode(encoded)).toEqual(ascii(plain));
    }
  });

  it('round-trips random bytes', () => {
    for (let length = 0; length < 40; length++) {
      const data = new Uint8Array(randomBytes(length));
      expect(base32Decode(base32Encode(data))).toEqual(data);
    }
  });

  it('encodes 16 bytes as 26 characters', () => {
    expect(base32Encode(new Uint8Array(16).fill(0xff))).toBe('77777777777777777777777774');
  });

  it('refuses non-canonical text', () => {
    expect(base32Decode('MY')).toBeNull(); // upper case
    expect(base32Decode('my======')).toBeNull(); // padding
    expect(base32Decode('mz')).toBeNull(); // unused bits set (f is "my")
    expect(base32Decode('m')).toBeNull(); // impossible length
    expect(base32Decode('my1')).toBeNull(); // outside the alphabet
  });
});

import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256, toHex } from './sha256';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('sha256', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(toHex(sha256(ascii('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(toHex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with node:crypto at every padding boundary', () => {
    for (let length = 0; length <= 200; length++) {
      const data = new Uint8Array(randomBytes(length));
      expect(toHex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});

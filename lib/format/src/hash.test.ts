import { describe, expect, it } from 'vitest';
import { contentHash, isContentHash, isNameHash, nameHash } from './hash';

describe('name and content hashes', () => {
  it('hashes the canonical form, so key order does not matter', () => {
    const a = nameHash({ kind: 'face', role: 'side', src: [1, 2] });
    const b = nameHash({ src: [1, 2], role: 'side', kind: 'face' });
    expect(a).toBe(b);
    expect(isNameHash(a)).toBe(true);
    expect(a).toHaveLength(26);
  });

  it('is the first 16 bytes of SHA-256 of the canonical UTF-8, in base32', () => {
    // SHA-256("{}") = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
    expect(nameHash({})).toBe('iqjw7i2vwntyuekgvulpp2dety');
  });

  it('distinguishes values that differ only in type', () => {
    expect(nameHash({ i: 1 })).not.toBe(nameHash({ i: '1' }));
  });

  it('writes content hashes as lower-case hex', () => {
    const hash = contentHash(new TextEncoder().encode('abc'));
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(isContentHash(hash)).toBe(true);
    expect(isContentHash(hash.toUpperCase())).toBe(false);
  });

  it('refuses malformed name hashes', () => {
    expect(isNameHash('iqjw7i2vwntyuekgvulpp2dety')).toBe(true);
    expect(isNameHash('iqjw7i2vwntyuekgvulpp2detz')).toBe(false); // unused bits set
    expect(isNameHash('IQJW7I2VWNTYUEKGVULPP2DETY')).toBe(false);
    expect(isNameHash('iqjw7i2vwntyuekgvulpp2det')).toBe(false);
  });
});

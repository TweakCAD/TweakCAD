import { describe, expect, it } from 'vitest';
import { canonicalize, CanonicalJsonError } from './canonical';

describe('canonicalize (RFC 8785)', () => {
  it('matches the RFC 8785 §3.2.2 sample', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts member names by UTF-16 code units, not code points', () => {
    // U+1F600 is a surrogate pair starting 0xD83D, which sorts before U+FB33 (0xFB33).
    const input = { דּ: 1, '\u{1F600}': 2, a: 3, é: 4 };
    expect(canonicalize(input)).toBe('{"a":3,"é":4,"\u{1F600}":2,"דּ":1}');
  });

  it('writes the ECMAScript number forms', () => {
    expect(canonicalize([0, -0, 1, -1.5, 1e21, 1e-7, 123456789012345680000, 5e-324])).toBe(
      '[0,0,1,-1.5,1e+21,1e-7,123456789012345680000,5e-324]',
    );
  });

  it('sorts nested objects and keeps array order', () => {
    expect(canonicalize({ b: [{ z: 1, y: 2 }], a: {} })).toBe('{"a":{},"b":[{"y":2,"z":1}]}');
  });

  it('refuses values that are not JSON', () => {
    expect(() => canonicalize({ a: NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalize([Infinity])).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined at \/a/);
    expect(() => canonicalize(new Date(0))).toThrow(/plain object/);
    expect(() => canonicalize('\uD800')).toThrow(/lone surrogate/);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalize([1, , 3])).toThrow(/hole/);
    expect(() => canonicalize(1n)).toThrow(/bigint/);
  });

  it('accepts surrogate pairs', () => {
    expect(canonicalize('\u{1F600}')).toBe('"\u{1F600}"');
  });
});

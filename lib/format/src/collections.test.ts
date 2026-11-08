import { describe, expect, it } from 'vitest';
import {
  FormatError,
  isFormatInteger,
  makeCountedSet,
  makeSet,
  readCountedSet,
  readSet,
  readTableIds,
  readUnion,
} from './collections';

describe('sets', () => {
  it('sorts members by canonical UTF-8 bytes', () => {
    // "é" (C3 A9) sorts after "z" in UTF-8 bytes; "10" sorts before "9" as text.
    expect(makeSet(['é', 'z', 'a'])).toEqual({ set: ['a', 'z', 'é'] });
    expect(makeSet([9, 10])).toEqual({ set: [10, 9] });
    expect(makeSet([{ b: 1, a: 2 }, { a: 1 }])).toEqual({ set: [{ a: 1 }, { b: 1, a: 2 }] });
  });

  it('refuses duplicates, including ones equal only after canonicalization', () => {
    expect(() =>
      makeSet([
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ]),
    ).toThrow(FormatError);
  });

  it('reads only canonical sets', () => {
    expect(readSet({ set: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(() => readSet({ set: ['b', 'a'] })).toThrow(/order/);
    expect(() => readSet({ set: ['a', 'a'] })).toThrow(/duplicate/);
    expect(() => readSet(['a'])).toThrow();
    expect(() => readSet({ set: [], extra: 1 })).toThrow();
  });

  it('counts repeated items', () => {
    const counted = makeCountedSet(['f2', 'f1', 'f2']);
    expect(counted).toEqual({
      set: [
        { item: 'f1', count: 1 },
        { item: 'f2', count: 2 },
      ],
    });
    expect(readCountedSet(counted)).toEqual(counted.set);
    expect(() => readCountedSet({ set: [{ item: 'a', count: 0 }] })).toThrow();
    expect(() => readCountedSet({ set: [{ item: 'a', count: 1.5 }] })).toThrow();
    expect(() =>
      readCountedSet({
        set: [
          { item: 'b', count: 1 },
          { item: 'a', count: 1 },
        ],
      }),
    ).toThrow(/order/);
  });
});

describe('tagged unions', () => {
  it('reads exactly one key holding an object', () => {
    expect(readUnion({ end: {} })).toEqual({ tag: 'end', payload: {} });
    expect(readUnion({ before: { id: 'x' } }, ['end', 'before']).payload).toEqual({ id: 'x' });
  });

  it('refuses zero keys, several keys, non-object payloads and unknown variants', () => {
    expect(() => readUnion({})).toThrow();
    expect(() => readUnion({ a: {}, b: {} })).toThrow();
    expect(() => readUnion({ a: 1 })).toThrow();
    expect(() => readUnion({ a: [] })).toThrow();
    expect(() => readUnion({ c: {} }, ['a', 'b'])).toThrow(/unknown variant/);
  });
});

describe('tables and integers', () => {
  it('requires unique row ids', () => {
    expect(readTableIds([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b']);
    expect(() => readTableIds([{ id: 'a' }, { id: 'a' }])).toThrow(/duplicate/);
    expect(() => readTableIds([{}])).toThrow();
  });

  it('bounds integers at ±2⁵³', () => {
    expect(isFormatInteger(2 ** 53)).toBe(true);
    expect(isFormatInteger(-(2 ** 53))).toBe(true);
    expect(isFormatInteger(2 ** 54)).toBe(false);
    expect(isFormatInteger(1.5)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { CAD_TOOLS } from '@tweakcad/cad-tools';
import type { PickResult } from '../app/picking';
import { toolsWithoutRunner } from './executor';
import { HandleTable } from './handles';
import { createTransactionBalance } from './transactions';

const record = (finest: string, area: number): PickResult => ({
  reference: { entity: { id: [finest], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: { area } } },
  names: {},
});

describe('the executor', () => {
  it('runs every tool of the catalogue', () => {
    expect(CAD_TOOLS.length).toBeGreaterThan(0);
    expect(toolsWithoutRunner()).toEqual([]);
  });
});

describe('handles', () => {
  it('gives one entity one handle, across evaluations, whatever its measures', () => {
    const t = new HandleTable();
    const a = t.add({ kind: 'face', part: 'p', generation: 1, key: 4, feature: 'f', picked: record('A', 10) });
    expect(a).toMatch(/^f:\d+$/);
    // Listed again in a later evaluation, under another key and with another area.
    expect(t.add({ kind: 'face', part: 'p', generation: 2, key: 9, feature: 'f', picked: record('A', 12) })).toBe(a);
    expect(t.get(a)?.key).toBe(9);
    expect(t.known(2, 9)?.handle).toBe(a);
    const b = t.add({ kind: 'face', part: 'p', generation: 2, key: 10, feature: 'f', picked: record('B', 1) });
    expect(b).not.toBe(a);
    expect(t.add({ kind: 'edge', part: 'p', generation: 2, key: 11, feature: 'f', picked: record('C', 1) })).toMatch(
      /^e:/,
    );
  });

  it('keeps one key lookup per handle, and none for handles past the limit', () => {
    const t = new HandleTable(2);
    const a = t.add({ kind: 'face', part: 'p', generation: 1, key: 1, feature: 'f', picked: record('A', 1) });
    for (let g = 2; g <= 100; g++)
      expect(t.add({ kind: 'face', part: 'p', generation: g, key: g, feature: 'f', picked: record('A', 1) })).toBe(a);
    expect(t.known(1, 1)).toBeUndefined();
    expect(t.known(100, 100)?.handle).toBe(a);
    t.moved(t.get(a) as NonNullable<ReturnType<HandleTable['get']>>, 101, 7);
    expect(t.known(100, 100)).toBeUndefined();
    expect(t['byKey'].size).toBe(1);
    t.add({ kind: 'face', part: 'p', generation: 101, key: 8, feature: 'f', picked: record('B', 1) });
    t.add({ kind: 'face', part: 'p', generation: 101, key: 9, feature: 'f', picked: record('C', 1) });
    expect(t.get(a)).toBeUndefined();
    expect(t.known(101, 7)).toBeUndefined();
    expect(t['byKey'].size).toBe(2);
  });

  it('gives a detected region the same handle while its loops are the same', () => {
    const t = new HandleTable();
    const region: PickResult = {
      region: { sketch: 's', loop: [{ closed: { curve: { drawn: { id: 'c' } } } }], holes: { set: [] } } as never,
    };
    const a = t.add({ kind: 'region', part: 'p', generation: 1, key: 1, feature: 's', picked: region });
    expect(
      t.add({ kind: 'region', part: 'p', generation: 3, key: 7, feature: 's', picked: structuredClone(region) }),
    ).toBe(a);
  });

  it('forgets the oldest past its limit', () => {
    const t = new HandleTable(2);
    const first = t.add({ kind: 'body', part: 'p', generation: 1, key: 1, feature: 'f', picked: record('1', 0) });
    t.add({ kind: 'body', part: 'p', generation: 1, key: 2, feature: 'f', picked: record('2', 0) });
    t.add({ kind: 'body', part: 'p', generation: 1, key: 3, feature: 'f', picked: record('3', 0) });
    expect(t.size).toBe(2);
    expect(t.get(first)).toBeUndefined();
  });
});

describe('transaction balance', () => {
  it('closes what its caller left open, and never more', () => {
    const log: string[] = [];
    const inner = { begin: (label: string) => log.push(`begin ${label}`), end: () => log.push('end') };
    const balance = createTransactionBalance(inner);
    balance.transactions.end();
    expect(log).toEqual([]);
    balance.transactions.begin('a');
    balance.transactions.begin('b');
    balance.transactions.end();
    expect(balance.open).toBe(1);
    balance.closeOpen();
    expect(log).toEqual(['begin a', 'begin b', 'end', 'end']);
    expect(balance.open).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { nameHash } from './hash';
import { checkNameTable, NameTable } from './names';

describe('name table', () => {
  it('interns name objects under their hashes', () => {
    const names = new NameTable();
    const hash = names.intern({ feature: 'feat_aaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'start' });
    expect(hash).toBe(nameHash({ role: 'start', feature: 'feat_aaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    expect(names.intern({ role: 'start', feature: 'feat_aaaaaaaaaaaaaaaaaaaaaaaaaa' })).toBe(hash);
    expect(names.size).toBe(1);
  });

  it('writes only the hashes asked for', () => {
    const names = new NameTable();
    const a = names.intern({ n: 'a' });
    names.intern({ n: 'b' });
    expect(names.toJson([a])).toEqual({ [a]: { n: 'a' } });
  });

  it('round-trips a valid table', () => {
    const names = new NameTable();
    const a = names.intern({ n: 'a' });
    const loaded = NameTable.fromJson(names.toJson());
    expect(loaded.get(a)).toEqual({ n: 'a' });
  });

  it('refuses a table whose entry does not match its hash', () => {
    const a = nameHash({ n: 'a' });
    const table = { [a]: { n: 'b' }, notahash: {} };
    expect(checkNameTable(table)).toEqual({ malformed: ['notahash'], mismatched: [a] });
    expect(() => NameTable.fromJson(table)).toThrow(/refused/);
  });
});

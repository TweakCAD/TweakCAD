import { describe, expect, it } from 'vitest';
import { isId, newId, parseId } from './ids';

describe('ids', () => {
  it('encodes 128 random bits after the kind', () => {
    const id = newId('feat', () => new Uint8Array(16));
    expect(id).toBe('feat_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(parseId(id)).toEqual({ kind: 'feat', body: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' });
  });

  it('makes distinct ids from crypto randomness', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('crv')));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isId(id, 'crv')).toBe(true);
  });

  it('accepts kinds not yet in the list', () => {
    expect(isId('weld_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
  });

  it('refuses malformed ids', () => {
    expect(isId('feat_aaaaaaaaaaaaaaaaaaaaaaaaab')).toBe(false); // unused bits set
    expect(isId('feat_aaaa')).toBe(false);
    expect(isId('Feat_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isId('_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isId('v2_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false); // kinds are letters only
    expect(isId('feat_12345678')).toBe(false); // too short, with digits outside the alphabet
    expect(isId('feat_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'part')).toBe(false);
  });

  it('refuses bad kinds and short random sources', () => {
    expect(() => newId('Bad')).toThrow();
    expect(() => newId('feat', () => new Uint8Array(8))).toThrow();
  });
});

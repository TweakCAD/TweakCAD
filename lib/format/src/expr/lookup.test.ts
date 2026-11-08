import { describe, expect, it } from 'vitest';
import { ExprError } from './errors';
import { parseLookupTable } from './lookup';

const CRLF = '\r\n';

function table(...lines: string[]): string {
  return lines.join(CRLF) + CRLF;
}

function expectTableError(source: string | Uint8Array): void {
  try {
    parseLookupTable(source);
  } catch (e) {
    expect(e).toBeInstanceOf(ExprError);
    expect((e as ExprError).kind).toBe('table');
    return;
  }
  expect.unreachable(`expected ${String(source)} to be refused`);
}

describe('lookup tables', () => {
  it('reads text and unit columns', () => {
    const t = parseLookupTable(table('size,pitch[mm],len[in],note', 'M6,1,1,coarse'));
    expect(t.get('M6', 'pitch')).toEqual({ kind: 'scalar', dim: [1, 0, 0, 0], value: 1 });
    expect(t.get('M6', 'len')).toEqual({ kind: 'scalar', dim: [1, 0, 0, 0], value: 25.4 });
    expect(t.get('M6', 'note')).toEqual({ kind: 'text', value: 'coarse' });
    expect(t.get('M6', 'size')).toEqual({ kind: 'text', value: 'M6' });
  });

  it('reads a compound unit, by one multiplication into base units', () => {
    const t = parseLookupTable(table('k,rho[g/cm^3]', 'steel,7.85'));
    expect(t.get('steel', 'rho')).toEqual({ kind: 'scalar', dim: [-3, 1, 0, 0], value: 7.85 * 1e-9 });
  });

  it('compares keys exactly, as text', () => {
    const t = parseLookupTable(table('k,v', '001,a', '1,b', 'A,c', 'a,d', ' 1,e'));
    expect(t.get('001', 'v')).toEqual({ kind: 'text', value: 'a' });
    expect(t.get('1', 'v')).toEqual({ kind: 'text', value: 'b' });
    expect(t.get(' 1', 'v')).toEqual({ kind: 'text', value: 'e' });
    expect(t.get('a', 'v')).toEqual({ kind: 'text', value: 'd' });
    expect(() => t.get('01', 'v')).toThrow(ExprError);
  });

  it('refuses a missing key or column on lookup', () => {
    const t = parseLookupTable(table('k,v', 'a,b'));
    expect(() => t.get('z', 'v')).toThrow(/no key/);
    expect(() => t.get('a', 'z')).toThrow(/no column/);
    expect(() => t.get('constructor', 'v')).toThrow(/no key/);
  });

  it('refuses duplicate keys and headers, whatever the unit', () => {
    expectTableError(table('k,v', 'a,1', 'a,2'));
    expectTableError(table('k,v,v', 'a,1,2'));
    expectTableError(table('k,v[mm],v[in]', 'a,1,2'));
    expectTableError(table('k,k', 'a,b'));
  });

  it('takes JSON numbers only in a unit column', () => {
    const ok = (cell: string): number => {
      const value = parseLookupTable(table('k,v[mm]', `a,${cell}`)).get('a', 'v');
      return (value as { value: number }).value;
    };
    expect(ok('0')).toBe(0);
    expect(ok('-1.5')).toBe(-1.5);
    expect(ok('2e3')).toBe(2000);
    expect(ok('2E+3')).toBe(2000);
    expect(ok('25e-1')).toBe(2.5);
    expect(Object.is(ok('-0'), 0)).toBe(true);
    for (const cell of [
      '',
      ' 1',
      '1 ',
      '+1',
      '01',
      '.5',
      '5.',
      '1e',
      '0x10',
      'NaN',
      'Infinity',
      'null',
      '1mm',
      '1,5',
    ]) {
      expectTableError(table('k,v[mm]', `a,"${cell}"`));
    }
    expectTableError(table('k,v[mm]', 'a,1e999'));
  });

  it('pauses what uses a malformed table', () => {
    expect(() => parseLookupTable(table('k,v[mm]', 'a,wide'))).toThrow(ExprError);
    try {
      parseLookupTable(table('k,v[mm]', 'a,wide'));
    } catch (e) {
      expect((e as ExprError).integrity).toBe(false);
    }
  });

  it('refuses a bad cell in a row nobody looks up', () => {
    expectTableError(table('k,v[mm]', 'a,1', 'b,wide'));
  });

  it('refuses a malformed header', () => {
    expectTableError(table('k,[mm]', 'a,1'));
    expectTableError(table('k,', 'a,1'));
    expectTableError(table('k,v[mm', 'a,1'));
    expectTableError(table('k,v]mm[', 'a,1'));
    expectTableError(table('k,v[mm][mm]', 'a,1'));
    expectTableError(table('k,v[furlong]', 'a,1'));
  });

  it('keeps the key column as text', () => {
    expectTableError(table('k[mm],v', '1,a'));
    expectTableError(table('k[],v', '1,a'));
  });

  it('reads a ratio column', () => {
    const t = parseLookupTable(table('k,teeth[]', 'a,20', 'b,1.5'));
    expect(t.get('a', 'teeth')).toEqual({ kind: 'scalar', dim: [0, 0, 0, 0], value: 20 });
    expect(t.get('b', 'teeth')).toEqual({ kind: 'scalar', dim: [0, 0, 0, 0], value: 1.5 });
    expectTableError(table('k,teeth[]', 'a,many'));
    expectTableError(table('k,teeth[]', 'a,'));
  });

  it('follows RFC 4180 quoting', () => {
    const t = parseLookupTable(table('k,v', '"a,b","say ""hi"""', `"two${CRLF}lines",x`));
    expect(t.get('a,b', 'v')).toEqual({ kind: 'text', value: 'say "hi"' });
    expect(t.get(`two${CRLF}lines`, 'v')).toEqual({ kind: 'text', value: 'x' });
  });

  it('allows a last record without a line break, and an empty field', () => {
    const t = parseLookupTable(`k,v${CRLF}a,`);
    expect(t.get('a', 'v')).toEqual({ kind: 'text', value: '' });
  });

  it('takes lines ending in CRLF or LF', () => {
    for (const source of ['k,v\na,b\n', 'k,v\na,b', 'k,v\r\na,b\n', 'k,v\na,b\r\n']) {
      expect(parseLookupTable(source).get('a', 'v')).toEqual({ kind: 'text', value: 'b' });
    }
    expect(parseLookupTable('k,v\n"a\nb",c\n').get('a\nb', 'v')).toEqual({ kind: 'text', value: 'c' });
  });

  it('drops a leading byte-order mark, and only that', () => {
    const fromText = parseLookupTable('\uFEFFk,v\na,b\n');
    expect(fromText.get('a', 'k')).toEqual({ kind: 'text', value: 'a' });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('k,v\na,b\n')]);
    expect(parseLookupTable(bytes).get('a', 'k')).toEqual({ kind: 'text', value: 'a' });
    expect(parseLookupTable('k,v\n\uFEFFa,b\n').get('\uFEFFa', 'v')).toEqual({ kind: 'text', value: 'b' });
  });

  it('refuses what RFC 4180 does not allow', () => {
    expectTableError(`k,v\ra,b\r`);
    expectTableError('');
    expectTableError(table('k,v', 'a"b,c'));
    expectTableError(table('k,v', '"a"b,c'));
    expectTableError(table('k,v', '"a,c'));
    expectTableError(table('k,v', 'a'));
    expectTableError(table('k,v', 'a,b,c'));
    expectTableError(table('k,v', 'a,b', ''));
  });

  it('reads UTF-8 bytes and refuses anything else', () => {
    const bytes = new TextEncoder().encode(table('k,v', 'é,ü'));
    expect(parseLookupTable(bytes).get('é', 'v')).toEqual({ kind: 'text', value: 'ü' });
    expectTableError(new Uint8Array([0x6b, 0xff, 0x0d, 0x0a]));
  });

  it('allows a table with no rows', () => {
    expect(() => parseLookupTable(table('k,v')).get('a', 'v')).toThrow(/no key/);
  });
});

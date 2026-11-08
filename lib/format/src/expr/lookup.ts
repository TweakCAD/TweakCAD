/**
 * Lookup tables: CSV assets (RFC 4180, UTF-8, lines ending in CRLF or LF, a
 * leading byte-order mark dropped), every cell checked when the table is read.
 */

import { ExprError } from './errors';
import { roundDecimal } from './dyadic';
import { parseUnit } from './parser';
import { RATIO, type Unit } from './units';
import { scalarValue, type ExprValue } from './values';

const JSON_NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const HEADER = /^([^[\]]+)(?:\[([^[\]]*)\])?$/;
const RATIO_UNIT: Unit = { dim: RATIO, scale: 1 };

function tableError(message: string): never {
  throw new ExprError('table', message);
}

function readRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let at = 0;
  const field = (): string => {
    if (text.charAt(at) === '"') {
      let value = '';
      at += 1;
      for (;;) {
        const close = text.indexOf('"', at);
        if (close < 0) tableError('unterminated quoted field');
        value += text.slice(at, close);
        at = close + 1;
        if (text.charAt(at) !== '"') return value;
        value += '"';
        at += 1;
      }
    }
    const start = at;
    while (at < text.length && !',\r\n'.includes(text.charAt(at))) {
      if (text.charAt(at) === '"') tableError('a quote inside an unquoted field');
      at += 1;
    }
    return text.slice(start, at);
  };

  for (;;) {
    record.push(field());
    if (text.charAt(at) === ',') {
      at += 1;
      continue;
    }
    records.push(record);
    record = [];
    if (at >= text.length) return records;
    if (text.startsWith('\r\n', at)) at += 2;
    else if (text.charAt(at) === '\n') at += 1;
    else tableError('records must end with CRLF or LF');
    if (at >= text.length) return records;
  }
}

function readNumber(cell: string, unit: Unit, column: string): number {
  const match = JSON_NUMBER.exec(cell);
  if (match === null) tableError(`${JSON.stringify(cell)} in column ${column} is not a number`);
  const [, sign, whole = '', fraction = '', exponent = '0'] = match;
  const magnitude = roundDecimal(whole + fraction, Number(exponent) - fraction.length);
  const value = (sign === '-' ? -magnitude : magnitude) * unit.scale;
  if (!Number.isFinite(value)) tableError(`${cell} in column ${column} is not finite`);
  return value + 0;
}

function readColumn(header: string, index: number): { name: string; unit?: Unit } {
  const match = HEADER.exec(header);
  const name = match?.[1];
  if (name === undefined) tableError(`malformed column header ${JSON.stringify(header)}`);
  const unitText = match?.[2];
  if (unitText === undefined) return { name };
  if (index === 0) tableError('the key column is always text');
  if (unitText === '') return { name, unit: RATIO_UNIT };
  try {
    return { name, unit: parseUnit(unitText) };
  } catch (e) {
    if (e instanceof ExprError) tableError(`column ${name}: ${e.message}`);
    throw e;
  }
}

export interface LookupTable {
  /** The cell at `key` and `column`; a missing key or column is an error. */
  get(key: string, column: string): ExprValue;
}

/** Reads a lookup table from its CSV text or UTF-8 bytes. */
export function parseLookupTable(source: string | Uint8Array): LookupTable {
  let text: string;
  if (typeof source === 'string') {
    text = source;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
    } catch {
      tableError('the table is not UTF-8');
    }
  }

  const [headers, ...rows] = readRecords(text.startsWith('\uFEFF') ? text.slice(1) : text);
  const columns = (headers as string[]).map(readColumn);
  const indexes = new Map<string, number>();
  columns.forEach(({ name }, i) => {
    if (indexes.has(name)) tableError(`duplicate column ${name}`);
    indexes.set(name, i);
  });

  const cells = new Map<string, ExprValue[]>();
  for (const row of rows) {
    if (row.length !== columns.length) tableError(`a row has ${row.length} fields, not ${columns.length}`);
    const key = row[0] as string;
    if (cells.has(key)) tableError(`duplicate key ${JSON.stringify(key)}`);
    cells.set(
      key,
      row.map((cell, i) => {
        const { name, unit } = columns[i] as { name: string; unit?: Unit };
        return unit === undefined ? { kind: 'text', value: cell } : scalarValue(unit.dim, readNumber(cell, unit, name));
      }),
    );
  }

  return {
    get(key, column) {
      const index = indexes.get(column);
      if (index === undefined) tableError(`no column ${JSON.stringify(column)}`);
      const row = cells.get(key);
      if (row === undefined) tableError(`no key ${JSON.stringify(key)}`);
      return row[index] as ExprValue;
    },
  };
}

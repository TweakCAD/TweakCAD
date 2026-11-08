import { ExprError } from './errors';

export type Token =
  | { type: 'number'; text: string; digits: string; exponent: number; start: number; end: number }
  | { type: 'name'; text: string; start: number; end: number }
  | { type: 'string'; value: string; start: number; end: number }
  | { type: 'symbol'; text: string; start: number; end: number }
  | { type: 'end'; start: number; end: number };

const SYMBOLS = [
  '||',
  '&&',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '!',
  '?',
  ':',
  '.',
  ',',
  '(',
  ')',
  '[',
  ']',
];

const NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const SPACE = /[ \t\r\n]*/y;

function matchAt(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0];
}

function readNumber(raw: string, start: number): Token {
  const [mantissa = '', exponent = '0'] = raw.split(/[eE]/);
  const [whole = '', fraction = ''] = mantissa.split('.');
  return {
    type: 'number',
    text: raw,
    digits: whole + fraction,
    exponent: Number(exponent) - fraction.length,
    start,
    end: start + raw.length,
  };
}

function readString(text: string, start: number): Token {
  let value = '';
  let i = start + 1;
  for (;;) {
    if (i >= text.length) throw new ExprError('syntax', 'unterminated text', start);
    const c = text.charAt(i);
    if (c === '"') return { type: 'string', value, start, end: i + 1 };
    if (c === '\\') {
      const next = text.charAt(i + 1);
      if (next !== '"' && next !== '\\') throw new ExprError('syntax', 'only \\" and \\\\ are escapes', i);
      value += next;
      i += 2;
    } else {
      value += c;
      i += 1;
    }
  }
}

/** Splits expression text into tokens, ending with an `end` token. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  for (;;) {
    at += matchAt(SPACE, text, at)?.length ?? 0;
    if (at >= text.length) {
      tokens.push({ type: 'end', start: at, end: at });
      return tokens;
    }
    const number = matchAt(NUMBER, text, at);
    if (number !== undefined) {
      tokens.push(readNumber(number, at));
      at += number.length;
      continue;
    }
    const name = matchAt(NAME, text, at);
    if (name !== undefined) {
      tokens.push({ type: 'name', text: name, start: at, end: at + name.length });
      at += name.length;
      continue;
    }
    if (text.charAt(at) === '"') {
      const token = readString(text, at);
      tokens.push(token);
      at = token.end;
      continue;
    }
    const symbol = SYMBOLS.find((s) => text.startsWith(s, at));
    if (symbol === undefined)
      throw new ExprError('syntax', `unexpected character ${JSON.stringify(text.charAt(at))}`, at);
    tokens.push({ type: 'symbol', text: symbol, start: at, end: at + symbol.length });
    at += symbol.length;
  }
}

/**
 * Strict JSON parsing for documents (RFC 8259 with the format's extra rules):
 * duplicate member names, lone surrogates and a byte-order mark are refused,
 * so no text can be read two ways. Integral numbers written with a fraction
 * or exponent (`1.0`, `1e3`) are reported by pointer, because integer fields
 * must be written without either (2.1).
 */

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'JsonSyntaxError';
  }
}

export interface ParsedJson {
  value: unknown;
  /** Pointers of integral numbers written with a fraction or exponent. */
  decoratedIntegers: Set<string>;
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

export function parseStrictJson(text: string): ParsedJson {
  let pos = 0;
  const decoratedIntegers = new Set<string>();

  const fail = (message: string): never => {
    throw new JsonSyntaxError(message, pos);
  };
  const ws = () => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };
  const token = (path: string): string => path.replace(/~/g, '~0').replace(/\//g, '~1');

  const parseString = (): string => {
    // pos is at the opening quote.
    pos++;
    let out = '';
    for (;;) {
      if (pos >= text.length) fail('unterminated string');
      const c = text.charCodeAt(pos);
      if (c === 0x22) {
        pos++;
        break;
      }
      if (c < 0x20) fail('control character in string');
      if (c === 0x5c) {
        const e = text[pos + 1];
        pos += 2;
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            fail('bad escape');
        }
        continue;
      }
      out += text[pos];
      pos++;
    }
    // Pairs written as two escapes are fine; a lone half is not.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)) {
      fail('lone surrogate in string');
    }
    return out;
  };

  const parseValue = (path: string): unknown => {
    ws();
    const c = text[pos];
    if (c === '{') {
      pos++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[pos] !== '"') fail('expected a member name');
        const key = parseString();
        if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`duplicate member "${key}"`);
        ws();
        if (text[pos] !== ':') fail('expected ":"');
        pos++;
        const v = parseValue(`${path}/${token(key)}`);
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === '}') {
          pos++;
          return obj;
        }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      pos++;
      const arr: unknown[] = [];
      ws();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(`${path}/${arr.length}`));
        ws();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        if (text[pos] === ']') {
          pos++;
          return arr;
        }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(text);
    if (!m) return fail('unexpected character');
    pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail('number out of range');
    if ((m[1] !== undefined || m[2] !== undefined) && Number.isInteger(n)) decoratedIntegers.add(path);
    return n;
  };

  if (text.charCodeAt(0) === 0xfeff) fail('byte-order mark');
  const value = parseValue('');
  ws();
  if (pos !== text.length) fail('trailing content');
  return { value, decoratedIntegers };
}

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Object members are sorted by the UTF-16 code units of their names, numbers
 * use the ECMAScript number serialization, strings use the minimal JSON
 * escaping, and no whitespace is written. Input must be plain JSON data:
 * `null`, booleans, finite numbers, well-formed strings, arrays and plain
 * objects.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path || '/'}`);
    this.name = 'CanonicalJsonError';
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function writeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalJsonError('string holds a lone surrogate', path);
  }
  // JSON.stringify applies exactly the RFC 8785 escaping to well-formed strings.
  return JSON.stringify(value);
}

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('number is not finite', path);
      }
      // ECMAScript Number serialization; -0 is written as 0.
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(writeString(value, path));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${typeof value} is not JSON`, path);
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      if (!(i in value)) throw new CanonicalJsonError('array has a hole', `${path}/${i}`);
      write(value[i], `${path}/${i}`, out);
    }
    out.push(']');
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError('object is not a plain object', path);
  }
  const record = value as Record<string, unknown>;
  // Default string order compares UTF-16 code units, as RFC 8785 requires.
  const keys = Object.keys(record).sort();
  out.push('{');
  keys.forEach((key, i) => {
    const child = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (record[key] === undefined) throw new CanonicalJsonError('value is undefined', child);
    if (i > 0) out.push(',');
    out.push(writeString(key, child), ':');
    write(record[key], child, out);
  });
  out.push('}');
}

/** The RFC 8785 canonical serialization of `value`. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, '', out);
  return out.join('');
}

const encoder = new TextEncoder();

/** The canonical serialization as UTF-8 bytes. */
export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}

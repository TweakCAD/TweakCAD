/**
 * Content-addressing for embedded components.
 *
 * A component's identity is the SHA-256 of the **canonical-JSON form of the
 * parsed document**, not of the bytes it arrived in. Two files with the same
 * content and different formatting — one pretty-printed from disk, one minified
 * off the catalog — collapse to the same hash, so inserting the same component
 * by both routes dedupes into a single `embeddedComponents` entry instead of
 * storing it twice under two names.
 *
 * That property is the whole reason this lives in one module rather than beside
 * each caller: two definitions of "the hash" would silently stop deduping, and
 * nothing would fail loudly enough to notice.
 */

/**
 * Deterministic serialization: object keys sorted lexicographically, no
 * whitespace. Two semantically-equal documents produce byte-identical output.
 *
 * Same shape RFC 8785 (JCS) prescribes for our usage. Numbers are not
 * normalised beyond `JSON.stringify`'s defaults — the `.cadjson` schema holds
 * every parametric value as a string expression, so the cases JCS's number
 * canonicalisation exists for do not arise here.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map(k =>
    JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]),
  ).join(',') + '}';
}

/**
 * SHA-256 hex digest via Web Crypto, available in every browser context
 * (main thread and worker) and in Node. `crypto.subtle.digest` is async-only,
 * which is why callers that already hold the parsed object still await.
 */
export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/** The `embeddedComponents` key for a component document. */
export async function hashComponentSource(source: unknown): Promise<string> {
  return sha256Hex(canonicalJson(source));
}

/**
 * Whether one document differs from another only in what is shown, not in
 * what is built: the attributes of parts and assemblies (colour, opacity,
 * visibility, body names, 16.1), a part's rollback (7.1; evaluation always
 * runs the whole timeline) and the name table, whose entries come and go
 * with attributes' target records. Evaluation reads none of these, so the
 * worker can show such a change without evaluating (see
 * `EvaluateServiceOptions.restyle`); it checks itself that no name its
 * features hold came or went.
 *
 * The editor's documents share every subtree an edit leaves alone, so the
 * comparison stops at identical subtrees and costs what the edit changed.
 */
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether two JSON values are equal. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && same(a[k], b[k]));
}

/** Whether two rows of a table are equal but for their `attributes`, and for parts their `rollback`. */
function sameRowsButShown(a: unknown, b: unknown, table: 'parts' | 'assemblies'): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x === y) return true;
    if (!isObject(x) || !isObject(y)) return false;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    keys.delete('attributes');
    if (table === 'parts') keys.delete('rollback');
    return [...keys].every((k) => same(x[k], y[k]));
  });
}

export function displayOnly(before: Json, after: Json): boolean {
  if (before === after) return true;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const [a, b] = [before[key], after[key]];
    if (a === b) continue;
    if (key === 'parts' || key === 'assemblies') {
      if (!sameRowsButShown(a, b, key)) return false;
    } else if (key !== 'names' && !same(a, b)) return false;
  }
  return true;
}

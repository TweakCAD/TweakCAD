/**
 * A document sent as its change from the one sent before. The editor's
 * documents share every subtree an edit leaves alone, so the change is found
 * by walking only where the two differ, and posting it to the worker costs
 * what the edit changed rather than the whole document. The worker applies it
 * to the document it kept, copying only along the changed paths, so what did
 * not change keeps its identity there too.
 */

/** One changed place: its path from the document root, and its new value, or that it is gone. */
export type PatchOp = { path: (string | number)[]; value: unknown } | { path: (string | number)[]; deleted: true };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The places where `after` differs from `before`; empty when they are equal. */
export function diffDocs(before: unknown, after: unknown): PatchOp[] {
  const out: PatchOp[] = [];
  const walk = (a: unknown, b: unknown, path: (string | number)[]): void => {
    if (a === b) return;
    if (isObject(a) && isObject(b)) {
      for (const [k, v] of Object.entries(b)) {
        if (!Object.hasOwn(a, k)) out.push({ path: [...path, k], value: v });
        else walk(a[k], v, [...path, k]);
      }
      for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) out.push({ path: [...path, k], deleted: true });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      b.forEach((v, i) => walk(a[i], v, [...path, i]));
      return;
    }
    out.push({ path, value: b });
  };
  walk(before, after, []);
  return out;
}

/** `base` with `patch` applied, `base` left as it was: containers along the changed paths are copied, the rest shared. */
export function applyPatch(base: unknown, patch: readonly PatchOp[]): unknown {
  let root = base;
  const copied = new Set<unknown>();
  const own = <T>(v: T): T => {
    if (copied.has(v)) return v;
    const c = (Array.isArray(v) ? [...v] : { ...(v as object) }) as T;
    copied.add(c);
    return c;
  };
  for (const op of patch) {
    if (op.path.length === 0) {
      if ('deleted' in op) throw new Error('a patch cannot delete the document');
      root = op.value;
      continue;
    }
    root = own(root);
    let at = root as Record<string | number, unknown>;
    for (const step of op.path.slice(0, -1)) {
      const next = at[step];
      if (typeof next !== 'object' || next === null) throw new Error('a patch path runs through a value');
      at = at[step] = own(next) as Record<string | number, unknown>;
    }
    const last = op.path[op.path.length - 1] as string | number;
    if ('deleted' in op) Reflect.deleteProperty(at, last);
    else at[last] = op.value;
  }
  return root;
}

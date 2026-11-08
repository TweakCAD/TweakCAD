import { canonicalize } from '../canonical';
import { isPlainObject } from '../collections';
import { child, type Diagnostic } from './diagnostics';
import { Reader, type Json } from './reader';
import { readCopyStep } from './references';

/** What one name-table entry holds, once read. */
interface NameEntry {
  /** Refusals of known fields of the wrong shape, relative to the entry. */
  refusals: Diagnostic[];
  /** Every name hash the entry contains (9.3). */
  nested: string[];
  /** The entry's `chain`, when it is one. */
  chain?: unknown[] | undefined;
}

/**
 * Reads a name object (9.3) on its own. Known fields of the wrong shape are
 * refusals. Unknown keys and variants are left to the naming-rules version
 * that wrote them: a reader that cannot compute such a level pauses the
 * references holding it (9.3), so they are no refusal here.
 */
function readNameEntry(entry: unknown): NameEntry {
  const r = new Reader();
  const o = r.object(entry, '', { required: ['kind', 'chain', 'feature'], optional: ['role', 'src'] });
  let chain: unknown[] | undefined;
  if (o) {
    if (o.kind !== undefined) r.string(o.kind, '/kind');
    if (o.chain !== undefined && r.list(o.chain, '/chain')) {
      chain = o.chain;
      o.chain.forEach((step, i) => readCopyStep(r, step, child('/chain', i)));
    }
    const feature = o.feature === undefined ? null : r.object(o.feature, '/feature', { required: ['id'] });
    if (feature) r.label(feature.id, '/feature/id');
    if (o.role !== undefined) r.string(o.role, '/role');
    if (o.src !== undefined && r.list(o.src, '/src'))
      o.src.forEach((item, i) => readSrcItem(r, item, child('/src', i)));
  }
  return {
    refusals: r.diagnostics.list.filter((d) => d.severity === 'refuse'),
    nested: r.usedHashes.map((u) => u.id),
    chain,
  };
}

/** One `src` item (9.3). */
function readSrcItem(r: Reader, value: unknown, path: string): void {
  const u = r.union(value, path, ['name', 'id', 'index', 'text', 'uses']);
  if (!u) return;
  switch (u.tag) {
    case 'name': {
      const o = r.object(u.payload, u.path, { required: ['hash'] });
      if (o) r.hash(o.hash, child(u.path, 'hash'));
      return;
    }
    case 'id': {
      const o = r.object(u.payload, u.path, { required: ['id'] });
      if (o) r.label(o.id, child(u.path, 'id'));
      return;
    }
    case 'index': {
      const o = r.object(u.payload, u.path, { required: ['i'] });
      if (o) r.integer(o.i, child(u.path, 'i'));
      return;
    }
    case 'text': {
      const o = r.object(u.payload, u.path, { required: ['t'] });
      if (o) r.string(o.t, child(u.path, 't'));
      return;
    }
    case 'uses': {
      // A counted set of face hashes, a seam's face counted twice.
      const members = r.set(u.payload, u.path);
      members?.forEach((m, i) => {
        const mp = child(child(u.path, 'set'), i);
        const entry = r.object(m, mp, { required: ['item', 'count'] });
        if (!entry) return;
        r.hash(entry.item, child(mp, 'item'));
        r.integer(entry.count, child(mp, 'count'), 1);
      });
      return;
    }
  }
}

/**
 * The name-table rules beyond re-hashing (9.3, 9.8, 20), for the entries the
 * document uses: each is a name object of the right shape, and every hash it
 * holds, transitively, is in the table. A missing nested entry pauses the
 * references holding the outer hash, as a missing entry of their own does.
 * Unused entries are never a refusal.
 */
export function checkUsedNames(r: Reader, names: Json): Map<string, NameEntry> {
  const read = new Map<string, NameEntry>();
  const entryOf = (hash: string): NameEntry | undefined => {
    if (!Object.prototype.hasOwnProperty.call(names, hash)) return undefined;
    let entry = read.get(hash);
    if (!entry) {
      entry = readNameEntry(names[hash]);
      read.set(hash, entry);
      for (const refusal of entry.refusals) {
        r.diagnostics.refuse(refusal.code, child('/names', hash) + refusal.path, refusal.message);
      }
    }
    return entry;
  };
  /** The first hash reachable from `hash` the table lacks. */
  const missing = new Map<string, string | null>();
  const firstMissing = (hash: string, open: Set<string>): string | null => {
    const known = missing.get(hash);
    if (known !== undefined) return known;
    const entry = entryOf(hash);
    if (!entry) return hash;
    if (open.has(hash)) return null;
    open.add(hash);
    let found: string | null = null;
    for (const nested of entry.nested) {
      found = firstMissing(nested, open);
      if (found !== null) break;
    }
    open.delete(hash);
    missing.set(hash, found);
    return found;
  };
  for (const use of r.usedHashes) {
    if (!Object.prototype.hasOwnProperty.call(names, use.id)) continue;
    const lacking = firstMissing(use.id, new Set());
    if (lacking !== null) {
      r.diagnostics.pause('missing-name', use.path, `name ${lacking}, which ${use.id} holds, is not in the name table`);
    }
  }
  return read;
}

/**
 * An in-context entity reference's name chain ends with its instance path's
 * steps, innermost first (9.1, 9.5, 20). Levels whose entry is missing are
 * already paused; a level whose chain says otherwise refuses.
 */
export function checkInContextChains(r: Reader, entries: ReadonlyMap<string, NameEntry>): void {
  for (const use of r.inContextUses) {
    if (!use.ladder || use.ladderPath === undefined) continue;
    const expected = [...use.steps].reverse().map((step) => {
      if (isPlainObject(step) && isPlainObject(step.instance)) {
        const id = step.instance.id;
        return { op: { id }, key: { instance: { id } } };
      }
      return isPlainObject(step) ? step.copy : step;
    });
    const want = safeCanonical(expected);
    use.ladder.forEach((hash, i) => {
      const chain = typeof hash === 'string' ? entries.get(hash)?.chain : undefined;
      if (!chain || want === undefined) return;
      const tail =
        chain.length >= expected.length ? safeCanonical(chain.slice(chain.length - expected.length)) : undefined;
      if (tail !== want) {
        r.diagnostics.refuse(
          'dangling',
          child(use.ladderPath as string, i),
          "the entity's name chain does not end with the steps of its instance path",
        );
      }
    });
  }
}

function safeCanonical(value: unknown): string | undefined {
  try {
    return canonicalize(value);
  } catch {
    return undefined;
  }
}

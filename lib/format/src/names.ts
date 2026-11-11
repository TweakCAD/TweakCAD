import type { JsonValue } from './canonical';
import { isPlainObject } from './collections';
import { isNameHash, nameHash, nameHashOnce } from './hash';

/** The document's name table: name hash → the canonical JSON object it hashes. */
export type NameTableJson = Record<string, JsonValue>;

export interface NameTableCheck {
  /** Keys that are not well-formed name hashes. */
  malformed: string[];
  /** Keys whose entry does not hash to the key. */
  mismatched: string[];
}

/**
 * Re-hashes every entry. Any malformed or mismatched entry refuses the
 * document; the caller decides how to report it.
 */
export function checkNameTable(table: unknown): NameTableCheck {
  const result: NameTableCheck = { malformed: [], mismatched: [] };
  if (!isPlainObject(table)) {
    result.malformed.push('');
    return result;
  }
  for (const [key, entry] of Object.entries(table)) {
    if (!isNameHash(key)) result.malformed.push(key);
    else if (nameHashOnce(entry) !== key) result.mismatched.push(key);
  }
  return result;
}

/** Strings that are well-formed name hashes, anywhere in `value`. */
function hashesIn(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === 'string') {
    if (isNameHash(value)) out.add(value);
  } else if (Array.isArray(value)) for (const item of value) hashesIn(item, out);
  else if (isPlainObject(value)) for (const item of Object.values(value)) hashesIn(item, out);
  return out;
}

/** Collects name objects while a document is built or written. */
export class NameTable {
  private readonly entries = new Map<string, JsonValue>();

  /** Hashes `name`, records it, and returns its hash. */
  intern(name: JsonValue): string {
    const hash = nameHash(name);
    if (!this.entries.has(hash)) this.entries.set(hash, name);
    return hash;
  }

  get(hash: string): JsonValue | undefined {
    return this.entries.get(hash);
  }

  /** Records names another table of this program hashed, without hashing them again. */
  adopt(entries: Iterable<readonly [string, JsonValue]>): void {
    for (const [hash, name] of entries) if (!this.entries.has(hash)) this.entries.set(hash, name);
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The entries a written value needs (9.8): every name hash anywhere in
   * `value`, with the hashes those entries contain, transitively.
   */
  usedBy(value: unknown): NameTableJson {
    const used = new Set<string>();
    const queue = [...hashesIn(value, new Set())];
    while (queue.length > 0) {
      const hash = queue.pop() as string;
      if (used.has(hash)) continue;
      const entry = this.entries.get(hash);
      if (entry === undefined) continue;
      used.add(hash);
      queue.push(...hashesIn(entry, new Set()));
    }
    return this.toJson(used);
  }

  /** The table restricted to `used` hashes, as written to a document. */
  toJson(used?: Iterable<string>): NameTableJson {
    const out: NameTableJson = {};
    const keys = used ? [...new Set(used)] : [...this.entries.keys()];
    for (const key of keys.sort()) {
      const entry = this.entries.get(key);
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  }

  /** Loads a document's table; malformed or mismatched entries are refused. */
  static fromJson(table: unknown): NameTable {
    const check = checkNameTable(table);
    if (check.malformed.length > 0 || check.mismatched.length > 0) {
      throw new Error(`name table refused: ${check.malformed.length} malformed, ${check.mismatched.length} mismatched`);
    }
    const names = new NameTable();
    for (const [key, entry] of Object.entries(table as NameTableJson)) {
      names.entries.set(key, entry);
    }
    return names;
  }
}

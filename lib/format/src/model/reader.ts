import { canonicalBytes } from '../canonical';
import { compareBytes, isFormatInteger, isPlainObject } from '../collections';
import { isNameHash } from '../hash';
import { parseId } from '../ids';
import { child, Diagnostics } from './diagnostics';

export type Json = Record<string, unknown>;

/** Whether unknown keys in an object pause dependents or are ignored. */
export type ObjectClass = 'schema' | 'presentational';

export interface FieldSpec {
  required: readonly string[];
  optional?: readonly string[];
  class?: ObjectClass;
}

/** An id definition or a must-exist id use, collected for the integrity pass. */
export interface IdUse {
  id: string;
  path: string;
  /** Expected kind, when the field names one. */
  kind?: string | undefined;
}

/**
 * Reading state for one document: diagnostics, plus the ids it defines and
 * the must-exist ids it uses.
 */
export class Reader {
  readonly diagnostics = new Diagnostics();
  readonly definitions = new Map<string, IdUse>();
  readonly mustExist: IdUse[] = [];
  /** Every name hash written in a reference or ladder, with where. */
  readonly usedHashes: IdUse[] = [];
  /** Every asset hash the document uses, with where; each must be in `assets`. */
  readonly assetUses: IdUse[] = [];
  /** Every selection reference, with where: the set it names. */
  readonly selectionUses: IdUse[] = [];
  /**
   * In-context references: the context, the canonical instance path and its
   * steps, where, and an entity `ref`'s ladder with where it is written.
   */
  readonly inContextUses: {
    context: string;
    instance: string;
    steps: unknown[];
    path: string;
    ladder?: unknown[];
    ladderPath?: string;
  }[] = [];
  /** Pointers of integral numbers the text wrote with a fraction or exponent. */
  decoratedIntegers: ReadonlySet<string> = new Set();

  /**
   * Checks that `value` is a schema object with exactly the known keys.
   * Returns the object, or null when it is not an object at all.
   */
  object(value: unknown, path: string, spec: FieldSpec): Json | null {
    if (!isPlainObject(value)) {
      this.diagnostics.refuse('wrong-type', path, 'expected an object');
      return null;
    }
    const known = new Set([...spec.required, ...(spec.optional ?? [])]);
    for (const key of Object.keys(value)) {
      if (key === 'extensions') {
        this.extensions(value[key], child(path, key));
        continue;
      }
      if (value[key] === null) {
        this.diagnostics.refuse('null', child(path, key), 'null is never written');
        continue;
      }
      if (!known.has(key)) {
        if (spec.class === 'presentational') {
          this.diagnostics.ignore('unknown-key', child(path, key), `unknown key "${key}" kept`);
        } else {
          this.diagnostics.pause('unknown-key', child(path, key), `unknown key "${key}"`);
        }
      }
    }
    for (const key of spec.required) {
      if (!(key in value)) {
        this.diagnostics.refuse('missing-field', child(path, key), `missing field "${key}"`);
      }
    }
    return value;
  }

  /** `extensions`: a map from namespace to any JSON; `core` is reserved. */
  extensions(value: unknown, path: string): void {
    if (!isPlainObject(value)) {
      this.diagnostics.refuse('bad-extensions', path, 'extensions must be an object');
      return;
    }
    if ('core' in value) {
      this.diagnostics.refuse('bad-extensions', child(path, 'core'), 'the "core" namespace is reserved');
    }
  }

  /** Reads a tagged union; returns its tag and payload, or null when broken or unknown. */
  union(value: unknown, path: string, known: readonly string[]): { tag: string; payload: Json; path: string } | null {
    if (!isPlainObject(value)) {
      this.diagnostics.refuse('wrong-type', path, 'expected a tagged union');
      return null;
    }
    const keys = Object.keys(value);
    const tag = keys[0];
    if (keys.length !== 1 || tag === undefined) {
      this.diagnostics.refuse('wrong-type', path, `a tagged union has exactly one key, found ${keys.length}`);
      return null;
    }
    const payload = value[tag];
    if (!isPlainObject(payload)) {
      this.diagnostics.refuse('wrong-type', child(path, tag), `variant "${tag}" must hold an object`);
      return null;
    }
    if (!known.includes(tag)) {
      this.diagnostics.pause('unknown-variant', child(path, tag), `unknown variant "${tag}"`);
      return null;
    }
    return { tag, payload, path: child(path, tag) };
  }

  string(value: unknown, path: string): value is string {
    if (typeof value === 'string') return true;
    this.diagnostics.refuse('wrong-type', path, 'expected a string');
    return false;
  }

  boolean(value: unknown, path: string): value is boolean {
    if (typeof value === 'boolean') return true;
    this.diagnostics.refuse('wrong-type', path, 'expected a boolean');
    return false;
  }

  integer(value: unknown, path: string, min?: number): value is number {
    if (!isFormatInteger(value)) {
      this.diagnostics.refuse('wrong-type', path, 'expected an integer');
      return false;
    }
    if (this.decoratedIntegers.has(path)) {
      this.diagnostics.refuse('wrong-type', path, 'an integer is written without a fraction or exponent');
      return false;
    }
    if (min !== undefined && value < min) {
      this.diagnostics.refuse('bad-value', path, `expected an integer of at least ${min}`);
      return false;
    }
    return true;
  }

  number(value: unknown, path: string): value is number {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    this.diagnostics.refuse('wrong-type', path, 'expected a finite number');
    return false;
  }

  /** An array, refusing anything else. */
  list(value: unknown, path: string): value is unknown[] {
    if (Array.isArray(value)) return true;
    this.diagnostics.refuse('wrong-type', path, 'expected an array');
    return false;
  }

  /** A JSON object used as a map (keys are user or registry names). */
  map(value: unknown, path: string): value is Json {
    if (isPlainObject(value)) return true;
    this.diagnostics.refuse('wrong-type', path, 'expected a map');
    return false;
  }

  /** A set: `{"set": [...]}`, canonical order, no duplicates. Returns the members. */
  set(value: unknown, path: string): unknown[] | null {
    if (!isPlainObject(value) || Object.keys(value).length !== 1 || !Array.isArray(value.set)) {
      this.diagnostics.refuse('bad-set', path, 'a set is {"set": [...]}');
      return null;
    }
    let previous: Uint8Array | null = null;
    const members = value.set;
    members.forEach((member, i) => {
      const bytes = canonicalBytes(member);
      if (previous !== null) {
        const order = compareBytes(previous, bytes);
        if (order === 0) this.diagnostics.refuse('bad-set', child(child(path, 'set'), i), 'duplicate set member');
        else if (order > 0) {
          this.diagnostics.refuse('bad-set', child(child(path, 'set'), i), 'set members out of canonical order');
        }
      }
      previous = bytes;
    });
    return members;
  }

  /** Checks an id's shape and, when given, its kind. */
  idShape(value: unknown, path: string, kind?: string): value is string {
    const parsed = parseId(value);
    if (parsed === null) {
      this.diagnostics.refuse('bad-id', path, 'malformed id');
      return false;
    }
    if (kind !== undefined && parsed.kind !== kind) {
      this.diagnostics.refuse('bad-id', path, `expected a ${kind}_ id`);
      return false;
    }
    return true;
  }

  /** A row's own id or a value object's id: unique in the document. */
  define(value: unknown, path: string, kind?: string): value is string {
    if (!this.idShape(value, path, kind)) return false;
    const earlier = this.definitions.get(value);
    if (earlier) {
      this.diagnostics.refuse('duplicate-id', path, `id ${value} is also defined at ${earlier.path}`);
      return false;
    }
    this.definitions.set(value, { id: value, path, kind });
    return true;
  }

  /** A must-exist id field; resolved after the whole document is read. */
  refer(value: unknown, path: string, kind?: string): value is string {
    if (!this.idShape(value, path, kind)) return false;
    this.mustExist.push({ id: value, path, kind });
    return true;
  }

  /** A label id (opaque provenance): shape only. */
  label(value: unknown, path: string, kind?: string): value is string {
    return this.idShape(value, path, kind);
  }

  /** A name hash written in a reference or ladder. */
  hash(value: unknown, path: string): value is string {
    if (!isNameHash(value)) {
      this.diagnostics.refuse('bad-hash', path, 'malformed name hash');
      return false;
    }
    this.usedHashes.push({ id: value, path });
    return true;
  }

  /** A well-formed name hash of something not stored in `names` (a context's manifest). */
  hashOnly(value: unknown, path: string): value is string {
    if (isNameHash(value)) return true;
    this.diagnostics.refuse('bad-hash', path, 'malformed name hash');
    return false;
  }

  /** Reads `{"id": <id>}` (a must-exist id wrapper) and returns the id. */
  idRef(value: unknown, path: string, kind?: string): string | null {
    const o = this.object(value, path, { required: ['id'] });
    if (!o) return null;
    return this.refer(o.id, child(path, 'id'), kind) ? (o.id as string) : null;
  }
}

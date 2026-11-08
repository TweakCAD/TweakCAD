/**
 * Handles: the short names the tools give entities of the evaluation (a
 * body, face, edge, vertex, sketch region, curve or point, a construction
 * output), such as `f:3`.
 *
 * A display key means something only in the evaluation it came from, so a
 * handle is picked when it is listed: it holds the reference a feature input
 * would store (spec 9.2), with its name-table entries. A feature tool writes
 * that reference; a tool that needs the entity in the current evaluation
 * (a measure, a list of a body's faces) resolves it again (9.6). So a handle
 * keeps naming its entity across later edits for as long as the entity
 * exists, and the same entity listed again gets the same handle.
 */
import { canonicalize } from '@tweakcad/format';
import type { EntityRecord } from '@tweakcad/format';
import type { Key } from '@tweakcad/worker/src/v2/service/types';
import type { PickResult } from '../app/picking';

export type HandleKind = 'body' | 'face' | 'edge' | 'vertex' | 'region' | 'curve' | 'point' | 'construction';

const LETTER: Record<HandleKind, string> = {
  body: 'b',
  face: 'f',
  edge: 'e',
  vertex: 'v',
  region: 'r',
  curve: 'c',
  point: 'p',
  construction: 'k',
};

export interface HandleEntry {
  handle: string;
  kind: HandleKind;
  /** The part whose evaluation it was listed from. */
  part: string;
  /** The display generation `key` belongs to. */
  generation: number;
  key: Key;
  /** The feature that made it; for a sketch entity, its sketch. */
  feature: string;
  /** What a feature input stores for it. */
  picked: PickResult;
}

/** The handles of one session, in the order they were made; the oldest go past `limit`. */
export class HandleTable {
  private next = 1;
  private readonly entries = new Map<string, HandleEntry>();
  private readonly byName = new Map<string, string>();
  private readonly byKey = new Map<string, string>();

  constructor(private readonly limit = 20_000) {}

  /** The handle for an entity just picked: an existing one for the same reference, or a new one. */
  add(entry: Omit<HandleEntry, 'handle'>): string {
    const name = nameOf(entry.picked);
    const known = (name && this.byName.get(name)) ?? this.byKey.get(keyOf(entry.generation, entry.key));
    const existing = known ? this.entries.get(known) : undefined;
    if (existing && existing.kind === entry.kind) {
      this.forgetKey(existing);
      Object.assign(existing, {
        generation: entry.generation,
        key: entry.key,
        picked: entry.picked,
        part: entry.part,
        feature: entry.feature,
      });
      this.byKey.set(keyOf(entry.generation, entry.key), existing.handle);
      return existing.handle;
    }
    const handle = `${LETTER[entry.kind]}:${this.next++}`;
    this.entries.set(handle, { ...entry, handle });
    if (name) this.byName.set(name, handle);
    this.byKey.set(keyOf(entry.generation, entry.key), handle);
    this.trim();
    return handle;
  }

  /** The handle an already-listed key of this generation has, if any. */
  known(generation: number, key: Key): HandleEntry | undefined {
    const h = this.byKey.get(keyOf(generation, key));
    return h ? this.entries.get(h) : undefined;
  }

  get(handle: string): HandleEntry | undefined {
    return this.entries.get(handle.trim());
  }

  /** Records that `handle` is `key` in `generation`, after resolving it again. */
  moved(entry: HandleEntry, generation: number, key: Key): void {
    this.forgetKey(entry);
    entry.generation = generation;
    entry.key = key;
    this.byKey.set(keyOf(generation, key), entry.handle);
  }

  get size(): number {
    return this.entries.size;
  }

  private trim(): void {
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string;
      const e = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (!e) continue;
      const name = nameOf(e.picked);
      if (name && this.byName.get(name) === oldest) this.byName.delete(name);
      this.forgetKey(e);
    }
  }

  /** Drops the lookup of the entry's key, which only the newest key of a handle keeps. */
  private forgetKey(e: HandleEntry): void {
    const k = keyOf(e.generation, e.key);
    if (this.byKey.get(k) === e.handle) this.byKey.delete(k);
  }
}

const keyOf = (generation: number, key: Key) => `${generation}:${key}`;

/** The reference's entity record, when the pick wrote one. */
export function recordOf(picked: PickResult): EntityRecord | null {
  if ('region' in picked) return null;
  const ref = picked.reference as { entity?: EntityRecord };
  return ref.entity ?? null;
}

/** A canonical text of what the pick names: equal for two picks of one entity. */
function nameOf(picked: PickResult): string | null {
  if ('region' in picked) return `region:${canonicalize(picked.region)}`;
  const record = recordOf(picked);
  if (!record) return null;
  // The snapshot holds measures, which change as the entity moves; the rest names it.
  const name: Record<string, unknown> = { ...record };
  delete name.snapshot;
  return `id:${canonicalize(name)}`;
}

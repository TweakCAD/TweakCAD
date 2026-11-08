/**
 * The design segment's index and record framing.
 *
 * `MetaStream.dat` lists the record types and, for each type, the ids of its
 * records, then maps every id to its byte offset in `BulkStream.dat`. A record
 * has two levels: the primary one holds the most-derived class's members and a
 * secondary one, at its own offset, the base class's. Members carry no tags, so
 * a reader works from the type GUID and class version.
 */

import { ByteReader, F3dFormatError } from './byteReader';

export type RecordType = {
  /** Upper-case first eight hex digits of the type GUID, enough to tell types apart. */
  key: string;
  baseKey: string;
  version: number;
};

export type DesignIndex = {
  bulk: Uint8Array;
  typeOf: Map<number, RecordType>;
  idsOf: Map<string, number[]>;
  primary: Map<number, number>;
  secondary: Map<number, number>;
  /** Base-type key of each known type key, for walking subclass chains. */
  baseOf: Map<string, string>;
  /** First offset after `offset` at which another record level starts. */
  endOf(offset: number): number;
};

const SERIALIZER_WITH_EXTENDED_HEADER = 1234;
const MAX_TYPES = 100_000;

const keyOf = (guid: string): string => guid.slice(0, 8).toUpperCase();

export function parseDesignIndex(meta: Uint8Array, bulk: Uint8Array): DesignIndex {
  const r = new ByteReader(meta);
  r.str8(); // segment name
  r.u32();
  r.wstr(); // asset GUID
  if (r.u32() === SERIALIZER_WITH_EXTENDED_HEADER) r.skip(12);
  else r.skip(4);
  r.str8(); // full type name
  r.str8(); // add-in
  r.skip(8);

  const typeCount = r.u32();
  if (typeCount > MAX_TYPES) throw new F3dFormatError(`Design lists ${typeCount} types`);

  const typeOf = new Map<number, RecordType>();
  const idsOf = new Map<string, number[]>();
  const baseOf = new Map<string, string>();
  for (let i = 0; i < typeCount; i++) {
    const guid = r.str8();
    const base = r.str8();
    const version = r.u32();
    r.str8(); // module
    const count = r.count(8);
    const type: RecordType = { key: keyOf(guid), baseKey: keyOf(base), version };
    baseOf.set(type.key, type.baseKey);
    const ids = idsOf.get(type.key) ?? [];
    for (let j = 0; j < count; j++) {
      const id = r.u64();
      if (!typeOf.has(id)) {
        typeOf.set(id, type);
        ids.push(id);
      }
    }
    idsOf.set(type.key, ids);
  }

  const namedCount = r.count(8);
  r.skip(namedCount * 8);

  const readOffsets = (): Map<number, number> => {
    const offsets = new Map<number, number>();
    const count = r.count(16);
    for (let i = 0; i < count; i++) {
      const id = r.u64();
      const offset = r.u64();
      if (offset < bulk.length) offsets.set(id, offset);
    }
    return offsets;
  };
  const primary = readOffsets();
  const secondary = readOffsets();

  const starts = Float64Array.from([...primary.values(), ...secondary.values()]).sort();
  const endOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo < starts.length ? (starts[lo] as number) : bulk.length;
  };

  return { bulk, typeOf, idsOf, primary, secondary, baseOf, endOf };
}

/** True when `key` is `ancestor` or a subclass of it. */
export function isKindOf(index: DesignIndex, key: string | undefined, ancestor: string): boolean {
  let k = key;
  for (let depth = 0; k !== undefined && depth < 16; depth++) {
    if (k === ancestor) return true;
    k = index.baseOf.get(k);
  }
  return false;
}

export type RecordRange = { id: number; start: number; end: number };

export function primaryRange(index: DesignIndex, id: number): RecordRange | undefined {
  const start = index.primary.get(id);
  return start === undefined ? undefined : { id, start, end: index.endOf(start) };
}

export function secondaryRange(index: DesignIndex, id: number): RecordRange | undefined {
  const start = index.secondary.get(id);
  return start === undefined ? undefined : { id, start, end: index.endOf(start) };
}

/**
 * Local reference at `pos`: a present byte, a u64 id, in one generation the
 * target's type GUID as a 36-character str8, then two zero bytes for "same
 * document, same segment". Returns null when the bytes aren't one.
 */
export function refAt(bytes: Uint8Array, pos: number, end: number): { id: number; next: number } | null {
  if (pos + 11 > end || bytes[pos] !== 1) return null;
  let id = 0;
  for (let i = 7; i >= 0; i--) id = id * 256 + (bytes[pos + 1 + i] as number);
  if (!Number.isSafeInteger(id)) return null;
  let next = pos + 9;
  if (bytes[next] === 36 && bytes[next + 1] === 0 && bytes[next + 2] === 0 && bytes[next + 3] === 0) next += 40;
  if (next + 2 > end || bytes[next] !== 0 || bytes[next + 1] !== 0) return null;
  return { id, next: next + 2 };
}

/** Every local reference to a known record in a byte range, in order. */
export function refsIn(index: DesignIndex, start: number, end: number): { id: number; pos: number; next: number }[] {
  const out: { id: number; pos: number; next: number }[] = [];
  for (let p = start; p + 11 <= end;) {
    const ref = refAt(index.bulk, p, end);
    if (ref && ref.id !== 0 && index.typeOf.has(ref.id)) {
      out.push({ id: ref.id, pos: p, next: ref.next });
      p = ref.next;
    } else {
      p++;
    }
  }
  return out;
}

export type Prologue = {
  /** Loci of the leading block, when the record has one. */
  leading: number[];
  properties: Map<string, number>;
  /** Offset of the first member after the prologue. */
  next: number;
};

/**
 * The fixed start of a record: class tag, id, name, an optional leading block
 * of (reference, role) pairs, and an optional property block.
 */
export function readPrologue(index: DesignIndex, range: RecordRange): Prologue {
  const r = new ByteReader(index.bulk, range.start, range.end);
  r.str8(); // class tag
  r.u64(); // id
  r.str8(); // name

  const leading: number[] = [];
  if (r.u8() === 1) {
    const count = r.count(15);
    for (let i = 0; i < count; i++) {
      const ref = refAt(index.bulk, r.pos, range.end);
      if (!ref) throw new F3dFormatError(`Unreadable leading block in record ${range.id}`);
      r.pos = ref.next;
      r.skip(4); // role
      leading.push(ref.id);
    }
  }

  const properties = new Map<string, number>();
  if (r.u8() === 1) {
    const count = r.count(16);
    for (let i = 0; i < count; i++) {
      const key = r.str8();
      const type = r.str8();
      if (type.endsWith('String')) {
        r.wstr();
      } else {
        // Identity values can use all 64 bits, so these stay out of the safe-integer read.
        const low = r.u32();
        const high = r.u32();
        properties.set(key, high * 2 ** 32 + low);
      }
    }
  }
  return { leading, properties, next: r.pos };
}

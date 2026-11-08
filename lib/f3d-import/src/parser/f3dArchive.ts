/**
 * Read the design streams out of a `.f3d` or `.f3z` archive.
 *
 * A `.f3d` is a ZIP whose entries are stored, deflated, or Zstandard (method
 * 93). fflate's `unzipSync` rejects method 93, so the central directory is read
 * here and each entry is decompressed on its own. A `.f3z` is a plain ZIP of
 * `.f3d` members: `Manifest.json` names the root and `DesignDescription.json`
 * says which member each link of a design opens.
 *
 * Only the entries the importer reads are decompressed. Declared sizes are
 * checked before anything is inflated, and the real output is counted against
 * the same limits, so a small file can't expand without bound.
 */

import { inflateSync, strFromU8 } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { ByteReader, F3dFormatError } from './byteReader';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_ZSTD = 93;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_EXTRA_ID = 1;

export const MAX_ENTRIES = 65536;
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
/** Largest stored expansion is 16x in practice; the cap leaves room without allowing a bomb. */
export const MAX_RATIO = 1024;

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

function findEocd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new F3dFormatError('Not a ZIP archive');
}

function readDirectory(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEocd(bytes);
  const tail = new ByteReader(bytes, eocd + 10);
  let count = tail.u16();
  tail.skip(4);
  let offset = tail.u32();

  if (offset === ZIP64_SENTINEL_32 || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0) {
      const l = new ByteReader(bytes, locator);
      if (l.u32() === SIG_EOCD64_LOCATOR) {
        l.skip(4);
        const z = new ByteReader(bytes, l.u64());
        z.skip(32);
        count = z.u64();
        z.skip(8);
        offset = z.u64();
      }
    }
  }
  if (count > MAX_ENTRIES) throw new F3dFormatError(`Archive lists ${count} entries`);

  const entries: ZipEntry[] = [];
  const r = new ByteReader(bytes, offset);
  for (let i = 0; i < count; i++) {
    if (r.u32() !== SIG_CENTRAL) throw new F3dFormatError('Malformed ZIP directory');
    r.skip(6); // versions, flags
    const method = r.u16();
    r.skip(8); // time, date, crc
    let compressedSize = r.u32();
    let size = r.u32();
    const nameLength = r.u16();
    const extraLength = r.u16();
    const commentLength = r.u16();
    r.skip(8); // disk, attributes
    let localOffset = r.u32();
    const nameEnd = r.pos + nameLength;
    if (nameEnd > r.end) throw new F3dFormatError('Malformed ZIP entry name');
    const name = strFromU8(bytes.subarray(r.pos, nameEnd));
    r.pos = nameEnd;

    const extraEnd = r.pos + extraLength;
    while (r.pos + 4 <= extraEnd) {
      const id = r.u16();
      const length = r.u16();
      const next = r.pos + length;
      if (id === ZIP64_EXTRA_ID) {
        if (size === ZIP64_SENTINEL_32) size = r.u64();
        if (compressedSize === ZIP64_SENTINEL_32) compressedSize = r.u64();
        if (localOffset === ZIP64_SENTINEL_32) localOffset = r.u64();
      }
      r.pos = next;
    }
    r.pos = extraEnd + commentLength;
    entries.push({ name, method, compressedSize, size, localOffset });
  }
  return entries;
}

function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.size > MAX_ENTRY_BYTES) throw new F3dFormatError(`Entry ${entry.name} is too large`);
  if (entry.compressedSize > 0 && entry.size / entry.compressedSize > MAX_RATIO) {
    throw new F3dFormatError(`Entry ${entry.name} expands too far`);
  }
  const local = new ByteReader(bytes, entry.localOffset);
  if (local.u32() !== SIG_LOCAL) throw new F3dFormatError('Malformed ZIP local header');
  local.skip(22);
  const nameLength = local.u16();
  const extraLength = local.u16();
  local.skip(nameLength + extraLength);
  const start = local.pos;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new F3dFormatError(`Entry ${entry.name} runs past the archive`);
  const data = bytes.subarray(start, end);

  let out: Uint8Array;
  switch (entry.method) {
    case METHOD_STORED:
      out = data;
      break;
    case METHOD_DEFLATE:
      out = inflateSync(data, { out: new Uint8Array(entry.size) });
      break;
    case METHOD_ZSTD:
      // Sized to the declared length: the decoder has no limit of its own.
      out = zstdDecompress(data, new Uint8Array(entry.size));
      break;
    default:
      throw new F3dFormatError(`Entry ${entry.name} uses unsupported compression ${entry.method}`);
  }
  if (out.length > MAX_ENTRY_BYTES) throw new F3dFormatError(`Entry ${entry.name} is too large`);
  return out;
}

export type F3dDesignStreams = {
  meta: Uint8Array;
  bulk: Uint8Array;
  /** The design's B-rep streams, inflated when asked for. */
  breps(): Uint8Array[];
};

const DESIGN_STREAM = /^(.*\/)(Design1|FusionDesignSegmentType1)\/(Meta|Bulk)Stream\.dat$/;

/** The design segment's two streams. A file can hold other asset states beside the active one, so a path marked `[Active]` wins. */
function streamsOf(bytes: Uint8Array, entries: ZipEntry[]): F3dDesignStreams {
  const matches = entries.filter((e) => DESIGN_STREAM.test(e.name));
  const preferred = matches.filter((e) => e.name.includes('[Active]'));
  const pool = preferred.length > 0 ? preferred : matches;
  const meta = pool.find((e) => e.name.endsWith('MetaStream.dat'));
  if (!meta) throw new F3dFormatError('This file has no design data');
  const folder = DESIGN_STREAM.exec(meta.name) as RegExpExecArray;
  const bulkName = `${folder[1]}${folder[2]}/BulkStream.dat`;
  const bulk = entries.find((e) => e.name === bulkName);
  if (!bulk) throw new F3dFormatError('This file has no design data');

  const prefix = folder[1] as string;
  const brepEntries = entries.filter((e) => e.name.startsWith(`${prefix}Breps.BlobParts/`) && /\.smbh?$/.test(e.name));
  return {
    meta: readEntry(bytes, meta),
    bulk: readEntry(bytes, bulk),
    breps: () => brepEntries.map((e) => readEntry(bytes, e)),
  };
}

/** One design of a package: what it is called, and which member each of its link roles opens. */
type PackageObject = { name: string | null; roles: Map<string, string> };

type Description = {
  designDescription?: {
    designGraphs?: {
      rootIds?: unknown[];
      designObjects?: {
        id: unknown;
        relativePath?: unknown;
        friendlyName?: unknown;
        references?: { relationships?: { id: unknown; metadata?: { neutronRole?: unknown } }[] }[];
      }[];
    }[];
  };
};

/** The objects of a package's description, by member path. */
function readDescription(
  bytes: Uint8Array,
  entries: ZipEntry[],
): { objects: Map<string, PackageObject>; root: string | null } {
  const objects = new Map<string, PackageObject>();
  const entry = entries.find((e) => e.name === 'DesignDescription.json');
  if (!entry) return { objects, root: null };
  try {
    const parsed = JSON.parse(strFromU8(readEntry(bytes, entry))) as Description;
    const graph = parsed.designDescription?.designGraphs?.[0];
    const list = graph?.designObjects ?? [];
    const pathOf = new Map(list.map((o) => [o.id, o.relativePath]));
    for (const o of list) {
      if (typeof o.relativePath !== 'string') continue;
      const roles = new Map<string, string>();
      for (const reference of o.references ?? []) {
        for (const r of reference.relationships ?? []) {
          const role = r.metadata?.neutronRole;
          const member = pathOf.get(r.id);
          if (typeof role === 'string' && typeof member === 'string') roles.set(role.toLowerCase(), member);
        }
      }
      objects.set(o.relativePath, { name: typeof o.friendlyName === 'string' ? o.friendlyName : null, roles });
    }
    const root = list.find((o) => o.id === graph?.rootIds?.[0])?.relativePath;
    return { objects, root: typeof root === 'string' ? root : null };
  } catch {
    // A package with an unreadable description still has its root design.
    return { objects, root: null };
  }
}

/** A `.f3d`, or a `.f3z` with the designs its root links to. */
export type F3dPackage = {
  /** The root design's member path, or `''` for a lone `.f3d`. */
  root: string;
  /** The streams of a design, inflated when asked for. */
  open(path: string): F3dDesignStreams;
  /** A design's link roles, lower case, to the member each opens. */
  roles(path: string): ReadonlyMap<string, string>;
  nameOf(path: string): string | null;
};

const NO_ROLES: ReadonlyMap<string, string> = new Map();

export function readPackage(input: Uint8Array): F3dPackage {
  const top = readDirectory(input);
  const members = top.filter((e) => /\.f3d$/i.test(e.name));
  if (members.length === 0)
    return { root: '', open: () => streamsOf(input, top), roles: () => NO_ROLES, nameOf: () => null };

  const { objects, root: described } = readDescription(input, top);
  let root = members.find((e) => e.name === described);
  const manifest = top.find((e) => e.name === 'Manifest.json');
  if (!root && manifest) {
    try {
      const parsed = JSON.parse(strFromU8(readEntry(input, manifest))) as { root?: unknown };
      root = members.find((e) => e.name === parsed.root);
    } catch {
      // A package with an unreadable manifest still has its first member.
    }
  }
  root ??= members[0] as ZipEntry;
  return {
    root: root.name,
    open: (path) => {
      const member = members.find((e) => e.name === path);
      if (!member) throw new F3dFormatError(`Package has no member ${path}`);
      const bytes = readEntry(input, member);
      return streamsOf(bytes, readDirectory(bytes));
    },
    roles: (path) => objects.get(path)?.roles ?? NO_ROLES,
    nameOf: (path) => objects.get(path)?.name ?? null,
  };
}

/** The root design's streams. */
export function readDesignStreams(input: Uint8Array): F3dDesignStreams {
  const pack = readPackage(input);
  return pack.open(pack.root);
}

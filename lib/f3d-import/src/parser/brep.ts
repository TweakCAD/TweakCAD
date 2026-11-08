/**
 * The B-rep streams, read as far as naming needs: faces, the tags that tie them
 * to the features that made them, and their surfaces.
 *
 * A stream is a sequence of tagged values grouped into records, each starting
 * with its class chain, most derived first. Pointers count records, except that
 * a history section sits outside the numbering. A face's tags live in attribute
 * records that name the face as their owner.
 */

import { F3dFormatError } from './byteReader';

export type Vec3 = [number, number, number];

/** A surface in the file's centimetres. */
export type BrepSurface =
  | { kind: 'plane'; origin: Vec3; normal: Vec3 }
  | { kind: 'cone'; origin: Vec3; axis: Vec3; radius: number; sine: number; cosine: number }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'torus'; center: Vec3; axis: Vec3; major: number; minor: number };

export type FaceTag = { token: string; ops: number[] };

export type BrepFace = { tags: FaceTag[]; surface: BrepSurface | null };

type Value = number | string | boolean | Vec3 | null;

type Record = {
  classes: string[];
  pointers: number[];
  values: Value[];
};

const decoder = new TextDecoder('latin1');

function readStream(bytes: Uint8Array): Record[] {
  const magic = decoder.decode(bytes.subarray(0, 15));
  const width = magic === 'ASM BinaryFile8' ? 8 : magic === 'ASM BinaryFile4' ? 4 : 0;
  if (width === 0) throw new F3dFormatError('Unknown B-rep stream');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The header ends where the first string token, the product name, starts.
  let p = -1;
  for (let q = 23; q < 80; q++) {
    if (bytes[q] === 7 && (bytes[q + 1] as number) > 4 && (bytes[q + 1] as number) < 40) {
      p = q;
      break;
    }
  }
  if (p < 0) throw new F3dFormatError('Malformed B-rep header');

  const integer = (at: number): number => (width === 8 ? Number(view.getBigInt64(at, true)) : view.getInt32(at, true));

  const records: Record[] = [];
  let current: Record = { classes: [], pointers: [], values: [] };
  let depth = 0;
  const end = bytes.length;

  while (p < end) {
    const tag = bytes[p++] as number;
    switch (tag) {
      case 0x00:
        break;
      case 0x01:
      case 0x02:
        p += 1;
        break;
      case 0x03:
        p += 2;
        break;
      case 0x04:
        if (depth === 0) current.values.push(integer(p));
        p += width;
        break;
      case 0x05:
        p += 4;
        break;
      case 0x06:
        if (depth === 0) current.values.push(view.getFloat64(p, true));
        p += 8;
        break;
      case 0x07:
      case 0x0d:
      case 0x0e: {
        const length = bytes[p++] as number;
        if (p + length > end) throw new F3dFormatError('Truncated B-rep string');
        if (depth === 0) {
          const text = decoder.decode(bytes.subarray(p, p + length));
          if (tag === 0x07) current.values.push(text);
          else current.classes.push(text);
        }
        p += length;
        break;
      }
      case 0x08:
        p += 2 + view.getUint16(p, true);
        break;
      case 0x09:
      case 0x12: {
        const length = width === 8 ? Number(view.getBigUint64(p, true)) : view.getUint32(p, true);
        p += width + length;
        break;
      }
      case 0x0a:
        if (depth === 0) current.values.push(false);
        break;
      case 0x0b:
        if (depth === 0) current.values.push(true);
        break;
      case 0x0c:
        if (depth === 0) current.pointers.push(integer(p));
        p += width;
        break;
      case 0x0f:
        depth++;
        break;
      case 0x10:
        depth--;
        break;
      case 0x11:
        records.push(current);
        current = { classes: [], pointers: [], values: [] };
        depth = 0;
        break;
      case 0x13:
      case 0x14:
        if (depth === 0) {
          current.values.push([view.getFloat64(p, true), view.getFloat64(p + 8, true), view.getFloat64(p + 16, true)]);
        }
        p += 24;
        break;
      case 0x15:
      case 0x17:
        p += width;
        break;
      case 0x16:
        p += 16;
        break;
      default:
        throw new F3dFormatError(`Unknown B-rep token ${tag}`);
    }
  }
  return records;
}

/** Records in pointer order: the history section is left out, its closing marker kept. */
function addressable(records: readonly Record[]): Record[] {
  const out: Record[] = [];
  let inHistory = false;
  for (const record of records) {
    const chain = record.classes.join(' ');
    if (chain.startsWith('Begin of ASM History')) {
      inHistory = true;
      continue;
    }
    if (chain.startsWith('End of ASM History Section')) {
      inHistory = false;
      out.push({ ...record, classes: record.classes.slice(5) });
      continue;
    }
    if (!inHistory) out.push(record);
  }
  return out;
}

const isVec = (v: Value): v is Vec3 => Array.isArray(v);
const vecs = (r: Record): Vec3[] => r.values.filter(isVec);
const numbers = (r: Record): number[] => r.values.filter((v): v is number => typeof v === 'number');

function readSurface(r: Record | undefined): BrepSurface | null {
  if (!r) return null;
  const [kind] = r.classes;
  const v = vecs(r);
  const n = numbers(r).slice(1); // the first number is a slot, not a value
  if (kind === 'plane' && v[0] && v[1]) return { kind: 'plane', origin: v[0], normal: v[1] };
  if (kind === 'cone' && v[0] && v[1] && v[2]) {
    const [, sine = 0, cosine = 1] = n;
    return { kind: 'cone', origin: v[0], axis: v[1], radius: Math.hypot(...v[2]), sine, cosine };
  }
  if (kind === 'sphere' && v[0]) return { kind: 'sphere', center: v[0], radius: Math.abs(n[0] ?? 0) };
  if (kind === 'torus' && v[0] && v[1]) {
    return { kind: 'torus', center: v[0], axis: v[1], major: n[0] ?? 0, minor: Math.abs(n[1] ?? 0) };
  }
  return null;
}

/** `int groups`, then per group: the token's length, token, 0, count, that many operation ids, 0. */
function readTags(r: Record): FaceTag[] {
  const v = r.values;
  const start = v.findIndex((x) => typeof x === 'string' && x.startsWith('generic_tag_attrib_def '));
  if (start < 0) return [];
  const tags: FaceTag[] = [];
  let i = start + 1;
  const groups = v[i++];
  if (typeof groups !== 'number') return [];
  for (let g = 0; g < groups && i < v.length; g++) {
    i++; // the token's length
    const token = v[i++];
    i++; // zero
    const count = v[i++];
    if (typeof token !== 'string' || typeof count !== 'number') break;
    const ops: number[] = [];
    for (let k = 0; k < count; k++) ops.push(v[i++] as number);
    i++; // zero
    tags.push({ token, ops });
  }
  return tags;
}

/** Every face in a stream with its tags and surface. */
export function readBrepFaces(bytes: Uint8Array): BrepFace[] {
  const records = addressable(readStream(bytes));
  const tagsOf = new Map<number, FaceTag[]>();
  for (const r of records) {
    if (r.classes[0] !== 'ATTRIB_CUSTOM') continue;
    const tags = readTags(r);
    if (tags.length === 0) continue;
    const owner = r.pointers[r.pointers.length - 1] as number;
    tagsOf.set(owner, [...(tagsOf.get(owner) ?? []), ...tags]);
  }

  const faces: BrepFace[] = [];
  records.forEach((r, index) => {
    if (r.classes[r.classes.length - 1] !== 'face') return;
    const tags = tagsOf.get(index);
    if (!tags) return;
    const surfaceIndex = r.pointers[r.pointers.length - 1] as number;
    faces.push({ tags, surface: readSurface(records[surfaceIndex]) });
  });
  return faces;
}

/** Faces of a design, looked up by the tag a recipe gives them. */
export class FaceIndex {
  /** By token and operation: one token can sit on thousands of faces, few of them sharing an operation. */
  private readonly byOp = new Map<string, Map<number, number[]>>();
  private readonly listed: BrepFace[] = [];

  add(faces: readonly BrepFace[]): void {
    for (const face of faces) {
      const at = this.listed.length;
      this.listed.push(face);
      for (const tag of face.tags) {
        let ops = this.byOp.get(tag.token);
        if (!ops) this.byOp.set(tag.token, (ops = new Map()));
        for (const op of tag.ops) {
          const list = ops.get(op);
          if (!list) ops.set(op, [at]);
          else if (list[list.length - 1] !== at) list.push(at);
        }
      }
    }
  }

  /**
   * Faces carrying this tag, best first. A face keeps its tag as later features
   * change it, gaining their operations, so the closest list of operations is
   * the state the feature saw.
   */
  find(tag: FaceTag): BrepFace[] {
    const ops = this.byOp.get(tag.token);
    if (!ops) return [];
    const candidates = new Set<number>();
    for (const op of tag.ops) for (const at of ops.get(op) ?? []) candidates.add(at);
    const wanted = new Set(tag.ops);
    const found: { at: number; difference: number }[] = [];
    for (const at of candidates) {
      for (const t of (this.listed[at] as BrepFace).tags) {
        if (t.token !== tag.token || !t.ops.some((op) => wanted.has(op))) continue;
        const own = new Set(t.ops);
        found.push({
          at,
          difference: t.ops.filter((op) => !wanted.has(op)).length + tag.ops.filter((op) => !own.has(op)).length,
        });
        break;
      }
    }
    return found.sort((a, b) => a.difference - b.difference || a.at - b.at).map((f) => this.listed[f.at] as BrepFace);
  }
}

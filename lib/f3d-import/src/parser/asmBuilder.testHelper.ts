/**
 * Builds ASM B-rep streams for tests: records written as tagged values, the
 * way a stream stores them, and a box solid made of them.
 */
import type { Item, Vec3 } from './asm';

export type BuiltRecord = { classes: string[]; items: Item[] };

const ref = (v: number): Item => ({ t: 'ref', v });
const int = (v: number): Item => ({ t: 'int', v });
const bool = (v: boolean): Item => ({ t: 'bool', v });
const pos = (v: Vec3): Item => ({ t: 'pos', v });
const vec = (v: Vec3): Item => ({ t: 'vec', v });
const f64 = (v: number): Item => ({ t: 'f64', v });
const str = (v: string): Item => ({ t: 'str', v });

/** The entity header every record starts with: no attributes, no history number, a reserved pointer. */
const head = (attrib = -1): Item[] => [ref(attrib), int(-1), ref(-1)];

class Bytes {
  private readonly out: number[] = [];
  byte(b: number): void {
    this.out.push(b & 0xff);
  }
  u32(v: number): void {
    for (let i = 0; i < 4; i++) this.byte(v >>> (8 * i));
  }
  i64(v: number): void {
    const b = new DataView(new ArrayBuffer(8));
    b.setBigInt64(0, BigInt(v), true);
    for (let i = 0; i < 8; i++) this.byte(b.getUint8(i));
  }
  f64(v: number): void {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.byte(b.getUint8(i));
  }
  text(tag: number, s: string): void {
    const t = new TextEncoder().encode(s);
    this.byte(tag);
    this.byte(t.length);
    for (const c of t) this.byte(c);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

function item(b: Bytes, x: Item): void {
  switch (x.t) {
    case 'int':
      b.byte(0x04);
      b.i64(x.v);
      break;
    case 'enum':
      b.byte(0x15);
      b.i64(x.v);
      break;
    case 'ref':
      b.byte(0x0c);
      b.i64(x.v);
      break;
    case 'f64':
      b.byte(0x06);
      b.f64(x.v);
      break;
    case 'str':
      b.text(0x07, x.v);
      break;
    case 'bool':
      b.byte(x.v ? 0x0a : 0x0b);
      break;
    case 'pos':
    case 'vec':
      b.byte(x.t === 'pos' ? 0x13 : 0x14);
      for (const c of x.v) b.f64(c);
      break;
    case 'uv':
      b.byte(0x16);
      for (const c of x.v) b.f64(c);
      break;
    case 'sub':
      b.byte(0x0f);
      for (const [i, inner] of x.v.entries()) {
        // A subtype's name is a class token.
        if (i === 0 && inner.t === 'str') b.text(0x0d, inner.v);
        else item(b, inner);
      }
      b.byte(0x10);
      break;
  }
}

/** A `BinaryFile8` stream of `records`, after the header record. */
export function asmStream(records: readonly BuiltRecord[]): Uint8Array {
  const b = new Bytes();
  for (const c of 'ASM BinaryFile8') b.byte(c.charCodeAt(0));
  b.u32(23200);
  for (let i = 0; i < 12; i++) b.byte(0);
  const bodies = records.filter((r) => r.classes[0] === 'body').length;
  b.i64(1 + bodies);
  b.i64(0);
  b.text(0x07, 'Test');
  b.text(0x07, 'ASM 232.4.0.65535 NT');
  b.text(0x07, 'Mon Nov 10 00:00:00 2026');
  b.byte(0x06);
  b.f64(10);
  b.byte(0x06);
  b.f64(1e-6);
  b.byte(0x06);
  b.f64(1e-10);
  b.byte(0x11);
  for (const r of records) {
    r.classes.forEach((c, i) => b.text(i === r.classes.length - 1 ? 0x0d : 0x0e, c));
    for (const x of r.items) item(b, x);
    b.byte(0x11);
  }
  for (const [i, c] of ['End', 'of', 'ASM', 'data'].entries()) b.text(i === 3 ? 0x0d : 0x0e, c);
  return b.bytes();
}

/**
 * An axis-aligned box from `min` to `max`, in centimetres, as one body. Each
 * face's loop runs counter-clockwise seen from outside; `key` is the body's key.
 */
export function boxRecords(min: Vec3, max: Vec3, key = -1): BuiltRecord[] {
  const records: BuiltRecord[] = [];
  const add = (classes: string[], items: Item[]): number => {
    records.push({ classes, items });
    return records.length; // Record 0 is the header.
  };
  const corner = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  // Faces as corner cycles, counter-clockwise seen from outside, with their outward normals.
  const faces: { cycle: number[]; normal: Vec3 }[] = [
    { cycle: [0, 2, 3, 1], normal: [0, 0, -1] },
    { cycle: [4, 5, 7, 6], normal: [0, 0, 1] },
    { cycle: [0, 1, 5, 4], normal: [0, -1, 0] },
    { cycle: [2, 6, 7, 3], normal: [0, 1, 0] },
    { cycle: [0, 4, 6, 2], normal: [-1, 0, 0] },
    { cycle: [1, 3, 7, 5], normal: [1, 0, 0] },
  ];
  // Record numbers are known ahead: lay out the indices first.
  const body = 1;
  const lump = 2;
  const shell = 3;
  let next = 4;
  const faceAt = faces.map(() => next++);
  const loopAt = faces.map(() => next++);
  const surfaceAt = faces.map(() => next++);
  const coedgeAt = faces.map(() => [0, 1, 2, 3].map(() => next++));
  const edgeKeys: string[] = [];
  const edgeOf = new Map<string, { at: number; from: number; to: number }>();
  for (const f of faces)
    for (let i = 0; i < 4; i++) {
      const a = f.cycle[i] as number;
      const c = f.cycle[(i + 1) % 4] as number;
      const k = `${Math.min(a, c)}-${Math.max(a, c)}`;
      if (!edgeOf.has(k)) {
        edgeKeys.push(k);
        edgeOf.set(k, { at: 0, from: Math.min(a, c), to: Math.max(a, c) });
      }
    }
  for (const k of edgeKeys) (edgeOf.get(k) as { at: number }).at = next++;
  const curveAt = new Map(edgeKeys.map((k) => [k, next++]));
  const vertexAt = [0, 1, 2, 3, 4, 5, 6, 7].map(() => next++);
  const pointAt = [0, 1, 2, 3, 4, 5, 6, 7].map(() => next++);

  // The coedges of each edge, for partners.
  const uses = new Map<string, number[]>();
  faces.forEach((f, fi) =>
    f.cycle.forEach((a, i) => {
      const c = f.cycle[(i + 1) % 4] as number;
      const k = `${Math.min(a, c)}-${Math.max(a, c)}`;
      uses.set(k, [...(uses.get(k) ?? []), (coedgeAt[fi] as number[])[i] as number]);
    }),
  );

  add(['body'], [ref(-1), int(key), ref(-1), ref(lump), ref(-1), ref(-1)]);
  add(['lump'], [...head(), ref(-1), ref(shell), ref(body)]);
  add(['shell'], [...head(), ref(-1), ref(-1), ref(faceAt[0] as number), ref(-1), ref(lump)]);
  faces.forEach((_, i) =>
    add(
      ['face'],
      [
        ...head(),
        ref(i + 1 < faces.length ? (faceAt[i + 1] as number) : -1),
        ref(loopAt[i] as number),
        ref(shell),
        ref(-1),
        ref(surfaceAt[i] as number),
        bool(false),
        bool(false),
      ],
    ),
  );
  faces.forEach((_, i) =>
    add(['loop'], [...head(), ref(-1), ref((coedgeAt[i] as number[])[0] as number), ref(faceAt[i] as number)]),
  );
  faces.forEach((f) => {
    const p = corner(f.cycle[0] as number);
    const q = corner(f.cycle[1] as number);
    add(
      ['plane', 'surface'],
      [
        ...head(),
        pos(p),
        vec(f.normal),
        vec([q[0] - p[0], q[1] - p[1], q[2] - p[2]].map((x) => Math.sign(x)) as Vec3),
        bool(false),
        bool(false),
        bool(false),
        bool(false),
        bool(false),
      ],
    );
  });
  faces.forEach((f, fi) =>
    f.cycle.forEach((a, i) => {
      const c = f.cycle[(i + 1) % 4] as number;
      const k = `${Math.min(a, c)}-${Math.max(a, c)}`;
      const ring = coedgeAt[fi] as number[];
      const partner = (uses.get(k) as number[]).find((u) => u !== ring[i]) as number;
      add(
        ['coedge'],
        [
          ...head(),
          ref(ring[(i + 1) % 4] as number),
          ref(ring[(i + 3) % 4] as number),
          ref(partner),
          ref((edgeOf.get(k) as { at: number }).at),
          bool(a > c),
          ref(loopAt[fi] as number),
          int(0),
          ref(-1),
        ],
      );
    }),
  );
  for (const k of edgeKeys) {
    const e = edgeOf.get(k) as { at: number; from: number; to: number };
    const length = Math.hypot(...corner(e.to).map((x, i) => x - (corner(e.from)[i] as number)));
    add(
      ['edge'],
      [
        ...head(),
        ref(vertexAt[e.from] as number),
        f64(0),
        ref(vertexAt[e.to] as number),
        f64(length),
        ref((uses.get(k) as number[])[0] as number),
        ref(curveAt.get(k) as number),
        bool(false),
        str('unknown'),
      ],
    );
  }
  for (const k of edgeKeys) {
    const e = edgeOf.get(k) as { from: number; to: number };
    const p = corner(e.from);
    const q = corner(e.to);
    const length = Math.hypot(...q.map((x, i) => x - (p[i] as number)));
    add(
      ['straight', 'curve'],
      [...head(), pos(p), vec(q.map((x, i) => (x - (p[i] as number)) / length) as Vec3), bool(false), bool(false)],
    );
  }
  const edgeAtVertex = (v: number): number =>
    (edgeOf.get(edgeKeys.find((k) => k.split('-').map(Number).includes(v)) as string) as { at: number }).at;
  vertexAt.forEach((_, v) => add(['vertex'], [...head(), ref(edgeAtVertex(v)), int(0), ref(pointAt[v] as number)]));
  pointAt.forEach((_, v) => add(['point'], [...head(), pos(corner(v))]));
  return records;
}

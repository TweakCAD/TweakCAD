/**
 * Builds small design streams byte by byte, for tests. Real files can't be kept
 * in the repository, so tests describe the layout they rely on here.
 */

import { zipSync } from 'fflate';

export class ByteWriter {
  private parts: number[] = [];

  get length(): number {
    return this.parts.length;
  }
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u32(v: number): this {
    for (let i = 0; i < 4; i++) this.u8(Math.floor(v / 2 ** (8 * i)));
    return this;
  }
  u64(v: number): this {
    return this.u32(v % 2 ** 32).u32(Math.floor(v / 2 ** 32));
  }
  f64(v: number): this {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    b.forEach((x) => this.u8(x));
    return this;
  }
  str8(s: string): this {
    this.u32(s.length);
    for (const c of s) this.u8(c.charCodeAt(0));
    return this;
  }
  wstr(s: string): this {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.u8(c).u8(c >> 8);
    }
    return this;
  }
  ref(id: number): this {
    return this.u8(1).u64(id).u8(0).u8(0);
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

type Level = (w: ByteWriter) => void;
type Spec = { id: number; type: string; primary: Level; secondary?: Level };

/** A record's start: class tag, id, empty name. */
export const head = (w: ByteWriter, id: number): ByteWriter => w.str8('100').u64(id).u32(0);

const guid = (key: string): string => `${key}-0000-0000-0000-000000000000`;

export function buildDesign(
  records: Spec[],
  parents: Record<string, string> = {},
): { meta: Uint8Array; bulk: Uint8Array } {
  const bulk = new ByteWriter();
  const primary: [number, number][] = [];
  const secondary: [number, number][] = [];
  for (const r of records) {
    primary.push([r.id, bulk.length]);
    r.primary(bulk);
    if (r.secondary) {
      secondary.push([r.id, bulk.length]);
      r.secondary(bulk);
    }
  }

  const types = new Map<string, number[]>();
  for (const r of records) types.set(r.type, [...(types.get(r.type) ?? []), r.id]);

  const meta = new ByteWriter();
  meta.str8('Design').u32(1).wstr('00000000-0000-4000-8000-000000000001');
  meta.u32(0).u32(0);
  meta.str8('Design').str8('').u32(0).u32(0);
  meta.u32(types.size);
  for (const [key, ids] of types) {
    meta
      .str8(guid(key))
      .str8(guid(parents[key] ?? '00000000'))
      .u32(1)
      .str8('Geometry')
      .u32(ids.length);
    ids.forEach((id) => meta.u64(id));
  }
  meta.u32(0);
  meta.u32(primary.length);
  primary.forEach(([id, offset]) => meta.u64(id).u64(offset));
  meta.u32(secondary.length);
  secondary.forEach(([id, offset]) => meta.u64(id).u64(offset));
  return { meta: meta.bytes(), bulk: bulk.bytes() };
}

export function buildArchive(streams: { meta: Uint8Array; bulk: Uint8Array }): Uint8Array {
  return zipSync({
    'FusionAssetName[Active]/Design1/MetaStream.dat': [streams.meta, { level: 0 }],
    'FusionAssetName[Active]/Design1/BulkStream.dat': [streams.bulk, { level: 6 }],
  });
}

export const TYPES = {
  sketch: '44A64366',
  placement: 'F47A46FB',
  point: 'C2CEDAE7',
  incidence: '362B7EC3',
  line: 'DCA267ED',
  circle: 'F0130424',
  relation: '60403D47',
  linearDimension: '8C780195',
  parameter: '7A6A3D31',
  parameterOwner: 'D91D429C',
} as const;

/** Point: prologue with an empty property block, incidence reference, flags, x y z. */
export function pointRecord(id: number, incidenceId: number, x: number, y: number): Spec {
  return {
    id,
    type: TYPES.point,
    primary: (w) => {
      head(w, id).u8(0).u8(0);
      w.ref(incidenceId).zeros(8).f64(x).f64(y).f64(0).zeros(32);
    },
  };
}

/** Line: twelve doubles, then the end and start point references. */
export function lineRecord(id: number, start: number, end: number, from: [number, number], to: [number, number]): Spec {
  return {
    id,
    type: TYPES.line,
    primary: (w) => {
      head(w, id).u8(0).u8(0);
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy);
      for (const v of [from[0], from[1], 0, dx, dy, 0, dx / length, dy / length, 0, 0, 0, 1]) w.f64(v);
      w.ref(end).ref(start).zeros(52);
    },
  };
}

export function relationRecord(id: number, sketchId: number, mask: number, loci: number[]): Spec {
  return {
    id,
    type: TYPES.relation,
    primary: (w) => {
      head(w, id).u8(1).u32(loci.length);
      loci.forEach((l) => w.ref(l).u32(0));
      w.u8(0).ref(sketchId).u32(mask).u32(0).u32(0).u8(0);
    },
  };
}

export function sketchRecord(id: number, placementId: number, name: string, owned: number[]): Spec {
  return {
    id,
    type: TYPES.sketch,
    primary: (w) => {
      head(w, id).u8(0).u8(0).zeros(4);
    },
    secondary: (w) => {
      head(w, id).ref(placementId).u32(1).u8(0).u8(0).wstr(name).u8(0).u32(owned.length);
      owned.forEach((o) => w.ref(o));
    },
  };
}

export function placementRecord(id: number, matrix: number[] | null): Spec {
  return {
    id,
    type: TYPES.placement,
    primary: (w) => {
      head(w, id).u8(0).u8(0);
      if (matrix) {
        w.u8(0);
        matrix.forEach((v) => w.f64(v));
      } else {
        w.u8(1);
      }
      w.u8(0);
    },
  };
}

/** Parameter: owner reference, expression, flags, role, unit, name, value. */
export function parameterRecord(
  id: number,
  ownerId: number | null,
  name: string,
  expression: string,
  value: number,
  options: { role?: string; unit?: string; user?: boolean } = {},
): Spec {
  return {
    id,
    type: TYPES.parameter,
    primary: (w) => {
      head(w, id).u8(0).u8(0).zeros(9);
      if (ownerId !== null) w.ref(ownerId);
      else w.u8(0);
      w.wstr(expression)
        .zeros(4)
        .u8(options.user ? 1 : 0);
      w.wstr(options.role ?? 'Linear Dimension-1')
        .wstr(options.unit ?? 'mm')
        .wstr(name)
        .f64(value)
        .u8(0)
        .zeros(11);
    },
  };
}

export function parameterOwnerRecord(id: number): Spec {
  return { id, type: TYPES.parameterOwner, primary: (w) => void head(w, id).u8(0).u8(0).zeros(4) };
}

export function linearDimensionRecord(
  id: number,
  sketchId: number,
  ownerId: number,
  loci: number[],
  axis: 0 | 0x40 | 0x80 = 0,
): Spec {
  return {
    id,
    type: TYPES.linearDimension,
    primary: (w) => {
      head(w, id).u8(0).u8(0).zeros(8);
      w.u8(0).u8(axis).zeros(5); // the direction byte sits six bytes before the reference
      w.ref(ownerId).u32(loci.length);
      loci.forEach((l) => w.ref(l));
      w.u8(0);
    },
    secondary: (w) => {
      head(w, id).ref(sketchId).zeros(8);
    },
  };
}

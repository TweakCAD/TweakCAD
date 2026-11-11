/**
 * The solids of an ASM B-rep stream as plain topology and geometry, in
 * millimetres: body → lump → shell → face → loop → coedge → edge → vertex, each
 * face with its surface and each edge with its curve. Analytic surfaces and
 * curves are read as they are; a free-form one, or an intersection curve, is
 * read from the B-spline copy the stream keeps of it.
 *
 * Fields are read by position after the entity header (attribute chain,
 * history number, one reserved pointer). Senses compose as the stream defines
 * them: a face's sense is relative to its surface's own normal, an edge's to
 * its curve, a coedge's to its edge, and an `intcurve` or `spline` record can
 * itself be the reverse of the B-spline it stores.
 */

import { F3dFormatError } from './byteReader';
import type { AsmRecord, AsmStream, Item, Vec3 } from './asm';

export type { Vec3 } from './asm';

export type BodySurface =
  | { kind: 'plane'; origin: Vec3; normal: Vec3; x: Vec3 }
  | { kind: 'cylinder'; origin: Vec3; axis: Vec3; x: Vec3; radius: number }
  | { kind: 'cone'; origin: Vec3; axis: Vec3; x: Vec3; radius: number; semiAngle: number }
  | { kind: 'sphere'; origin: Vec3; axis: Vec3; x: Vec3; radius: number }
  | { kind: 'torus'; origin: Vec3; axis: Vec3; x: Vec3; major: number; minor: number }
  /** An elliptical cylinder, turning about `axis` from `x`; made a B-spline once its faces' extent is known. */
  | { kind: 'ellipticCylinder'; origin: Vec3; axis: Vec3; x: Vec3; major: number; minor: number }
  | {
      kind: 'bspline';
      uDegree: number;
      vDegree: number;
      uKnots: number[];
      uMults: number[];
      vKnots: number[];
      vMults: number[];
      /** Control points by u, then v. */
      poles: Vec3[][];
      weights?: number[][];
    };

export type BodyCurve =
  | { kind: 'line'; origin: Vec3; direction: Vec3 }
  | { kind: 'circle'; origin: Vec3; axis: Vec3; x: Vec3; radius: number }
  | { kind: 'ellipse'; origin: Vec3; axis: Vec3; x: Vec3; major: number; minor: number }
  | { kind: 'bspline'; degree: number; knots: number[]; mults: number[]; poles: Vec3[]; weights?: number[] };

export type BodyEdge = {
  start: number;
  end: number;
  curve: BodyCurve;
  /** Whether the edge runs, start to end, the way its curve does. */
  sameSense: boolean;
};

/** A face boundary: edges in order, each used forward or backward, or a single point. */
export type BodyLoop = { edges: { edge: number; forward: boolean }[] } | { vertex: number };

export type BodyFace = {
  surface: BodySurface;
  /** Whether the face's outward normal is its surface's normal. */
  sameSense: boolean;
  loops: BodyLoop[];
};

/** A solid: its outer shell first, then the shells of its voids. */
export type BodySolid = { shells: BodyFace[][] };

export type ReadBody = {
  solids: BodySolid[];
  vertices: Vec3[];
  edges: BodyEdge[];
};

/** A body this reader cannot write, with the reason. */
export class BodyRefusal extends Error {}

/** Model space: centimetres to millimetres, then `matrix` (row-major 4 × 4), when given. */
export type Placement = (p: Vec3, direction: boolean) => Vec3;

export function placement(matrix?: readonly number[]): Placement {
  return (p, direction) => {
    const s = direction ? p : ([p[0] * 10, p[1] * 10, p[2] * 10] as Vec3);
    if (!matrix) return s;
    const m = matrix;
    const w = direction ? 0 : 1;
    return [
      (m[0] as number) * s[0] + (m[1] as number) * s[1] + (m[2] as number) * s[2] + (m[3] as number) * w,
      (m[4] as number) * s[0] + (m[5] as number) * s[1] + (m[6] as number) * s[2] + (m[7] as number) * w,
      (m[8] as number) * s[0] + (m[9] as number) * s[1] + (m[10] as number) * s[2] + (m[11] as number) * w,
    ];
  };
}

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const unit = (v: Vec3): Vec3 => {
  const n = norm(v);
  if (!(n > 0)) throw new BodyRefusal('a direction has no length');
  return [v[0] / n, v[1] / n, v[2] / n];
};
const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

/** Reads typed values in order, skipping optional range ends (`false`, or `true` and a number). */
class Cursor {
  private i = 0;
  constructor(private readonly items: Item[]) {}
  private next(t: Item['t']): Item {
    const item = this.items[this.i++];
    if (!item || item.t !== t) throw new BodyRefusal(`unexpected value in a ${t} slot`);
    return item;
  }
  pos(): Vec3 {
    return this.next('pos').v as Vec3;
  }
  vec(): Vec3 {
    return this.next('vec').v as Vec3;
  }
  f64(): number {
    return this.next('f64').v as number;
  }
  int(): number {
    const item = this.items[this.i++];
    if (!item || (item.t !== 'int' && item.t !== 'enum')) throw new BodyRefusal('unexpected value in an integer slot');
    return item.v;
  }
  bool(): boolean {
    return this.next('bool').v as boolean;
  }
  str(): string {
    return this.next('str').v as string;
  }
  range(): void {
    if (this.bool()) this.f64();
  }
  /** An optional range end: its value, or null when it is open. */
  bound(): number | null {
    return this.bool() ? this.f64() : null;
  }
  get done(): boolean {
    return this.i >= this.items.length;
  }
  peek(): Item | undefined {
    return this.items[this.i];
  }
  skip(n = 1): void {
    this.i += n;
  }
  get at(): number {
    return this.i;
  }
  set at(i: number) {
    this.i = i;
  }
}

/** The values of a record after its entity header (attribute, history number, reserved pointer). */
function payload(r: AsmRecord): Item[] {
  return r.items.slice(3);
}

const refAt = (r: AsmRecord, i: number): number => {
  const item = r.items[i];
  return item && item.t === 'ref' ? item.v : -1;
};
const boolAt = (r: AsmRecord, i: number): boolean => {
  const item = r.items[i];
  return item?.t === 'bool' ? item.v : false;
};

const is = (r: AsmRecord | undefined, kind: string): boolean => !!r && r.classes.includes(kind);

/** Every subtype definition of the stream in order, as `ref N` names them. */
function subtypeTable(records: readonly AsmRecord[]): Item[][] {
  const table: Item[][] = [];
  const walk = (items: Item[]): void => {
    for (const item of items) {
      if (item.t !== 'sub') continue;
      const first = item.v[0];
      if (first?.t === 'str' && first.v !== 'ref') table.push(item.v);
      walk(item.v);
    }
  };
  for (const r of records) walk(r.items);
  return table;
}

/** A subtype, through `ref N` when it is one. */
function resolve(sub: Item[], table: Item[][], depth = 0): Item[] {
  const first = sub[0];
  if (first?.t === 'str' && first.v === 'ref') {
    const n = sub[1];
    const target = n && (n.t === 'int' || n.t === 'enum') ? table[n.v] : undefined;
    if (!target || depth > 64) throw new BodyRefusal('a shared curve or surface is missing');
    return resolve(target, table, depth + 1);
  }
  return sub;
}

type Knots = { knots: number[]; mults: number[] };

function readKnots(c: Cursor, count: number): Knots {
  const knots: number[] = [];
  const mults: number[] = [];
  for (let k = 0; k < count; k++) {
    knots.push(c.f64());
    mults.push(c.int());
  }
  return { knots, mults };
}

/** The stream keeps end knots one short: a curve of degree p ends on p, where B-spline readers expect p + 1. */
function clamp({ knots, mults }: Knots): Knots {
  const out = [...mults];
  out[0] = (out[0] as number) + 1;
  out[out.length - 1] = (out[out.length - 1] as number) + 1;
  return { knots, mults: out };
}

const poleCount = (mults: number[], degree: number): number => mults.reduce((a, b) => a + b, 0) - (degree - 1);

/** A `nubs` or `nurbs` curve block starting at the cursor's name. */
function readCurveBlock(c: Cursor, place: Placement): BodyCurve {
  const rational = c.str() === 'nurbs';
  const degree = c.int();
  if (c.peek()?.t === 'str') c.str();
  c.int(); // closure
  const count = c.int();
  const knots = readKnots(c, count);
  const n = poleCount(knots.mults, degree);
  if (!(n > degree) || n > 1_000_000) throw new BodyRefusal('a B-spline curve has a bad knot vector');
  const poles: Vec3[] = [];
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    poles.push(place([c.f64(), c.f64(), c.f64()], false));
    if (rational) weights.push(c.f64());
  }
  const { knots: k, mults } = clamp(knots);
  return { kind: 'bspline', degree, knots: k, mults, poles, ...(rational ? { weights } : {}) };
}

/** A `nubs` or `nurbs` surface block starting at the cursor's name. */
function readSurfaceBlock(c: Cursor, place: Placement): BodySurface {
  const rational = c.str() === 'nurbs';
  const uDegree = c.int();
  const vDegree = c.int();
  // A rational surface says in which directions it is rational.
  if (c.peek()?.t === 'str') c.str();
  c.int(); // u closure
  c.int(); // v closure
  c.int(); // u singularity
  c.int(); // v singularity
  const uCount = c.int();
  const vCount = c.int();
  const u = readKnots(c, uCount);
  const v = readKnots(c, vCount);
  const nu = poleCount(u.mults, uDegree);
  const nv = poleCount(v.mults, vDegree);
  if (!(nu > uDegree) || !(nv > vDegree) || nu * nv > 4_000_000)
    throw new BodyRefusal('a B-spline surface has a bad knot vector');
  // Stored v outer, u inner.
  const poles: Vec3[][] = Array.from({ length: nu }, () => []);
  const weights: number[][] = Array.from({ length: nu }, () => []);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      (poles[i] as Vec3[]).push(place([c.f64(), c.f64(), c.f64()], false));
      if (rational) (weights[i] as number[]).push(c.f64());
    }
  }
  const uc = clamp(u);
  const vc = clamp(v);
  return {
    kind: 'bspline',
    uDegree,
    vDegree,
    uKnots: uc.knots,
    uMults: uc.mults,
    vKnots: vc.knots,
    vMults: vc.mults,
    poles,
    ...(rational ? { weights } : {}),
  };
}

const isBlockName = (item: Item | undefined): boolean => item?.t === 'str' && (item.v === 'nubs' || item.v === 'nurbs');

/** The first B-spline curve block directly in a subtype: an intersection curve's own copy. */
function curveCache(sub: Item[], place: Placement): BodyCurve {
  for (let i = 0; i < sub.length; i++) {
    if (!isBlockName(sub[i])) continue;
    const c = new Cursor(sub);
    c.at = i;
    try {
      return readCurveBlock(c, place);
    } catch {
      // Not a curve block here; keep looking.
    }
  }
  throw new BodyRefusal(`the curve ${String(sub[0]?.v)} keeps no B-spline`);
}

/** The last B-spline surface block directly in a subtype: a free-form surface's own copy. */
function surfaceCache(sub: Item[], place: Placement): BodySurface {
  for (let i = sub.length - 1; i >= 0; i--) {
    if (!isBlockName(sub[i])) continue;
    const c = new Cursor(sub);
    c.at = i;
    try {
      return readSurfaceBlock(c, place);
    } catch {
      // Not a surface block here; keep looking.
    }
  }
  throw new BodyRefusal(`the surface ${String(sub[0]?.v)} keeps no B-spline`);
}

/**
 * A curve swept along a vector (`cyl_spl_sur`) that keeps no B-spline of
 * itself: S(u, v) = C(u) + v·E over the stored v range, written as the
 * B-spline of its curve's copy, straight in v. Its normal is C' × E, so a
 * reversed curve turns it over.
 */
function sweptCurve(sub: Item[], table: Item[][], place: Placement): { surface: BodySurface; flipped: boolean } {
  const c = new Cursor(sub);
  c.str();
  if (c.peek()?.t !== 'int') throw new BodyRefusal('this form of swept surface is not read yet');
  c.int();
  if (c.str() !== 'intcurve') throw new BodyRefusal('a swept surface of this curve is not read yet');
  const reversed = c.bool();
  const inner = c.peek();
  if (inner?.t !== 'sub') throw new BodyRefusal('a swept surface has no curve');
  c.skip();
  const curve = curveCache(resolve(inner.v, table), place);
  if (curve.kind !== 'bspline') throw new BodyRefusal('a swept surface has no curve');
  c.range();
  c.range();
  const along = place(c.vec(), true);
  c.pos();
  if (c.int() !== 2) throw new BodyRefusal('a swept surface keeps no B-spline');
  c.range();
  c.range();
  const v0 = c.bound();
  const v1 = c.bound();
  if (v0 === null || v1 === null) throw new BodyRefusal('a swept surface has no length');
  const step = (p: Vec3, v: number): Vec3 => [
    p[0] + v * 10 * along[0],
    p[1] + v * 10 * along[1],
    p[2] + v * 10 * along[2],
  ];
  return {
    surface: {
      kind: 'bspline',
      uDegree: curve.degree,
      vDegree: 1,
      uKnots: curve.knots,
      uMults: curve.mults,
      vKnots: [v0, v1],
      vMults: [2, 2],
      poles: curve.poles.map((p) => [step(p, v0), step(p, v1)]),
      ...(curve.weights ? { weights: curve.weights.map((w) => [w, w]) } : {}),
    },
    flipped: reversed,
  };
}

/** A surface and whether its normal is the reverse of the stream's own for it. */
function readSurface(r: AsmRecord, table: Item[][], place: Placement): { surface: BodySurface; flipped: boolean } {
  const kind = r.classes[0];
  const c = new Cursor(payload(r));
  switch (kind) {
    case 'plane': {
      const origin = place(c.pos(), false);
      const normal = unit(place(c.vec(), true));
      const x = unit(place(c.vec(), true));
      return { surface: { kind: 'plane', origin, normal, x }, flipped: false };
    }
    case 'cone': {
      const origin = place(c.pos(), false);
      const axis = unit(place(c.vec(), true));
      const major = c.vec();
      const ratio = c.f64();
      c.range();
      c.range();
      const sine = c.f64();
      const cosine = c.f64();
      const radius = norm(major) * 10;
      const x = unit(place(major, true));
      // The normal points away from the axis when the cosine is positive.
      const flipped = cosine < 0;
      if (Math.abs(Math.abs(ratio) - 1) > 1e-9) {
        if (Math.abs(sine) >= 1e-12) throw new BodyRefusal('elliptical cones are not read yet');
        // Its section turns the way its ratio says.
        const turn = ratio < 0 ? neg(axis) : axis;
        return {
          surface: { kind: 'ellipticCylinder', origin, axis: turn, x, major: radius, minor: radius * Math.abs(ratio) },
          flipped,
        };
      }
      if (Math.abs(sine) < 1e-12) return { surface: { kind: 'cylinder', origin, axis, x, radius }, flipped };
      const semiAngle = Math.asin(Math.min(1, Math.abs(sine)));
      // The radius grows along the axis when sine / cosine is positive.
      const opens = sine / cosine > 0;
      return {
        surface: { kind: 'cone', origin, axis: opens ? axis : neg(axis), x, radius, semiAngle },
        flipped,
      };
    }
    case 'sphere': {
      const origin = place(c.pos(), false);
      const radius = c.f64();
      const x = unit(place(c.vec(), true));
      const axis = unit(place(c.vec(), true));
      return { surface: { kind: 'sphere', origin, axis, x, radius: Math.abs(radius) * 10 }, flipped: radius < 0 };
    }
    case 'torus': {
      const origin = place(c.pos(), false);
      const axis = unit(place(c.vec(), true));
      const major = c.f64();
      const minor = c.f64();
      const x = unit(place(c.vec(), true));
      if (!(major > 0)) throw new BodyRefusal('a torus with a negative ring radius is not read yet');
      return {
        surface: { kind: 'torus', origin, axis, x, major: major * 10, minor: Math.abs(minor) * 10 },
        flipped: minor < 0,
      };
    }
    case 'spline': {
      const reversed = c.bool();
      const sub = c.peek();
      if (sub?.t !== 'sub') throw new BodyRefusal('a free-form surface has no definition');
      const definition = resolve(sub.v, table);
      try {
        return { surface: surfaceCache(definition, place), flipped: reversed };
      } catch (e) {
        if (definition[0]?.t !== 'str' || definition[0].v !== 'cyl_spl_sur') throw e;
        const swept = sweptCurve(definition, table, place);
        return { surface: swept.surface, flipped: reversed !== swept.flipped };
      }
    }
    default:
      throw new BodyRefusal(`${kind ?? 'unknown'} surfaces are not read yet`);
  }
}

/** A curve and whether it runs the reverse of the stream's own for it. */
function readCurve(r: AsmRecord, table: Item[][], place: Placement): { curve: BodyCurve; reversed: boolean } {
  const kind = r.classes[0];
  const c = new Cursor(payload(r));
  switch (kind) {
    case 'straight': {
      const origin = place(c.pos(), false);
      const direction = unit(place(c.vec(), true));
      return { curve: { kind: 'line', origin, direction }, reversed: false };
    }
    case 'ellipse': {
      const origin = place(c.pos(), false);
      const normal = unit(place(c.vec(), true));
      const major = c.vec();
      const ratio = c.f64();
      const x = unit(place(major, true));
      const a = norm(major) * 10;
      // A negative ratio turns the other way round the normal.
      const axis = ratio < 0 ? neg(normal) : normal;
      if (Math.abs(Math.abs(ratio) - 1) < 1e-12)
        return { curve: { kind: 'circle', origin, axis, x, radius: a }, reversed: false };
      return { curve: { kind: 'ellipse', origin, axis, x, major: a, minor: a * Math.abs(ratio) }, reversed: false };
    }
    case 'intcurve': {
      const reversed = c.bool();
      const sub = c.peek();
      if (sub?.t !== 'sub') throw new BodyRefusal('a curve has no definition');
      return { curve: curveCache(resolve(sub.v, table), place), reversed };
    }
    default:
      throw new BodyRefusal(`${kind ?? 'unknown'} curves are not read yet`);
  }
}

/** Reads bodies of a stream; `transforms` applies each body's own transform. */
export class AsmBodies {
  private readonly records: AsmRecord[];
  private readonly table: Item[][];

  constructor(stream: AsmStream) {
    this.records = stream.records;
    this.table = subtypeTable(stream.records);
  }

  private at(i: number, kind: string): AsmRecord {
    const r = this.records[i];
    if (!r || !is(r, kind)) throw new F3dFormatError(`B-rep record ${i} is not a ${kind}`);
    return r;
  }

  /** Indices of the stream's body records, in order. */
  bodies(): number[] {
    const out: number[] = [];
    this.records.forEach((r, i) => {
      if (r.classes[0] === 'body') out.push(i);
    });
    return out;
  }

  /** A body's key, the number a design names it by; -1 when it has none. */
  key(body: number): number {
    const item = this.at(body, 'body').items[1];
    return item?.t === 'int' ? item.v : -1;
  }

  /**
   * Whether a body holds a sketch's regions rather than a model body: it has
   * edges, every one carrying a sketch link, and no face carries a tag.
   */
  isSketchRegion(body: number): boolean {
    let edges = 0;
    let linked = 0;
    for (const face of this.facesOf(body)) {
      if (this.hasAttribute(face, 'generic_tag_attrib_def')) return false;
      for (const loop of this.chain(refAt(this.records[face] as AsmRecord, 4), 'loop', 3)) {
        for (const coedge of this.ring(loop)) {
          const edge = refAt(this.records[coedge] as AsmRecord, 6);
          edges++;
          if (this.hasAttribute(edge, 'sketch_attrib_def')) linked++;
        }
      }
    }
    return edges > 0 && linked === edges;
  }

  private hasAttribute(entity: number, family: string): boolean {
    let a = refAt(this.records[entity] as AsmRecord, 0);
    for (let guard = 0; a >= 0 && guard < 1000; guard++) {
      const r = this.records[a];
      if (!r) return false;
      if (r.items.some((x) => x.t === 'str' && x.v.startsWith(family))) return true;
      a = refAt(r, 2);
    }
    return false;
  }

  /** Records along a `next` chain from `first`. */
  private chain(first: number, kind: string, next: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let i = first; i >= 0; i = refAt(this.at(i, kind), next)) {
      if (seen.has(i)) throw new F3dFormatError('A B-rep chain loops');
      seen.add(i);
      out.push(i);
    }
    return out;
  }

  /** A loop's coedges in order. */
  private ring(loop: number): number[] {
    const first = refAt(this.at(loop, 'loop'), 4);
    if (first < 0) return [];
    const out: number[] = [];
    const seen = new Set<number>();
    for (let i = first; ;) {
      if (seen.has(i)) throw new F3dFormatError('A B-rep loop runs away');
      seen.add(i);
      out.push(i);
      i = refAt(this.at(i, 'coedge'), 3);
      if (i === first || i < 0) break;
    }
    return out;
  }

  private shellFaces(shell: number): number[] {
    const r = this.at(shell, 'shell');
    const faces = this.chain(refAt(r, 5), 'face', 3);
    const subshells = (first: number, depth: number): void => {
      if (depth > 64) throw new F3dFormatError('B-rep subshells nest too deep');
      for (const s of this.chain(first, 'subshell', 4)) {
        const sr = this.records[s] as AsmRecord;
        faces.push(...this.chain(refAt(sr, 6), 'face', 3));
        subshells(refAt(sr, 5), depth + 1);
      }
    };
    subshells(refAt(r, 4), 0);
    return faces;
  }

  private facesOf(body: number): number[] {
    const out: number[] = [];
    for (const lump of this.chain(refAt(this.at(body, 'body'), 3), 'lump', 3))
      for (const shell of this.chain(refAt(this.at(lump, 'lump'), 4), 'shell', 3)) out.push(...this.shellFaces(shell));
    return out;
  }

  /** The transform a body record names, as a row-major 4 × 4 in centimetres; null when it has none. */
  private transformOf(body: number): number[] | null {
    const t = refAt(this.at(body, 'body'), 5);
    if (t < 0) return null;
    const r = this.records[t];
    if (!r || r.classes[0] !== 'transform') return null;
    const a = payload(r)
      .filter((x) => x.t === 'f64')
      .map((x) => x.v as number);
    if (a.length < 13) return null;
    const s = a[12] as number;
    // Stored by columns: the images of x, y and z, then the translation.
    return [
      s * (a[0] as number),
      s * (a[3] as number),
      s * (a[6] as number),
      a[9] as number,
      s * (a[1] as number),
      s * (a[4] as number),
      s * (a[7] as number),
      a[10] as number,
      s * (a[2] as number),
      s * (a[5] as number),
      s * (a[8] as number),
      a[11] as number,
      0,
      0,
      0,
      1,
    ];
  }

  /**
   * One body, placed by `matrix` (row-major 4 × 4 in millimetres) after its own
   * transform. Refuses a body with a sheet face or a surface or curve not read yet.
   */
  read(body: number, matrix?: readonly number[]): ReadBody {
    const own = this.transformOf(body);
    const inMm = own ? own.map((v, i) => (i === 3 || i === 7 || i === 11 ? v * 10 : v)) : null;
    const total = inMm ? (matrix ? multiply(matrix, inMm) : inMm) : matrix;
    const place = placement(total ?? undefined);

    const vertices: Vec3[] = [];
    const vertexOf = new Map<number, number>();
    const vertex = (v: number): number => {
      let at = vertexOf.get(v);
      if (at === undefined) {
        const point = this.at(refAt(this.at(v, 'vertex'), 5), 'point');
        at = vertices.length;
        vertices.push(place(new Cursor(payload(point)).pos(), false));
        vertexOf.set(v, at);
      }
      return at;
    };
    const edges: BodyEdge[] = [];
    const edgeOf = new Map<number, number | null>();
    const edge = (e: number): number | null => {
      if (edgeOf.has(e)) return edgeOf.get(e) as number | null;
      const r = this.at(e, 'edge');
      const curve = refAt(r, 8);
      const start = vertex(refAt(r, 3));
      const end = vertex(refAt(r, 5));
      let at: number | null = null;
      // An edge with no curve, or a degenerate one, is a point: a cone's tip or a sphere's pole.
      if (curve >= 0 && !is(this.records[curve], 'degenerate_curve')) {
        const read = readCurve(this.records[curve] as AsmRecord, this.table, place);
        at = edges.length;
        edges.push({ start, end, curve: read.curve, sameSense: boolAt(r, 9) === read.reversed });
      }
      edgeOf.set(e, at);
      return at;
    };

    const solids: BodySolid[] = [];
    for (const lump of this.chain(refAt(this.at(body, 'body'), 3), 'lump', 3)) {
      const shells: BodyFace[][] = [];
      for (const shell of this.chain(refAt(this.at(lump, 'lump'), 4), 'shell', 3)) {
        const faces: BodyFace[] = [];
        for (const f of this.shellFaces(shell)) {
          const r = this.at(f, 'face');
          if (boolAt(r, 9)) throw new BodyRefusal('a body with sheet faces is not a solid');
          const { surface, flipped } = readSurface(this.at(refAt(r, 7), 'surface'), this.table, place);
          const loops: BodyLoop[] = [];
          for (const loop of this.chain(refAt(r, 4), 'loop', 3)) {
            const uses: { edge: number; forward: boolean }[] = [];
            let point = -1;
            for (const co of this.ring(loop)) {
              const cr = this.at(co, 'coedge');
              const e = refAt(cr, 6);
              const at = edge(e);
              if (at === null) point = vertex(refAt(this.at(e, 'edge'), 3));
              else uses.push({ edge: at, forward: !boolAt(cr, 7) });
            }
            if (uses.length > 0) loops.push({ edges: uses });
            else if (point >= 0) loops.push({ vertex: point });
          }
          faces.push({
            surface: surface.kind === 'ellipticCylinder' ? ellipticPatch(surface, loops, vertices, edges) : surface,
            sameSense: boolAt(r, 8) === flipped,
            loops,
          });
        }
        if (faces.length > 0) shells.push(faces);
      }
      if (shells.length === 0) continue;
      // The outer shell is the one that reaches furthest.
      const reach = (faces: BodyFace[]): number => {
        const pts = faces.flatMap((f) =>
          f.loops.flatMap((l) =>
            'vertex' in l
              ? [vertices[l.vertex] as Vec3]
              : l.edges.map((u) => vertices[(edges[u.edge] as BodyEdge).start] as Vec3),
          ),
        );
        if (pts.length === 0) return 0;
        const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k] as number)));
        const hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k] as number)));
        return Math.hypot(...hi.map((h, k) => h - (lo[k] as number)));
      };
      shells.sort((a, b) => reach(b) - reach(a));
      solids.push({ shells });
    }
    return { solids, vertices, edges };
  }
}

/**
 * An elliptical cylinder as the exact rational B-spline of the stretch of it
 * a face uses: the ellipse in four quadratic arcs, swept along the axis past
 * every point of the face's boundary. Its normal points away from the axis.
 */
function ellipticPatch(
  s: Extract<BodySurface, { kind: 'ellipticCylinder' }>,
  loops: readonly BodyLoop[],
  vertices: readonly Vec3[],
  edges: readonly BodyEdge[],
): BodySurface {
  const along = (p: Vec3): number =>
    (p[0] - s.origin[0]) * s.axis[0] + (p[1] - s.origin[1]) * s.axis[1] + (p[2] - s.origin[2]) * s.axis[2];
  const reach: number[] = [];
  for (const loop of loops) {
    if ('vertex' in loop) {
      reach.push(along(vertices[loop.vertex] as Vec3));
      continue;
    }
    for (const use of loop.edges) {
      const e = edges[use.edge] as BodyEdge;
      reach.push(along(vertices[e.start] as Vec3), along(vertices[e.end] as Vec3));
      // A B-spline lies within its control points.
      if (e.curve.kind === 'bspline') for (const p of e.curve.poles) reach.push(along(p));
    }
  }
  if (reach.length === 0) throw new BodyRefusal('an elliptical cylinder face has no boundary');
  const lo = Math.min(...reach);
  const hi = Math.max(...reach);
  const margin = (hi - lo) * 0.5 + 1;
  const [a, b, c] = s.axis;
  const [x0, x1, x2] = s.x;
  const y: Vec3 = [b * x2 - c * x1, c * x0 - a * x2, a * x1 - b * x0];
  const corners: [number, number, number][] = [
    [1, 0, 1],
    [1, 1, Math.SQRT1_2],
    [0, 1, 1],
    [-1, 1, Math.SQRT1_2],
    [-1, 0, 1],
    [-1, -1, Math.SQRT1_2],
    [0, -1, 1],
    [1, -1, Math.SQRT1_2],
    [1, 0, 1],
  ];
  const at = (u: number, v: number, d: number): Vec3 => [
    s.origin[0] + u * s.major * s.x[0] + v * s.minor * y[0] + d * s.axis[0],
    s.origin[1] + u * s.major * s.x[1] + v * s.minor * y[1] + d * s.axis[1],
    s.origin[2] + u * s.major * s.x[2] + v * s.minor * y[2] + d * s.axis[2],
  ];
  return {
    kind: 'bspline',
    uDegree: 2,
    vDegree: 1,
    uKnots: [0, 0.25, 0.5, 0.75, 1],
    uMults: [3, 2, 2, 2, 3],
    vKnots: [0, 1],
    vMults: [2, 2],
    poles: corners.map(([u, v]) => [at(u, v, lo - margin), at(u, v, hi + margin)]),
    weights: corners.map(([, , w]) => [w, w]),
  };
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++)
        out[i * 4 + j] = (out[i * 4 + j] as number) + (a[i * 4 + k] as number) * (b[k * 4 + j] as number);
  return out;
}

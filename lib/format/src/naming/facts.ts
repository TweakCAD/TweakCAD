/**
 * What the naming module asks of a geometry kernel, and what feature builders
 * tell it. The kernel adapter implements `KernelFacts` and produces
 * `OperationHistory`; nothing here knows a naming rule, and the naming module
 * never sees a kernel handle.
 */

export type Vec3 = readonly [number, number, number];

/** A live kernel shape: a body, a tool, a profile face. Opaque to naming. */
export type ShapeRef = string;

/** One sub-shape of a live shape. Valid during one build; never stored or hashed. */
export type ShapeKey = number;

/** What happened to one kind of sub-shape in one operation. */
export interface SubShapeHistory {
  /** Same key before and after. */
  kept: readonly ShapeKey[];
  /** Input key to what it became (one or more result keys). */
  modified: ReadonlyMap<ShapeKey, readonly ShapeKey[]>;
  /** Input keys with no image in the result. */
  deleted: readonly ShapeKey[];
  /** Result keys with no history at all. */
  added: readonly ShapeKey[];
}

/** What one kernel operation did. Every key listed exists in its shape. */
export interface OperationHistory {
  result: ShapeRef;
  inputs: readonly { shape: ShapeRef; use: 'target' | 'tool' }[];
  faces: SubShapeHistory;
  edges: SubShapeHistory;
  /** New faces by the input face that generated them: shell inner walls. */
  facesFromFace: ReadonlyMap<ShapeKey, readonly ShapeKey[]>;
  /** New faces by the input edge that generated them: fillet blends, swept walls. */
  facesFromEdge: ReadonlyMap<ShapeKey, readonly ShapeKey[]>;
  /** Sweep family only: the cap faces. Empty lists for a full revolve or a closed sweep. */
  caps?: { first: readonly ShapeKey[]; last: readonly ShapeKey[] };
  /** Sweep only: the faces of one profile edge along one path edge. */
  spine?: readonly { path: ShapeKey; profile: ShapeKey; faces: readonly ShapeKey[] }[];
}

/** Adjacency of one shape's sub-shapes. */
export interface ShapeTopology {
  faces: readonly ShapeKey[];
  edges: readonly {
    edge: ShapeKey;
    form: 'normal' | 'seam' | 'degenerate';
    /** A seam's one face counts 2. */
    faces: readonly { face: ShapeKey; count: 1 | 2 }[];
    /** One vertex when the edge is closed. */
    ends: readonly ShapeKey[];
  }[];
  vertices: readonly { vertex: ShapeKey; faces: readonly ShapeKey[]; edges: readonly ShapeKey[] }[];
  solids: readonly { solid: ShapeKey; faces: readonly ShapeKey[] }[];
}

export interface BSplineCurve {
  degree: number;
  poles: readonly Vec3[];
  weights: readonly number[];
  knots: readonly number[];
  multiplicities: readonly number[];
}

export interface BSplineSurface {
  degrees: readonly [number, number];
  poles: readonly (readonly Vec3[])[];
  weights: readonly (readonly number[])[];
  knots: readonly [readonly number[], readonly number[]];
  multiplicities: readonly [readonly number[], readonly number[]];
}

export type CurveFacts =
  | { kind: 'line' }
  | { kind: 'circle'; center: Vec3; axis: Vec3; radius: number }
  | { kind: 'ellipse'; center: Vec3; axis: Vec3; major: Vec3; radii: readonly [number, number] }
  | ({ kind: 'bspline'; first: number; last: number } & BSplineCurve);

/** `plane.normal` is the face's outward normal. `halfAngle` is in degrees. */
export type SurfaceFacts =
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  | {
      kind: 'cylinder' | 'cone' | 'sphere' | 'torus';
      origin: Vec3;
      axis: Vec3;
      x: Vec3;
      radii: readonly number[];
      halfAngle?: number;
    }
  | ({ kind: 'bspline' } & BSplineSurface);

export interface EdgeGeometry {
  curve: CurveFacts;
  start: Vec3;
  end: Vec3;
  closed: boolean;
}

export interface FaceGeometry {
  surface: SurfaceFacts;
  /** Outer loop first; each an ordered cycle with the face on the left. */
  loops: readonly (readonly { edge: ShapeKey; reversed: boolean }[])[];
}

/** The 9.7 measures, in the part frame and format units. `curve`, `surface`: 9.7's enums. */
export interface Measures {
  centroid?: Vec3;
  area?: number;
  bbox?: readonly [Vec3, Vec3];
  surface?: string;
  normal?: Vec3;
  axis?: Vec3;
  vertices?: readonly Vec3[];
  midpoint?: Vec3;
  center?: Vec3;
  length?: number;
  tangent?: Vec3;
  curve?: string;
  quarter?: Vec3;
  threeQuarter?: Vec3;
  point?: Vec3;
  volume?: number;
}

/** One sub-shape in a shape's 13.2 index order. */
export interface SubShape {
  key: ShapeKey;
  kind: 'compound' | 'compsolid' | 'solid' | 'shell' | 'face' | 'wire' | 'edge' | 'vertex';
  /** Indices of its direct sub-shapes in the same list. */
  children: readonly number[];
}

/**
 * Everything the naming module asks of a kernel. A fact the kernel cannot read
 * throws an error whose `code` is `'unsupported'` (see `isUnsupportedFact`).
 */
export interface KernelFacts {
  topology(shape: ShapeRef): ShapeTopology;
  edgeGeometry(edge: ShapeKey): EdgeGeometry;
  faceGeometry(face: ShapeKey): FaceGeometry;
  measures(entity: ShapeKey): Measures;
  /** The 9.6 sample point, walking `sampleSequence()`. Null: no tried point lies inside. */
  samplePoint(entity: ShapeKey): Vec3 | null;
  /**
   * The 9.6 sign against a face. 0: the point lies in the face's surface (or on
   * the solid's boundary), which writes no side entry. Null: the closest points
   * disagree, which pauses a piece being named.
   */
  side(point: Vec3, face: ShapeKey, test: 'solid' | 'normal'): 1 | -1 | 0 | null;
  /** The 13.2 index order with direct children, for shape maps. */
  subShapes(shape: ShapeRef): readonly SubShape[];
  /**
   * An edge's parameter range as its shape stores it, read rather than
   * computed, so the same stored bytes always give the same numbers. Null for
   * a degenerate edge.
   */
  edgeRange(edge: ShapeKey): readonly [number, number] | null;
}

/** Whether `error` says the kernel has no way to read a fact, rather than that something broke. */
export function isUnsupportedFact(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'unsupported';
}

/** One item of a `src`. Builders never hash: `entity` becomes `name(e)` in the naming module. */
export type SrcFact = { id: string } | { index: number } | { text: string } | { entity: ShapeKey };

/** What only the builder knows. An output listed here wins over history. */
export interface BuilderReport {
  outputs: readonly { entity: ShapeKey; role: string; src: readonly SrcFact[] }[];
  /** Tool faces of this step, for `branch` signs. */
  dividers: readonly ShapeKey[];
  /**
   * Result faces that carry on an input face the history does not link them
   * to, as if that face had become them: a shell's outer skin standing for the
   * original face it was offset from.
   */
  continued?: readonly { entity: ShapeKey; from: ShapeKey }[];
}

/** How each solid of a feature's result came to be. */
export interface BodyOutcome {
  solid: ShapeKey;
  /** `same`: the input solid this one still is, for a shape that holds several bodies. */
  from: { create: readonly SrcFact[] } | { carry: readonly ShapeRef[] } | { same: ShapeKey };
}

/**
 * The 9.6 dyadic sample sequence by level: at level L, every tuple of the
 * first 2^L − 1 values not tried at an earlier level, the first coordinate
 * fastest. Values are fractions of the parameter or box range.
 */
export function* sampleSequence(dimensions: 2 | 3): Generator<readonly number[]> {
  const values: number[] = [];
  let tried = 0;
  for (let level = 1; level <= 20; level++) {
    const step = 2 ** -level;
    for (let k = 1; k < 2 ** level; k += 2) values.push(k * step);
    const n = values.length;
    // Every tuple over the first n values with at least one index >= tried.
    const index = new Array<number>(dimensions).fill(0);
    for (;;) {
      if (index.some((i) => i >= tried)) {
        yield index.map((i) => values[i] as number);
      }
      let d = 0;
      while (d < dimensions) {
        index[d] = (index[d] as number) + 1;
        if ((index[d] as number) < n) break;
        index[d] = 0;
        d++;
      }
      if (d === dimensions) break;
    }
    tried = n;
  }
}

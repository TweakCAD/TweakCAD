import type {
  EdgeGeometry,
  FaceGeometry,
  KernelFacts,
  Measures,
  ShapeKey,
  ShapeRef,
  ShapeTopology,
  SubShape,
  Vec3,
} from './facts';

/** A sub-shape with its children by key, before they are numbered. */
interface TreeNode {
  key: ShapeKey;
  kind: SubShape['kind'];
  children: readonly ShapeKey[];
}

/** 13.2's index order. */
const INDEX_ORDER: readonly SubShape['kind'][] = [
  'compound',
  'compsolid',
  'solid',
  'shell',
  'face',
  'wire',
  'edge',
  'vertex',
];

/**
 * A kernel of axis-aligned planar faces for naming tests: each face is a
 * plane with an outward normal, and every sub-shape has a sample point.
 */
export class FakeKernel implements KernelFacts {
  readonly shapes = new Map<ShapeRef, ShapeTopology>();
  readonly planes = new Map<ShapeKey, { normal: Vec3; offset: number }>();
  readonly points = new Map<ShapeKey, Vec3>();
  readonly edgeFacts = new Map<ShapeKey, EdgeGeometry>();
  readonly faceFacts = new Map<ShapeKey, FaceGeometry>();
  readonly measured = new Map<ShapeKey, Measures>();
  readonly trees = new Map<ShapeRef, readonly TreeNode[]>();
  /** Keys whose geometry the kernel has no way to read. */
  readonly unsupported = new Set<ShapeKey>();

  private refuse(key: ShapeKey): void {
    if (this.unsupported.has(key)) throw Object.assign(new Error(`no data for ${key}`), { code: 'unsupported' });
  }

  topology(shape: ShapeRef): ShapeTopology {
    const t = this.shapes.get(shape);
    if (!t) throw new Error(`unknown shape ${shape}`);
    return t;
  }

  edgeGeometry(edge: ShapeKey): EdgeGeometry {
    this.refuse(edge);
    const g = this.edgeFacts.get(edge);
    if (!g) throw new Error(`unknown edge ${edge}`);
    return g;
  }

  faceGeometry(face: ShapeKey): FaceGeometry {
    this.refuse(face);
    const g = this.faceFacts.get(face);
    if (g) return g;
    const p = this.planes.get(face);
    if (!p) throw new Error(`unknown face ${face}`);
    const point = p.normal.map((n) => n * p.offset) as unknown as Vec3;
    return { surface: { kind: 'plane', point, normal: p.normal }, loops: [] };
  }

  measures(entity: ShapeKey): Measures {
    const measured = this.measured.get(entity);
    if (measured) return measured;
    const point = this.points.get(entity);
    return point ? { point } : {};
  }

  samplePoint(entity: ShapeKey): Vec3 | null {
    return this.points.get(entity) ?? null;
  }

  side(point: Vec3, face: ShapeKey): 1 | -1 | 0 | null {
    const p = this.planes.get(face);
    if (!p) return null;
    const d = p.normal[0] * point[0] + p.normal[1] * point[1] + p.normal[2] * point[2] - p.offset;
    return d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0;
  }

  subShapes(shape: ShapeRef): readonly SubShape[] {
    const nodes = INDEX_ORDER.flatMap((kind) => (this.trees.get(shape) ?? []).filter((n) => n.kind === kind));
    const index = new Map(nodes.map((n, i) => [n.key, i]));
    return nodes.map((n) => ({ key: n.key, kind: n.kind, children: n.children.map((c) => index.get(c) as number) }));
  }
}

export const FACE_ROLES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
export type FaceRole = (typeof FACE_ROLES)[number];

const AXIS: Record<FaceRole, [number, number]> = {
  '+x': [0, 1],
  '-x': [0, -1],
  '+y': [1, 1],
  '-y': [1, -1],
  '+z': [2, 1],
  '-z': [2, -1],
};

const roleOn = (axis: number, sign: number): FaceRole =>
  FACE_ROLES.find((r) => AXIS[r][0] === axis && AXIS[r][1] === sign) as FaceRole;

export interface FakeBox {
  shape: ShapeRef;
  faces: Record<FaceRole, ShapeKey>;
  /** The edge between two adjacent faces. */
  edge(a: FaceRole, b: FaceRole): ShapeKey;
  solid: ShapeKey;
}

/** Adds an axis-aligned box. Keys run from `base`, so two builds can use different keys. */
export function addBox(kernel: FakeKernel, shape: ShapeRef, base: number, lo: Vec3, hi: Vec3): FakeBox {
  const min = [...lo] as number[];
  const max = [...hi] as number[];
  const at = (v: number[], i: number) => v[i] as number;
  const faces = {} as Record<FaceRole, ShapeKey>;
  FACE_ROLES.forEach((role, i) => {
    const key = base + i;
    faces[role] = key;
    const [axis, sign] = AXIS[role];
    const normal = [0, 0, 0] as [number, number, number];
    normal[axis] = sign;
    const offset = sign > 0 ? at(max, axis) : -at(min, axis);
    kernel.planes.set(key, { normal, offset });
    const center = [0, 1, 2].map((a) =>
      a === axis ? (sign > 0 ? at(max, a) : at(min, a)) : (at(min, a) + at(max, a)) / 2,
    );
    kernel.points.set(key, center as unknown as Vec3);
  });

  const edges: ShapeTopology['edges'][number][] = [];
  const edgeKeys = new Map<string, ShapeKey>();
  let next = base + 10;
  const pairs: [FaceRole, FaceRole][] = [];
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const a = FACE_ROLES[i] as FaceRole;
      const b = FACE_ROLES[j] as FaceRole;
      if (AXIS[a][0] !== AXIS[b][0]) pairs.push([a, b]);
    }
  }
  const corner = (sx: number, sy: number, sz: number): Vec3 => [
    sx > 0 ? at(max, 0) : at(min, 0),
    sy > 0 ? at(max, 1) : at(min, 1),
    sz > 0 ? at(max, 2) : at(min, 2),
  ];
  const vertexKey = (sx: number, sy: number, sz: number) =>
    base + 40 + (sx > 0 ? 1 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 4 : 0);
  const signs = (role: FaceRole) => AXIS[role];

  for (const [a, b] of pairs) {
    const key = next++;
    edgeKeys.set(`${a}|${b}`, key);
    edgeKeys.set(`${b}|${a}`, key);
    // The edge runs along the third axis; its ends are the two corners.
    const [axA, sA] = signs(a);
    const [axB, sB] = signs(b);
    const s = [0, 0, 0];
    s[axA] = sA;
    s[axB] = sB;
    const free = [0, 1, 2].find((x) => x !== axA && x !== axB) as number;
    const ends = [-1, 1].map((f) => {
      const t = [...s];
      t[free] = f;
      return vertexKey(t[0] as number, t[1] as number, t[2] as number);
    });
    edges.push({
      edge: key,
      form: 'normal',
      faces: [
        { face: faces[a], count: 1 },
        { face: faces[b], count: 1 },
      ],
      ends,
    });
    const along = (f: number) =>
      [0, 1, 2].map((x) =>
        x === free ? at(min, x) + f * (at(max, x) - at(min, x)) : (s[x] as number) > 0 ? at(max, x) : at(min, x),
      ) as unknown as Vec3;
    const mid = along(0.5);
    kernel.points.set(key, mid);
    kernel.edgeFacts.set(key, { curve: { kind: 'line' }, start: along(0), end: along(1), closed: false });
    const tangent = [0, 1, 2].map((x) => (x === free ? 1 : 0)) as unknown as Vec3;
    kernel.measured.set(key, {
      midpoint: mid,
      length: at(max, free) - at(min, free),
      tangent,
      bbox: [along(0), along(1)],
      curve: 'line',
      quarter: along(0.25),
      threeQuarter: along(0.75),
    });
  }

  const vertices: ShapeTopology['vertices'][number][] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const roles: FaceRole[] = [sx > 0 ? '+x' : '-x', sy > 0 ? '+y' : '-y', sz > 0 ? '+z' : '-z'];
        const key = vertexKey(sx, sy, sz);
        vertices.push({
          vertex: key,
          faces: roles.map((r) => faces[r]),
          edges: [
            edgeKeys.get(`${roles[0]}|${roles[1]}`) as ShapeKey,
            edgeKeys.get(`${roles[0]}|${roles[2]}`) as ShapeKey,
            edgeKeys.get(`${roles[1]}|${roles[2]}`) as ShapeKey,
          ],
        });
        kernel.points.set(key, corner(sx, sy, sz));
      }
    }
  }

  // Each face's loop runs round its outward normal: along u, v, back along u and v.
  const box = [lo, hi] as const;
  const size = (axis: number) => at(max, axis) - at(min, axis);
  const wires: TreeNode[] = [];
  const faceNodes: TreeNode[] = [];
  FACE_ROLES.forEach((role, i) => {
    const [axis, sign] = AXIS[role];
    const u = (axis + (sign > 0 ? 1 : 2)) % 3;
    const v = (axis + (sign > 0 ? 2 : 1)) % 3;
    const edgeTo = (other: FaceRole) => edgeKeys.get(`${role}|${other}`) as ShapeKey;
    const loop = [
      { edge: edgeTo(roleOn(v, -1)), reversed: false },
      { edge: edgeTo(roleOn(u, 1)), reversed: false },
      { edge: edgeTo(roleOn(v, 1)), reversed: true },
      { edge: edgeTo(roleOn(u, -1)), reversed: true },
    ];
    const normal = (kernel.planes.get(faces[role]) as { normal: Vec3 }).normal;
    const point = kernel.points.get(faces[role]) as Vec3;
    kernel.faceFacts.set(faces[role], { surface: { kind: 'plane', point, normal }, loops: [loop] });
    const wire = base + 70 + i;
    wires.push({ key: wire, kind: 'wire', children: loop.map((l) => l.edge) });
    faceNodes.push({ key: faces[role], kind: 'face', children: [wire] });
    const onFace = vertices
      .filter((x) => x.faces.includes(faces[role]))
      .map((x) => kernel.points.get(x.vertex) as Vec3);
    kernel.measured.set(faces[role], {
      centroid: point,
      area: size(u) * size(v),
      bbox: [
        onFace.reduce((a, b) => (a.join() < b.join() ? a : b)),
        onFace.reduce((a, b) => (a.join() > b.join() ? a : b)),
      ],
      surface: 'plane',
      normal,
      vertices: onFace,
    });
  });

  const solid = base + 60;
  const shell = base + 61;
  kernel.points.set(solid, [0, 1, 2].map((a) => (at(min, a) + at(max, a)) / 2) as unknown as Vec3);
  kernel.measured.set(solid, { volume: size(0) * size(1) * size(2), bbox: box });
  kernel.shapes.set(shape, {
    faces: Object.values(faces),
    edges,
    vertices,
    solids: [{ solid, faces: Object.values(faces) }],
  });
  kernel.trees.set(shape, [
    { key: solid, kind: 'solid', children: [shell] },
    { key: shell, kind: 'shell', children: Object.values(faces) },
    ...faceNodes,
    ...wires,
    ...edges.map((e) => ({ key: e.edge, kind: 'edge' as const, children: e.ends })),
    ...vertices.map((x) => ({ key: x.vertex, kind: 'vertex' as const, children: [] })),
  ]);
  return {
    shape,
    faces,
    solid,
    edge: (a, b) => {
      const k = edgeKeys.get(`${a}|${b}`);
      if (k === undefined) throw new Error(`no edge between ${a} and ${b}`);
      return k;
    },
  };
}

/** Wraps shapes in one compound, as 13.2 stores them. */
export function addCompound(kernel: FakeKernel, shape: ShapeRef, key: ShapeKey, parts: readonly ShapeRef[]): void {
  const topologies = parts.map((p) => kernel.topology(p));
  const nodes = parts.flatMap((p) => kernel.trees.get(p) ?? []);
  const solids = topologies.flatMap((t) => t.solids);
  kernel.shapes.set(shape, {
    faces: topologies.flatMap((t) => t.faces),
    edges: topologies.flatMap((t) => t.edges),
    vertices: topologies.flatMap((t) => t.vertices),
    solids,
  });
  kernel.trees.set(shape, [{ key, kind: 'compound', children: solids.map((s) => s.solid) }, ...nodes]);
  const boxes = solids.map((s) => kernel.measures(s.solid).bbox as readonly [Vec3, Vec3]);
  const reach = (pick: (...v: number[]) => number, end: 0 | 1) =>
    [0, 1, 2].map((i) => pick(...boxes.map((b) => b[end][i] as number))) as unknown as Vec3;
  kernel.measured.set(key, {
    volume: solids.reduce((sum, s) => sum + (kernel.measures(s.solid).volume as number), 0),
    bbox: [reach(Math.min, 0), reach(Math.max, 1)],
  });
}

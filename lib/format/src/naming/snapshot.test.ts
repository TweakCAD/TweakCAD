import { describe, expect, it } from 'vitest';
import { canonicalize, type JsonValue } from '../canonical';
import { NameTable } from '../names';
import { addBox, FACE_ROLES, FakeKernel } from './fakeKernel';
import type { EdgeGeometry, ShapeKey, ShapeTopology, SurfaceFacts, Vec3 } from './facts';
import { startFeature } from './namer';
import { resolve, writeRecord } from './resolve';
import {
  describeEdge,
  describeEntity,
  describeFace,
  describeFaces,
  describeVertex,
  describeWire,
  diagonal,
  loadTolerance,
  matchesDescription,
  matchesSnapshot,
  partSize,
  tightTolerance,
  writeEdge,
  type Description,
  type Tolerance,
} from './snapshot';
import { NamedState } from './state';

const TIGHT = tightTolerance(100);
const LOOSE = loadTolerance(100);

const line = (start: Vec3, end: Vec3): EdgeGeometry => ({ curve: { kind: 'line' }, start, end, closed: false });

const arc = (start: Vec3, end: Vec3, axis: Vec3 = [0, 0, 1]): EdgeGeometry => ({
  curve: { kind: 'circle', center: [0, 0, 0], axis, radius: 1 },
  start,
  end,
  closed: false,
});

const circle = (start: Vec3, axis: Vec3 = [0, 0, 1], radius = 1, center: Vec3 = [0, 0, 0]): EdgeGeometry => ({
  curve: { kind: 'circle', center, axis, radius },
  start,
  end: start,
  closed: true,
});

const spline = (poles: Vec3[], knots = [0, 1], first = 0, last = 1): EdgeGeometry => ({
  curve: {
    kind: 'bspline',
    first,
    last,
    degree: poles.length - 1,
    poles,
    weights: poles.map(() => 1),
    knots,
    multiplicities: knots.map(() => poles.length),
  },
  start: poles[0] as Vec3,
  end: poles[poles.length - 1] as Vec3,
  closed: false,
});

/** A description of one surface with no loops, on a kernel of its own. */
function surface(facts: SurfaceFacts): Description {
  const kernel = new FakeKernel();
  kernel.faceFacts.set(1, { surface: facts, loops: [] });
  return describeFace(1, kernel) as Description;
}

const sameAs = (a: Description, b: Description, t: Tolerance = TIGHT) => matchesDescription(a, b, t);

const cylinder = (origin: Vec3, axis: Vec3, x: Vec3, r: number): SurfaceFacts => ({
  kind: 'cylinder',
  origin,
  axis,
  x,
  radii: [r],
});

describe('writing geometry in canonical order', () => {
  it('writes an open edge from its smaller end', () => {
    const forward = writeEdge(line([0, 0, 0], [1, 0, 0]));
    expect(writeEdge(line([1, 0, 0], [0, 0, 0]))).toEqual(forward);
    expect(forward).toEqual({ edge: { closed: false, curve: { line: { start: [0, 0, 0], end: [1, 0, 0] } } } });
  });

  it("turns an arc's axis with it, so it still runs counter-clockwise from start to end", () => {
    // The long way from (1,0) to (0,1) about -z, written from the smaller end, runs about +z.
    const written = writeEdge(arc([1, 0, 0], [0, 1, 0], [0, 0, -1]));
    expect(written).toEqual(writeEdge(arc([0, 1, 0], [1, 0, 0], [0, 0, 1])));
    expect(written.edge.curve).toMatchObject({ circle: { start: [0, 1, 0], end: [1, 0, 0], axis: [0, 0, 1] } });
  });

  it("reverses a B-spline's poles and knots", () => {
    const written = writeEdge(
      spline(
        [
          [2, 0, 0],
          [1, 1, 0],
          [0, 0, 0],
        ],
        [0, 0.25, 1],
        0,
        1,
      ),
    );
    expect(written.edge.curve).toMatchObject({
      bspline: {
        poles: [
          [0, 0, 0],
          [1, 1, 0],
          [2, 0, 0],
        ],
        knots: [0, 0.75, 1],
      },
    });
  });

  it('writes a closed edge from its parametric start', () => {
    expect(writeEdge(circle([1, 0, 0])).edge.curve).toMatchObject({ circle: { start: [1, 0, 0], axis: [0, 0, 1] } });
  });

  it('writes a loop from its smallest edge in the direction of travel, wherever the kernel starts it', () => {
    const kernel = new FakeKernel();
    const box = addBox(kernel, 'box', 100, [0, 0, 0], [1, 1, 1]);
    const top = box.faces['+z'];
    const { surface: plane, loops } = kernel.faceGeometry(top);
    const first = describeFace(top, kernel);
    const loop = loops[0] as (typeof loops)[number];
    kernel.faceFacts.set(top, { surface: plane, loops: [[...loop.slice(2), ...loop.slice(0, 2)]] });
    expect(canonicalize(describeFace(top, kernel) as unknown as JsonValue)).toBe(
      canonicalize(first as unknown as JsonValue),
    );

    // Corners follow each other: the loop reads tip to tail.
    const edges = (first as { face: { loops: { edge: { curve: { line: { start: Vec3; end: Vec3 } } } }[][] } }).face
      .loops[0];
    edges?.forEach((e, i) => {
      const next = edges[(i + 1) % edges.length];
      expect(e.edge.curve.line.end).toEqual(next?.edge.curve.line.start);
    });
  });

  it('writes the outer loop first and sorts the inner loops and sets', () => {
    const kernel = new FakeKernel();
    kernel.edgeFacts.set(1, circle([3, 0, 0], [0, 0, 1], 3));
    kernel.edgeFacts.set(2, circle([1, 0, 0], [0, 0, -1], 1, [1, 1, 0]));
    kernel.edgeFacts.set(3, circle([2, 0, 0], [0, 0, -1], 1, [-1, -1, 0]));
    const plane: SurfaceFacts = { kind: 'plane', point: [0, 0, 0], normal: [0, 0, 1] };
    const use = (edge: ShapeKey) => [{ edge, reversed: false }];
    kernel.faceFacts.set(10, { surface: plane, loops: [use(1), use(2), use(3)] });
    kernel.faceFacts.set(11, { surface: plane, loops: [use(1), use(3), use(2)] });
    expect(describeFace(10, kernel)).toEqual(describeFace(11, kernel));
    const a = describeFaces('shell', [10, 11], kernel);
    expect(a).toEqual(describeFaces('shell', [11, 10], kernel));
    expect(a).toHaveProperty('shell.faces.set');
  });
});

describe('matching geometry', () => {
  const edge = (g: EdgeGeometry): Description => writeEdge(g);

  it('matches an edge in either direction, and tells an arc from its complement', () => {
    const quarter = {
      edge: {
        closed: false,
        curve: {
          circle: {
            center: [0, 0, 0],
            axis: [0, 0, 1],
            radius: 1,
            start: [1, 0, 0],
            end: [0, 1, 0],
          },
        },
      },
    } as unknown as Description;
    const other = {
      edge: {
        closed: false,
        curve: {
          circle: {
            center: [0, 0, 0],
            axis: [0, 0, -1],
            radius: 1,
            start: [0, 1, 0],
            end: [1, 0, 0],
          },
        },
      },
    } as unknown as Description;
    const threeQuarters = {
      edge: {
        closed: false,
        curve: {
          circle: {
            center: [0, 0, 0],
            axis: [0, 0, -1],
            radius: 1,
            start: [1, 0, 0],
            end: [0, 1, 0],
          },
        },
      },
    } as unknown as Description;
    expect(sameAs(quarter, other)).toBe(true);
    expect(sameAs(quarter, threeQuarters)).toBe(false);
  });

  it("does not compare a closed edge's start point, but keeps its axis line", () => {
    expect(sameAs(edge(circle([1, 0, 0])), edge(circle([0, 1, 0], [0, 0, -1])))).toBe(true);
    expect(sameAs(edge(circle([1, 0, 0])), edge(circle([1, 0, 0], [0, 1, 0])))).toBe(false);
    expect(sameAs(edge(circle([1, 0, 0])), edge(circle([1, 0, 0], [0, 0, 1], 1.001)))).toBe(false);
  });

  it('compares a degenerate edge by its one point', () => {
    const pole = (z: number): EdgeGeometry => ({
      curve: { kind: 'line' },
      start: [0, 0, z],
      end: [0, 0, z],
      closed: true,
    });
    expect(sameAs(edge(pole(5)), edge(pole(5)))).toBe(true);
    expect(sameAs(edge(pole(5)), edge(pole(-5)))).toBe(false);
  });

  it('matches an ellipse whose major axis is written the other way', () => {
    const ellipse = (major: Vec3): EdgeGeometry => ({
      curve: { kind: 'ellipse', center: [0, 0, 0], axis: [0, 0, 1], major, radii: [2, 1] },
      start: [2, 0, 0],
      end: [2, 0, 0],
      closed: true,
    });
    expect(sameAs(edge(ellipse([1, 0, 0])), edge(ellipse([-1, 0, 0])))).toBe(true);
    expect(sameAs(edge(ellipse([1, 0, 0])), edge(ellipse([0, 1, 0])))).toBe(false);
  });

  it('compares a B-spline as written, in either direction', () => {
    const poles: Vec3[] = [
      [0, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
    ];
    const spun = writeEdge(spline(poles, [0, 0.25, 1]));
    const back = {
      edge: {
        closed: false,
        curve: {
          bspline: {
            ...(spun.edge.curve as { bspline: object }).bspline,
            poles: [...poles].reverse(),
            knots: [0, 0.75, 1],
          },
        },
      },
    } as unknown as Description;
    expect(sameAs(spun, back)).toBe(true);
    expect(sameAs(spun, edge(spline(poles, [0, 0.5, 1])))).toBe(false);
    // An equivalent curve with an inserted knot does not match: the reference asks.
    expect(sameAs(edge(spline(poles, [0, 1])), edge(spline(poles, [0, 0.5, 1])))).toBe(false);
  });

  it('matches a loop under any rotation, inner loops one to one', () => {
    const kernel = new FakeKernel();
    const box = addBox(kernel, 'box', 100, [0, 0, 0], [1, 1, 1]);
    const top = box.faces['+z'];
    const plain = describeFace(top, kernel) as { face: { loops: unknown[][] } };
    const [a, b, c, d] = plain.face.loops[0] as unknown[];
    const spun = { face: { ...plain.face, loops: [[c, d, a, b]] } } as unknown as Description;
    const scrambled = { face: { ...plain.face, loops: [[a, c, b, d]] } } as unknown as Description;
    expect(sameAs(plain as unknown as Description, spun)).toBe(true);
    expect(sameAs(plain as unknown as Description, scrambled)).toBe(false);
  });

  it('never matches a loop or wire travelled the other way', () => {
    const circleEdge = (axis: Vec3) => ({
      edge: {
        closed: true,
        curve: { circle: { center: [0, 0, 0], axis, radius: 1, start: [1, 0, 0], end: [1, 0, 0] } },
      },
    });
    const sphere = (axis: Vec3) =>
      ({
        face: {
          surface: { sphere: { origin: [0, 0, 0], axis: [0, 0, 1], x: [1, 0, 0], radii: [1] } },
          loops: [[circleEdge(axis)]],
        },
      }) as unknown as Description;
    expect(sameAs(sphere([0, 0, 1]), sphere([0, 0, 1]))).toBe(true);
    expect(sameAs(sphere([0, 0, 1]), sphere([0, 0, -1]))).toBe(false);
    // The standalone edge still matches either way.
    expect(
      sameAs(circleEdge([0, 0, 1]) as unknown as Description, circleEdge([0, 0, -1]) as unknown as Description),
    ).toBe(true);
    const line = (start: Vec3, end: Vec3) => ({ edge: { closed: false, curve: { line: { start, end } } } });
    const wire = (...edges: unknown[]) => ({ wire: { edges } }) as unknown as Description;
    const [p, q] = [
      [0, 0, 0],
      [1, 0, 0],
    ] as Vec3[];
    expect(
      sameAs(
        wire(line(p as Vec3, q as Vec3), line(q as Vec3, p as Vec3)),
        wire(line(q as Vec3, p as Vec3), line(p as Vec3, q as Vec3)),
      ),
    ).toBe(true);
    expect(sameAs(wire(line(p as Vec3, q as Vec3)), wire(line(q as Vec3, p as Vec3)))).toBe(false);
  });

  it('matches a set one to one, even where a greedy pairing would fail', () => {
    const t: Tolerance = { position: 1, direction: 1, ratio: 1e-9 };
    const face = (x: number): unknown => ({
      face: { surface: { plane: { point: [x, 0, 0], normal: [1, 0, 0] } }, loops: [] },
    });
    const set = (...xs: number[]) => ({ shell: { faces: { set: xs.map(face) } } }) as unknown as Description;
    expect(sameAs(set(0.5, 1.2), set(1.2, 0), t)).toBe(true); // 0.5 pairs with 0, though it reaches 1.2 too
    expect(sameAs(set(0, 0.5), set(0.2, 5), t)).toBe(false);
    expect(sameAs(set(0), set(0, 0), t)).toBe(false);
  });

  it('compares a plane by normal and offset, not by the point it stores', () => {
    const plane = (point: Vec3, normal: Vec3) => surface({ kind: 'plane', point, normal });
    expect(sameAs(plane([0, 0, 5], [0, 0, 1]), plane([3, 7, 5], [0, 0, 1]))).toBe(true);
    expect(sameAs(plane([0, 0, 5], [0, 0, 1]), plane([0, 0, 6], [0, 0, 1]))).toBe(false);
    expect(sameAs(plane([0, 0, 5], [0, 0, 1]), plane([0, 0, 5], [0, 0, -1]))).toBe(false);
  });

  it('compares a cylinder by its axis line and radius, not its frame', () => {
    const base = surface(cylinder([0, 0, 0], [0, 0, 1], [1, 0, 0], 5));
    expect(sameAs(base, surface(cylinder([0, 0, 40], [0, 0, -1], [0, 1, 0], 5)))).toBe(true);
    expect(sameAs(base, surface(cylinder([1, 0, 0], [0, 0, 1], [1, 0, 0], 5)))).toBe(false);
    expect(sameAs(base, surface(cylinder([0, 0, 0], [0, 0, 1], [1, 0, 0], 5.001)))).toBe(false);
  });

  it('compares a cone by apex, axis line and half-angle, wherever its frame sits', () => {
    const cone = (z: number, axis: Vec3, radius: number, halfAngle: number) =>
      surface({ kind: 'cone', origin: [0, 0, z], axis, x: [1, 0, 0], radii: [radius], halfAngle });
    const base = cone(0, [0, 0, 1], 1, 45); // apex at z = -1
    expect(sameAs(base, cone(1, [0, 0, 1], 2, 45))).toBe(true);
    expect(sameAs(base, cone(1, [0, 0, -1], 2, -45))).toBe(true);
    expect(sameAs(base, cone(0, [0, 0, 1], 2, 45))).toBe(false);
    expect(sameAs(base, cone(0, [0, 0, 1], 1, 30))).toBe(false);
  });

  it('compares a sphere by centre and radius, a torus also by its axis line', () => {
    const round = (kind: 'sphere' | 'torus', origin: Vec3, axis: Vec3, x: Vec3, radii: number[]) =>
      surface({ kind, origin, axis, x, radii });
    const sphere = round('sphere', [0, 0, 0], [0, 0, 1], [1, 0, 0], [5]);
    const torus0 = () => round('torus', [0, 0, 0], [0, 0, 1], [1, 0, 0], [5, 1]);
    expect(sameAs(sphere, round('sphere', [0, 0, 0], [0, 0, -1], [0, 1, 0], [5]))).toBe(true);
    expect(sameAs(sphere, round('sphere', [1, 0, 0], [0, 0, 1], [1, 0, 0], [5]))).toBe(false);
    // A sphere's axis is frame only: a turned sphere is the same sphere.
    expect(sameAs(sphere, round('sphere', [0, 0, 0], [1, 0, 0], [0, 1, 0], [5]))).toBe(true);
    expect(sameAs(torus0(), round('torus', [0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 1]))).toBe(false);
    const torus = torus0();
    expect(sameAs(torus, round('torus', [0, 0, 0], [0, 0, -1], [0, 1, 0], [5, 1]))).toBe(true);
    expect(sameAs(torus, round('torus', [0, 0, 0], [0, 0, 1], [1, 0, 0], [5, 2]))).toBe(false);
    expect(sameAs(sphere, torus)).toBe(false);
  });

  it('compares a B-spline surface as written', () => {
    const patch = (z: number, knot: number): SurfaceFacts => ({
      kind: 'bspline',
      degrees: [1, 1],
      poles: [
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [
          [1, 0, 0],
          [1, 1, z],
        ],
      ],
      weights: [
        [1, 1],
        [1, 1],
      ],
      knots: [
        [0, knot],
        [0, 1],
      ],
      multiplicities: [
        [2, 2],
        [2, 2],
      ],
    });
    expect(sameAs(surface(patch(0, 1)), surface(patch(0, 1)))).toBe(true);
    expect(sameAs(surface(patch(0, 1)), surface(patch(0.5, 1)))).toBe(false);
    expect(sameAs(surface(patch(0, 1)), surface(patch(0, 1 + 1e-9)), LOOSE)).toBe(false); // knots: 1e-12 at any tolerance
  });

  it('holds the tight and load tolerances apart', () => {
    const tilted: Vec3 = [Math.sin((1e-7 * Math.PI) / 180), 0, Math.cos((1e-7 * Math.PI) / 180)];
    const a = surface({ kind: 'plane', point: [0, 0, 0], normal: [0, 0, 1] });
    const b = surface({ kind: 'plane', point: [0, 0, 0], normal: tilted });
    expect(sameAs(a, b, TIGHT)).toBe(false);
    expect(sameAs(a, b, LOOSE)).toBe(true);

    const r = (radius: number) => surface(cylinder([0, 0, 0], [0, 0, 1], [1, 0, 0], radius));
    expect(sameAs(r(5), r(5 * (1 + 1e-8)), TIGHT)).toBe(false);
    expect(sameAs(r(5), r(5 * (1 + 1e-8)), LOOSE)).toBe(true);
    expect(sameAs(r(5), r(5 * (1 + 1e-10)), TIGHT)).toBe(true);

    const point = (x: number): Description => ({ vertex: { point: [x, 0, 0] } });
    expect(TIGHT.position).toBeCloseTo(1e-4 + 1e-9, 15);
    expect(sameAs(point(0), point(0.9e-4))).toBe(true);
    expect(sameAs(point(0), point(1.1e-4))).toBe(false);
  });

  it('never matches a description of the wrong shape', () => {
    const good: Description = { vertex: { point: [0, 0, 0] } };
    for (const bad of [
      null,
      3,
      'x',
      {},
      { vertex: {} },
      { vertex: { point: [0] } },
      { face: {} },
      { edge: { closed: false } },
    ]) {
      expect(matchesDescription(bad, good, TIGHT)).toBe(false);
      expect(matchesDescription(good, bad, TIGHT)).toBe(false);
    }
  });
});

describe('what the kernel cannot read', () => {
  it('leaves the description absent, for a composite too', () => {
    const kernel = new FakeKernel();
    const box = addBox(kernel, 'box', 100, [0, 0, 0], [1, 1, 1]);
    const faces = Object.values(box.faces);
    expect(describeFaces('solid', faces, kernel)).not.toBeNull();
    kernel.unsupported.add(box.faces['+z']);
    expect(describeFace(box.faces['+z'], kernel)).toBeNull();
    expect(describeFaces('solid', faces, kernel)).toBeNull();
    expect(describeEdge(box.edge('+x', '+z'), kernel)).not.toBeNull();
    kernel.unsupported.add(box.edge('+x', '+z'));
    expect(describeEdge(box.edge('+x', '+z'), kernel)).toBeNull();
    expect(describeFace(box.faces['+x'], kernel)).toBeNull(); // its loop holds that edge
  });

  it('lets any other failure through', () => {
    const kernel = new FakeKernel();
    expect(() => describeEdge(1, kernel)).toThrow('unknown edge');
  });
});

describe('every kind', () => {
  const kernel = new FakeKernel();
  const box = addBox(kernel, 'box', 100, [0, 0, 0], [1, 2, 3]);

  it('describes vertices, wires and solids from what the kernel reports', () => {
    const vertex = kernel.topology('box').vertices[0]?.vertex as ShapeKey;
    expect(describeVertex(vertex, kernel)).toEqual({ vertex: { point: kernel.measures(vertex).point } });
    const loop = kernel.faceGeometry(box.faces['+z']).loops[0] as Parameters<typeof describeWire>[0];
    const wire = describeWire(loop, kernel) as { wire: { edges: unknown[] } };
    expect(wire.wire.edges).toEqual(
      (describeFace(box.faces['+z'], kernel) as { face: { loops: unknown[][] } }).face.loops[0],
    );
    const spun = describeWire([...loop.slice(1), loop[0] as (typeof loop)[number]], kernel) as Description;
    expect(sameAs(wire as unknown as Description, spun)).toBe(true);
  });

  it('measures a part by the box round all its bodies', () => {
    const names = new NameTable();
    const other = addBox(kernel, 'other', 300, [10, 0, 0], [11, 1, 1]);
    let state = NamedState.empty();
    for (const [i, b] of [box, other].entries()) {
      const namer = startFeature(state, { feature: `feat_${i}`, ordinal: i }, kernel, names);
      namer.step(
        {
          result: b.shape,
          inputs: [],
          faces: { kept: [], modified: new Map(), deleted: [], added: [] },
          edges: { kept: [], modified: new Map(), deleted: [], added: [] },
          facesFromFace: new Map(),
          facesFromEdge: new Map(),
        },
        { outputs: FACE_ROLES.map((role) => ({ entity: b.faces[role], role, src: [] })), dividers: [] },
      );
      state = namer.finish([{ solid: b.solid, from: { create: [{ index: 0 }] } }]);
    }
    expect(partSize(state, kernel)).toBeCloseTo(
      diagonal([
        [0, 0, 0],
        [11, 2, 3],
      ]),
      12,
    );
    expect(partSize(NamedState.empty(), kernel)).toBe(0);
    const body = state.get(box.solid);
    expect(describeEntity(body!, kernel)).toHaveProperty('body.faces.set');
  });
});

/**
 * A prism whose two walls meet along two look-alike edges at x = ±w: same
 * faces, same neighbours, same sides. Only their position tells them apart.
 */
function lens(w: number, base: number, feature = 'feat_lens') {
  const kernel = new FakeKernel();
  const names = new NameTable();
  const [left, right, top, bottom] = [base, base + 1, base + 2, base + 3];
  const [front, back] = [base + 10, base + 11];
  const corners = [base + 20, base + 21, base + 22, base + 23];
  kernel.planes.set(left, { normal: [0, -1, 0], offset: 1 });
  kernel.planes.set(right, { normal: [0, 1, 0], offset: 1 });
  kernel.planes.set(top, { normal: [0, 0, 1], offset: 10 });
  kernel.planes.set(bottom, { normal: [0, 0, -1], offset: 0 });
  const edgeAt = (x: number): EdgeGeometry => line([x, 0, 0], [x, 0, 10]);
  kernel.edgeFacts.set(front, edgeAt(w));
  kernel.edgeFacts.set(back, edgeAt(-w));
  kernel.points.set(front, [w, 0, 5]);
  kernel.points.set(back, [-w, 0, 5]);
  const wall = (edge: ShapeKey, ends: ShapeKey[]) => ({
    edge,
    form: 'normal' as const,
    faces: [
      { face: left, count: 1 as const },
      { face: right, count: 1 as const },
    ],
    ends,
  });
  const [fb, ft, bb, bt] = corners as [number, number, number, number];
  const topology: ShapeTopology = {
    faces: [left, right, top, bottom],
    edges: [wall(front, [fb, ft]), wall(back, [bb, bt])],
    vertices: [
      { vertex: fb, faces: [left, right, bottom], edges: [front] },
      { vertex: ft, faces: [left, right, top], edges: [front] },
      { vertex: bb, faces: [left, right, bottom], edges: [back] },
      { vertex: bt, faces: [left, right, top], edges: [back] },
    ],
    solids: [{ solid: base + 30, faces: [left, right, top, bottom] }],
  };
  kernel.shapes.set('lens', topology);
  kernel.measured.set(base + 30, {
    volume: 1,
    bbox: [
      [-w, -1, 0],
      [w, 1, 10],
    ],
  });
  const namer = startFeature(NamedState.empty(), { feature, ordinal: 0 }, kernel, names);
  namer.step(
    {
      result: 'lens',
      inputs: [],
      faces: { kept: [], modified: new Map(), deleted: [], added: [] },
      edges: { kept: [], modified: new Map(), deleted: [], added: [] },
      facesFromFace: new Map(),
      facesFromEdge: new Map(),
    },
    {
      outputs: [
        { entity: left, role: 'left', src: [] },
        { entity: right, role: 'right', src: [] },
        { entity: top, role: 'top', src: [] },
        { entity: bottom, role: 'bottom', src: [] },
      ],
      dividers: [],
    },
  );
  const state = namer.finish([{ solid: base + 30, from: { create: [{ index: 0 }] } }]);
  return { kernel, state, front, back };
}

describe('rule 5', () => {
  it('writes geometry only when the record shares its name', () => {
    const { kernel, state, front } = lens(4, 100);
    const twin = writeRecord(state.get(front)!, state, kernel);
    expect(twin.n).toBe(2);
    expect(twin.snapshot.geometry).toEqual(describeEdge(front, kernel));

    const alone = writeRecord(
      [...state.entities.values()].find((e) => e.kind === 'face')!,
      state,
      kernel,
    );
    expect(alone.n).toBe(1);
    expect(alone.snapshot.geometry).toBeUndefined();
  });

  it('tells two look-alike edges apart by geometry alone', () => {
    const first = lens(4, 100);
    const record = writeRecord(first.state.get(first.back)!, first.state, first.kernel);
    const again = lens(4, 900);
    const found = resolve(record, again.state, again.kernel);
    expect(found).toMatchObject({ outcome: 'same', entities: [{ key: again.back }] });
  });

  it('asks when the geometry moved, however little past the tolerance', () => {
    const first = lens(4, 100);
    const record = writeRecord(first.state.get(first.back)!, first.state, first.kernel);
    const moved = lens(4.01, 900);
    const found = resolve(record, moved.state, moved.kernel);
    expect(found.outcome).toBe('ask');
  });

  it('asks when both candidates match', () => {
    const first = lens(4, 100);
    const record = writeRecord(first.state.get(first.back)!, first.state, first.kernel);
    const again = lens(4, 900);
    again.kernel.edgeFacts.set(again.front, again.kernel.edgeGeometry(again.back));
    expect(resolve(record, again.state, again.kernel).outcome).toBe('ask');
  });

  it('asks when the kernel cannot describe the entity: no geometry written, none matched', () => {
    const first = lens(4, 100);
    first.kernel.unsupported.add(first.back);
    const unread = writeRecord(first.state.get(first.back)!, first.state, first.kernel);
    expect(unread.snapshot.geometry).toBeUndefined();
    const again = lens(4, 900);
    expect(resolve(unread, again.state, again.kernel).outcome).toBe('ask');

    const second = lens(4, 100);
    const record = writeRecord(second.state.get(second.back)!, second.state, second.kernel);
    const blind = lens(4, 900);
    blind.kernel.unsupported.add(blind.back);
    blind.kernel.unsupported.add(blind.front);
    expect(resolve(record, blind.state, blind.kernel).outcome).toBe('ask');
  });

  it("takes rule 3's complete match when one of the n has gone", () => {
    const first = lens(4, 100);
    const record = writeRecord(first.state.get(first.back)!, first.state, first.kernel);
    const again = lens(4, 900);
    const entities = new Map(again.state.entities);
    entities.delete(again.front);
    const fewer = new NamedState(entities, again.state.bodies, again.state.splits, again.state.producers);
    expect(resolve(record, fewer, again.kernel)).toMatchObject({ outcome: 'same', entities: [{ key: again.back }] });
    const gone = new Map(again.state.entities);
    gone.delete(again.back);
    const other = new NamedState(gone, again.state.bodies, again.state.splits, again.state.producers);
    expect(resolve(record, other, again.kernel).outcome).toBe('ask');
  });

  it('lets the caller compare in another frame', () => {
    const first = lens(4, 100);
    const record = writeRecord(first.state.get(first.back)!, first.state, first.kernel);
    const again = lens(4, 900);
    const found = resolve(record, again.state, again.kernel, { matchesGeometry: (e) => e.key === again.front });
    expect(found).toMatchObject({ outcome: 'same', entities: [{ key: again.front }] });
  });
});

describe('comparing snapshots', () => {
  const kernel = new FakeKernel();
  const box = addBox(kernel, 'box', 100, [0, 0, 0], [1, 2, 3]);
  const edge = box.edge('+x', '+z');
  const snapshot = (key: ShapeKey) => ({ ...(kernel.measures(key) as Record<string, JsonValue>) });

  it('agrees with itself, and ignores order among vertices and between quarter points', () => {
    const face = snapshot(box.faces['+z']);
    const flipped = { ...face, vertices: [...(face.vertices as JsonValue[])].reverse() };
    expect(matchesSnapshot(face, flipped, LOOSE)).toBe(true);
    const line = snapshot(edge);
    expect(
      matchesSnapshot(
        line,
        { ...line, quarter: line.threeQuarter as JsonValue, threeQuarter: line.quarter as JsonValue },
        LOOSE,
      ),
    ).toBe(true);
  });

  it('fails on any measure that moved, is missing, or is of another kind', () => {
    const face = snapshot(box.faces['+z']);
    expect(matchesSnapshot(face, { ...face, area: (face.area as number) * 1.01 }, LOOSE)).toBe(false);
    expect(matchesSnapshot(face, { ...face, surface: 'cylinder' }, LOOSE)).toBe(false);
    expect(matchesSnapshot(face, { ...face, normal: [0, 0, -1] }, LOOSE)).toBe(false);
    const lacking = Object.fromEntries(Object.entries(face).filter(([key]) => key !== 'area'));
    expect(matchesSnapshot(face, lacking, LOOSE)).toBe(false);
    expect(matchesSnapshot(snapshot(edge), snapshot(box.edge('+x', '-z')), LOOSE)).toBe(false);
  });

  it('compares stored geometry, fails when it is not available live, and treats a malformed snapshot as a mismatch', () => {
    const point = (x: number) => ({ geometry: { vertex: { point: [x, 0, 0] } } });
    expect(matchesSnapshot(point(0), point(0), LOOSE)).toBe(true);
    expect(matchesSnapshot(point(0), point(1), LOOSE)).toBe(false);
    expect(matchesSnapshot(point(0), {}, LOOSE)).toBe(false); // this kernel cannot read it
    expect(matchesSnapshot({}, point(0), LOOSE)).toBe(true); // written without geometry
    expect(matchesSnapshot({ centroid: 'x' }, { centroid: [0, 0, 0] }, LOOSE)).toBe(false);
  });
});

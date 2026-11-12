/**
 * The kernel half of the naming engine: answers `KernelFacts` from occt-wasm
 * and turns its history into `OperationHistory`. It knows the kernel and no
 * naming rule; the naming module never sees a kernel handle.
 *
 * One adapter lives for one build. Each shape is registered with `addShape`,
 * which walks it once. From then on the adapter holds its own handle to every
 * sub-shape, so a caller may release its shapes straight after an operation,
 * and no freed shape's memory can come back under an old hash during the build.
 * `dispose` releases all of it.
 *
 * Keys. A `ShapeKey` is handed out per sub-shape and stays the same for every
 * shape that holds that sub-shape. Kernel hashes are remainders below 2³¹ and
 * can collide, also within one shape, so a hash only finds a bucket of
 * candidates: `isSame` picks the one that is the same sub-shape, and two
 * different sub-shapes are never merged. History never goes by hash: the
 * kernel names a sub-shape by its position among that kind of sub-shape of
 * its shape, the order the walk enters them in, which is the order of the
 * kernel's own `TopExp::MapShapes`. The kernel's counts are checked against
 * the walk's before a history is read.
 *
 * Orientation. A hash ignores orientation, but a kept face can turn over: a
 * cutter's floor left in a pocket, a profile that became an extrusion's start
 * cap. Its outward normal then points the other way, and `side` has no shape to
 * tell the two apart. So faces, and the shells, solids and compounds holding
 * them, have one key per orientation; history reports a turned-over face as
 * `modified`, its one image being itself the other way round.
 */

import {
  sampleSequence,
  type EdgeGeometry,
  type FaceGeometry,
  type KernelFacts,
  type Measures,
  type OperationHistory,
  type ShapeKey,
  type ShapeRef,
  type ShapeTopology,
  type SubShape,
  type SurfaceFacts,
  type Vec3,
} from '@tweakcad/format';
import { OcctError, type EvolutionData, type OcctKernel, type ShapeHandle } from 'occt-wasm';
import {
  agreedSign,
  compareVec3,
  curveFacts,
  distance,
  dot,
  firstClearPoint,
  orderLoop,
  scale,
  sub,
  surfaceFacts,
  toVec3,
  unit,
  type LoopUse,
} from './namingAdapterGeometry.ts';
import {
  NamingAdapterError,
  buildOperationHistory,
  type HeldKey,
  type InputSubShapes,
  type ResultSubShapes,
} from './namingAdapterHistory.ts';

export { NamingAdapterError, type NamingAdapterErrorCode } from './namingAdapterHistory.ts';

/** The largest upper bound the kernel's hash takes. */
export const HASH_BOUND = 2147483647;

/** The 13.2 index order, which is also the kernel's kind numbering. */
const KINDS = ['compound', 'compsolid', 'solid', 'shell', 'face', 'wire', 'edge', 'vertex'] as const;
type Kind = (typeof KINDS)[number];

/** Kinds whose key includes orientation: everything that decides a face's outward side. */
const ORIENTED: ReadonlySet<Kind> = new Set<Kind>(['compound', 'compsolid', 'solid', 'shell', 'face']);

/** The kinds a 9.6 body sample point applies to. */
const BODY_KINDS: ReadonlySet<Kind> = new Set<Kind>(['compound', 'compsolid', 'solid']);

/** 9.6: a sample point stays this fraction of its entity's bounding-box diagonal off the boundary. */
const CLEARANCE = 1e-6;

/** OCCT's `Precision::Confusion`: points closer than this are the same point to the kernel. */
const CONFUSION = 1e-7;

const TWO_PI = 2 * Math.PI;

/** Surface kinds periodic in u, and in v. */
const PERIODIC_U: ReadonlySet<string> = new Set(['cylinder', 'cone', 'sphere', 'torus']);
const PERIODIC_V: ReadonlySet<string> = new Set(['torus']);

interface Entry {
  key: ShapeKey;
  /** Shared by the entries of one sub-shape held different ways round. */
  same: number;
  kind: Kind;
  hash: number;
  handle: ShapeHandle;
  orientation: string;
  /** Direct children in stored order. A seam's edge appears twice in its wire. */
  uses: ShapeKey[];
  box?: readonly [Vec3, Vec3];
  /** Compound of this entity's wires or shells, for boundary distances. */
  boundary?: ShapeHandle;
  sample?: Vec3 | null;
  /** A face's plane normal, or null off a plane; read once. */
  planeNormal?: Vec3 | null;
}

interface ShapeRecord {
  root: Entry;
  /** Sub-shapes of each kind in first-visit order, one per (shape, location): the kernel's `getSubShapes` order. */
  entries: Record<Kind, Entry[]>;
  /** The same entries by hash; a bucket holds more than one only when different sub-shapes share a hash. */
  byHash: Record<Kind, Map<number, Entry[]>>;
  topology?: ShapeTopology;
}

type WalkRecord = Omit<ShapeRecord, 'root'>;

function emptyRecord(): WalkRecord {
  const entries = {} as Record<Kind, Entry[]>;
  const byHash = {} as Record<Kind, Map<number, Entry[]>>;
  for (const kind of KINDS) {
    entries[kind] = [];
    byHash[kind] = new Map();
  }
  return { entries, byHash };
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const heldKey = ({ key, same }: Entry): HeldKey => ({ key, same });

/** The entry at a kernel position, or a `malformed` error naming what the list said. */
function at(entries: readonly Entry[], position: number | undefined, what: string): Entry {
  const entry = position === undefined ? undefined : entries[position];
  if (!entry) throw new NamingAdapterError('malformed', `There is no ${what} at ${position}`);
  return entry;
}

const point3 = (p: Vec3): { x: number; y: number; z: number } => ({ x: p[0], y: p[1], z: p[2] });

function wrapInto(value: number, min: number, max: number): number {
  let wrapped = value;
  while (wrapped < min - CONFUSION) wrapped += TWO_PI;
  while (wrapped > max + CONFUSION) wrapped -= TWO_PI;
  return wrapped;
}

export class NamingAdapter implements KernelFacts {
  private readonly shapes = new Map<ShapeRef, ShapeRecord>();
  private readonly keys = new Map<ShapeKey, Entry>();
  private readonly byHash = new Map<number, Entry[]>();
  /** The solid most recently registered with each face. */
  private readonly solidOfFace = new Map<ShapeKey, Entry>();
  private nextKey = 1;

  /** @param hashBound passed to every hash call; history must be asked for with the same value. */
  constructor(
    private readonly k: OcctKernel,
    readonly hashBound: number = HASH_BOUND,
  ) {}

  /**
   * Register a live shape and walk it. Call for each input before its operation
   * and for each shape with no history. The handle stays the caller's.
   */
  addShape(shape: ShapeHandle, ref?: ShapeRef): ShapeRef {
    const name = ref ?? `shape_${this.shapes.size + 1}`;
    if (this.shapes.has(name)) throw new NamingAdapterError('unknown', `Shape ${name} is already registered`);
    const walk = emptyRecord();
    const root = this.visit(this.ownedCopy(shape), walk);
    this.shapes.set(name, { ...walk, root });
    for (const solid of walk.entries.solid) {
      for (const face of this.descendants(solid, 'face')) this.solidOfFace.set(face.key, solid);
    }
    return name;
  }

  /** The kernel handle of a key, owned by the adapter and valid until `dispose`. */
  handleOf(key: ShapeKey): ShapeHandle {
    return this.entry(key).handle;
  }

  /** The key a sub-shape has in a registered shape. */
  keyIn(shape: ShapeRef, subShape: ShapeHandle): ShapeKey {
    const kind = this.kindOf(subShape);
    const found = this.record(shape)
      .byHash[kind].get(this.k.hashCode(subShape, this.hashBound))
      ?.find((entry) => this.k.isSame(entry.handle, subShape));
    if (!found) {
      throw new NamingAdapterError('unknown', `This ${kind} is not part of shape ${shape}`);
    }
    return found.key;
  }

  /** Face hashes of registered shapes, for a `*WithHistory` call's `inputFaceHashes`. */
  faceHashes(shapes: readonly ShapeRef[]): number[] {
    return shapes.flatMap((ref) => this.record(ref).entries.face.map((face) => face.hash));
  }

  /** The history of one `*WithHistory` call. Registers its result. */
  history(evolution: EvolutionData, inputs: OperationHistory['inputs'], ref?: ShapeRef): OperationHistory {
    return this.buildHistory(evolution, inputs, this.addShape(evolution.result, ref));
  }

  /**
   * The history of a kernel sweep, loft or revolve of `profiles` (one shape,
   * or the section wires of a loft): its walls by profile edge, and its caps,
   * which a full revolve or a closed sweep does not have. A profile edge on a
   * revolve's axis makes no wall. With `spine`, the wire a pipe or sweep ran
   * along, also its faces by path edge and profile edge.
   */
  sweepHistory(
    evolution: EvolutionData,
    profiles: ShapeRef | readonly ShapeRef[],
    ref?: ShapeRef,
    spine?: ShapeRef,
  ): OperationHistory {
    const inputs = typeof profiles === 'string' ? [profiles] : profiles;
    const history = this.history(
      evolution,
      inputs.map((shape) => ({ shape, use: 'target' as const })),
      ref,
    );
    const faces = this.record(history.result).entries.face;
    const capFaces = (positions: readonly number[]) =>
      positions.map((position) => at(faces, position, 'cap face in the result').key);
    const first = capFaces(evolution.firstShapeIndexed);
    const last = capFaces(evolution.lastShapeIndexed);
    const caps = new Set([...first, ...last]);
    return {
      ...history,
      faces: { ...history.faces, added: history.faces.added.filter((face) => !caps.has(face)) },
      caps: { first, last },
      ...(spine === undefined ? {} : { spine: this.spinePairs(evolution, inputs, spine, history.result) }),
    };
  }

  /** `spineGeneratedIndexed`, runs of `[spine edge, profile edge, count, face...]`, as keys. The profile is the first. */
  private spinePairs(
    evolution: EvolutionData,
    profiles: readonly ShapeRef[],
    spine: ShapeRef,
    result: ShapeRef,
  ): NonNullable<OperationHistory['spine']> {
    const list = evolution.spineGeneratedIndexed;
    const faces = this.record(result).entries.face;
    const spineEdges = this.record(spine).entries.edge;
    const [profile] = profiles;
    const profileEdges = profile === undefined ? [] : this.record(profile).entries.edge;
    const pairs: { path: ShapeKey; profile: ShapeKey; faces: ShapeKey[] }[] = [];
    for (let i = 0; i < list.length;) {
      const count = list[i + 2];
      if (count === undefined || i + 3 + count > list.length) {
        throw new NamingAdapterError('malformed', `The spine list ends inside the entry at ${i}`);
      }
      pairs.push({
        path: at(spineEdges, list[i], 'edge of the spine').key,
        profile: at(profileEdges, list[i + 1], 'edge of the profile').key,
        faces: list.slice(i + 3, i + 3 + count).map((f) => at(faces, f, 'face of the sweep').key),
      });
      i += 3 + count;
    }
    return pairs;
  }

  topology(shape: ShapeRef): ShapeTopology {
    const record = this.record(shape);
    if (record.topology) return record.topology;

    const faceCounts = new Map<ShapeKey, Map<ShapeKey, number>>();
    for (const face of record.entries.face) {
      for (const wire of this.children(face, 'wire')) {
        for (const edge of this.children(wire, 'edge')) {
          const counts = faceCounts.get(edge.key) ?? new Map<ShapeKey, number>();
          counts.set(face.key, (counts.get(face.key) ?? 0) + 1);
          faceCounts.set(edge.key, counts);
        }
      }
    }

    const edgesAtVertex = new Map<ShapeKey, ShapeKey[]>();
    const edges = record.entries.edge.map((edge) => {
      const faces = [...(faceCounts.get(edge.key) ?? [])].map(([face, count]) => ({
        face,
        count: count > 1 ? (2 as const) : (1 as const),
      }));
      const ends = unique(edge.uses);
      for (const end of ends) edgesAtVertex.set(end, [...(edgesAtVertex.get(end) ?? []), edge.key]);
      const seam = faces.length === 1 && faces[0]?.count === 2;
      return {
        edge: edge.key,
        form: this.isDegenerate(edge) ? ('degenerate' as const) : seam ? ('seam' as const) : ('normal' as const),
        faces,
        ends,
      };
    });

    const facesOfEdge = new Map(edges.map((edge) => [edge.edge, edge.faces]));
    const topology: ShapeTopology = {
      faces: record.entries.face.map((face) => face.key),
      edges,
      vertices: record.entries.vertex.map((vertex) => {
        const atVertex = edgesAtVertex.get(vertex.key) ?? [];
        const faces = atVertex.flatMap((edge) => (facesOfEdge.get(edge) ?? []).map((use) => use.face));
        return { vertex: vertex.key, faces: unique(faces), edges: atVertex };
      }),
      solids: record.entries.solid.map((solid) => ({
        solid: solid.key,
        faces: this.descendants(solid, 'face').map((face) => face.key),
      })),
    };
    record.topology = topology;
    return topology;
  }

  edgeGeometry(edge: ShapeKey): EdgeGeometry {
    const entry = this.entryOf(edge, 'edge');
    if (this.isDegenerate(entry)) {
      const point = this.endPoint(entry);
      return { curve: { kind: 'line' }, start: point, end: point, closed: true };
    }
    const { first, last } = this.k.curveParameters(entry.handle);
    return {
      curve: curveFacts(this.k, entry.handle, this.k.curveType(entry.handle)),
      start: this.curvePoint(entry, first),
      end: this.curvePoint(entry, last),
      closed: this.isClosed(entry),
    };
  }

  edgeRange(edge: ShapeKey): readonly [number, number] | null {
    const entry = this.entryOf(edge, 'edge');
    if (this.isDegenerate(entry)) return null;
    const { first, last } = this.k.curveParameters(entry.handle);
    return [first, last];
  }

  faceGeometry(face: ShapeKey): FaceGeometry {
    const entry = this.entryOf(face, 'face');
    return { surface: this.surface(entry), loops: this.loops(entry) };
  }

  measures(entity: ShapeKey): Measures {
    const entry = this.entry(entity);
    switch (entry.kind) {
      case 'vertex':
        return { point: this.vertexPoint(entry) };
      case 'edge':
        return this.edgeMeasures(entry);
      case 'face':
        return this.faceMeasures(entry);
      case 'wire':
        return { length: this.k.getLength(entry.handle), bbox: this.bbox(entry) };
      case 'shell':
        return { area: this.k.getSurfaceArea(entry.handle), bbox: this.bbox(entry) };
      default:
        return { volume: this.k.getVolume(entry.handle), bbox: this.bbox(entry) };
    }
  }

  /**
   * The normal of a face's plane, up to sign, or null for a face on any other
   * surface: its surface alone is read, not the face's area, centre or
   * vertices as `measures` reads them.
   */
  planeNormal(face: ShapeKey): Vec3 | null {
    const entry = this.entryOf(face, 'face');
    if (entry.planeNormal === undefined) {
      const surface = this.k.surfaceType(entry.handle) === 'plane' ? this.surface(entry) : undefined;
      entry.planeNormal = surface?.kind === 'plane' ? surface.normal : null;
    }
    return entry.planeNormal;
  }

  samplePoint(entity: ShapeKey): Vec3 | null {
    const entry = this.entry(entity);
    if (entry.sample === undefined) entry.sample = this.findSample(entry);
    return entry.sample;
  }

  side(point: Vec3, face: ShapeKey, test: 'solid' | 'normal'): 1 | -1 | 0 | null {
    const entry = this.entryOf(face, 'face');
    return test === 'solid' ? this.solidSide(point, entry) : this.normalSide(point, entry);
  }

  subShapes(shape: ShapeRef): readonly SubShape[] {
    const record = this.record(shape);
    const ordered = KINDS.flatMap((kind) => record.entries[kind]);
    const index = new Map(ordered.map((entry, i) => [entry.key, i]));
    return ordered.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      children: unique(entry.uses).flatMap((child) => index.get(child) ?? []),
    }));
  }

  /** Release every handle the adapter holds. The adapter is empty afterwards. */
  dispose(): void {
    for (const entry of this.keys.values()) {
      this.k.release(entry.handle);
      if (entry.boundary !== undefined) this.k.release(entry.boundary);
    }
    this.keys.clear();
    this.byHash.clear();
    this.shapes.clear();
    this.solidOfFace.clear();
  }

  /**
   * The kernel numbers its inputs in the order it read them, and `inputs` may
   * list them in another (by role): each kernel input is matched to the given
   * one with its root hash and face and edge counts, two that match alike in
   * the order given. An input the kernel read that is not given, or a given one
   * it did not read, or other result counts, mean the history was read against
   * the wrong shapes: an error, not a history that names the wrong sub-shapes.
   */
  private buildHistory(
    evolution: EvolutionData,
    inputs: OperationHistory['inputs'],
    result: ShapeRef,
  ): OperationHistory {
    const given = inputs.map(({ shape }) => this.record(shape));
    const resultRecord = this.record(result);
    const mismatch = () =>
      new NamingAdapterError(
        'malformed',
        `The kernel's history reads other shapes than ${inputs.map((i) => i.shape).join(', ')} into ${result}`,
      );
    let records = given;
    const reported = evolution.inputShapes;
    if (reported.length > 0) {
      const signature = (r: ShapeRecord) => [r.root.hash, r.entries.face.length, r.entries.edge.length].join();
      const unused = given.map((_, i) => i);
      records = [];
      for (let i = 0; i * 3 < reported.length; i++) {
        const want = reported.slice(3 * i, 3 * i + 3).join();
        const alike = unused.filter((j) => signature(given[j] as ShapeRecord) === want);
        const pick = alike.includes(i) ? i : alike[0];
        if (pick === undefined) throw mismatch();
        unused.splice(unused.indexOf(pick), 1);
        records.push(given[pick] as ShapeRecord);
      }
      const counts = [resultRecord.entries.face.length, resultRecord.entries.edge.length];
      if (unused.length > 0 || evolution.resultCounts.join() !== counts.join()) throw mismatch();
    }
    const inputSubShapes: InputSubShapes[] = records.map((r) => ({
      faces: r.entries.face.map(heldKey),
      edges: r.entries.edge.map(heldKey),
    }));
    const resultSubShapes: ResultSubShapes = KINDS.map((kind) => resultRecord.entries[kind].map(heldKey));
    return buildOperationHistory(evolution, inputSubShapes, resultSubShapes, { result, inputs });
  }

  /** A handle to the same shape that does not depend on the caller's. */
  private ownedCopy(shape: ShapeHandle): ShapeHandle {
    const wrapper = this.k.makeCompound([shape]);
    const [own] = this.k.iterShapes(wrapper);
    this.k.release(wrapper);
    if (own === undefined) throw new NamingAdapterError('malformed', 'A null shape cannot be registered');
    return own;
  }

  private kindOf(shape: ShapeHandle): Kind {
    const kind = this.k.getShapeType(shape);
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new NamingAdapterError('unsupported', `A shape of kind "${kind}" cannot be registered`);
    }
    return kind as Kind;
  }

  /** Take over `handle`, entering it and what it holds into `walk`. Depth first, children in stored order. */
  private visit(handle: ShapeHandle, walk: WalkRecord): Entry {
    let entry: Entry;
    try {
      const kind = this.kindOf(handle);
      const hash = this.k.hashCode(handle, this.hashBound);

      // One entry per (shape, location) in a shape, whatever the orientation.
      const inShape = walk.byHash[kind].get(hash)?.find((held) => this.k.isSame(held.handle, handle));
      if (inShape) {
        this.k.release(handle);
        return inShape;
      }

      const orientation = ORIENTED.has(kind) ? this.k.shapeOrientation(handle) : '';
      const same = this.sameAs(kind, hash, handle);
      const known = same.find((held) => held.orientation === orientation);
      if (known) {
        this.k.release(handle);
        this.adopt(known, walk);
        return known;
      }

      const key = this.nextKey++;
      entry = { key, same: same[0]?.same ?? key, kind, hash, handle, orientation, uses: [] };
    } catch (e) {
      // Not yet held by an entry: the handle is still this call's to release.
      this.k.release(handle);
      throw e;
    }
    this.keys.set(entry.key, entry);
    this.byHash.set(entry.hash, [...(this.byHash.get(entry.hash) ?? []), entry]);
    this.enter(entry, walk);
    const children = this.k.iterShapes(entry.handle);
    let next = 0;
    try {
      for (; next < children.length; next++) entry.uses.push(this.visit(children[next] as ShapeHandle, walk).key);
    } catch (e) {
      // The child that threw released its own handle; the ones not reached are released here.
      for (const child of children.slice(next + 1)) this.k.release(child);
      throw e;
    }
    return entry;
  }

  /** Enter an entry known from another shape, with what it holds, no kernel calls needed. */
  private adopt(entry: Entry, walk: WalkRecord): void {
    if (walk.byHash[entry.kind].get(entry.hash)?.some((held) => held.same === entry.same)) return;
    this.enter(entry, walk);
    for (const child of entry.uses) this.adopt(this.entry(child), walk);
  }

  private enter(entry: Entry, walk: WalkRecord): void {
    walk.entries[entry.kind].push(entry);
    const bucket = walk.byHash[entry.kind].get(entry.hash);
    if (bucket) bucket.push(entry);
    else walk.byHash[entry.kind].set(entry.hash, [entry]);
  }

  /** The entries already standing for this sub-shape, one per orientation; entries that only share its hash are passed over. */
  private sameAs(kind: Kind, hash: number, handle: ShapeHandle): Entry[] {
    return (this.byHash.get(hash) ?? []).filter((entry) => entry.kind === kind && this.k.isSame(entry.handle, handle));
  }

  private record(shape: ShapeRef): ShapeRecord {
    const record = this.shapes.get(shape);
    if (!record) throw new NamingAdapterError('unknown', `Shape ${shape} is not registered`);
    return record;
  }

  private entry(key: ShapeKey): Entry {
    const entry = this.keys.get(key);
    if (!entry) throw new NamingAdapterError('unknown', `Key ${key} is not held by this adapter`);
    return entry;
  }

  private entryOf(key: ShapeKey, kind: Kind): Entry {
    const entry = this.entry(key);
    if (entry.kind !== kind) throw new NamingAdapterError('unknown', `Key ${key} is a ${entry.kind}, not a ${kind}`);
    return entry;
  }

  private children(entry: Entry, kind: Kind): Entry[] {
    return entry.uses.map((key) => this.entry(key)).filter((child) => child.kind === kind);
  }

  /** Every sub-shape of one kind below an entry, once each, in first-visit order. */
  private descendants(entry: Entry, kind: Kind): Entry[] {
    const found = new Map<ShapeKey, Entry>();
    const walk = (at: Entry): void => {
      for (const key of at.uses) {
        const child = this.entry(key);
        if (child.kind === kind) found.set(key, child);
        else walk(child);
      }
    };
    walk(entry);
    return [...found.values()];
  }

  /** Degenerate edges have no length. Their curve type says nothing: a cone's apex reports a circle. */
  private isDegenerate(edge: Entry): boolean {
    return unique(edge.uses).length === 1 && this.k.curveLength(edge.handle) <= CONFUSION;
  }

  private isClosed(edge: Entry): boolean {
    return unique(edge.uses).length === 1 || this.k.curveIsClosed(edge.handle);
  }

  private vertexPoint(vertex: Entry): Vec3 {
    return toVec3(this.k.vertexPosition(vertex.handle));
  }

  private endPoint(edge: Entry): Vec3 {
    const [end] = this.children(edge, 'vertex');
    if (!end) throw new NamingAdapterError('malformed', `Edge ${edge.key} has no vertex`);
    return this.vertexPoint(end);
  }

  private curvePoint(edge: Entry, parameter: number): Vec3 {
    return toVec3(this.k.curvePointAtParam(edge.handle, parameter));
  }

  private bbox(entry: Entry): readonly [Vec3, Vec3] {
    if (!entry.box) {
      const b = this.k.getBoundingBox(entry.handle);
      entry.box = [
        [b.xmin, b.ymin, b.zmin],
        [b.xmax, b.ymax, b.zmax],
      ];
    }
    return entry.box;
  }

  private surface(face: Entry): SurfaceFacts {
    return surfaceFacts(this.k, face.handle, this.k.surfaceType(face.handle));
  }

  /** A face's boundary loops. Composed orientations already run with the face on the left of its outward normal. */
  private loops(face: Entry): FaceGeometry['loops'] {
    const outerWire = this.k.outerWire(face.handle);
    const wires = this.k.iterShapes(face.handle).filter((wire) => {
      if (this.kindOf(wire) === 'wire') return true;
      this.k.release(wire);
      return false;
    });
    const outer = wires.map((wire) => this.k.isSame(wire, outerWire));
    this.k.release(outerWire);
    const loops = wires.map((wire, i) => ({ outer: outer[i] === true, loop: this.wireLoop(wire) }));
    for (const wire of wires) this.k.release(wire);
    return [...loops.filter((l) => l.outer), ...loops.filter((l) => !l.outer)].map((l) => l.loop);
  }

  private wireLoop(wire: ShapeHandle): { edge: ShapeKey; reversed: boolean }[] {
    const uses = this.k.iterShapes(wire).map((edge) => {
      const use = this.edgeUse(edge);
      this.k.release(edge);
      return use;
    });
    return orderLoop(uses).map(({ edge, reversed }) => ({ edge, reversed }));
  }

  /** One oriented edge of a wire. A forward vertex is where the oriented edge starts. */
  private edgeUse(edge: ShapeHandle): LoopUse<ShapeKey> {
    const orientation = this.k.shapeOrientation(edge);
    if (orientation !== 'forward' && orientation !== 'reversed') {
      throw new NamingAdapterError('unsupported', `A wire edge with orientation "${orientation}" has no direction`);
    }
    const [known] = this.sameAs('edge', this.k.hashCode(edge, this.hashBound), edge);
    if (!known) throw new NamingAdapterError('unknown', 'A wire holds an edge this adapter never walked');

    let from: ShapeKey | undefined;
    let to: ShapeKey | undefined;
    for (const vertex of this.k.iterShapes(edge)) {
      const key = this.sameAs('vertex', this.k.hashCode(vertex, this.hashBound), vertex)[0]?.key;
      const end = this.k.shapeOrientation(vertex);
      if (end === 'forward') from = key;
      if (end === 'reversed') to = key;
      this.k.release(vertex);
    }
    if (from === undefined || to === undefined) {
      throw new NamingAdapterError('malformed', `Edge ${known.key} does not have two ends`);
    }
    return { edge: known.key, reversed: orientation === 'reversed', from, to };
  }

  private edgeMeasures(edge: Entry): Measures {
    const box = this.bbox(edge);
    if (this.isDegenerate(edge)) {
      const point = this.endPoint(edge);
      return { center: point, length: 0, bbox: box, curve: 'line', quarter: point, threeQuarter: point };
    }

    const h = edge.handle;
    const { first, last } = this.k.curveParameters(h);
    const closed = this.isClosed(edge);
    // 9.7: an open edge is measured from its smaller end, a closed one from its parametric start.
    const flip = !closed && compareVec3(this.curvePoint(edge, last), this.curvePoint(edge, first)) < 0;
    const parameter = (t: number): number => (flip ? last - t * (last - first) : first + t * (last - first));

    const type = this.k.curveType(h);
    const measures: Measures = {
      length: this.k.curveLength(h),
      bbox: box,
      curve: type === 'line' || type === 'circle' || type === 'ellipse' ? type : 'freeform',
      quarter: this.curvePoint(edge, parameter(0.25)),
      threeQuarter: this.curvePoint(edge, parameter(0.75)),
    };
    if (closed) {
      const facts = type === 'circle' || type === 'ellipse' ? curveFacts(this.k, h, type) : undefined;
      const center = facts && 'center' in facts ? facts.center : toVec3(this.k.getLinearCenterOfMass(h));
      return { ...measures, center };
    }
    const tangent = unit(toVec3(this.k.curveTangent(h, parameter(0.5))));
    return {
      ...measures,
      midpoint: this.curvePoint(edge, parameter(0.5)),
      tangent: flip ? scale(tangent, -1) : tangent,
    };
  }

  private faceMeasures(face: Entry): Measures {
    const h = face.handle;
    const type = this.k.surfaceType(h);
    const analytic = ['plane', 'cylinder', 'cone', 'sphere', 'torus'].includes(type);
    const points = this.descendants(face, 'vertex').map((vertex) => this.vertexPoint(vertex));
    const measures: Measures = {
      centroid: toVec3(this.k.getSurfaceCenterOfMass(h)),
      area: this.k.getSurfaceArea(h),
      bbox: this.bbox(face),
      surface: analytic ? type : 'freeform',
      vertices: points.sort(compareVec3),
    };
    if (!analytic || type === 'sphere') return measures;
    const surface = this.surface(face);
    if (surface.kind === 'plane') return { ...measures, normal: surface.normal };
    return surface.kind === 'bspline' ? measures : { ...measures, axis: surface.axis };
  }

  private clearanceFor(entry: Entry): number {
    const [low, high] = this.bbox(entry);
    return CLEARANCE * distance(low, high);
  }

  /** Compound of a face's wires or a body's shells, built once. */
  private boundary(entry: Entry): ShapeHandle {
    if (entry.boundary === undefined) {
      const parts = entry.kind === 'face' ? this.children(entry, 'wire') : this.descendants(entry, 'shell');
      entry.boundary = this.k.makeCompound(parts.map((part) => part.handle));
    }
    return entry.boundary;
  }

  /** Distance from a point to a shape, trimmed to the shape. Inside a solid it is 0; boundaries give the real value. */
  private distanceTo(point: Vec3, shape: ShapeHandle): number {
    const vertex = this.k.makeVertex(point[0], point[1], point[2]);
    try {
      return this.k.distanceBetween(vertex, shape);
    } finally {
      this.k.release(vertex);
    }
  }

  private findSample(entry: Entry): Vec3 | null {
    if (entry.kind === 'vertex') return this.vertexPoint(entry);
    if (entry.kind === 'edge') return this.edgeSample(entry);
    if (entry.kind === 'face') return this.faceSample(entry);
    if (BODY_KINDS.has(entry.kind)) return this.bodySample(entry);
    throw new NamingAdapterError('unsupported', `9.6 defines no sample point for a ${entry.kind}`);
  }

  private edgeSample(edge: Entry): Vec3 {
    if (this.isDegenerate(edge)) return this.endPoint(edge);
    const { first, last } = this.k.curveParameters(edge.handle);
    return this.curvePoint(edge, (first + last) / 2);
  }

  private faceSample(face: Entry): Vec3 | null {
    const h = face.handle;
    const { uMin, uMax, vMin, vMax } = this.k.uvBounds(h);
    const boundary = this.boundary(face);
    return firstClearPoint(
      sampleSequence(2),
      ([a = 0, b = 0]) => {
        const u = uMin + a * (uMax - uMin);
        const v = vMin + b * (vMax - vMin);
        if (this.k.classifyPointOnFace(h, u, v) !== 'in') return null;
        const point = toVec3(this.k.pointOnSurface(h, u, v));
        return { point, clearance: this.distanceTo(point, boundary) };
      },
      this.clearanceFor(face),
    );
  }

  private bodySample(body: Entry): Vec3 | null {
    const [low, high] = this.bbox(body);
    const boundary = this.boundary(body);
    return firstClearPoint(
      sampleSequence(3),
      ([a = 0, b = 0, c = 0]) => {
        const point: Vec3 = [
          low[0] + a * (high[0] - low[0]),
          low[1] + b * (high[1] - low[1]),
          low[2] + c * (high[2] - low[2]),
        ];
        if (!this.k.containsPoint(body.handle, point3(point))) return null;
        return { point, clearance: this.distanceTo(point, boundary) };
      },
      this.clearanceFor(body),
    );
  }

  /** Outside +1, inside −1. The kernel calls a boundary point inside, so that case is ruled out first. */
  private solidSide(point: Vec3, face: Entry): 1 | -1 | 0 | null {
    const solid = this.solidOfFace.get(face.key);
    if (!solid) throw new NamingAdapterError('unknown', `Face ${face.key} is not part of any registered solid`);
    if (this.distanceTo(point, this.boundary(solid)) <= CONFUSION) return 0;
    return this.k.containsPoint(solid.handle, point3(point)) ? -1 : 1;
  }

  private normalSide(point: Vec3, face: Entry): 1 | -1 | 0 | null {
    const onSurface = this.surfaceFoot(point, face);
    if (onSurface && distance(point, onSurface) <= CONFUSION) return 0;

    const candidates = this.closestCandidates(point, face, onSurface);
    const nearest = Math.min(...candidates.map((q) => distance(point, q)));
    // A nearer point than any candidate means a local minimum no call reports: no answer, not a guess.
    if (nearest > this.distanceTo(point, face.handle) + CONFUSION) return null;

    return agreedSign(
      candidates.filter((q) => distance(point, q) <= nearest + CONFUSION).map((q) => this.signAt(point, q, face)),
    );
  }

  /** The closest point on the face's untrimmed surface. */
  private surfaceFoot(point: Vec3, face: Entry): Vec3 | undefined {
    return this.unlessNoProjection(() => toVec3(this.k.projectPointOnFace(face.handle, point3(point))));
  }

  /**
   * Every point the face's closest point can be. `projectPointOnFace` ignores
   * the trim and `projectPointOnEdge` stops short of an edge's ends, so these
   * are the surface foot when it is on the face, each edge's foot, and each
   * vertex.
   */
  private closestCandidates(point: Vec3, face: Entry, foot: Vec3 | undefined): Vec3[] {
    const candidates: Vec3[] = [];
    if (foot && this.isOnFace(foot, face)) candidates.push(foot);
    for (const edge of this.descendants(face, 'edge')) {
      const onEdge = this.isDegenerate(edge)
        ? undefined
        : this.unlessNoProjection(() => toVec3(this.k.projectPointOnEdge(edge.handle, point3(point)).point));
      if (onEdge) candidates.push(onEdge);
    }
    for (const vertex of this.descendants(face, 'vertex')) candidates.push(this.vertexPoint(vertex));
    return candidates;
  }

  /** Whether a point of the face's surface lies within its trim. */
  private isOnFace(point: Vec3, face: Entry): boolean {
    const h = face.handle;
    const type = this.k.surfaceType(h);
    const { uMin, uMax, vMin, vMax } = this.k.uvBounds(h);
    const uv = this.unlessNoProjection(() => this.k.uvFromPoint(h, point3(point)));
    if (!uv) return false;
    const u = PERIODIC_U.has(type) ? wrapInto(uv.u, uMin, uMax) : uv.u;
    const v = PERIODIC_V.has(type) ? wrapInto(uv.v, vMin, vMax) : uv.v;
    return this.k.classifyPointOnFace(h, u, v) !== 'out';
  }

  /** Which side of the outward normal at `q` a point is on; 0 when that has no answer. */
  private signAt(point: Vec3, q: Vec3, face: Entry): 1 | -1 | 0 {
    const normal = this.unlessNoProjection(() => {
      const { u, v } = this.k.uvFromPoint(face.handle, point3(q));
      return toVec3(this.k.surfaceNormal(face.handle, u, v));
    });
    if (!normal) return 0;
    const side = dot(sub(point, q), normal);
    if (side > 0) return 1;
    return side < 0 ? -1 : 0;
  }

  /** Runs a projection the kernel may refuse, as it does past an edge's ends or at a surface's pole. */
  private unlessNoProjection<T>(project: () => T): T | undefined {
    try {
      return project();
    } catch (e) {
      if (e instanceof OcctError) return undefined;
      throw e;
    }
  }
}

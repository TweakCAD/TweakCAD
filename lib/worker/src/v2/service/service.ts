/**
 * The version-2 evaluation service: evaluates a document, keeps the
 * evaluation alive (its kernel shapes, naming adapter and states) until the
 * next one, and answers the app's questions about it. It runs where the
 * kernel runs, in the worker; `worker.ts` exposes it and `client.ts` is the
 * app's side.
 *
 * Keys name entities of the kept evaluation (see `types.ts`). A part's
 * display is its state at its rollback (7.1), or at the end of its timeline;
 * an assembly's instances share their definition's mesh, each with the
 * placement the pose solve gave it, so a part placed many times is meshed
 * once. A hidden body is not meshed until it shows, and a display made
 * again for a change only to what is shown (`EvaluateServiceOptions.restyle`)
 * keeps the keys. A body shape meshed before, in this evaluation or one it
 * resumed from, is not meshed again: its pick tables are made from what the
 * first meshing found, and its geometry is not sent when the client holds it
 * (`EvaluateServiceOptions.held`).
 *
 * The service owns its kernel: every shape made on it since the kept
 * evaluation started is released when an evaluation starts afresh.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { onSurface, unheldConstraints, type SurfaceSpec } from './onSurfaces';
import {
  canonicalize,
  compareCreation,
  containsInOrder,
  cyclePolyline,
  describeEntity,
  finest,
  idItem,
  isNameHash,
  isPlainObject,
  ladderOf,
  prepareCurve,
  resolve,
  resolveRegion,
  ValueEvaluator,
  ValuePause,
  writeRecord,
  type DetectedRegion,
  type EntityKey,
  type EntityKind,
  type EntityRecord,
  type ExprValue,
  type JsonValue,
  type Measures,
  type NameTableJson,
  type NamedEntity,
  type NamedState,
  type ShapeKey,
  type ShapeRef,
  type SubShape,
  type SolvedCurve,
} from '@tweakcad/format';
import { HASH_BOUND, NamingAdapter } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  FeaturePause,
  type ConstructionOutput,
  type Evaluation,
  type Frame,
  type Json,
  type PartResult,
  type SketchResult,
} from '../context';
import type { AssemblyNode, AssemblyResult } from '../assembly';
import { emptyPart, variantsOf, documentOf } from '../variants';
import { lift } from '../profiles';
import { externalCandidates } from '../sketchExternal';
import { QUANTITY, measureOperands, type Operand } from '../builders/measure';
import { compose, IDENTITY, inverse, matrixOf, type Rigid } from '../rigid';
import { motionOf } from '../contexts';
import { runMotion } from '../copies';
import { updateContexts as recapture } from '../capture';
import { FreezeError, freezeFeature } from '../freeze';
import { evaluateCached, namesHeld, stepsOf, valuesFor, type Recorded } from './cache';
import { DEFAULT_COLOR, PartStyles, readProperties, type Properties } from './styles';
import { asciiStl, binaryStl } from './stl';
import { build3mf, type ThreeMfBody } from './threemf';
import { importShape, type ImportFormat, type ImportedShape, type ImportProgress } from './importShape';
import { bodyIdentity } from './identity';
export { bodyIdentity };
import { exportFcstd, type FcstdExport, type PlacedShape } from '../fcstd/export';
import type { FcPlacement } from '../fcstd/file';
import type {
  AssemblyDisplay,
  BeforeScope,
  BodiesBefore,
  BodyDisplay,
  BodyMesh,
  ConstructionDisplay,
  ContextRequest,
  ContextsUpdate,
  DefinitionDisplay,
  FrozenResult,
  Display,
  EntityInfo,
  EvaluateServiceOptions,
  ExportFormat,
  ExportOptions,
  ExternalCandidates,
  FrameDisplay,
  InstanceDisplay,
  ListedBody,
  Key,
  MeasureKind,
  Measured,
  BodyMeasures,
  PickOptions,
  PickOutline,
  PickTarget,
  Picked,
  PickedEntity,
  Placement,
  PlacedReference,
  Progress,
  Resolved,
  ResolveScope,
  Scope,
  ShapeMeasures,
  SketchDisplay,
  Style,
  ThreadDisplay,
  Vec3,
} from './types';

/** The display deflection, as fine as the app has always shown. */
const DISPLAY = { linearDeflection: 0.05, angularDeflection: 0.1 };
type Deflection = typeof DISPLAY;

/** The mesh of a body the display does not send: one the client holds, or a hidden body's. */
function emptyMesh(): BodyMesh {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    faces: new Uint32Array(0),
    segments: new Float32Array(0),
    edges: new Uint32Array(0),
    points: new Float32Array(0),
    vertices: new Uint32Array(0),
  };
}

/** Whether two JSON values are the same. */
function sameJson(a: unknown, b: unknown): boolean {
  return a === b || canonicalize(a as JsonValue) === canonicalize(b as JsonValue);
}

/** Whether two JSON values are equal, key order aside; stops at the first difference. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (Array.isArray(b)) return false;
  const [x, y] = [a as Json, b as Json];
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => k in y && equal(x[k], y[k]));
}

/**
 * Whether two documents are equal but for what is shown: the attributes of
 * part and assembly rows, a part's rollback (evaluation runs the whole
 * timeline whatever it says), and the name table (whose entries a feature
 * holds are checked on their own).
 */
function sameButShown(a: Json, b: Json): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('names');
  for (const key of keys) {
    if (key !== 'parts' && key !== 'assemblies') {
      if (!equal(a[key], b[key])) return false;
      continue;
    }
    const [x, y] = [a[key], b[key]];
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
      if (!equal(x, y)) return false;
      continue;
    }
    for (let i = 0; i < x.length; i++) {
      const [r, s] = [x[i] as Json, y[i] as Json];
      if (!isPlainObject(r) || !isPlainObject(s)) {
        if (!equal(r, s)) return false;
        continue;
      }
      const fields = new Set([...Object.keys(r), ...Object.keys(s)]);
      fields.delete('attributes');
      if (key === 'parts') fields.delete('rollback');
      for (const f of fields) if (!equal(r[f], s[f])) return false;
    }
  }
  return true;
}
/** Evaluations in a row that may resume from one evaluation's shapes before one starts afresh. */
const MAX_CARRIED = 16;
const ENTITY_KINDS = new Set<EntityKind>([
  'face',
  'edge',
  'vertex',
  'body',
  'region',
  'curve',
  'plane',
  'axis',
  'point',
  'frame',
]);

/** One build of a part, as the service keeps it. */
interface Definition {
  index: number;
  part: string;
  variant: string;
  /** The evaluation it was built in, and its part row there. */
  ev: Evaluation;
  row: Json;
  /** Its build at the end of the timeline, and the one shown. */
  result: PartResult;
  shown: PartResult;
  rollback: string | null;
  /** For a part of the document: the part after each feature, by ordinal. */
  steps: readonly (PartResult | undefined)[] | undefined;
  styles: PartStyles;
}

interface Leaf {
  path: Json;
  definition: Definition;
  placement: Rigid;
  /** The assembly's own node it lies in, and its placement in that node's frame. */
  top: AssemblyNode;
  inTop: Rigid;
  /** Each body of the definition and its placed copy in the assembly's result. */
  pairs: [ShapeRef, ShapeRef][];
  override: Partial<Style>;
  visible: boolean;
}

interface AssemblyView {
  id: string;
  result: AssemblyResult;
  leaves: Leaf[];
  /** Assembly sub-shape key → its instance and the definition's sub-shape key; built when first asked. */
  back?: Map<ShapeKey, { index: number; key: ShapeKey }>;
}

type Entry =
  | { type: 'model'; scope: string; key: ShapeKey; info: EntityInfo }
  | { type: 'curve'; def: Definition; sketch: SketchResult; root: string; glyph: boolean; info: EntityInfo }
  | { type: 'point'; def: Definition; sketch: SketchResult; id: string; info: EntityInfo }
  | {
      type: 'region';
      def: Definition;
      sketch: SketchResult;
      row: string | null;
      region: DetectedRegion;
      info: EntityInfo;
    }
  | { type: 'construction'; def: Definition; output: ConstructionOutput; info: EntityInfo };

/** An entry before it has its key. */
type Draft<E> = E extends unknown ? Omit<E, 'info'> & { info: Omit<EntityInfo, 'key'> } : never;

const scopeKey = (s: Scope) => ('definition' in s ? `d${s.definition}` : `a${s.assembly}`);
const v3 = (v: readonly number[]): Vec3 => [v[0] as number, v[1] as number, v[2] as number];
const frameOut = (f: Frame): FrameDisplay => ({ origin: v3(f.origin), x: v3(f.x), y: v3(f.y), normal: v3(f.normal) });

/**
 * Whether `e` is the entity `key` named when it was recorded, or a piece of
 * it: it has the name or carries it as an alias, on a branch that holds the
 * recorded branch's splits still in effect.
 */
function carries(e: NamedEntity, key: EntityKey, state: NamedState): boolean {
  const wanted = key.branch.filter((b) => state.splits.has(b.split));
  const branches = [
    ...(e.ladder.includes(key.hash) ? [e.branch] : []),
    ...e.aliases.filter((a) => a.hash === key.hash).map((a) => a.branch),
  ];
  return branches.some((b) => containsInOrder(b, wanted));
}

/** The `n`-th sub-shape key of `to` for `from`'s, the two being copies in the same index order. */
function pairKeys(ev: Evaluation, from: ShapeRef, to: ShapeRef, out: Map<ShapeKey, ShapeKey>): void {
  const a = ev.adapter.subShapes(from);
  const b = ev.adapter.subShapes(to);
  a.forEach((s, i) => {
    const t = b[i];
    if (t && t.kind === s.kind) out.set(s.key, t.key);
  });
}

/** The state a part shows: at its rollback (7.1), when its steps are known, otherwise at the end of its timeline. */
function shownAt(
  row: Json,
  result: PartResult,
  steps: readonly (PartResult | undefined)[] | undefined,
): { shown: PartResult; rollback: string | null } {
  const before = (row.rollback as Json | undefined)?.before as Json | undefined;
  const ordinal = before ? ((row.timeline as Json[]) ?? []).findIndex((f) => f.id === before.id) : -1;
  if (ordinal < 0 || !steps) return { shown: result, rollback: null };
  return { shown: ordinal === 0 ? emptyPart() : (steps[ordinal - 1] ?? result), rollback: before?.id as string };
}

/** How far a display's meshing has come, for progress. */
interface Meshing {
  done: number;
  total: number;
  progress: ((p: Progress) => void) | undefined;
}

/**
 * What meshing a body shape found, kept to make its pick tables again
 * without the kernel while the shape lives: the geometry depends on the
 * shape alone, the tables on which of its sub-shapes have names.
 */
interface MeshPlan {
  /** The geometry's id, which the client keeps it under. */
  id: number;
  /** Per face with triangles: first triangle, triangle count, face. */
  faces: number[];
  /** Per drawn edge with a name then: first segment, segment count, edge; and the drawn edges that had none, so no segments. */
  edges: number[];
  unnamedEdges: ShapeKey[];
  /** The vertices with a point and a name then, one per point; and those without a name. */
  vertices: ShapeKey[];
  unnamedVertices: ShapeKey[];
  /** The generation of the display that last used it. */
  used: number;
}

/** Displays a mesh plan outlives unused: enough for a preview and the committed display to take turns. */
const PLAN_DISPLAYS = 4;

/** One live body of a part: its entity, the shape holding it, and its own solid. */
interface ShownBody {
  entity: NamedEntity;
  ref: ShapeRef;
  /** The body's solid: the shape's handle when the shape holds one solid, the solid's own otherwise. */
  handle: ShapeHandle;
  faces: readonly ShapeKey[];
  /** True when the shape holds other solids besides. */
  shared: boolean;
  /** Its place in creation order, from 1: the n of its default name "Body n". */
  number: number;
}

const numbering = new WeakMap<readonly (PartResult | undefined)[], Map<string, number>>();

/**
 * Every body a part's timeline makes, by identity, numbered from 1 in the
 * order they first appear: by the feature that made them, then in the
 * order it left them. A body keeps its number in every state that holds it,
 * and the number of a consumed body is not given again.
 */
function bodyNumbers(steps: readonly (PartResult | undefined)[]): Map<string, number> {
  let numbers = numbering.get(steps);
  if (numbers) return numbers;
  numbers = new Map();
  for (const step of steps) {
    const state = step?.state;
    if (!state) continue;
    for (const solid of state.bodies.keys()) {
      const e = state.get(solid);
      if (!e) continue;
      const id = bodyIdentity(e);
      if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    }
  }
  numbering.set(steps, numbers);
  return numbers;
}

/**
 * The bodies of a part's state, one per solid, in creation order, which
 * numbers them "Body 1", "Body 2", ... wherever they are shown or exported.
 * With `steps` (the part after each feature, when the part was built in
 * this evaluation) a body's number is its place among all the bodies the
 * timeline makes (`bodyNumbers`), the same in each state that holds it;
 * otherwise, its place among the state's bodies, ordered by the feature
 * that created them, then by 7.3's creation key, pieces of one body by
 * their branch.
 */
function shownBodies(
  ev: Evaluation,
  state: NamedState,
  shapes: ReadonlyMap<ShapeRef, ShapeHandle>,
  steps?: readonly (PartResult | undefined)[],
): ShownBody[] {
  const numbers = steps ? bodyNumbers(steps) : undefined;
  const unnumbered = Number.MAX_SAFE_INTEGER;
  const out: (ShownBody & { order: string })[] = [];
  for (const [ref, handle] of shapes) {
    const { solids } = ev.adapter.topology(ref);
    for (const s of solids) {
      const entity = state.bodies.get(s.solid) === ref ? state.get(s.solid) : undefined;
      if (!entity) continue;
      const shared = solids.length > 1;
      const order = bodyIdentity(entity);
      out.push({
        entity,
        ref,
        handle: shared ? ev.adapter.handleOf(s.solid) : handle,
        faces: s.faces,
        shared,
        number: numbers?.get(order) ?? unnumbered,
        order,
      });
    }
  }
  out.sort(
    (a, b) =>
      a.number - b.number ||
      a.entity.createdAt - b.entity.createdAt ||
      compareCreation(a.entity, b.entity) ||
      (a.order < b.order ? -1 : a.order > b.order ? 1 : 0),
  );
  // Bodies no step numbers follow the numbered ones.
  let next = out.reduce((n, b) => (b.number === unnumbered ? n : Math.max(n, b.number)), 0);
  for (const b of out) if (b.number === unnumbered) b.number = ++next;
  return out;
}

/** The summed volume and the box of shapes; a shape-less state measures nothing. */
/** Where in `edges` the edges of the faces at `faces` lie, among the sub-shapes `all`. A seam, met twice round its wire, bounds nothing. */
function edgesOfFaces(all: readonly SubShape[], edges: readonly SubShape[], faces: readonly number[]): number[] {
  const list = all.filter((s) => s.kind === 'face');
  return faces.flatMap((i) => {
    const seen = new Map<SubShape, number>();
    const walk = (s: SubShape): void => {
      for (const c of s.children) {
        const child = all[c] as SubShape;
        if (child.kind === 'edge') seen.set(child, (seen.get(child) ?? 0) + 1);
        else if (child.kind === 'wire') walk(child);
      }
    };
    const face = list[i];
    if (face) walk(face);
    return [...seen].filter(([, n]) => n === 1).map(([edge]) => edges.indexOf(edge));
  });
}

function measuresOf(k: OcctKernel, shapes: readonly ShapeHandle[]): ShapeMeasures {
  let volume = 0;
  const center: Vec3 = [0, 0, 0];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of shapes) {
    const v = k.getVolume(s);
    volume += v;
    const c = k.getCenterOfMass(s);
    center[0] += c.x * v;
    center[1] += c.y * v;
    center[2] += c.z * v;
    const b = k.getBoundingBox(s);
    [b.xmin, b.ymin, b.zmin].forEach((v, a) => (min[a] = Math.min(min[a] as number, v)));
    [b.xmax, b.ymax, b.zmax].forEach((v, a) => (max[a] = Math.max(max[a] as number, v)));
  }
  return {
    volume,
    center: volume > 0 ? [center[0] / volume, center[1] / volume, center[2] / volume] : center,
    min,
    max,
  };
}

/** Strings that are name hashes, anywhere in `v`. */
function hashesIn(v: unknown, out: Set<string>): Set<string> {
  if (typeof v === 'string') {
    if (isNameHash(v)) out.add(v);
  } else if (Array.isArray(v)) for (const item of v) hashesIn(item, out);
  else if (isPlainObject(v)) for (const item of Object.values(v)) hashesIn(item, out);
  return out;
}

/**
 * The name-table entries of `table` that the hashes under `rows` use, with
 * the entries those name in turn, leaving out the ones `known` holds.
 */
function namesFor(rows: unknown, table: Json, known: Json): NameTableJson {
  const names: Json = {};
  const queue = [...hashesIn(rows, new Set())];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const hash = queue.pop() as string;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const name = table[hash];
    if (name === undefined) continue;
    if (!(hash in known)) names[hash] = name;
    for (const inner of hashesIn(name, new Set())) queue.push(inner);
  }
  return names as NameTableJson;
}

/** A feature row of a part's timeline, composites' children included. */
function findFeatureRow(doc: Json, id: string): Json | undefined {
  const find = (features: unknown): Json | undefined => {
    for (const f of Array.isArray(features) ? (features as Json[]) : []) {
      if (f.id === id) return f;
      const inner = find(f.children);
      if (inner) return inner;
    }
    return undefined;
  };
  for (const part of (doc.parts as Json[] | undefined) ?? []) {
    const f = find(part.timeline);
    if (f) return f;
  }
  return undefined;
}

/** Positions turned a quarter about X, so the model's up (+Y) is +Z and its front (+Z) is -Y, as slicers lay out a bed. */
function yUpToZUp(positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    out[i] = positions[i] as number;
    out[i + 1] = -(positions[i + 2] as number);
    out[i + 2] = positions[i + 1] as number;
  }
  return out;
}

export class EvaluationService {
  private recorded: Recorded | undefined;
  /** The last evaluation that was not a preview, while a preview is kept; it shares the kept one's shapes. */
  private committed: Recorded | undefined;
  /** Whether the kept evaluation built its parts only up to their rollbacks. */
  private partial = false;
  private doc: Json | undefined;
  private mark: number | undefined;
  private baseline = 0;
  private generation = 0;
  private entries: Entry[] = [];
  private modelKeys = new Map<string, Map<ShapeKey, Key>>();
  private sketchKeys = new Map<string, Key>();
  private regionKeys = new Map<DetectedRegion, Key>();
  private constructionKeys = new Map<ConstructionOutput, Key>();
  private definitions: Definition[] = [];
  private parts = new Map<string, Definition>();
  private assemblies = new Map<string, AssemblyView>();
  /** Mesh plans by body shape and deflection; they name the kernel's shapes, so they go when the shapes are released. */
  private plans = new Map<string, MeshPlan>();
  private geometries = 0;
  /** The geometries the client holds, as the evaluate running says. */
  private held: ReadonlySet<number> = new Set();

  constructor(
    private readonly kernel: OcctKernel,
    private readonly solver?: GcsWrapper,
    /** Whether an edit may resume from the features it leaves unchanged. */
    private readonly cache = true,
  ) {}

  /** The kept evaluation, for tests and tools that read it directly. */
  get evaluation(): Evaluation | undefined {
    return this.recorded?.ev;
  }

  /**
   * Evaluates `doc`, keeps the evaluation in place of the last one, and
   * returns its display. One that fails keeps nothing, so no earlier key
   * names anything. `progress` hears where the evaluation stands as it goes.
   * What is kept is remembered by the identity of `doc`'s objects as well as
   * by their content, so `doc` must not change afterwards.
   */
  evaluate(doc: Json, options: EvaluateServiceOptions = {}, progress?: (p: Progress) => void): Display {
    const k = this.kernel;
    const t0 = performance.now();
    progress?.({ phase: 'reading' });
    const deflection: Deflection = {
      linearDeflection: options.linearDeflection ?? DISPLAY.linearDeflection,
      angularDeflection: options.angularDeflection ?? DISPLAY.angularDeflection,
    };
    this.held = new Set(options.held ?? []);
    if (options.restyle !== undefined && options.restyle === this.generation && !this.partial) {
      const restyled = this.restyle(doc, deflection, progress);
      if (restyled) {
        restyled.timing = {
          evaluate: 0,
          display: performance.now() - t0,
          resumed: this.recorded?.resumed ?? 0,
          misses: [],
        };
        return restyled;
      }
    }
    const previous = this.recorded;
    const afresh = !this.cache
      ? 'the cache is off'
      : !previous
        ? 'nothing was evaluated before'
        : previous.carried >= MAX_CARRIED
          ? `${MAX_CARRIED} evaluations in a row resumed from the same shapes`
          : k.shapeCount > Math.max(4 * this.baseline, this.baseline + 200_000)
            ? 'the kernel holds too many shapes'
            : undefined;
    if (afresh) this.release();
    this.mark ??= k.checkpoint();
    this.reset();
    try {
      // A preview's evaluation is kept beside the committed one, which a later evaluation may resume from instead.
      const committed = !afresh && this.partial ? this.committed : undefined;
      const preview = options.preview === true;
      this.recorded = evaluateCached(doc, k, this.solver, afresh ? undefined : previous, {
        ...(progress ? { progress } : {}),
        ...(committed ? { alternative: committed } : {}),
        toRollback: preview,
      });
      this.committed = preview ? (committed ?? (this.partial ? undefined : previous)) : undefined;
      this.partial = preview;
    } catch (e) {
      // A build that threw leaves nothing to resume from.
      this.release();
      throw e;
    }
    if (afresh) this.baseline = k.shapeCount;
    this.doc = doc;
    const t1 = performance.now();
    let display: Display;
    try {
      this.define(this.recorded);
      display = {
        generation: ++this.generation,
        ...this.compose(deflection, progress, options.meshes !== false),
        timing: { evaluate: 0, display: 0, resumed: 0 },
      };
    } catch (e) {
      // The app keeps the display before this one; its keys must not name this evaluation's entities.
      this.release();
      throw e;
    }
    const misses = afresh ? [`afresh: ${afresh}`] : this.recorded.misses;
    display.timing = {
      evaluate: t1 - t0,
      display: performance.now() - t1,
      resumed: this.recorded.resumed,
      placed: this.recorded.placedKept,
      misses,
    };
    return display;
  }

  /**
   * The display of `doc` made from the kept evaluation, when `doc` differs
   * from the kept document only in what is shown (see
   * `EvaluateServiceOptions.restyle`); undefined when it does more, and must
   * be evaluated. Keys stay as they are, and only a body the client holds no
   * mesh of is meshed.
   */
  private restyle(
    doc: Json,
    deflection: Deflection,
    progress: ((p: Progress) => void) | undefined,
  ): Display | undefined {
    const recorded = this.recorded;
    const kept = this.doc;
    if (!recorded || !kept) return undefined;
    // Everything but what is shown is as the kept build had it.
    if (!sameButShown(kept, doc)) return undefined;
    // Names may come and go with attributes' targets, but none a kept feature holds.
    const was = (kept.names as Json | undefined) ?? {};
    const now = (doc.names as Json | undefined) ?? {};
    const added = Object.keys(now).filter((hash) => !(hash in was));
    const changed = [...added, ...Object.keys(was).filter((hash) => !(hash in now) || !sameJson(was[hash], now[hash]))];
    if (changed.length > 0) {
      const held = namesHeld(recorded);
      if (changed.some((hash) => held.has(hash))) return undefined;
    }
    // A value the build read must read the same in `doc`.
    const rows = new Map(((doc.parts as Json[] | undefined) ?? []).map((p) => [p.id as string, p]));
    const values = valuesFor(recorded, doc);
    if (!values) return undefined;
    const ev = recorded.ev;
    ev.values = values;
    for (const hash of added) ev.names.intern(now[hash] as JsonValue);
    this.doc = doc;
    for (const [id, def] of this.parts) {
      def.row = rows.get(id) as Json;
      ({ shown: def.shown, rollback: def.rollback } = shownAt(def.row, def.result, def.steps));
      def.styles = new PartStyles(ev, def.row, def.shown.state);
    }
    // The display marks again what it shows: a rollback moved shows other states.
    for (const e of this.entries) if (e.type === 'model') e.info.shown = false;
    const previous = this.generation;
    return {
      generation: ++this.generation,
      restyled: previous,
      ...this.compose(deflection, progress, true),
      timing: { evaluate: 0, display: 0, resumed: 0 },
    };
  }

  /** Releases the kept evaluation and every kernel shape it made. */
  release(): void {
    if (this.mark !== undefined) this.kernel.releaseSince(this.mark);
    this.mark = undefined;
    this.recorded = undefined;
    this.committed = undefined;
    this.partial = false;
    this.doc = undefined;
    this.plans = new Map();
    this.reset();
  }

  private reset(): void {
    this.entries = [];
    this.modelKeys = new Map();
    this.sketchKeys = new Map();
    this.regionKeys = new Map();
    this.constructionKeys = new Map();
    this.definitions = [];
    this.parts = new Map();
    this.assemblies = new Map();
  }

  private get ev(): Evaluation {
    if (!this.recorded) throw new Error('nothing is evaluated');
    return this.recorded.ev;
  }

  // ---- keys ----

  private add(entry: Draft<Entry>): Key {
    const key = this.entries.length;
    (entry as Entry).info = { key, ...entry.info };
    this.entries.push(entry as Entry);
    return key;
  }

  /** The key of a model entity in a scope, registering it if new. */
  private modelKey(scope: Scope, entity: NamedEntity, state: NamedState, shown: boolean): Key {
    const s = scopeKey(scope);
    let keys = this.modelKeys.get(s);
    if (!keys) this.modelKeys.set(s, (keys = new Map()));
    const known = keys.get(entity.key);
    if (known !== undefined) {
      if (shown) (this.entries[known] as Entry).info.shown = true;
      return known;
    }
    const key = this.add({
      type: 'model',
      scope: s,
      key: entity.key,
      info: { kind: entity.kind, scope, body: null, feature: entity.createdBy, shown },
    });
    keys.set(entity.key, key);
    const info = (this.entries[key] as Entry).info;
    info.body = entity.kind === 'body' ? key : this.bodyKeyOf(scope, entity, state, shown);
    return key;
  }

  /** The key of the body an entity lies on. */
  private bodyKeyOf(scope: Scope, entity: NamedEntity, state: NamedState, shown: boolean): Key | null {
    const body = this.bodyEntityOf(entity, state);
    return body ? this.modelKey(scope, body, state, shown) : null;
  }

  /** The body entity an entity lies on; a body's is itself. */
  private bodyEntityOf(entity: NamedEntity, state: NamedState): NamedEntity | undefined {
    if (entity.kind === 'body') return entity;
    const solids = this.ev.adapter.topology(entity.body).solids;
    const faceKeys = entity.kind === 'face' ? [entity.key] : this.facesOf(entity);
    const solid = solids.find((s) => faceKeys.some((f) => s.faces.includes(f))) ?? solids[0];
    return solid ? state.get(solid.solid) : undefined;
  }

  private facesOf(entity: NamedEntity): ShapeKey[] {
    const topology = this.ev.adapter.topology(entity.body);
    if (entity.kind === 'edge')
      return topology.edges.find((e) => e.edge === entity.key)?.faces.map((f) => f.face) ?? [];
    if (entity.kind === 'vertex') return [...(topology.vertices.find((v) => v.vertex === entity.key)?.faces ?? [])];
    return [];
  }

  /** The entities behind keys, including any handed out after the display. */
  entities(keys: readonly Key[]): EntityInfo[] {
    return keys.flatMap((k) => (this.entries[k] ? [{ ...(this.entries[k] as Entry).info }] : []));
  }

  // ---- display ----

  /** The builds of parts the kept evaluation shows: each part of the document, then each variant of a component. */
  private define(recorded: Recorded): void {
    const ev = recorded.ev;
    const doc = this.doc as Json;
    const byResult = new Set<PartResult>();
    const define = (
      part: string,
      variant: string,
      of: Evaluation,
      row: Json,
      result: PartResult,
      steps?: readonly (PartResult | undefined)[],
    ) => {
      const { shown, rollback } = shownAt(row, result, steps);
      const def: Definition = {
        index: this.definitions.length,
        part,
        variant,
        ev: of,
        row,
        result,
        shown,
        rollback,
        steps,
        styles: new PartStyles(of, row, shown.state),
      };
      this.definitions.push(def);
      byResult.add(result);
      return def;
    };
    for (const row of (doc.parts as Json[]) ?? []) {
      const result = ev.parts.get(row.id as string);
      if (result)
        this.parts.set(
          row.id as string,
          define(row.id as string, '', ev, row, result, stepsOf(recorded, row.id as string)),
        );
    }
    for (const v of variantsOf(ev)) {
      if (v.kind !== 'part' || byResult.has(v.result as PartResult)) continue;
      const row = ((documentOf(v.ev).parts as Json[]) ?? []).find((p) => p.id === v.id);
      if (row) define(v.id, v.key, v.ev, row, v.result as PartResult);
    }
  }

  /**
   * The display of the defined builds. With `meshed` false the definitions
   * hold no bodies and nothing is meshed: the evaluation is prepared for the
   * questions asked of it (picks, locators, pauses). A body whose
   * geometry the client holds is sent as kept, with its pick tables only; a
   * hidden body is not meshed until shown.
   */
  private compose(
    mesh: Deflection,
    progress: ((p: Progress) => void) | undefined,
    meshed: boolean,
  ): Omit<Display, 'generation' | 'timing'> {
    const ev = this.ev;
    const doc = this.doc as Json;
    const byResult = new Map(this.definitions.map((d) => [d.result, d]));
    const meshing: Meshing = {
      done: 0,
      total: this.definitions.reduce((n, d) => n + d.shown.state.bodies.size, 0),
      progress,
    };
    const definitions = this.definitions.map((d) => this.definitionDisplay(d, mesh, meshing, meshed));
    for (const [key, plan] of this.plans) if (plan.used <= this.generation - PLAN_DISPLAYS) this.plans.delete(key);
    const assemblies: AssemblyDisplay[] = [];
    for (const [id, result] of ev.assemblies) {
      const row = ((doc.assemblies as Json[]) ?? []).find((a) => a.id === id);
      if (!row) continue;
      const view: AssemblyView = { id, result, leaves: this.leavesOf(result, row, byResult) };
      this.assemblies.set(id, view);
      assemblies.push({
        id,
        instances: view.leaves.map((l): InstanceDisplay => ({
          path: l.path,
          definition: l.definition.index,
          placement: { position: v3(l.placement.position), rotation: [...l.placement.rotation] },
          override: l.override,
          visible: l.visible,
        })),
        joints: Object.fromEntries(result.joints),
        jointFrames: Object.fromEntries(
          [...result.jointFrames].map(([joint, { a, b }]) => [
            joint,
            {
              a: { position: v3(a.position), rotation: [...a.rotation] },
              b: { position: v3(b.position), rotation: [...b.rotation] },
            },
          ]),
        ),
        activePosition: result.activePosition,
        exploded: Object.fromEntries(
          [...result.exploded].map(([exploded, moved]) => [
            exploded,
            view.leaves.map((l): Placement => {
              const at = moved.get(l.top.key);
              const p = at ? compose(at, l.inTop) : l.placement;
              return { position: v3(p.position), rotation: [...p.rotation] };
            }),
          ]),
        ),
      });
    }
    return {
      definitions,
      parts: Object.fromEntries([...this.parts].map(([id, d]) => [id, d.index])),
      assemblies,
      entities: this.entries.map((e) => ({ ...e.info })),
      pauses: ev.pauses.map((p) => ({ ...p })),
      stale: ev.stale.map((p) => ({ ...p })),
      outOfDate: ev.outOfDate.map((o) => ({ ...o })),
    };
  }

  /**
   * Every placed part of an assembly, nested assemblies flattened, with what
   * instance attributes set over it: the assembly's own, and each nested
   * assembly's on the instances inside it, read in that assembly's build.
   */
  private leavesOf(result: AssemblyResult, row: Json, byResult: Map<PartResult, Definition>): Leaf[] {
    /** Instance attributes by their path from this assembly, with how deep the assembly holding each lies. */
    const overrides: { path: string[]; depth: number; props: Properties }[] = [];
    const attributesOf = (ev: Evaluation, assembly: Json, prefix: readonly Json[], depth: number) => {
      for (const a of (assembly.attributes as Json[]) ?? []) {
        const instance = ((a.target as Json).object as Json | undefined)?.instance as Json | undefined;
        if (instance)
          overrides.push({
            path: [...prefix, ...((instance.path as Json[]) ?? [])].map((s) => JSON.stringify(s)),
            depth,
            props: readProperties(ev, a),
          });
      }
    };
    attributesOf(this.ev, row, [], 0);
    const out: Leaf[] = [];
    interface Outer {
      path: Json[];
      placement: Rigid;
      map: (s: ShapeRef) => ShapeRef | undefined;
      top?: { node: AssemblyNode; inTop: Rigid };
      depth: number;
    }
    const walk = (nodes: readonly AssemblyNode[], outer: Outer) => {
      for (const n of nodes) {
        // A node that could not be placed has no bodies here; its pause says why.
        if (n.shapes.length === 0) continue;
        const path = [...outer.path, ...((n.path.path as Json[]) ?? [])];
        const placement = compose(outer.placement, n.placement);
        const top = outer.top
          ? { node: outer.top.node, inTop: compose(outer.top.inTop, n.placement) }
          : { node: n, inTop: IDENTITY };
        const placed = new Map([...n.variant.result.shapes.keys()].map((s, i) => [s, n.shapes[i]]));
        const map = (s: ShapeRef) => {
          const here = placed.get(s);
          return here === undefined ? undefined : outer.map(here);
        };
        if (n.variant.kind === 'assembly') {
          const depth = outer.depth + 1;
          const inner = ((documentOf(n.variant.ev).assemblies as Json[] | undefined) ?? []).find(
            (a) => a.id === n.variant.id,
          );
          if (inner) attributesOf(n.variant.ev, inner, path, depth);
          walk((n.variant.result as AssemblyResult).nodes ?? [], { path, placement, map, top, depth });
          continue;
        }
        const definition = byResult.get(n.variant.result as PartResult);
        if (!definition) continue;
        const pairs = [...definition.result.shapes.keys()].flatMap((s): [ShapeRef, ShapeRef][] => {
          const to = map(s);
          return to === undefined ? [] : [[s, to]];
        });
        // The outermost instance with an attribute sets over everything inside it; on one instance, the outermost assembly's attribute.
        const steps = path.map((s) => JSON.stringify(s));
        const along = overrides.filter((o) => o.path.length <= steps.length && o.path.every((s, i) => s === steps[i]));
        along.sort((a, b) => a.path.length - b.path.length || a.depth - b.depth);
        const override: Partial<Style> = {};
        for (const o of along.reverse()) {
          if (o.props.color !== undefined) override.color = o.props.color;
          if (o.props.opacity !== undefined) override.opacity = o.props.opacity;
        }
        out.push({
          path: { path },
          definition,
          placement,
          top: top.node,
          inTop: top.inTop,
          pairs,
          override,
          visible: !along.some((o) => o.props.visible === false),
        });
      }
    };
    walk(result.nodes, { path: [], placement: IDENTITY, map: (s) => s, depth: 0 });
    return out;
  }

  private definitionDisplay(
    def: Definition,
    options: Deflection,
    meshing: Meshing | undefined,
    meshed: boolean,
  ): DefinitionDisplay {
    const scope: Scope = { definition: def.index };
    const state = def.shown.state;
    const bodies = (meshed ? shownBodies(this.ev, state, def.shown.shapes, def.steps) : []).map((b): BodyDisplay => {
      if (meshing?.progress) {
        meshing.total = Math.max(meshing.total, meshing.done + 1);
        meshing.progress({ phase: 'meshing', done: meshing.done++, total: meshing.total });
      }
      const props = def.styles.body(b.entity);
      const style: Style = {
        color: props.color ?? DEFAULT_COLOR,
        opacity: props.opacity ?? 1,
        visible: props.visible !== false,
      };
      // A hidden body waits until it shows, unless the client holds its geometry.
      let drawn: { mesh: BodyMesh; faces: { entity: NamedEntity; key: Key }[] };
      let mark: { kept?: true; unmeshed?: true; geometry?: number };
      if (style.visible || this.holds(b, options)) {
        const made = this.mesh(def, scope, b, options);
        drawn = made;
        mark = made.kept ? { kept: true, geometry: made.geometry } : { geometry: made.geometry };
      } else {
        drawn = { mesh: emptyMesh(), faces: [] };
        mark = { unmeshed: true };
      }
      const faceStyles = drawn.faces.flatMap(({ entity, key }) => {
        const f = def.styles.face(entity, props);
        const s: Style = { color: f.color ?? DEFAULT_COLOR, opacity: f.opacity ?? 1, visible: f.visible !== false };
        return s.color !== style.color || s.opacity !== style.opacity || s.visible !== style.visible
          ? [{ key, ...s }]
          : [];
      });
      return {
        ...style,
        key: this.modelKey(scope, b.entity, state, true),
        id: bodyIdentity(b.entity),
        feature: b.entity.createdBy,
        name: props.name ?? `Body ${b.number}`,
        faceStyles,
        mesh: drawn.mesh,
        ...mark,
      };
    });
    const sketches: SketchDisplay[] = [...def.shown.sketches].map(([feature, sketch]) =>
      this.sketchDisplay(def, feature, sketch),
    );
    const construction: ConstructionDisplay[] = [...def.shown.construction].map(([id, output]) => {
      const feature = ((this.ev.names.get(output.ladder[0] as string) as Json | undefined)?.feature as Json | undefined)
        ?.id as string | undefined;
      const key = this.constructionKey(def, output, feature ?? id);
      return {
        key,
        feature: feature ?? id,
        kind: output.kind,
        frame: frameOut(output.frame),
        visible: def.styles.featureShown(feature ?? id),
      };
    });
    return {
      index: def.index,
      part: def.part,
      variant: def.variant,
      rollback: def.rollback,
      bodies,
      sketches,
      construction,
      threads: this.threadsDisplay(def, scope),
    };
  }

  /** The shown state's cosmetic threads, each on the keys of the faces it threads that the display shows. */
  private threadsDisplay(def: Definition, scope: Scope): ThreadDisplay[] {
    const state = def.shown.state;
    const keys = this.modelKeys.get(scopeKey(scope));
    const out: ThreadDisplay[] = [];
    for (const [feature, threads] of def.shown.threads) {
      for (const t of threads) {
        const faces = new Set<Key>();
        let radius: number | undefined;
        for (const f of t.faces) {
          for (const e of state.lookup(f.hash)) {
            const key = e.kind === 'face' && carries(e, f, state) ? keys?.get(e.key) : undefined;
            if (key === undefined) continue;
            faces.add(key);
            if (radius === undefined) {
              const { surface } = this.ev.adapter.faceGeometry(e.key);
              if (surface.kind === 'cylinder') radius = surface.radii[0];
            }
          }
        }
        if (faces.size === 0 || radius === undefined) continue;
        out.push({
          feature,
          faces: [...faces],
          designation: t.designation,
          class: t.class,
          internal: t.internal,
          pitch: t.pitch,
          radius,
          start: v3(t.start),
          direction: v3(t.direction),
          length: t.length,
          ...(t.hand ? { hand: t.hand } : {}),
        });
      }
    }
    return out;
  }

  private constructionKey(def: Definition, output: ConstructionOutput, feature: string): Key {
    const known = this.constructionKeys.get(output);
    if (known !== undefined) return known;
    const key = this.add({
      type: 'construction',
      def,
      output,
      info: { kind: output.kind, scope: { definition: def.index }, body: null, feature, shown: true },
    });
    this.constructionKeys.set(output, key);
    return key;
  }

  /**
   * One body's mesh and pick tables, and its geometry's id. A shape meshed
   * before keeps its geometry: its pick tables are made again from its plan,
   * and, when the client holds the geometry, it is not sent (`kept`).
   */
  private mesh(
    def: Definition,
    scope: Scope,
    body: ShownBody,
    options: Deflection,
  ): { mesh: BodyMesh; faces: { entity: NamedEntity; key: Key }[]; geometry: number; kept: boolean } {
    const planKey = `${body.ref}|${body.handle}|${options.linearDeflection}|${options.angularDeflection}`;
    const plan = this.plans.get(planKey);
    if (plan) {
      const again = this.tablesFrom(plan, scope, def.shown.state);
      if (again) {
        plan.used = this.generation;
        if (this.held.has(plan.id))
          return { mesh: { ...emptyMesh(), ...again.tables }, faces: again.faces, geometry: plan.id, kept: true };
      }
    }
    const made = this.meshAfresh(def, scope, body, options);
    this.plans.set(planKey, { ...made.plan, used: this.generation });
    return { mesh: made.mesh, faces: made.faces, geometry: made.plan.id, kept: false };
  }

  /** Whether the client holds the geometry of a body's shape. */
  private holds(body: ShownBody, options: Deflection): boolean {
    const plan = this.plans.get(`${body.ref}|${body.handle}|${options.linearDeflection}|${options.angularDeflection}`);
    return plan !== undefined && this.held.has(plan.id);
  }

  /** A body's pick tables from its mesh plan, in the state shown; undefined when a sub-shape gained or lost its name, which changes what is drawn. */
  private tablesFrom(
    plan: MeshPlan,
    scope: Scope,
    state: NamedState,
  ):
    { tables: Pick<BodyMesh, 'faces' | 'edges' | 'vertices'>; faces: { entity: NamedEntity; key: Key }[] } | undefined {
    if (plan.unnamedEdges.some((e) => state.get(e)) || plan.unnamedVertices.some((v) => state.get(v))) return undefined;
    const edgeEntities: NamedEntity[] = [];
    for (let i = 2; i < plan.edges.length; i += 3) {
      const entity = state.get(plan.edges[i] as ShapeKey);
      if (!entity) return undefined;
      edgeEntities.push(entity);
    }
    const vertexEntities: NamedEntity[] = [];
    for (const v of plan.vertices) {
      const entity = state.get(v);
      if (!entity) return undefined;
      vertexEntities.push(entity);
    }
    const faces: number[] = [];
    const styled: { entity: NamedEntity; key: Key }[] = [];
    for (let i = 0; i + 2 < plan.faces.length; i += 3) {
      const entity = state.get(plan.faces[i + 2] as ShapeKey);
      if (!entity) continue;
      const key = this.modelKey(scope, entity, state, true);
      faces.push(plan.faces[i] as number, plan.faces[i + 1] as number, key);
      styled.push({ entity, key });
    }
    sortRanges(faces);
    const edges: number[] = [];
    edgeEntities.forEach((entity, n) =>
      edges.push(
        plan.edges[n * 3] as number,
        plan.edges[n * 3 + 1] as number,
        this.modelKey(scope, entity, state, true),
      ),
    );
    const vertices = vertexEntities.map((entity) => this.modelKey(scope, entity, state, true));
    return {
      tables: { faces: new Uint32Array(faces), edges: new Uint32Array(edges), vertices: new Uint32Array(vertices) },
      faces: styled,
    };
  }

  /** One body's mesh and pick tables from the kernel, and what it found, for its plan. */
  private meshAfresh(
    def: Definition,
    scope: Scope,
    body: ShownBody,
    options: Deflection,
  ): { mesh: BodyMesh; faces: { entity: NamedEntity; key: Key }[]; plan: Omit<MeshPlan, 'used'> } {
    const { kernel: k, adapter } = this.ev;
    const { ref, handle } = body;
    const state = def.shown.state;
    const plan: Omit<MeshPlan, 'used'> = {
      id: ++this.geometries,
      faces: [],
      edges: [],
      unnamedEdges: [],
      vertices: [],
      unnamedVertices: [],
    };
    const byHash = { face: new Map<number, ShapeKey>(), edge: new Map<number, ShapeKey>() };
    for (const s of adapter.subShapes(ref)) {
      if (s.kind === 'face' || s.kind === 'edge')
        byHash[s.kind].set(k.hashCode(adapter.handleOf(s.key), HASH_BOUND), s.key);
    }
    // The vertices on the body's own faces; in a shape of one solid, all of them.
    const own = new Set(body.faces);
    const vertices = adapter
      .topology(ref)
      .vertices.filter((v) => !body.shared || v.faces.some((f) => own.has(f)))
      .map((v) => v.vertex);
    const m = k.meshShape(handle, options);
    const faces: number[] = [];
    const styled: { entity: NamedEntity; key: Key }[] = [];
    const groups = m.faceGroups ?? new Int32Array(0);
    for (let i = 0; i + 2 < groups.length; i += 3) {
      const [start, count] = [(groups[i] as number) / 3, (groups[i + 1] as number) / 3];
      const face = byHash.face.get(groups[i + 2] as number);
      if (face !== undefined && count > 0) plan.faces.push(start, count, face);
      const entity = face === undefined ? undefined : state.get(face);
      if (!entity || count === 0) continue;
      const key = this.modelKey(scope, entity, state, true);
      faces.push(start, count, key);
      styled.push({ entity, key });
    }
    sortRanges(faces);

    const drawn = new Map(adapter.topology(ref).edges.map((e) => [e.edge, e.form === 'normal']));
    const wire = k.wireframe(handle, { deflection: options.linearDeflection, source: 'triangulation' });
    const segments: number[] = [];
    const edges: number[] = [];
    const eg = wire.edgeGroups;
    for (let i = 0; i + 2 < eg.length; i += 3) {
      const [start, count] = [eg[i] as number, eg[i + 1] as number];
      const edge = byHash.edge.get(eg[i + 2] as number);
      const entity = edge === undefined ? undefined : state.get(edge);
      if (edge !== undefined && !entity && drawn.get(edge) === true && count >= 6) plan.unnamedEdges.push(edge);
      if (!entity || drawn.get(entity.key) !== true || count < 6) continue;
      const first = segments.length / 6;
      for (let p = start; p + 5 < start + count; p += 3) {
        for (let c = 0; c < 6; c++) segments.push(wire.points[p + c] as number);
      }
      edges.push(first, segments.length / 6 - first, this.modelKey(scope, entity, state, true));
      plan.edges.push(first, segments.length / 6 - first, entity.key);
    }
    const points: number[] = [];
    const vertexKeys: number[] = [];
    for (const v of vertices) {
      const entity = state.get(v);
      if (!entity) plan.unnamedVertices.push(v);
      const at = entity ? adapter.measures(v).point : undefined;
      if (!entity || !at) continue;
      points.push(...at);
      vertexKeys.push(this.modelKey(scope, entity, state, true));
      plan.vertices.push(v);
    }
    return {
      mesh: {
        positions: new Float32Array(m.positions),
        normals: new Float32Array(m.normals),
        indices: new Uint32Array(m.indices),
        faces: new Uint32Array(faces),
        segments: new Float32Array(segments),
        edges: new Uint32Array(edges),
        points: new Float32Array(points),
        vertices: new Uint32Array(vertexKeys),
      },
      faces: styled,
      plan,
    };
  }

  private sketchDisplay(def: Definition, feature: string, sketch: SketchResult): SketchDisplay {
    const scope = { definition: def.index };
    const polyline = (pts: readonly (readonly [number, number])[]) =>
      new Float32Array(pts.flatMap((p) => lift(sketch.frame, p)));
    const curveKey = (root: string, glyph: boolean) => {
      const id = `${def.index}|${feature}|curve|${root}`;
      const known = this.sketchKeys.get(id);
      if (known !== undefined) return known;
      const key = this.add({
        type: 'curve',
        def,
        sketch,
        root,
        glyph,
        info: { kind: 'curve', scope, body: null, feature, shown: true },
      });
      this.sketchKeys.set(id, key);
      return key;
    };
    const curves = [
      ...sketch.solved.curves.map((c) => [c, false] as const),
      ...sketch.others.map((c) => [c, true] as const),
    ].flatMap(([c, construction]: readonly [SolvedCurve, boolean]) => {
      const closed = c.anchors.kind === 'points' && c.anchors.start === c.anchors.end;
      const curve = prepareCurve(c.shape, closed);
      if (!curve) return [];
      const glyph = 'glyph' in c.key;
      const root = 'drawn' in c.key ? c.key.drawn.id : c.key.glyph.text;
      return [{ key: curveKey(root, glyph), root, construction, points: polyline(curve.polyline().points) }];
    });
    const points = sketch.solved.points.map((p) => {
      const id = `${def.index}|${feature}|point|${p.id}`;
      let key = this.sketchKeys.get(id);
      if (key === undefined) {
        key = this.add({
          type: 'point',
          def,
          sketch,
          id: p.id,
          info: { kind: 'point', scope, body: null, feature, shown: true },
        });
        this.sketchKeys.set(id, key);
      }
      return { key, id: p.id, at: v3(lift(sketch.frame, [p.x, p.y])) };
    });
    const rowOf = (region: DetectedRegion): string | null =>
      sketch.matching.kept.find((r) => r.region === region)?.id ??
      sketch.matching.divided.find((d) => d.pieces.some((p) => p.region === region))?.id ??
      null;
    const regions = sketch.detection.regions.map((region) => {
      let key = this.regionKeys.get(region);
      const row = rowOf(region);
      if (key === undefined) {
        key = this.add({
          type: 'region',
          def,
          sketch,
          row,
          region,
          info: { kind: 'region', scope, body: null, feature, shown: true },
        });
        this.regionKeys.set(region, key);
      }
      const loops = [region.outer, ...region.inner].map((c) =>
        polyline(cyclePolyline(sketch.detection.arrangement, c, 1)),
      );
      return { key, row, loops };
    });
    const externals = sketch.externals.map((e) => ({ id: e.id, shape: e.shape, bounds: e.bounds }));
    return {
      feature,
      frame: frameOut(sketch.frame),
      visible: def.styles.featureShown(feature),
      curves,
      points,
      regions,
      externals,
      ...(sketch.dof !== undefined ? { dof: sketch.dof } : {}),
    };
  }

  // ---- picking and references ----

  private definitionOfPart(part: string): Definition {
    const def = this.parts.get(part);
    if (!def) throw new Error(`part ${part} is not in the evaluation`);
    return def;
  }

  /** The state of a part just before feature `before`, or as shown. */
  private stateOf(def: Definition, before?: string): PartResult {
    if (before === undefined) return def.shown;
    const ordinal = ((def.row.timeline as Json[]) ?? []).findIndex((f) => f.id === before);
    if (ordinal < 0) throw new Error(`feature ${before} is not in part ${def.part}`);
    return ordinal === 0 ? emptyPart() : (def.steps?.[ordinal - 1] ?? def.shown);
  }

  /** The name-table entries `record` uses, with every name they contain, that the document lacks (9.8). */
  private namesFor(record: unknown): NameTableJson {
    const names = this.ev.names;
    const doc = (this.doc?.names as Json | undefined) ?? {};
    const out: NameTableJson = {};
    const queue = [...hashesIn(record, new Set())];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const hash = queue.pop() as string;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const name = names.get(hash);
      if (name === undefined) continue;
      if (!(hash in doc)) out[hash] = name;
      for (const inner of hashesIn(name, new Set())) queue.push(inner);
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  /** A record naming a sketch row or construction output by its ladder, as the editor writes one. */
  private plainRecord(ladder: readonly string[]): EntityRecord {
    return { id: [...ladder], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} };
  }

  /** The entity of an assembly's result that a key of an instance's definition is placed as. */
  private placed(target: PickTarget): { view: AssemblyView; entity: NamedEntity } | undefined {
    const entry = this.entries[target.key];
    const view = target.instance && this.assemblies.get(target.instance.assembly);
    const leaf = target.instance && view?.leaves[target.instance.index];
    if (
      !entry ||
      entry.type !== 'model' ||
      !view ||
      !leaf ||
      entry.scope !== scopeKey({ definition: leaf.definition.index })
    )
      return undefined;
    const map = new Map<ShapeKey, ShapeKey>();
    for (const [from, to] of leaf.pairs) pairKeys(this.ev, from, to, map);
    const key = map.get(entry.key);
    const entity = key === undefined ? undefined : view.result.state.get(key);
    return entity && { view, entity };
  }

  /**
   * The record a feature stores for a picked entity, and the names it needs.
   * `before` writes it against the part just before that feature, for a
   * feature being edited; null when the entity is not in that state.
   * `frameOf` writes a pick through an instance with its snapshot in the
   * frame of the part at that instance path (an in-context reference, 9.7).
   */
  pick(target: PickTarget, options: PickOptions = {}): Picked | null {
    const entry = this.entries[target.key];
    if (!entry) return null;
    const ev = this.ev;
    const done = (record: EntityRecord): Picked => ({ reference: { entity: record }, names: this.namesFor(record) });
    if (target.instance) {
      const placed = this.placed(target);
      if (!placed) return null;
      const record = writeRecord(placed.entity, placed.view.result.state, ev.adapter);
      if (options.frameOf === undefined) return done(record);
      const holder = placed.view.result.nodes.find((n) => canonicalize(n.path) === canonicalize(options.frameOf));
      const handle = placed.view.result.shapes.get(placed.entity.body);
      const snapshot = holder && handle && this.snapshotMoved(placed.entity, handle, record, inverse(holder.placement));
      return snapshot ? done({ ...record, snapshot }) : null;
    }
    switch (entry.type) {
      case 'model': {
        const def = this.definitions.find((d) => scopeKey({ definition: d.index }) === entry.scope);
        const state = def
          ? this.stateOf(def, options.before).state
          : this.assemblies.get(entry.scope.slice(1))?.result.state;
        const entity = state?.get(entry.key);
        if (state && entity) return done(writeRecord(entity, state, ev.adapter));
        // An entity of the shown state that the state before the feature holds under another shape (a face or
        // edge the feature changed, picked on its preview): its record as shown, read in the state before.
        const shownEntity = def && options.before !== undefined ? def.shown.state.get(entry.key) : undefined;
        if (!def || !state || !shownEntity) return null;
        const found = resolve(writeRecord(shownEntity, def.shown.state, ev.adapter), state, ev.adapter);
        const only = found.outcome === 'same' && found.entities.length === 1 ? found.entities[0] : undefined;
        if (only) return done(writeRecord(only, state, ev.adapter));
        // One the edited feature made from a single entity of the state before (a shell's wall offset from a
        // face, its rim from the face it opened): that entity, as a click on the face before the feature would pick it.
        const source = shownEntity.createdBy === options.before ? this.madeFrom(shownEntity, state) : undefined;
        return source ? done(writeRecord(source, state, ev.adapter)) : null;
      }
    }
    if (options.before !== undefined) {
      // A sketch's entities and a construction output are the same build in every state that holds them.
      const held = this.stateOf(entry.def, options.before);
      const there =
        entry.type === 'construction'
          ? [...held.construction.values()].includes(entry.output)
          : held.sketches.get(entry.info.feature) === entry.sketch;
      if (!there) return null;
    }
    switch (entry.type) {
      case 'curve':
      case 'point': {
        if (entry.type === 'curve' && entry.glyph) return null;
        const id = entry.type === 'curve' ? entry.root : entry.id;
        const ladder = ladderOf(
          { kind: entry.type, chain: [], feature: entry.info.feature, role: entry.type, src: [idItem(id)] },
          ev.names,
        );
        return done(this.plainRecord(ladder));
      }
      case 'region': {
        if (entry.row === null)
          return { region: { sketch: entry.info.feature, loop: entry.region.loop, holes: entry.region.holes } };
        const ladder = ladderOf(
          { kind: 'region', chain: [], feature: entry.info.feature, role: 'region', src: [idItem(entry.row)] },
          ev.names,
        );
        return done(this.plainRecord(ladder));
      }
      case 'construction':
        return done(this.plainRecord(entry.output.ladder));
    }
  }

  /** The one entity of `state`, of the same kind, that `entity`'s name says it was made from; undefined for none or several. */
  private madeFrom(entity: NamedEntity, state: NamedState): NamedEntity | undefined {
    const level = this.ev.names.get(finest(entity.ladder)) as { src?: unknown } | undefined;
    const src = Array.isArray(level?.src) ? (level.src as { name?: { hash?: unknown } }[]) : [];
    const hashes = src.flatMap((item) => (typeof item?.name?.hash === 'string' ? [item.name.hash] : []));
    if (hashes.length !== 1 || src.length !== 1) return undefined;
    const found = state.lookup(hashes[0] as string).filter((e) => e.kind === entity.kind);
    return found.length === 1 ? found[0] : undefined;
  }

  /**
   * A record's snapshot (9.7) as it reads with the entity's body moved by
   * `by`: the body is moved as a context capture moves it, and the entity is
   * found at its place in the moved body's topology. Identity, neighbours and
   * sides do not depend on the frame, so only the snapshot is written again.
   * The moved body is named by an adapter of its own, released with it, so
   * the kept evaluation gains nothing. Null for an entity kind with no place
   * in a body's topology.
   */
  private snapshotMoved(
    entity: NamedEntity,
    handle: ShapeHandle,
    record: EntityRecord,
    by: Rigid,
  ): EntityRecord['snapshot'] | null {
    const { adapter: kept, kernel: k } = this.ev;
    const before = kept.topology(entity.body);
    const at = (t: typeof before): ShapeKey[] =>
      entity.kind === 'face'
        ? [...t.faces]
        : entity.kind === 'edge'
          ? t.edges.map((e) => e.edge)
          : entity.kind === 'vertex'
            ? t.vertices.map((v) => v.vertex)
            : entity.kind === 'body'
              ? t.solids.map((s) => s.solid)
              : [];
    const index = at(before).indexOf(entity.key);
    if (index < 0) return null;
    const mark = k.checkpoint();
    const adapter = new NamingAdapter(k);
    try {
      // Registered alone, the body's sub-shapes come in the same order as in the kept adapter.
      const source = adapter.addShape(handle, entity.body);
      const { histories, moved } = runMotion(
        { ev: { kernel: k, adapter } } as unknown as Parameters<typeof runMotion>[0],
        { shape: source, handle },
        motionOf(by),
      );
      const shape = histories.length > 0 ? moved.shape : source;
      const key = at(adapter.topology(shape))[index];
      if (key === undefined) return null;
      const placed: NamedEntity = { ...entity, key, body: shape };
      const snapshot: EntityRecord['snapshot'] = { ...(adapter.measures(key) as EntityRecord['snapshot']) };
      if (record.snapshot.geometry !== undefined) {
        const geometry = describeEntity(placed, adapter);
        if (geometry === null) return null;
        snapshot.geometry = geometry as unknown as EntityRecord['snapshot'][string];
      }
      return snapshot;
    } finally {
      adapter.dispose();
      k.releaseSince(mark);
    }
  }

  /** The keys a stored record lands on now (9.6), for highlighting a feature's references. */
  resolve(record: EntityRecord, scope: ResolveScope): Resolved & { instances?: { index: number; key: Key }[] } {
    const ev = this.ev;
    if ('assembly' in scope) {
      const view = this.assemblies.get(scope.assembly);
      if (!view) throw new Error(`assembly ${scope.assembly} is not in the evaluation`);
      const state = view.result.state;
      const found = resolve(record, state, ev.adapter);
      if (found.outcome === 'gone') return found;
      const entities = found.outcome === 'same' ? found.entities : found.suggestions;
      const keys = entities.map((e) => this.modelKey({ assembly: view.id }, e, state, true));
      const back = this.backMap(view);
      const instances = entities.flatMap((e) => {
        const at = back.get(e.key);
        const leaf = at && view.leaves[at.index];
        const entity = leaf && leaf.definition.shown.state.get(at.key);
        return leaf && entity
          ? [
              {
                index: at.index,
                key: this.modelKey({ definition: leaf.definition.index }, entity, leaf.definition.shown.state, true),
              },
            ]
          : [];
      });
      return found.outcome === 'same'
        ? { outcome: 'same', keys, instances }
        : { outcome: 'ask', suggestions: keys, instances };
    }
    const def = this.definitionOfPart(scope.part);
    const part = this.stateOf(def, scope.before);
    const shown = part === def.shown;
    const definition = { definition: def.index };
    if (record.id.length === 0) return { outcome: 'gone' };
    const level = ev.names.get(finest(record.id)) as Json | undefined;
    const src = (level?.src as Json[] | undefined)?.[0];
    const sketch = level ? part.sketches.get((level.feature as Json | undefined)?.id as string) : undefined;
    if (level && (level.kind === 'curve' || level.kind === 'point') && src && 'id' in src) {
      const id = `${def.index}|${(level.feature as Json).id as string}|${String(level.kind)}|${(src.id as Json).id as string}`;
      const key = sketch ? this.sketchKeys.get(id) : undefined;
      return key === undefined ? { outcome: 'gone' } : { outcome: 'same', keys: [key] };
    }
    if (level?.kind === 'region' && src && 'id' in src) {
      if (!sketch) return { outcome: 'gone' };
      const regions = resolveRegion((src.id as Json).id as string, sketch.table, sketch.matching);
      const keys = regions.flatMap((r) => {
        const k = this.regionKeys.get(r);
        return k === undefined ? [] : [k];
      });
      return keys.length > 0 ? { outcome: 'same', keys } : { outcome: 'gone' };
    }
    const hash = finest(record.id);
    const output = [...part.construction.values()].find((c) => c.ladder.includes(hash));
    if (output)
      return {
        outcome: 'same',
        keys: [this.constructionKey(def, output, (level?.feature as Json | undefined)?.id as string)],
      };
    const found = resolve(record, part.state, ev.adapter);
    if (found.outcome === 'gone') return found;
    const entities = found.outcome === 'same' ? found.entities : found.suggestions;
    const keys = entities.map((e) =>
      this.modelKey(definition, e, part.state, shown && def.shown.state.get(e.key) === e),
    );
    return found.outcome === 'same' ? { outcome: 'same', keys } : { outcome: 'ask', suggestions: keys };
  }

  private backMap(view: AssemblyView): Map<ShapeKey, { index: number; key: ShapeKey }> {
    if (view.back) return view.back;
    const back = new Map<ShapeKey, { index: number; key: ShapeKey }>();
    view.leaves.forEach((leaf, index) => {
      const map = new Map<ShapeKey, ShapeKey>();
      for (const [from, to] of leaf.pairs) pairKeys(this.ev, from, to, map);
      for (const [key, placed] of map) back.set(placed, { index, key });
    });
    view.back = back;
    return back;
  }

  /**
   * The bodies of a part as it stands just before `scope.feature` (at the
   * part's rollback when the part does not hold that feature), named as the
   * display names them, and where each of `records` lands in that state.
   * With `picks`, each body's reference is written against that state too.
   * Nothing is evaluated: the state is one the kept evaluation recorded.
   */
  bodiesBefore(
    scope: BeforeScope,
    records: readonly EntityRecord[] = [],
    options: { picks?: boolean } = {},
  ): BodiesBefore {
    const ev = this.ev;
    const def = this.definitionOfPart(scope.part);
    const before = ((def.row.timeline as Json[]) ?? []).some((f) => f.id === scope.feature) ? scope.feature : undefined;
    const result = this.stateOf(def, before);
    const state = result.state;
    const styles = result === def.shown ? def.styles : new PartStyles(def.ev, def.row, state);
    const definition: Scope = { definition: def.index };
    const bodies = shownBodies(ev, state, result.shapes, def.steps).map((b): ListedBody => {
      const props = styles.body(b.entity);
      const listed: ListedBody = {
        key: this.modelKey(definition, b.entity, state, def.shown.state.get(b.entity.key) === b.entity),
        id: bodyIdentity(b.entity),
        feature: b.entity.createdBy,
        name: props.name ?? `Body ${b.number}`,
        color: props.color ?? DEFAULT_COLOR,
        opacity: props.opacity ?? 1,
        visible: props.visible !== false,
      };
      if (options.picks) {
        const record = writeRecord(b.entity, state, ev.adapter);
        listed.picked = { reference: { entity: record }, names: this.namesFor(record) };
      }
      return listed;
    });
    const references = records.map((record): PlacedReference => {
      const level = record.id.length > 0 ? (ev.names.get(finest(record.id)) as Json | undefined) : undefined;
      const named =
        typeof level?.kind === 'string' && ENTITY_KINDS.has(level.kind as EntityKind)
          ? (level.kind as EntityKind)
          : null;
      let found: Resolved;
      try {
        found = this.resolve(record, before === undefined ? { part: scope.part } : { part: scope.part, before });
      } catch {
        found = { outcome: 'gone' };
      }
      const entry = found.outcome === 'same' ? this.entries[found.keys[0] as Key] : undefined;
      if (!entry) return { found: false, kind: named, body: null };
      const entity = entry.type === 'model' ? state.get(entry.key) : undefined;
      const body = entity ? this.bodyEntityOf(entity, state) : undefined;
      return { found: true, kind: entry.info.kind, body: body ? bodyIdentity(body) : null };
    });
    return { generation: this.generation, bodies, references };
  }

  /**
   * Where each of `records` lies in a part as it stands just before
   * `scope.feature` (as `bodiesBefore` reads that state), drawn: a face or
   * a body meshed as the display meshes bodies, an edge sampled as a
   * polyline. Null for a record that lands on no single face, edge or body
   * there. Nothing is evaluated.
   */
  outlinesBefore(scope: BeforeScope, records: readonly EntityRecord[]): (PickOutline | null)[] {
    const { kernel: k, adapter } = this.ev;
    const def = this.definitionOfPart(scope.part);
    const before = ((def.row.timeline as Json[]) ?? []).some((f) => f.id === scope.feature) ? scope.feature : undefined;
    const state = this.stateOf(def, before).state;
    return records.map((record): PickOutline | null => {
      let found;
      try {
        found = resolve(record, state, adapter);
      } catch {
        return null;
      }
      const entity = found.outcome === 'same' && found.entities.length === 1 ? found.entities[0] : undefined;
      if (!entity) return null;
      const handle = adapter.handleOf(entity.key);
      if (entity.kind === 'face' || entity.kind === 'body') {
        const m = k.meshShape(handle, DISPLAY);
        return { kind: entity.kind, positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) };
      }
      if (entity.kind === 'edge') {
        const wire = k.wireframe(handle, DISPLAY.linearDeflection);
        const segments: number[] = [];
        const eg = wire.edgeGroups;
        for (let i = 0; i + 2 < eg.length; i += 3) {
          const [start, count] = [eg[i] as number, eg[i + 1] as number];
          for (let p = start; p + 5 < start + count; p += 3) {
            for (let c = 0; c < 6; c++) segments.push(wire.points[p + c] as number);
          }
        }
        return segments.length > 0 ? { kind: 'edge', segments: new Float32Array(segments) } : null;
      }
      return null;
    });
  }

  // ---- measures ----

  /** What a key names, for measuring; a key of an instance's definition is read where the instance places it. */
  private operand(target: Key | PickTarget): { scope: string; op: Operand; ev: Evaluation } {
    if (typeof target !== 'number' && target.instance) {
      const placed = this.placed(target);
      if (!placed) throw new FeaturePause('a measured entity is not placed in that instance');
      return {
        scope: `a${placed.view.id}`,
        op: { kind: 'entity', entity: placed.entity, state: placed.view.result.state },
        ev: this.ev,
      };
    }
    const key = typeof target === 'number' ? target : target.key;
    const entry = this.entries[key];
    if (!entry) throw new FeaturePause('a measured key is not in this evaluation');
    switch (entry.type) {
      case 'model': {
        const def = this.definitions.find((d) => scopeKey({ definition: d.index }) === entry.scope);
        const state = def ? def.shown.state : this.assemblies.get(entry.scope.slice(1))?.result.state;
        const entity = state?.get(entry.key);
        if (!state || !entity) throw new FeaturePause('a measured entity is not shown');
        return { scope: entry.scope, op: { kind: 'entity', entity, state }, ev: def?.ev ?? this.ev };
      }
      case 'construction': {
        const { kind, frame } = entry.output;
        const op: Operand =
          kind === 'axis'
            ? { kind: 'axis', direction: frame.normal }
            : kind === 'plane'
              ? { kind: 'plane', normal: frame.normal }
              : { kind: 'point', at: frame.origin };
        return { scope: `d${entry.def.index}`, op, ev: entry.def.ev };
      }
      case 'curve':
        return {
          scope: `d${entry.def.index}`,
          op: { kind: 'curve', sketch: entry.sketch, id: entry.root },
          ev: entry.def.ev,
        };
      case 'point': {
        const p = entry.sketch.solved.points.find((q) => q.id === entry.id);
        if (!p) throw new FeaturePause('a measured sketch point is not in this build');
        return {
          scope: `d${entry.def.index}`,
          op: { kind: 'point', at: lift(entry.sketch.frame, [p.x, p.y]) },
          ev: entry.def.ev,
        };
      }
      default:
        throw new FeaturePause('measuring sketch regions is not built yet');
    }
  }

  /**
   * The measures `core.measure` takes (appendix A), between picked keys, in
   * base units (mm, mm², mm³, deg). Keys picked on instances of an assembly
   * are measured where the instances place them.
   */
  measure(kind: MeasureKind, targets: readonly (Key | PickTarget)[]): Measured {
    try {
      const ops = targets.map((t) => this.operand(t));
      if (new Set(ops.map((o) => o.scope)).size > 1)
        throw new FeaturePause('the measured entities lie in different builds');
      const ev = ops[0]?.ev ?? this.ev;
      return {
        value: measureOperands(
          { ev },
          kind,
          ops.map((o) => o.op),
        ),
        quantity: QUANTITY[kind] ?? '',
      };
    } catch (e) {
      if (e instanceof FeaturePause) return { pause: e.message };
      throw e;
    }
  }

  /** The faces an edge or vertex lies on, as keys of the same scope; empty for anything else. */
  neighbours(key: Key): Key[] {
    const entry = this.entries[key];
    if (!entry || entry.type !== 'model') return [];
    const def = this.definitions.find((d) => scopeKey({ definition: d.index }) === entry.scope);
    const state = def ? def.shown.state : this.assemblies.get(entry.scope.slice(1))?.result.state;
    const entity = state?.get(entry.key);
    if (!state || !entity) return [];
    const scope: Scope = def ? { definition: def.index } : { assembly: entry.scope.slice(1) };
    return this.facesOf(entity).flatMap((f) => {
      const face = state.get(f);
      return face ? [this.modelKey(scope, face, state, true)] : [];
    });
  }

  /**
   * Re-captures contexts of `doc` (12.4) on this service's kernel, apart from
   * the kept evaluation, whose keys stay valid. Returns each context's new
   * row with the asset rows and name-table entries it brings that `doc`
   * lacks. With `passes` above one, passes repeat until the contexts are in
   * date (automatic updates), and nothing is returned when they do not
   * settle.
   */
  updateContexts(
    doc: Json,
    requests: readonly ContextRequest[],
    options: { passes?: number; capturedAt?: string } = {},
  ): ContextsUpdate {
    const k = this.kernel;
    const mark = k.checkpoint();
    const made: Evaluation[] = [];
    try {
      const out = recapture(doc, k, requests, {
        ...options,
        ...(this.solver ? { solver: this.solver } : {}),
        done: (ev) => made.push(ev),
      });
      if (!out.settled) return { settled: false, passes: out.passes, contexts: [], assets: {}, names: {} };
      const contexts = requests.map((r) => {
        const part = (out.document.parts as Json[]).find((p) => p.id === r.part) as Json;
        const row = (part.contexts as Json[]).find((c) => c.id === r.context) as Json;
        return { part: r.part, context: r.context, row };
      });
      const had = (doc.assets as Json | undefined) ?? {};
      const assets = Object.fromEntries(
        Object.entries((out.document.assets as Json | undefined) ?? {}).filter(([hash]) => !(hash in had)),
      );
      const names = namesFor(
        contexts.map((c) => c.row),
        (out.document.names as Json | undefined) ?? {},
        (doc.names as Json | undefined) ?? {},
      );
      return { settled: true, passes: out.passes, contexts, assets, names };
    } finally {
      for (const ev of made) ev.adapter.dispose();
      k.releaseSince(mark);
    }
  }

  /**
   * Freezes feature `feature` of `doc` (7.2) on this service's kernel, apart
   * from the kept evaluation: its `frozen` field as a build of `doc` gives
   * it, with the asset rows its stored shapes use and the name-table
   * entries it names that `doc` lacks. A feature that cannot be frozen, or
   * did not build, gives why.
   */
  freeze(doc: Json, feature: string): FrozenResult {
    const k = this.kernel;
    const mark = k.checkpoint();
    let evaluation: Evaluation | undefined;
    try {
      const out = freezeFeature(doc, k, feature, this.solver ? { solver: this.solver } : {});
      evaluation = out.evaluation;
      const frozen = findFeatureRow(out.document, feature)?.frozen as Json | undefined;
      if (!frozen || !('frozen' in frozen))
        return { ok: false, message: "only a feature of a part's own timeline is frozen" };
      const had = (doc.assets as Json | undefined) ?? {};
      const assets = Object.fromEntries(
        Object.entries((out.document.assets as Json | undefined) ?? {}).filter(([hash]) => !(hash in had)),
      );
      const names = namesFor(
        frozen,
        (out.document.names as Json | undefined) ?? {},
        (doc.names as Json | undefined) ?? {},
      );
      return { ok: true, frozen, assets, names };
    } catch (e) {
      if (e instanceof FreezeError) return { ok: false, message: e.message };
      throw e;
    } finally {
      evaluation?.adapter.dispose();
      k.releaseSince(mark);
    }
  }

  /**
   * The curves an external sketch row of a mode would take from the model
   * edge, face or body a key names, in a sketch's frame in the part, ordered
   * as the row's index counts them (8.1).
   */
  externalCurves(key: Key, mode: 'project' | 'intersect', frame: FrameDisplay): ExternalCandidates {
    const entry = this.entries[key];
    if (!entry || entry.type !== 'model') return { pause: 'pick an edge, a face or a body of the model' };
    const k = this.ev.kernel;
    const mark = k.checkpoint();
    try {
      const handle = this.ev.adapter.handleOf(entry.key);
      return { shapes: externalCandidates(k, handle, entry.info.kind, mode, frame) };
    } catch (e) {
      if (e instanceof FeaturePause) return { pause: e.message };
      throw e;
    } finally {
      // The section and its edges are the query's own; the answer is plain data.
      k.releaseSince(mark);
    }
  }

  /** The 9.7 measures of a model entity, in its part's frame; null for anything else. */
  properties(key: Key): { kind: EntityKind; measures: Measures } | null {
    const entry = this.entries[key];
    if (!entry || entry.type !== 'model') return null;
    return { kind: entry.info.kind, measures: this.ev.adapter.measures(entry.key) };
  }

  /** A shown body's volume, surface area, centre of mass and bounding box, in its part's frame; null for anything else. */
  bodyMeasures(key: Key): BodyMeasures | null {
    const entry = this.entries[key];
    if (!entry || entry.type !== 'model' || entry.info.kind !== 'body') return null;
    const k = this.ev.kernel;
    const h = this.ev.adapter.handleOf(entry.key);
    const b = k.getBoundingBox(h);
    const c = k.getCenterOfMass(h);
    return {
      volume: k.getVolume(h),
      area: k.getSurfaceArea(h),
      centroid: [c.x, c.y, c.z],
      bbox: [
        [b.xmin, b.ymin, b.zmin],
        [b.xmax, b.ymax, b.zmax],
      ],
    };
  }

  // ---- imports ----

  /**
   * Reads a STEP, STL or BREP file into the stored shape of the `core.import`
   * feature `feature` (13.3). The kept evaluation is not touched.
   */
  importFile(
    bytes: Uint8Array,
    format: ImportFormat,
    feature: string,
    name: string,
    report?: (p: ImportProgress) => void,
  ): ImportedShape {
    return importShape(this.kernel, bytes, format, feature, name, report);
  }

  /**
   * The edges or faces of a part, as it is just before feature `before` (or
   * as shown), that are sub-shapes of another program's shape by geometry:
   * for each `index` into that shape's sub-shapes of `kind` in 13.2 index
   * order (TopExp::MapShapes order, which FreeCAD's `Edge3` counts in, from
   * 0), the record of the one live entity whose measures agree, or null.
   * `'all'` asks for every one. `brep` is the shape as OCCT BREP text.
   */
  locate(
    part: string,
    before: string | undefined,
    brep: string,
    kind: 'edge' | 'face',
    indices: readonly number[] | 'all',
    ofFaces: readonly number[] = [],
  ): (PickedEntity | null)[] {
    const ev = this.ev;
    const k = this.kernel;
    const result = this.stateOf(this.definitionOfPart(part), before);
    const probe = new NamingAdapter(k);
    let handle: ShapeHandle | undefined;
    try {
      try {
        handle = k.fromBREP(brep);
      } catch {
        return indices === 'all' ? [] : indices.map(() => null);
      }
      const all = probe.subShapes(probe.addShape(handle, 'probe'));
      const theirs = all.filter((s) => s.kind === kind);
      const wanted =
        indices === 'all' ? theirs.map((_, i) => i) : [...new Set([...indices, ...edgesOfFaces(all, theirs, ofFaces)])];
      const live = [...result.shapes.keys()].flatMap((ref) => ev.adapter.subShapes(ref).filter((s) => s.kind === kind));
      const size = Math.max(1, ...live.map((s) => diagonal(ev.adapter.measures(s.key).bbox)));
      const tolerance = 1e-6 * size + 1e-7;
      const close = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
        a !== undefined &&
        b !== undefined &&
        a.length === b.length &&
        a.every((v, i) => Math.abs(v - (b[i] as number)) <= tolerance);
      /** Whether `p` lies on the live sub-shape `key`. */
      const onLive = (p: readonly number[] | undefined, key: ShapeKey) => {
        if (p === undefined) return false;
        const vertex = k.makeVertex(p[0] as number, p[1] as number, p[2] as number);
        try {
          return k.distanceBetween(vertex, ev.adapter.handleOf(key)) <= tolerance;
        } finally {
          k.release(vertex);
        }
      };
      const same = (a: Measures, b: Measures, key: ShapeKey): boolean => {
        const ratio = (x: number | undefined, y: number | undefined) =>
          x !== undefined && y !== undefined && Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x));
        if (kind === 'face') return ratio(a.area, b.area) && close(a.centroid, b.centroid);
        if (!ratio(a.length, b.length)) return false;
        if (a.midpoint !== undefined)
          return (
            close(a.midpoint, b.midpoint) &&
            (a.quarter === undefined || close(a.quarter, b.quarter) || close(a.quarter, b.threeQuarter))
          );
        // A closed edge's points are read from where its curve starts, which another program may put elsewhere on it:
        // its centre and two of its points lying on the live edge, or its kind and box, say where it is.
        if (a.midpoint !== b.midpoint) return false;
        return (
          (close(a.center, b.center) && onLive(a.quarter, key) && onLive(a.threeQuarter, key)) ||
          (a.curve === b.curve && close(a.bbox?.flat(), b.bbox?.flat()))
        );
      };
      const liveMeasures = live.map((s) => ({ key: s.key, m: ev.adapter.measures(s.key) }));
      const distance = (a: readonly number[], b: readonly number[]) =>
        Math.hypot(
          (a[0] as number) - (b[0] as number),
          (a[1] as number) - (b[1] as number),
          (a[2] as number) - (b[2] as number),
        );
      const parallel = (a: readonly number[], b: readonly number[]) =>
        Math.abs(
          Math.abs(
            (a[0] as number) * (b[0] as number) +
              (a[1] as number) * (b[1] as number) +
              (a[2] as number) * (b[2] as number),
          ) - 1,
        ) < 1e-6;
      // The same curve split or seamed otherwise: their edge lies along a live one, a circle by its centre and radius, a line by its direction.
      const along = (theirsEdge: Measures, liveEdge: Measures): boolean => {
        if (theirsEdge.curve !== liveEdge.curve) return false;
        if (theirsEdge.curve === 'circle') {
          const [c, tc, tp, box, theirBox] = [
            liveEdge.center,
            theirsEdge.center,
            theirsEdge.midpoint,
            liveEdge.bbox,
            theirsEdge.bbox,
          ];
          if (!c || !tc || !box || !theirBox || distance(c, tc) > tolerance) return false;
          const radius = liveEdge.midpoint ? distance(liveEdge.midpoint, c) : (liveEdge.length ?? 0) / (2 * Math.PI);
          const within =
            theirBox[0].every((v, i) => v >= (box[0][i] as number) - tolerance) &&
            theirBox[1].every((v, i) => v <= (box[1][i] as number) + tolerance);
          return (
            within &&
            (tp
              ? Math.abs(distance(tp, tc) - radius) <= tolerance
              : Math.abs((theirsEdge.length ?? 0) / (2 * Math.PI) - radius) <= tolerance)
          );
        }
        if (theirsEdge.curve === 'line') {
          const [p, t, tp, tt, bbox] = [
            liveEdge.midpoint,
            liveEdge.tangent,
            theirsEdge.midpoint,
            theirsEdge.tangent,
            liveEdge.bbox,
          ];
          if (!p || !t || !tp || !tt || !bbox || !parallel(t, tt)) return false;
          const d = [
            (tp[0] as number) - (p[0] as number),
            (tp[1] as number) - (p[1] as number),
            (tp[2] as number) - (p[2] as number),
          ] as const;
          const off = Math.hypot(d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]);
          return (
            off <= tolerance &&
            (liveEdge.length ?? 0) >= (theirsEdge.length ?? 0) - tolerance &&
            Math.hypot(...d) <= ((liveEdge.length ?? 0) - (theirsEdge.length ?? 0)) / 2 + tolerance
          );
        }
        return false;
      };
      // The same plane trimmed otherwise: facing the same way, at the same offset along the normal.
      const samePlane = (theirsFace: Measures, liveFace: Measures): boolean => {
        const [n, ln, at, lat] = [theirsFace.normal, liveFace.normal, theirsFace.centroid, liveFace.centroid];
        if (theirsFace.surface !== 'plane' || liveFace.surface !== 'plane' || !n || !ln || !at || !lat) return false;
        if (n[0] * ln[0] + n[1] * ln[1] + n[2] * ln[2] < 0 || !parallel(n, ln)) return false;
        return Math.abs((lat[0] - at[0]) * n[0] + (lat[1] - at[1]) * n[1] + (lat[2] - at[2]) * n[2]) <= tolerance;
      };
      return wanted.map((i) => {
        const theirsAt = theirs[i];
        if (!theirsAt) return null;
        const m = probe.measures(theirsAt.key);
        let found = liveMeasures.filter((l) => same(m, l.m, l.key));
        if (found.length === 0 && kind === 'edge') found = liveMeasures.filter((l) => along(m, l.m));
        if (found.length === 0 && kind === 'face') found = liveMeasures.filter((l) => samePlane(m, l.m));
        const entity = found.length === 1 ? result.state.get((found[0] as (typeof found)[number]).key) : undefined;
        if (!entity) return null;
        const record = writeRecord(entity, result.state, ev.adapter);
        return { reference: { entity: record }, names: this.namesFor(record) };
      });
    } finally {
      probe.dispose();
      if (handle !== undefined) k.release(handle);
    }
  }

  /**
   * The edges of a part, as it is just before feature `before` (or as shown),
   * lying on both surfaces of each pair, as records; an edge another program
   * names by the two faces either side of it.
   */
  locateOnSurfaces(
    part: string,
    before: string | undefined,
    pairs: readonly (readonly [SurfaceSpec, SurfaceSpec])[],
  ): PickedEntity[][] {
    const ev = this.ev;
    const result = this.stateOf(this.definitionOfPart(part), before);
    const edges = [...result.shapes.keys()].flatMap((ref) =>
      ev.adapter.subShapes(ref).filter((s) => s.kind === 'edge'),
    );
    const samples = edges.map((s) => {
      const m = ev.adapter.measures(s.key);
      return {
        key: s.key,
        points: [m.quarter, m.midpoint, m.threeQuarter].filter((p) => p !== undefined) as [number, number, number][],
      };
    });
    return pairs.map(([a, b]) =>
      samples.flatMap((s) => {
        if (!onSurface(s.points, a) || !onSurface(s.points, b)) return [];
        const entity = result.state.get(s.key);
        if (!entity) return [];
        const record = writeRecord(entity, result.state, ev.adapter);
        return [{ reference: { entity: record }, names: this.namesFor(record) }];
      }),
    );
  }

  /** The live bodies of a part, as it is just before feature `before` (or as shown), that any of `features` made, as records. */
  bodiesMadeBy(part: string, before: string | undefined, features: readonly string[]): PickedEntity[] {
    const ev = this.ev;
    const result = this.stateOf(this.definitionOfPart(part), before);
    const wanted = new Set(features);
    return [...result.state.bodies.keys()].flatMap((key) => {
      const entity = result.state.get(key);
      if (!entity || !wanted.has(entity.createdBy)) return [];
      const record = writeRecord(entity, result.state, ev.adapter);
      return [{ reference: { entity: record }, names: this.namesFor(record) }];
    });
  }

  /**
   * For each surface, the faces of a part, as it is just before feature
   * `before` (or as shown), whose edges all lie on it, with their body's record.
   */
  locateFacesOnSurfaces(
    part: string,
    before: string | undefined,
    surfaces: readonly SurfaceSpec[],
  ): { face: PickedEntity; body: PickedEntity }[][] {
    const ev = this.ev;
    const result = this.stateOf(this.definitionOfPart(part), before);
    const picked = (key: ShapeKey): PickedEntity | null => {
      const entity = result.state.get(key);
      if (!entity) return null;
      const record = writeRecord(entity, result.state, ev.adapter);
      return { reference: { entity: record }, names: this.namesFor(record) };
    };
    const faces = [...result.state.bodies].flatMap(([bodyKey, shape]) => {
      const topology = ev.adapter.topology(shape);
      const points = new Map<ShapeKey, [number, number, number][]>(topology.faces.map((f) => [f, []]));
      for (const e of topology.edges) {
        const m = ev.adapter.measures(e.edge);
        const samples = [m.quarter, m.midpoint, m.threeQuarter].filter((p) => p !== undefined) as [
          number,
          number,
          number,
        ][];
        for (const { face } of e.faces) points.get(face)?.push(...samples);
      }
      return [...points].map(([key, list]) => ({ key, bodyKey, points: list }));
    });
    return surfaces.map((surface) =>
      faces.flatMap((f) => {
        if (!onSurface(f.points, surface)) return [];
        const [face, body] = [picked(f.key), picked(f.bodyKey)];
        return face && body ? [{ face, body }] : [];
      }),
    );
  }

  /** The constraints of a sketch's inputs that the solver cannot hold still, by id (see `unheldConstraints`). */
  vetSketch(inputs: Json): string[] {
    if (!this.solver) return [];
    return unheldConstraints(inputs, this.ev.values, this.solver);
  }

  /**
   * For each sketch feature of `doc` named, the constraints of its inputs
   * the solver cannot hold still, as `vetSketch` gives them, read against
   * `doc`'s values alone: nothing is evaluated and the kept evaluation is
   * not touched. Null for a sketch some value of which does not evaluate
   * without a build (a measured value), which `vetSketch` vets after one.
   */
  vetSketches(doc: Json, features: readonly string[]): (string[] | null)[] {
    const solver = this.solver;
    if (!solver) return features.map(() => []);
    const values = new WatchedValues(doc);
    return features.map((id) => {
      const row = findFeatureRow(doc, id);
      if (!row || row.type !== 'core.sketch') return null;
      values.paused = false;
      const out = unheldConstraints(row.inputs as Json, values, solver);
      return values.paused ? null : out;
    });
  }

  // ---- exports ----

  /** A body as an export writes it: what its attributes set, its faces' colours where they differ, and its name. */
  private exported(def: Definition, b: ShownBody, state: NamedState) {
    const props = def.styles.body(b.entity);
    const faces = new Map<ShapeKey, string>();
    for (const key of b.faces) {
      const face = state.get(key);
      const color = face ? def.styles.face(face, props).color : undefined;
      if (face && color !== undefined && color !== props.color) faces.set(key, color);
    }
    return { props, faces, name: props.name ?? `Body ${b.number}` };
  }

  /** The bodies an export writes, each with what its attributes set and its faces' colours. */
  private exportBodies(
    scope: ResolveScope,
    options: ExportOptions,
  ): { handle: ShapeHandle; name: string; props: Properties; faces: Map<ShapeKey, string> }[] {
    const ev = this.ev;
    if ('part' in scope) {
      const def = this.definitionOfPart(scope.part);
      const state = def.shown.state;
      const wanted = options.bodies && new Set(options.bodies);
      return shownBodies(ev, state, def.shown.shapes, def.steps).flatMap((b) => {
        const e = this.exported(def, b, state);
        const key = this.modelKey({ definition: def.index }, b.entity, state, true);
        if (wanted ? !wanted.has(key) : e.props.visible === false) return [];
        return [{ handle: b.handle, name: e.name, props: e.props, faces: e.faces }];
      });
    }
    const view = this.assemblies.get(scope.assembly);
    if (!view) throw new Error(`assembly ${scope.assembly} is not in the evaluation`);
    return view.leaves.flatMap((leaf, i) => {
      if (!leaf.visible) return [];
      const def = leaf.definition;
      const placedShape = new Map(leaf.pairs);
      return shownBodies(ev, def.result.state, def.result.shapes, def.steps).flatMap((b) => {
        const e = this.exported(def, b, def.result.state);
        const to = placedShape.get(b.ref);
        if (to === undefined || e.props.visible === false) return [];
        const map = new Map<ShapeKey, ShapeKey>();
        pairKeys(ev, b.ref, to, map);
        const solid = map.get(b.entity.key);
        const handle = b.shared
          ? solid === undefined
            ? undefined
            : ev.adapter.handleOf(solid)
          : view.result.shapes.get(to);
        if (handle === undefined) return [];
        const faces = new Map<ShapeKey, string>();
        for (const [k, c] of e.faces) {
          const placed = map.get(k);
          if (placed !== undefined) faces.set(placed, leaf.override.color ?? c);
        }
        const props: Properties = {
          ...e.props,
          ...(leaf.override.color !== undefined ? { color: leaf.override.color } : {}),
        };
        return [{ handle, name: `${e.name} (${i + 1})`, props, faces }];
      });
    });
  }

  /**
   * An assembly as a STEP assembly: one product per part definition, holding
   * its bodies with their colours, and one placed occurrence of it per
   * instance, named after the instance's part and number, as other CAD
   * programs read and write assemblies.
   */
  private assemblyStep(assembly: string): Uint8Array {
    const k = this.kernel;
    const ev = this.ev;
    const view = this.assemblies.get(assembly);
    if (!view) throw new Error(`assembly ${assembly} is not in the evaluation`);
    const made: ShapeHandle[] = [];
    const xcaf = k.createXCAFDocument();
    try {
      type Prototype = {
        handle: ShapeHandle;
        bodies: { handle: ShapeHandle; props: Properties; faces: Map<ShapeKey, string> }[];
      };
      const prototypes = new Map<Definition, Prototype>();
      const prototype = (def: Definition): Prototype => {
        const known = prototypes.get(def);
        if (known) return known;
        const bodies = shownBodies(ev, def.result.state, def.result.shapes, def.steps).flatMap((b) => {
          const e = this.exported(def, b, def.result.state);
          return e.props.visible !== false ? [{ handle: b.handle, props: e.props, faces: e.faces }] : [];
        });
        let handle = bodies[0]?.handle;
        if (bodies.length !== 1) {
          handle = k.makeCompound(bodies.map((b) => b.handle));
          made.push(handle);
        }
        const out = { handle: handle as ShapeHandle, bodies };
        prototypes.set(def, out);
        return out;
      };
      const leaves = view.leaves.filter((l) => l.visible && prototype(l.definition).bodies.length > 0);
      if (leaves.length === 0) throw new Error('there is nothing to export');
      const placed = leaves.map((l) => {
        const h = k.located(prototype(l.definition).handle, matrixOf(l.placement));
        made.push(h);
        return h;
      });
      const compound = k.makeCompound(placed);
      made.push(compound);
      const name = ((this.doc?.assemblies as Json[] | undefined) ?? []).find((a) => a.id === assembly)?.name;
      const root = xcaf.addShape(compound, { assembly: true, name: typeof name === 'string' ? name : 'Assembly' });
      const named = new Set<number>();
      xcaf.getChildren(root).forEach((label, i) => {
        const leaf = leaves[i] as Leaf;
        const part = typeof leaf.definition.row.name === 'string' ? leaf.definition.row.name : 'Part';
        xcaf.setName(label, `${part} (${i + 1})`);
        if (leaf.override.color !== undefined) xcaf.setColor(label, rgb(leaf.override.color));
        const proto = xcaf.getReferredLabel(label);
        if (proto === null || named.has(proto)) return;
        named.add(proto);
        xcaf.setName(proto, part);
        const { bodies } = prototype(leaf.definition);
        const single = bodies.length === 1;
        for (const b of bodies) {
          if (single) {
            if (b.props.color) xcaf.setColor(proto, rgb(b.props.color));
          } else
            xcaf.addSubShape(proto, b.handle, {
              ...(b.props.name ? { name: b.props.name } : {}),
              ...(b.props.color ? { color: rgb(b.props.color) } : {}),
            });
          for (const [face, color] of b.faces)
            xcaf.addSubShape(proto, ev.adapter.handleOf(face), { color: rgb(color) });
        }
      });
      return new TextEncoder().encode(xcaf.exportSTEP());
    } finally {
      xcaf.close();
      for (const h of made.reverse()) k.release(h);
    }
  }

  /** A file of the kept evaluation's bodies: a part's shown bodies, or an assembly's placed ones. */
  /** The references of a part's live bodies, as it is just before feature `before` (or as shown). */
  bodyRecords(part: string, before: string | undefined): PickedEntity[] {
    const def = this.definitionOfPart(part);
    const result = this.stateOf(def, before);
    return shownBodies(this.ev, result.state, result.shapes, def.steps).map((b) => {
      const record = writeRecord(b.entity, result.state, this.ev.adapter);
      return { reference: { entity: record }, names: this.namesFor(record) };
    });
  }

  /** The volume and box of a shape in BREP text. */
  shapeMeasures(brep: string): ShapeMeasures | null {
    const k = this.kernel;
    let handle: ShapeHandle | undefined;
    try {
      handle = k.fromBREP(brep);
      return measuresOf(k, [handle]);
    } catch {
      return null;
    } finally {
      if (handle !== undefined) k.release(handle);
    }
  }

  /** The volume and box of a part just after one of its features, or null when the feature did not build. */
  stepMeasures(part: string, feature: string): ShapeMeasures | null {
    const def = this.definitionOfPart(part);
    const ordinal = ((def.row.timeline as Json[]) ?? []).findIndex((f) => f.id === feature);
    const step = ordinal < 0 ? undefined : def.steps?.[ordinal];
    return step ? measuresOf(this.kernel, [...step.shapes.values()]) : null;
  }

  /**
   * The evaluated document as a FreeCAD file: each part's bodies as PartDesign
   * Bodies, the document's assembly as their placements. A placed part of the
   * library comes as the solids of its build.
   */
  exportFreeCad(): FcstdExport {
    const ev = this.ev;
    const doc = this.doc;
    if (!doc) throw new Error('nothing has been evaluated');
    // A preview builds each part only up to the feature being edited.
    if (this.partial) throw new Error('a feature is being edited; finish or cancel it first');
    const inDocument = this.definitions.filter((d) => d.variant === '' && d.steps !== undefined);
    const parts = inDocument.map((d) => ({
      id: d.part,
      row: d.row,
      result: d.result,
      steps: d.steps as readonly (PartResult | undefined)[],
      def: d,
    }));
    const instances: { part: string; placement: FcPlacement }[] = [];
    const placedShapes: PlacedShape[] = [];
    const root = doc.root as Json;
    if ('assembly' in root) {
      const view = this.assemblies.get((root.assembly as Json).id as string);
      view?.leaves.forEach((leaf, i) => {
        if (!leaf.visible) return;
        const def = leaf.definition;
        const placement = leaf.placement;
        if (def.variant === '' && def.steps !== undefined) {
          instances.push({ part: def.part, placement });
          return;
        }
        for (const b of shownBodies(ev, def.result.state, def.result.shapes, def.steps)) {
          placedShapes.push({
            label: `${this.exported(def, b, def.result.state).name} ${i + 1}`,
            handle: b.handle,
            placement,
          });
        }
      });
    }
    return exportFcstd({
      doc,
      ev,
      parts,
      bodies: (part, state) => {
        const def = parts.find((p) => p.id === part.id)?.def;
        return shownBodies(ev, state.state, state.shapes, def?.steps).map((b) => {
          const look = def ? this.exported(def, b, state.state).props : undefined;
          return {
            id: bodyIdentity(b.entity),
            ref: b.ref,
            handle: b.handle,
            ...(look?.color ? { color: look.color } : {}),
            ...(look?.opacity !== undefined ? { opacity: look.opacity } : {}),
          };
        });
      },
      instances,
      placedShapes,
    });
  }

  exportFile(format: ExportFormat, scope: ResolveScope, options: ExportOptions = {}): Uint8Array {
    const k = this.kernel;
    const bodies = this.exportBodies(scope, options);
    if (bodies.length === 0) throw new Error('there is nothing to export');
    const deflection = {
      linearDeflection: options.linearDeflection ?? DISPLAY.linearDeflection,
      angularDeflection: options.angularDeflection ?? DISPLAY.angularDeflection,
    };
    const made: ShapeHandle[] = [];
    try {
      const whole = () => {
        if (bodies.length === 1) return (bodies[0] as (typeof bodies)[number]).handle;
        const c = k.makeCompound(bodies.map((b) => b.handle));
        made.push(c);
        return c;
      };
      switch (format) {
        case 'stl': {
          // Mesh files go to slicers, which stand a part on Z; the model stands on Y.
          const meshes = bodies.map((b) => {
            const m = k.meshShape(b.handle, deflection);
            return { positions: yUpToZUp(m.positions), indices: m.indices };
          });
          return options.ascii
            ? new TextEncoder().encode(asciiStl(meshes, options.name))
            : binaryStl(meshes, options.name);
        }
        case 'brep':
          return new Uint8Array(k.toBREPBinary(whole()));
        case 'step': {
          if ('assembly' in scope) return this.assemblyStep(scope.assembly);
          const xcaf = k.createXCAFDocument();
          try {
            for (const b of bodies) {
              const label = xcaf.addShape(b.handle, {
                name: b.name,
                ...(b.props.color ? { color: rgb(b.props.color) } : {}),
              });
              for (const [face, color] of b.faces)
                xcaf.addSubShape(label, this.ev.adapter.handleOf(face), { color: rgb(color) });
            }
            return new TextEncoder().encode(xcaf.exportSTEP());
          } finally {
            xcaf.close();
          }
        }
        case '3mf': {
          const out: ThreeMfBody[] = bodies.map((b) => {
            const m = k.meshShape(b.handle, deflection);
            const colors: (string | null)[] = new Array<string | null>(m.triangleCount).fill(null);
            if (b.faces.size > 0) {
              const byHash = new Map<number, string>();
              for (const [face, color] of b.faces)
                byHash.set(k.hashCode(this.ev.adapter.handleOf(face), HASH_BOUND), color);
              const groups = m.faceGroups ?? new Int32Array(0);
              for (let i = 0; i + 2 < groups.length; i += 3) {
                const color = byHash.get(groups[i + 2] as number);
                if (color === undefined) continue;
                const start = (groups[i] as number) / 3;
                for (let t = 0; t < (groups[i + 1] as number) / 3; t++) colors[start + t] = color;
              }
            }
            return {
              name: b.name,
              positions: yUpToZUp(m.positions),
              indices: m.indices,
              color: b.props.color ?? null,
              triangleColors: colors,
              ...(b.props.filamentSlot !== undefined ? { filamentSlot: b.props.filamentSlot } : {}),
            };
          });
          return build3mf(out, options.name ?? 'model', DEFAULT_COLOR);
        }
      }
      throw new Error(`cannot export ${String(format)}`);
    } finally {
      for (const h of made) k.release(h);
    }
  }
}

/** A document's value evaluator that notes when a value does not evaluate. */
class WatchedValues extends ValueEvaluator {
  paused = false;

  override value(id: string, target?: Parameters<ValueEvaluator['value']>[1]): ExprValue {
    try {
      return super.value(id, target);
    } catch (e) {
      if (e instanceof ValuePause) this.paused = true;
      throw e;
    }
  }

  override parameter(id: string): ExprValue {
    try {
      return super.parameter(id);
    } catch (e) {
      if (e instanceof ValuePause) this.paused = true;
      throw e;
    }
  }
}

/** The length of a bounding box's diagonal; 0 without one. */
function diagonal(box: Measures['bbox']): number {
  if (!box) return 0;
  const [a, b] = box;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** `#rrggbb` as the sRGB [0, 1] triple XCAF labels take. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** Sorts `[first, count, key]` triples by their first index. */
function sortRanges(table: number[]): void {
  const rows: [number, number, number][] = [];
  for (let i = 0; i + 2 < table.length; i += 3)
    rows.push([table[i] as number, table[i + 1] as number, table[i + 2] as number]);
  rows.sort((a, b) => a[0] - b[0]);
  table.length = 0;
  for (const r of rows) table.push(...r);
}

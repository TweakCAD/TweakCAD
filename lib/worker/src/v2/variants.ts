/**
 * Builds of inserted definitions (11.1, 12.1). An instance or a derive inserts
 * a part, an assembly or a library component with a set of insertion
 * overrides. The overrides are evaluated in the host (6.4); insertions with
 * the same effective overrides share one build, and each distinct set builds
 * its own **variant** of the definition, in an evaluation of its own document
 * whose values take the overrides before row selection.
 *
 * A placed copy of a build keeps every name it has with one copy step
 * appended to its `chain` (9.5): the instance step for an instance, the
 * `derive` step for a derive, a pattern's slot for an assembly copy.
 */
import type { ShapeHandle } from 'occt-wasm';
import {
  type NameTable,
  NamedState,
  ValueEvaluator,
  ValuePause,
  canonicalize,
  isNameHash,
  isPlainObject,
  startFeature,
  withChain,
  type CopyStep,
  type ExprValue,
  type FeatureNamer,
  type JsonValue,
  type NamedEntity,
  type OperationHistory,
  type ShapeKey,
  type ShapeRef,
  type SubShapeHistory,
  type ValueTarget,
} from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  FeaturePause,
  kv,
  type ConstructionOutput,
  type Evaluation,
  type Frame,
  type Json,
  type PartResult,
  type Pause,
  type PlacedRecord,
  type V3,
} from './context';
import type { Live } from './operation';
import { apply, applyVector, isIdentity, matrixOf, reflect, type Rigid } from './rigid';

/** What a placed copy is made from: live bodies with their names, and construction outputs. */
export type Placeable = Pick<PartResult, 'state' | 'shapes' | 'construction'>;

/** How a copy is placed: rigidly, or reflected in a plane (an opposite-hand derive). */
export type Motion = { rigid: Rigid } | { mirror: { point: V3; normal: V3 } };

/** One build of a definition with one set of effective insertion overrides. */
export interface Variant {
  /** The evaluation it was built in: the host's own when nothing is overridden in the host's document. */
  ev: Evaluation;
  kind: 'part' | 'assembly';
  /** The definition's id in that evaluation's document. */
  id: string;
  /** The document and effective overrides, canonical: equal keys share the build. */
  key: string;
  result: Placeable;
}

/** Builds one part's timeline into `ev.parts` (the evaluator's step 2). */
export type PartBuilder = (ev: Evaluation, part: Json) => void;
/** Builds one assembly into `ev.assemblies`. */
export type AssemblyBuilder = (ev: Evaluation, assembly: Json) => Placeable;

interface Shared {
  buildPart: PartBuilder;
  variants: Map<string, Variant>;
}

/** What one document's evaluation knows about insertions. */
interface Session {
  doc: Json;
  /** Which document: empty for the host, the library entries' ids and hashes for embedded ones. */
  docKey: string;
  shared: Shared;
  building: Set<string>;
  built: Set<string>;
}

const sessions = new WeakMap<Evaluation, Session>();
let variantCount = 0;

/**
 * The host's adapter, for a variant build: builders name some shapes after
 * their feature, which a second build of the same part repeats, so a
 * variant's names get a prefix of their own (by default a fresh one). Keys
 * and shapes stay shared.
 */
export function prefixed(adapter: Evaluation['adapter'], prefix = `variant${++variantCount}/`): Evaluation['adapter'] {
  const name = (ref: ShapeRef | undefined) => (ref === undefined ? undefined : `${prefix}${ref}`);
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'addShape') return (shape: ShapeHandle, ref?: ShapeRef) => target.addShape(shape, name(ref));
      if (prop === 'history') {
        return (e: Parameters<typeof target.history>[0], inputs: OperationHistory['inputs'], ref?: ShapeRef) =>
          target.history(e, inputs, name(ref));
      }
      if (prop === 'sweepHistory') {
        return (
          e: Parameters<typeof target.sweepHistory>[0],
          profiles: ShapeRef | readonly ShapeRef[],
          ref?: ShapeRef,
          spine?: ShapeRef,
        ) => target.sweepHistory(e, profiles, name(ref), spine);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
let assemblyBuilder: AssemblyBuilder | undefined;

/** The assembly module registers how assemblies build. */
export function registerAssemblyBuilder(build: AssemblyBuilder): void {
  assemblyBuilder = build;
}

/** Makes `ev` the host evaluation of `doc`: its parts build on demand with `buildPart`. */
export function startInsertions(ev: Evaluation, doc: Json, buildPart: PartBuilder): void {
  sessions.set(ev, {
    doc,
    docKey: '',
    shared: { buildPart, variants: new Map() },
    building: new Set(),
    built: new Set(),
  });
}

function session(ev: Evaluation): Session {
  const s = sessions.get(ev);
  if (!s) throw new Error('the evaluation has no document');
  return s;
}

/** The document an evaluation evaluates. */
export function documentOf(ev: Evaluation): Json {
  return session(ev).doc;
}

function definition(doc: Json, table: 'parts' | 'assemblies', id: string): Json {
  const row = ((doc[table] as Json[] | undefined) ?? []).find((r) => r.id === id);
  if (!row) throw new FeaturePause(`${table === 'parts' ? 'part' : 'assembly'} ${id} does not exist`);
  return row;
}

function once<T>(ev: Evaluation, key: string, what: string, done: () => T | undefined, build: () => void): T {
  const s = session(ev);
  if (s.building.has(key)) throw new FeaturePause(`${what} depends on itself`);
  if (!s.built.has(key)) {
    s.building.add(key);
    try {
      build();
    } finally {
      s.building.delete(key);
      s.built.add(key);
    }
  }
  const result = done();
  if (!result) throw new FeaturePause(`${what} did not build`);
  return result;
}

/** A part of the evaluation's document, built if it is not yet. */
export function ensurePart(ev: Evaluation, id: string): PartResult {
  return once(
    ev,
    id,
    `part ${id}`,
    () => ev.parts.get(id),
    () => session(ev).shared.buildPart(ev, definition(session(ev).doc, 'parts', id)),
  );
}

/** An assembly of the evaluation's document, built if it is not yet. */
export function ensureAssembly(ev: Evaluation, id: string): Placeable {
  return once(
    ev,
    id,
    `assembly ${id}`,
    () => ev.assemblies.get(id),
    () => {
      if (!assemblyBuilder) throw new FeaturePause('assemblies are not built');
      assemblyBuilder(ev, definition(session(ev).doc, 'assemblies', id));
    },
  );
}

/** The parameter or value row of `doc` with this id, outside its library. */
function findRow(doc: Json, id: string): Json | undefined {
  let found: Json | undefined;
  const walk = (v: unknown): void => {
    if (found) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!isPlainObject(v)) return;
    if (v.id === id && ('def' in v || 'value' in v)) {
      found = v;
      return;
    }
    for (const [key, item] of Object.entries(v)) if (key !== 'extensions') walk(item);
  };
  for (const [key, item] of Object.entries(doc)) if (key !== 'library' && key !== 'extensions') walk(item);
  return found;
}

/**
 * Insertion overrides evaluated in the host (6.4): each target's result by
 * id. Only public parameters and public named values may be set (6.2).
 */
function insertionResults(
  host: Evaluation,
  target: Json,
  overrides: readonly Json[],
  label: string,
): Map<string, ExprValue> {
  const out = new Map<string, ExprValue>();
  for (const o of overrides) {
    const v = o.value as Json | undefined;
    if (!v) throw new FeaturePause('an insertion sets only values');
    const t = v.target as Json;
    const id = ((t.parameter ?? t.value) as Json).id as string;
    const row = findRow(target, id);
    if (!row) throw new FeaturePause(`an insertion override targets ${id}, which the inserted document does not have`);
    const isParameter = 'parameter' in t;
    if (row.public !== true) throw new FeaturePause(`an insertion override targets ${id}, which is not public`);
    const valueTarget: ValueTarget | undefined =
      isParameter && typeof row.type === 'string'
        ? {
            type: row.type as ValueTarget['type'],
            ...(typeof row.quantity === 'string' ? { quantity: row.quantity } : {}),
            ...(Array.isArray(row.options) ? { options: row.options as string[] } : {}),
          }
        : undefined;
    try {
      out.set(id, host.values.evaluateDefinition(v.def as Json, label, valueTarget));
    } catch (e) {
      if (e instanceof ValuePause) throw new FeaturePause(`an insertion override does not evaluate: ${e.message}`);
      throw e;
    }
  }
  return out;
}

/** The document an insertion places, and which of its definitions. */
function inserted(host: Evaluation, of: Json): { doc: Json; docKey: string; kind: 'part' | 'assembly'; id: string } {
  const s = session(host);
  if ('part' in of) return { doc: s.doc, docKey: s.docKey, kind: 'part', id: (of.part as Json).id as string };
  if ('assembly' in of)
    return { doc: s.doc, docKey: s.docKey, kind: 'assembly', id: (of.assembly as Json).id as string };
  const value = (of.component as Json).value;
  let lib: string;
  try {
    lib = host.values.literal(value, { type: 'library' }) as string;
  } catch (e) {
    if (e instanceof ValuePause) throw new FeaturePause(`the component does not evaluate: ${e.message}`);
    throw e;
  }
  const entry = ((s.doc.library as Json[] | undefined) ?? []).find((l) => l.id === lib);
  if (!entry) throw new FeaturePause(`library entry ${lib} does not exist`);
  if (entry.kind !== 'document') throw new FeaturePause(`library entry ${lib} is not a document`);
  const content = entry.content as Json;
  if (!('inline' in content)) throw new FeaturePause(`library entry ${lib} is missing`);
  const doc = (content.inline as Json).definition as Json;
  const root = doc.root as Json;
  const docKey = `${s.docKey}/${lib}#${String(entry.hash)}`;
  if ('part' in root) return { doc, docKey, kind: 'part', id: (root.part as Json).id as string };
  if ('assembly' in root) return { doc, docKey, kind: 'assembly', id: (root.assembly as Json).id as string };
  throw new FeaturePause(`library entry ${lib} holds parameters only`);
}

/**
 * The build an insertion places: `of` is an instance's `of` or a derive's
 * `from`, `overrides` its insertion overrides, `label` the inserting row.
 */
export function variantOf(host: Evaluation, of: Json, overrides: readonly Json[], label: string): Variant {
  const target = inserted(host, of);
  const fixed = insertionResults(host, target.doc, overrides, label);
  const s = session(host);
  const build = (ev: Evaluation): Placeable =>
    target.kind === 'part' ? ensurePart(ev, target.id) : ensureAssembly(ev, target.id);
  const overrideKey = canonicalize([...fixed].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, v]) => [id, v]));
  const key = `${target.docKey}|${target.kind}|${target.id}|${overrideKey}`;
  if (fixed.size === 0 && target.docKey === s.docKey) {
    return { ev: host, kind: target.kind, id: target.id, key, result: build(host) };
  }
  const known = s.shared.variants.get(key);
  if (known) return known;
  if (target.docKey !== s.docKey) mergeNames(host.names, target.doc.names);
  const ev: Evaluation = {
    kernel: host.kernel,
    names: host.names,
    adapter: prefixed(host.adapter),
    values: new ValueEvaluator(target.doc, fixed),
    solver: host.solver,
    assets: host.assets,
    // A variant's sketches read fonts from the library of the document it comes from.
    library: (target.doc.library as Json[] | undefined) ?? [],
    parts: new Map(),
    assemblies: new Map(),
    pauses: [],
    stale: [],
    outOfDate: [],
  };
  sessions.set(ev, { doc: target.doc, docKey: target.docKey, shared: s.shared, building: new Set(), built: new Set() });
  const variant: Variant = { ev, kind: target.kind, id: target.id, key, result: build(ev) };
  s.shared.variants.set(key, variant);
  // What paused in the variant pauses in the host too, saying which insertion it was built through.
  const up = (p: Pause) => ({ ...p, through: [label, ...(p.through ?? [])] });
  host.pauses.push(...ev.pauses.map(up));
  host.stale.push(...ev.stale.map(up));
  return variant;
}

/** Every build of an inserted definition made in this evaluation and the variants inside it. */
export function variantsOf(ev: Evaluation): Variant[] {
  return [...session(ev).shared.variants.values()];
}

/** An embedded document keeps its own name table (9.8); its names join the evaluation's. */
function mergeNames(into: NameTable, table: unknown): void {
  if (!isPlainObject(table)) return;
  for (const entry of Object.values(table)) into.intern(entry as never);
}

/** Two states as one, for a namer that copies from one into the other. */
export function mergeStates(a: NamedState, b: NamedState): NamedState {
  return new NamedState(
    new Map([...a.entities, ...b.entities]),
    new Map([...a.bodies, ...b.bodies]),
    new Set([...a.splits, ...b.splits]),
    new Map([...b.producers, ...a.producers]),
  );
}

function pairs(adapter: Evaluation['adapter'], from: ShapeRef, to: ShapeRef): OperationHistory {
  const a = adapter.subShapes(from);
  const b = adapter.subShapes(to);
  const same =
    a.length === b.length &&
    a.every((s, i) => {
      const t = b[i];
      return (
        t !== undefined &&
        t.kind === s.kind &&
        t.children.length === s.children.length &&
        t.children.every((c, j) => c === s.children[j])
      );
    });
  if (!same) throw new FeaturePause('a placed copy did not keep the structure of its source');
  const kind = (k: 'face' | 'edge'): SubShapeHistory => {
    const modified = new Map<ShapeKey, ShapeKey[]>();
    a.forEach((s, i) => {
      if (s.kind === k) modified.set(s.key, [(b[i] as (typeof b)[number]).key]);
    });
    return { kept: [], modified, deleted: [], added: [] };
  };
  return {
    result: to,
    inputs: [{ shape: from, use: 'target' }],
    faces: kind('face'),
    edges: kind('edge'),
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
}

/**
 * Copies of `shapes` placed by `motion`, named by `namer` with `step` (9.5).
 * A rigid copy is a new shape whose sub-shapes pair with the source's in
 * index order; a reflected one is the kernel's mirror, with its history.
 */
export function copyShapes(
  ev: Evaluation,
  namer: FeatureNamer,
  shapes: Iterable<readonly [ShapeRef, ShapeHandle]>,
  motion: Motion,
  step: CopyStep,
): Live[] {
  const { kernel: k, adapter } = ev;
  const out: Live[] = [];
  for (const [ref, handle] of shapes) {
    let history: OperationHistory;
    let result: ShapeHandle;
    if ('mirror' in motion) {
      const { point, normal } = motion.mirror;
      const evolution = k.mirrorWithHistory(handle, kv(point), kv(normal), adapter.faceHashes([ref]), HASH_BOUND);
      history = adapter.history(evolution, [{ shape: ref, use: 'target' }]);
      result = evolution.result;
    } else {
      // A fresh copy, so two placements of one build never share a sub-shape.
      const copied = k.copy(handle);
      result = isIdentity(motion.rigid) ? copied : k.transform(copied, matrixOf(motion.rigid));
      if (result !== copied) k.release(copied);
      history = pairs(adapter, ref, adapter.addShape(result));
    }
    namer.copy(history, step);
    out.push({ shape: history.result, handle: result });
  }
  return out;
}

function movedFrame(motion: Motion, f: Frame): Frame {
  if ('rigid' in motion) {
    const p = motion.rigid;
    return {
      origin: apply(p, f.origin),
      x: applyVector(p, f.x),
      y: applyVector(p, f.y),
      normal: applyVector(p, f.normal),
    };
  }
  const { point, normal } = motion.mirror;
  const vector = (v: V3): V3 => {
    const d = v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2];
    return [v[0] - 2 * d * normal[0], v[1] - 2 * d * normal[1], v[2] - 2 * d * normal[2]];
  };
  const x = vector(f.x);
  const y = vector(f.y);
  return { origin: reflect(point, normal, f.origin), x, y, normal: vector(f.normal) };
}

/** Construction outputs of `from`, moved and renamed with `step`, added to `into`. */
export function copyConstruction(
  ev: Evaluation,
  into: Placeable,
  from: Placeable,
  motion: Motion,
  step: CopyStep,
): void {
  const prefix = canonicalize(step);
  for (const [key, c] of from.construction) {
    const output: ConstructionOutput = {
      kind: c.kind,
      frame: movedFrame(motion, c.frame),
      ladder: c.ladder.map((h) => withChain(h, [step], ev.names)),
    };
    into.construction.set(`${prefix}|${key}`, output);
  }
}

/** An empty part, for building places in. */
export function emptyPart(): PartResult {
  return {
    state: NamedState.empty(),
    shapes: new Map(),
    sketches: new Map(),
    construction: new Map(),
    tools: new Map(),
    threads: new Map(),
  };
}

const objectIds = new WeakMap<object, number>();
let objectCount = 0;
const objectId = (o: object): number => {
  let id = objectIds.get(o);
  if (id === undefined) objectIds.set(o, (id = ++objectCount));
  return id;
};

/**
 * What a placing depends on: the very state, shapes and construction outputs
 * placed (an evaluation that resumed a part shares them with the one before),
 * the motion, the step and the owner.
 */
function placementKey(
  from: Placeable,
  motion: Motion,
  step: CopyStep,
  owner: { feature: string; ordinal: number },
): string {
  const shapes = [...from.shapes].map(([ref, handle]) => `${ref}:${handle}`).join(',');
  const construction = [...from.construction].map(([key, c]) => `${key}:${objectId(c)}`).join(',');
  return `${objectId(from.state)}|${shapes}|${construction}|${canonicalize(motion as never)}|${canonicalize(step as never)}|${owner.feature}|${owner.ordinal}`;
}

/**
 * Every name the placed entities and construction outputs carry, and every
 * name those name in turn, with their entries: what a later evaluation
 * taking the placing over needs in its table, whatever its document's table
 * holds.
 */
function namesUsed(
  names: NameTable,
  entities: readonly (readonly [ShapeKey, NamedEntity])[],
  construction: readonly (readonly [string, ConstructionOutput])[],
): [string, JsonValue][] {
  const out = new Map<string, JsonValue>();
  const visit = (hash: string): void => {
    if (out.has(hash)) return;
    const name = names.get(hash);
    if (name === undefined) return;
    out.set(hash, name);
    const walk = (v: unknown): void => {
      if (typeof v === 'string') {
        if (isNameHash(v)) visit(v);
      } else if (Array.isArray(v)) for (const item of v) walk(item);
      else if (isPlainObject(v)) for (const item of Object.values(v)) walk(item);
    };
    walk(name);
  };
  for (const [, e] of entities) {
    for (const h of e.ladder) visit(h);
    for (const a of e.aliases) visit(a.hash);
    for (const h of e.standsFor) visit(h);
  }
  for (const [, c] of construction) for (const h of c.ladder) visit(h as string);
  return [...out];
}

const isEmpty = (p: Placeable) =>
  p.state.entities.size === 0 && p.state.bodies.size === 0 && p.shapes.size === 0 && p.construction.size === 0;

/** `into` with what a placing made, as `record` holds it. */
function takeOver(ev: Evaluation, into: Placeable, record: PlacedRecord): void {
  ev.names.adopt(record.names);
  const state = into.state;
  if (record.before === null ? isEmpty(into) : into.state === record.before) into.state = record.state;
  else {
    const producers = new Map(state.producers);
    for (const [id, by] of record.producers) producers.set(id, by);
    into.state = new NamedState(
      new Map([...state.entities, ...record.entities]),
      new Map([...state.bodies, ...record.bodies]),
      new Set([...state.splits, ...record.splits]),
      producers,
    );
  }
  for (const c of record.copies) into.shapes.set(c.shape, c.handle);
  for (const [key, c] of record.construction) into.construction.set(key, c);
}

/** What placing made in `into`, from its state and tables before; undefined when the placing changed what was there, which a record cannot replay. */
function recordOf(
  ev: Evaluation,
  before: { state: NamedState; construction: number; empty: boolean },
  into: Placeable,
  copies: Live[],
): PlacedRecord | undefined {
  const was = before.state;
  const now = into.state;
  for (const [k, e] of was.entities) if (now.entities.get(k) !== e) return undefined;
  for (const [k, b] of was.bodies) if (now.bodies.get(k) !== b) return undefined;
  const entities = [...now.entities].filter(([k]) => !was.entities.has(k));
  const construction = [...into.construction].slice(before.construction);
  return {
    copies: copies.map((c) => ({ shape: c.shape, handle: c.handle })),
    entities,
    bodies: [...now.bodies].filter(([k]) => !was.bodies.has(k)),
    splits: [...now.splits].filter((s) => !was.splits.has(s)),
    producers: [...now.producers].filter(([id, by]) => was.producers.get(id) !== by),
    construction,
    names: namesUsed(ev.names, entities, construction),
    before: before.empty ? null : was,
    state: now,
  };
}

/**
 * Places a copy of everything in `from` into `into` by `motion`, its names
 * carrying `step`. `owner` is the feature or row the copies are created by.
 * With the evaluation's placement cache, a placing an earlier evaluation
 * made of the very same build (one it resumed) is taken over, copies and
 * names, rather than made again.
 */
export function placeInto(
  ev: Evaluation,
  into: Placeable,
  from: Placeable,
  motion: Motion,
  step: CopyStep,
  owner: { feature: string; ordinal: number },
): Live[] {
  const cache = ev.placements;
  const key = cache ? placementKey(from, motion, step, owner) : undefined;
  const known = key === undefined ? undefined : cache?.get(key);
  if (known) {
    takeOver(ev, into, known);
    return known.copies.map((c) => ({ ...c }));
  }
  const before = { state: into.state, construction: into.construction.size, empty: isEmpty(into) };
  const namer = startFeature(mergeStates(into.state, from.state), owner, ev.adapter, ev.names);
  const copies = copyShapes(ev, namer, from.shapes, motion, step);
  for (const ref of from.shapes.keys()) namer.retire(ref);
  into.state = namer.finish([]);
  for (const c of copies) into.shapes.set(c.shape, c.handle);
  copyConstruction(ev, into, from, motion, step);
  if (key !== undefined) {
    const record = recordOf(ev, before, into, copies);
    if (record) cache?.set(key, record);
  }
  return copies;
}

/** The instance step of an instance (9.5). */
export const instanceStep = (id: string): CopyStep => ({ op: { id }, key: { instance: { id } } });

/** An instance path's chain steps, innermost first (9.5). */
export function stepsOfPath(path: Json): CopyStep[] {
  return ((path.path as Json[]) ?? [])
    .map((s) => ('instance' in s ? instanceStep((s.instance as Json).id as string) : (s.copy as CopyStep)))
    .reverse();
}

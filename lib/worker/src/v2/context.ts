/**
 * Shared state and helpers for evaluating version-2 documents: what an
 * evaluation holds, the feature-builder registry, value targets, frames and
 * vector maths. Builders register themselves; the evaluator dispatches.
 */
import type { OcctKernel, ShapeHandle, Vec3 as KVec3 } from 'occt-wasm';
import type {
  Detection,
  EntityKey,
  NameTable,
  NamedEntity,
  NamedState,
  RegionMatching,
  RegionTable,
  ShapeKey,
  ShapeRef,
  CurveShape,
  JsonValue,
  SolvedCurve,
  SolvedSketch,
  ValueEvaluator,
} from '@tweakcad/format';
import type { NamingAdapter } from '@tweakcad/kernel/src/namingAdapter.ts';
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { AssemblyResult } from './assembly';

export type Json = Record<string, unknown>;
export type V3 = [number, number, number];

/** A feature that did not build in this evaluation, and why. */
export interface Pause {
  feature: string;
  message: string;
  /** For a feature built in a variant (12.1, 11.1): the instances or derives it was built through, outermost first. */
  through?: string[];
}

/** Thrown by a builder when the feature cannot build in this evaluation; it pauses. */
export class FeaturePause extends Error {}

/** A frame in its part: origin and unit axes, `normal` = x × y. */
export interface Frame {
  origin: V3;
  x: V3;
  y: V3;
  normal: V3;
}

export interface SketchResult {
  frame: Frame;
  solved: SolvedSketch;
  detection: Detection;
  matching: RegionMatching;
  table: RegionTable;
  /** The live curves that bound no region, for display: construction curves, and external curves that are not defining. */
  others: readonly SolvedCurve[];
  /** Every live line by its curve root, construction lines included: its start and end in the sketch plane. */
  lines: Map<string, (readonly [readonly [number, number], readonly [number, number]])[]>;
  /** The external curves as built, by row id, for an editor's solve. */
  externals: readonly { id: string; shape: CurveShape; bounds: boolean }[];
  /** Degrees of freedom the solve left (0: fully defined); absent when evaluated without a solver. */
  dof?: number;
}

/** A construction feature's output (chapter 15), named at levels 0 and 1 under its feature. */
export interface ConstructionOutput {
  kind: 'plane' | 'axis' | 'point' | 'frame';
  /** A plane is the frame's xy plane, an axis its z axis through its origin, a point its origin. */
  frame: Frame;
  ladder: readonly string[];
}

export interface PartResult {
  state: NamedState;
  /** Live body shapes by their naming ref. */
  shapes: Map<ShapeRef, ShapeHandle>;
  sketches: Map<string, SketchResult>;
  /** Construction outputs by their feature's id. */
  construction: Map<string, ConstructionOutput>;
  /** The tool each feature with an operation applied, by the feature's id, for feature patterns. */
  tools: Map<string, RecordedTool>;
  /** Cosmetic threads by the id of the feature that made them. */
  threads: Map<string, CosmeticThread[]>;
}

/**
 * A feature's tool as it entered its operation: its solids fused, its sub-shapes with the names the feature gave them.
 */
export interface RecordedTool {
  shape: ShapeRef;
  handle: ShapeHandle;
  op: string;
  /** The operation's `targets` input. */
  targets: Json;
  names: ReadonlyMap<number, NamedEntity>;
  /** The feature's place in the build. */
  ordinal: number;
  /** The operation kept the tool as a body (`keepTools`). */
  keepTools: boolean;
}

/** A cosmetic thread: data on its faces, not geometry. Lengths in mm. */
export interface CosmeticThread {
  /** The threaded faces, by finest name and branch, after the feature built. */
  faces: EntityKey[];
  standard: string;
  designation: string;
  class: string;
  /** In a hole, or on a shaft. */
  internal: boolean;
  pitch: number;
  major: number;
  pitchDiameter: number;
  minor: number;
  /** Where the thread starts on the faces' axis, and the unit direction it runs in from there. */
  start: V3;
  direction: V3;
  length: number;
  /** Present on a left-handed thread only. */
  hand?: 'left';
}

export interface Evaluation {
  kernel: OcctKernel;
  names: NameTable;
  adapter: NamingAdapter;
  values: ValueEvaluator;
  solver: GcsWrapper | undefined;
  /** The document's `assets` table (13.1). */
  assets: Json;
  /** The document's `library` table (11). */
  library: Json[];
  parts: Map<string, PartResult>;
  /** Assemblies by id (chapter 12). */
  assemblies: Map<string, AssemblyResult>;
  pauses: Pause[];
  /** Frozen features that replayed on a body an earlier edit changed (7.2); they still built. */
  stale: Pause[];
  /** Captured contexts that differ from the assembly as this evaluation built it (12.4). */
  outOfDate: { part: string; context: string; reason: string }[];
  /** Placed copies an earlier evaluation on the same shapes made, to take over (see `placeInto`). */
  placements?: PlacementCache;
}

/** What placing one build by one motion made, apart from the place it was put in. */
export interface PlacedRecord {
  copies: { shape: ShapeRef; handle: ShapeHandle }[];
  /** What the place's state gained: entities, bodies, splits and producers, in order. */
  entities: [ShapeKey, NamedEntity][];
  bodies: [ShapeKey, ShapeRef][];
  splits: string[];
  producers: [string, string][];
  construction: [string, ConstructionOutput][];
  /** Every name the placed entities and outputs carry, and the names those name, with their entries. */
  names: [string, JsonValue][];
  /**
   * The place's state before (none when the place was empty) and the state
   * made: a later placing into a place standing in that very state, or into
   * an empty one, takes this very state, so what is placed in turn keeps
   * its identity too.
   */
  before: NamedState | null;
  state: NamedState;
}

/** Placed copies by what was placed, how and by whom; `get` takes one over into the evaluation running. */
export interface PlacementCache {
  get(key: string): PlacedRecord | undefined;
  set(key: string, record: PlacedRecord): void;
}

/** Everything one feature's builder works with. */
export interface BuildContext {
  ev: Evaluation;
  part: PartResult;
  feature: Json;
  /** The feature's inputs after the selected configuration rows' `input` overrides. */
  inputs: Json;
  id: string;
  ordinal: number;
}

export type Builder = (ctx: BuildContext) => void;

const builders = new Map<string, Builder>();

/** Every builder builds its type at `typeVersion` 1. */
const BUILT_VERSION = 1;

/** Registers the builder of one feature type at `typeVersion` 1. */
export function registerBuilder(type: string, builder: Builder): void {
  builders.set(type, builder);
}

/** The builder of a feature type at one `typeVersion`, if there is one. */
export function builderFor(type: string, typeVersion: unknown): Builder | undefined {
  return typeVersion === BUILT_VERSION ? builders.get(type) : undefined;
}

export const LENGTH = { type: 'number', quantity: 'length' } as const;
export const ANGLE = { type: 'number', quantity: 'angle' } as const;
export const RATIO = { type: 'number', quantity: 'ratio' } as const;
export const INTEGER = { type: 'integer' } as const;
export const FLAG = { type: 'boolean' } as const;
export const TEXT = { type: 'text' } as const;
export const PLACEMENT = { type: 'placement' } as const;
export const LENGTH_VECTOR = { type: 'vector', quantity: 'length' } as const;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => scale(a, 1 / norm(a));
export const kv = (p: V3): KVec3 => ({ x: p[0], y: p[1], z: p[2] });

/** Rotates `v` by the unit quaternion `[x, y, z, w]`. */
export function rotate(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = q as [number, number, number, number];
  const u: V3 = [x, y, z];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, w)), cross(u, t));
}

/**
 * Builds version-2 documents on the kernel, in the order of spec chapter 10,
 * naming every output with the naming engine. Each feature type's builder
 * registers itself (`registerBuilder`); a type with no builder, and inputs a
 * builder does not handle yet, pause with a reason. Nothing is guessed.
 */
import { OcctError, type OcctKernel } from 'occt-wasm';
import type { GcsWrapper } from '@salusoft89/planegcs';
import {
  NameTable,
  NamingPause,
  ValueEvaluator,
  ValuePause,
  readDocument,
  type Diagnostic,
  type JsonValue,
} from '@tweakcad/format';
import { NamingAdapter } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  FLAG,
  FeaturePause,
  builderFor,
  type BuildContext,
  type Evaluation,
  type Json,
  type PartResult,
  type Pause,
  type PlacementCache,
} from './context';
import { SketchSolvePause } from './sketchSolve';
import { replayFrozen } from './builders/frozen';
import { measureValues, measuredValues } from './builders/measure';
import { emptyPart, ensurePart, startInsertions } from './variants';
import { contextsOutOfDate } from './capture';
import { evaluateAssemblies } from './assembly';
// Builders register themselves when loaded.
import './sketch';
import './builders';

export type { Evaluation, Frame, Pause, PartResult, SketchResult } from './context';
export type { AssemblyResult, AssemblyNode } from './assembly';

/** One feature that built live: the part just before it and just after. */
export interface Built {
  ev: Evaluation;
  part: string;
  feature: Json;
  before: PartResult;
  after: PartResult;
}

/** One feature of a part of the evaluated document, whatever became of it: built, frozen, suppressed or paused. */
export interface Step {
  ev: Evaluation;
  part: string;
  feature: Json;
  ordinal: number;
  /** The inputs it was built with, after configuration overrides. */
  inputs: Json;
  /** The part as it stood after it. */
  after: PartResult;
  /** The pauses and stale reports it added. */
  pauses: Pause[];
  stale: Pause[];
}

/** Where a part's timeline takes over from an earlier build: the part as it stood before feature `from`. */
export interface Resume {
  from: number;
  part: PartResult;
}

export interface EvaluateOptions {
  /** A loaded planegcs instance that solves sketches; without it, stored positions are used. */
  solver?: GcsWrapper;
  /** Called after each feature that built live, its values measured. */
  observe?: (built: Built) => void;
  /** Called before each feature of a part of the document. */
  start?: (part: string, ordinal: number) => void;
  /** Called after each feature of a part of the document. */
  step?: (step: Step) => void;
  /**
   * Lets a part of the document start from an earlier build of its first
   * features. Whoever resumes has restored what those features gave the
   * evaluation besides the part: measured values, pauses and stale reports.
   */
  resume?: (ev: Evaluation, part: string) => Resume | undefined;
  /** The value evaluator to use; by default a new one of the document. */
  values?: ValueEvaluator;
  /** The name table to use, holding the document's names; by default one loaded from the document. */
  names?: NameTable;
  /** The naming adapter to use, for an evaluation that resumes from the shapes of an earlier one; by default a new one. */
  adapter?: NamingAdapter;
  /** The format reader's diagnostics of the document, for a caller that has read it; by default it is read again. */
  diagnostics?: readonly Diagnostic[];
  /** Called once the parts are built, before the assemblies place them. */
  placing?: () => void;
  /** The asset table the builders read, standing for the document's (one that records what is read); by default the document's. */
  assets?: Json;
  /** Placed copies of an earlier evaluation on the same shapes and adapter, to take over (see `placeInto`). */
  placements?: PlacementCache;
  /**
   * Where a part of the document stops: the features from that ordinal on
   * are not built, and the part's result is its state just before them (a
   * preview that shows the part at its rollback). Undefined builds it all.
   */
  until?: (part: string) => number | undefined;
}

/**
 * `root` with the value at an RFC 6901 pointer replaced; returns the new root,
 * a copy of `value` for the empty pointer. A step into a table is a row id (7.3).
 */
function applyPointer(root: Json, pointer: string, value: JsonValue): Json {
  if (pointer === '') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new FeaturePause('a configuration override replaces the inputs with something that is not an object');
    }
    return structuredClone(value) as Json;
  }
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  let at: unknown = root;
  tokens.forEach((token, i) => {
    const last = i === tokens.length - 1;
    if (Array.isArray(at)) {
      const index = at.findIndex((row) => typeof row === 'object' && row !== null && (row as Json).id === token);
      const position = index >= 0 ? index : /^\d+$/.test(token) ? Number(token) : -1;
      if (position < 0 || position >= at.length) throw new FeaturePause('a configuration override points nowhere');
      if (last) at[position] = value;
      else at = at[position];
      return;
    }
    if (typeof at !== 'object' || at === null || !(token in (at as Json))) {
      throw new FeaturePause('a configuration override points nowhere');
    }
    if (last) (at as Json)[token] = value;
    else at = (at as Json)[token];
  });
  return root;
}

/** Reader findings of content that could change geometry and is not understood (chapter 18). */
const NOT_UNDERSTOOD = new Set(['unknown-key', 'unknown-variant', 'unknown-version']);

const pointerStep = (path: string, token: string | number) =>
  `${path}/${String(token).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const within = (path: string, at: string) => path === at || path.startsWith(`${at}/`);
const isFrozen = (feature: Json) =>
  typeof feature.frozen === 'object' && feature.frozen !== null && 'frozen' in feature.frozen;

/**
 * The features that pause for content the reader does not understand (chapter
 * 18), with the reader's message: a feature holding such content, and every
 * feature of a part row, or of the document, holding it. A frozen feature
 * replays whatever its type, version and inputs (7.2).
 */
export function readerPauses(doc: Json, diagnostics: readonly Diagnostic[]): Map<Json, string> {
  const out = new Map<Json, string>();
  const unread = diagnostics.filter((d) => d.severity === 'pause' && NOT_UNDERSTOOD.has(d.code));
  if (unread.length === 0) return out;
  const features = new Map<string, Json>();
  const parts = new Map<string, Json[]>();
  const walk = (value: unknown, path: string, key: string | undefined, owners: Json[][]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (key === 'timeline' || key === 'children') {
          if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
            features.set(pointerStep(path, i), item as Json);
            for (const owner of owners) owner.push(item as Json);
          }
        }
        if (key === 'parts' && typeof item === 'object' && item !== null && 'timeline' in item) {
          const timeline: Json[] = [];
          parts.set(pointerStep(path, i), timeline);
          walk(item, pointerStep(path, i), undefined, [...owners, timeline]);
          return;
        }
        walk(item, pointerStep(path, i), undefined, owners);
      });
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, pointerStep(path, k), k, owners);
    }
  };
  const everything: Json[] = [];
  walk(doc, '', undefined, [everything]);

  const pause = (feature: Json, message: string) => {
    if (!out.has(feature)) out.set(feature, message);
  };
  const longest = <T>(table: Map<string, T>, path: string): [string, T] | undefined =>
    [...table].filter(([at]) => within(path, at)).sort(([a], [b]) => b.length - a.length)[0];
  for (const d of unread) {
    const feature = longest(features, d.path);
    if (feature) {
      const [at, f] = feature;
      const rest = d.path.slice(at.length);
      if (isFrozen(f) && (within(rest, '/inputs') || rest === '/type' || rest === '/typeVersion')) continue;
      pause(f, d.message);
      continue;
    }
    // Content of the part row itself, or of the document's top level, pauses every feature under it.
    const part = longest(parts, d.path);
    if (part) {
      if (d.path.slice(part[0].length).split('/').length === 2)
        for (const f of part[1]) pause(f, `${d.message} in its part`);
    } else if (d.path.split('/').length === 2) {
      for (const f of everything) pause(f, `${d.message} in the document`);
    }
  }
  return out;
}

/** The values a feature measures get no result in this build: what uses them pauses with `message`. */
function withholdMeasures(ev: Evaluation, inputs: Json, message: string): void {
  for (const id of measuredValues({ ev, inputs })) ev.values.withhold(id, message);
}

/** Evaluates a version-2 document: its parts and assemblies (chapter 10). */
export function evaluateDocument(doc: Json, kernel: OcctKernel, options: EvaluateOptions = {}): Evaluation {
  const ev: Evaluation = {
    kernel,
    names: options.names ?? NameTable.fromJson(doc.names),
    adapter: options.adapter ?? new NamingAdapter(kernel),
    values: options.values ?? new ValueEvaluator(doc),
    solver: options.solver,
    assets: options.assets ?? (doc.assets as Json),
    library: (doc.library as Json[] | undefined) ?? [],
    parts: new Map(),
    assemblies: new Map(),
    pauses: [],
    stale: [],
    outOfDate: [],
    ...(options.placements ? { placements: options.placements } : {}),
  };
  const unread = readerPauses(doc, options.diagnostics ?? readDocument(doc).diagnostics);
  // A part another part derives from builds first; the dependency graph decides, not the table order (10).
  startInsertions(ev, doc, (e, partJson) => buildPart(e, partJson, e === ev ? options : {}, unread));
  for (const partJson of doc.parts as Json[]) ensurePart(ev, partJson.id as string);
  if (((doc.assemblies as Json[] | undefined) ?? []).length > 0) options.placing?.();
  evaluateAssemblies(ev, doc);
  ev.outOfDate = contextsOutOfDate(ev, doc);
  return ev;
}

/** A part result whose tables can change without changing `p`'s. */
export function copyPart(p: PartResult): PartResult {
  return {
    state: p.state,
    shapes: new Map(p.shapes),
    sketches: new Map(p.sketches),
    construction: new Map(p.construction),
    tools: new Map(p.tools),
    threads: new Map(p.threads),
  };
}

/**
 * Builds one part's timeline into `ev.parts` (chapter 10, step 2). The
 * features in `unread` pause with their message, unbuilt.
 */
export function buildPart(
  ev: Evaluation,
  partJson: Json,
  options: EvaluateOptions = {},
  unread: ReadonlyMap<Json, string> = new Map(),
): void {
  const partId = partJson.id as string;
  const resumed = options.resume?.(ev, partId);
  const part: PartResult = resumed ? copyPart(resumed.part) : emptyPart();
  ev.parts.set(partId, part);
  const until = options.until?.(partId);
  (partJson.timeline as Json[]).forEach((feature, ordinal) => {
    if (resumed && ordinal < resumed.from) return;
    if (until !== undefined && ordinal >= until) return;
    options.start?.(partId, ordinal);
    const [pauses, stale] = [ev.pauses.length, ev.stale.length];
    const inputs = buildFeature(ev, partId, part, feature, ordinal, options, unread.get(feature));
    options.step?.({
      ev,
      part: partId,
      feature,
      ordinal,
      inputs,
      after: copyPart(part),
      pauses: ev.pauses.slice(pauses),
      stale: ev.stale.slice(stale),
    });
  });
}

/**
 * Builds one feature into `part`; returns the inputs it was built with.
 * `unread` is why the reader pauses it, when it does.
 */
function buildFeature(
  ev: Evaluation,
  partId: string,
  part: PartResult,
  feature: Json,
  ordinal: number,
  options: EvaluateOptions,
  unread: string | undefined,
): Json {
  const id = feature.id as string;
  // A paused feature has no effect, even if it had started on the part.
  const saved = copyPart(part);
  const before: PartResult = { ...part, shapes: saved.shapes };
  let inputs = feature.inputs as Json;
  try {
    if (ev.values.literal(feature.suppressed, FLAG) === true) {
      withholdMeasures(ev, inputs, 'the feature that measures it is suppressed');
      return inputs;
    }
    if (unread !== undefined) throw new FeaturePause(unread);
    const frozen = feature.frozen as Json;
    if ('frozen' in frozen) {
      replayFrozen({ ev, part, feature, inputs, id, ordinal }, frozen.frozen as Json);
      return inputs;
    }
    const builder = builderFor(feature.type as string, feature.typeVersion);
    if (!builder) {
      if (builderFor(feature.type as string, 1))
        throw new FeaturePause(`${String(feature.type)} typeVersion ${String(feature.typeVersion)} is not built`);
      throw new FeaturePause(`${String(feature.type)} is not built yet`);
    }
    const overrides = ev.values.inputOverrides.filter((o) => o.feature === id);
    if (overrides.length > 0) {
      inputs = structuredClone(inputs);
      for (const o of overrides) inputs = applyPointer(inputs, o.pointer, o.with);
    }
    const ctx: BuildContext = { ev, part, feature, inputs, id, ordinal };
    builder(ctx);
    measureValues(ctx, before);
    options.observe?.({ ev, part: partId, feature, before, after: { ...part, shapes: new Map(part.shapes) } });
  } catch (e) {
    const message =
      e instanceof FeaturePause || e instanceof ValuePause || e instanceof SketchSolvePause || e instanceof NamingPause
        ? e.message
        : e instanceof OcctError
          ? `the kernel could not build the feature: ${e.message}`
          : undefined;
    if (message === undefined) throw e;
    ev.pauses.push({ feature: id, message });
    Object.assign(part, saved);
    withholdMeasures(ev, feature.inputs as Json, 'the feature that measures it did not build');
  }
  return inputs;
}

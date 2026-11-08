/**
 * The feature-result cache: an edit rebuilds a part from the first feature
 * it changes. Each feature of a part of the document is recorded as it
 * builds, with what it depended on:
 * - the feature itself and the configuration input overrides that reach it,
 *   in canonical form;
 * - every value it read and what came of it, so a parameter edited anywhere,
 *   a configuration switched or a measured value that changed reaches it;
 * - every asset row it read, by content, so an asset loaded, replaced or
 *   altered under the same hash reaches it;
 * - which of the names it holds the document's name table lacks;
 * - the library and settings of the document, and the part's selection sets
 *   and captured contexts, by hash.
 * A later evaluation takes over a part's longest prefix of features whose
 * dependencies are all unchanged, in order, restoring what they gave the
 * evaluation besides the part: every result it gave a value or withheld from
 * one (measured values, a frozen feature's stored values, the withheld
 * measures of a suppressed or paused feature), pauses and names. A feature
 * that reads another part (a derive, an in-context reference), or that the
 * reader pauses for content it does not understand, is never taken over, nor
 * is anything after it.
 *
 * A resumed evaluation shares the kernel shapes and naming adapter of the
 * evaluation it resumes from, so whoever keeps the evaluations decides when
 * to start afresh and release what the old ones held.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { OcctKernel } from 'occt-wasm';
import {
  NameTable,
  ValueEvaluator,
  ValuePause,
  canonicalBytes,
  canonicalize,
  isNameHash,
  isPlainObject,
  readDocument,
  sha256,
  toHex,
  type ExprValue,
  type JsonValue,
} from '@tweakcad/format';
import { NamingAdapter } from '@tweakcad/kernel/src/namingAdapter.ts';
import { evaluateDocument, readerPauses, type Evaluation } from '../evaluate';
import type { Json, PartResult, Pause, PlacedRecord } from '../context';
import { prefixed } from '../variants';
import type { Progress } from './types';

/** One call a feature made to the value evaluator, and what came of it. */
interface Read {
  method: 'value' | 'parameter' | 'number' | 'literal' | 'definition';
  args: unknown[];
  outcome: string;
}

function outcomeOf(run: () => unknown): string {
  try {
    return `ok ${JSON.stringify(run()) ?? 'undefined'}`;
  } catch (e) {
    if (e instanceof ValuePause) return `pause ${e.message}`;
    return `error ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** A result a feature gave a value from outside the expressions, or withheld from it, in the order given. */
export type Effect = { id: string; result: ExprValue } | { id: string; withheld: string };

/**
 * A value evaluator that records each feature's reads, the outermost calls
 * only, and every result the feature's build gave a value or withheld from
 * one, between `begin` and `end`.
 */
export class RecordingValues extends ValueEvaluator {
  private depth = 0;
  private readonly open: { reads: Read[]; effects: Effect[] }[] = [];

  /** Starts recording a feature's reads and effects; nested features record their own. */
  begin(): void {
    this.open.push({ reads: [], effects: [] });
  }

  /** The reads and effects since the matching `begin`. */
  end(): { reads: Read[]; effects: Effect[] } {
    return this.open.pop() ?? { reads: [], effects: [] };
  }

  override supply(id: string, result: ExprValue): void {
    if (this.depth === 0) this.open[this.open.length - 1]?.effects.push({ id, result });
    super.supply(id, result);
  }

  override withhold(id: string, message: string): void {
    if (this.depth === 0) this.open[this.open.length - 1]?.effects.push({ id, withheld: message });
    super.withhold(id, message);
  }

  /** Gives the results and withholdings another evaluation recorded, in order, without recording them. */
  apply(effects: readonly Effect[]): void {
    this.quietly(() => {
      for (const e of effects) {
        if ('result' in e) this.supply(e.id, e.result);
        else this.withhold(e.id, e.withheld);
      }
    });
  }

  private record<T>(method: Read['method'], args: unknown[], run: () => T): T {
    const into = this.depth === 0 ? this.open[this.open.length - 1]?.reads : undefined;
    this.depth++;
    try {
      const result = run();
      into?.push({ method, args, outcome: `ok ${JSON.stringify(result) ?? 'undefined'}` });
      return result;
    } catch (e) {
      into?.push({
        method,
        args,
        outcome: e instanceof ValuePause ? `pause ${e.message}` : `error ${e instanceof Error ? e.message : String(e)}`,
      });
      throw e;
    } finally {
      this.depth--;
    }
  }

  /** Runs `read` without recording it. */
  quietly<T>(read: () => T): T {
    this.depth++;
    try {
      return read();
    } finally {
      this.depth--;
    }
  }

  /** Whether a read from another evaluation comes out the same here. */
  agrees(read: Read): boolean {
    const call = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[read.method] as (
      ...a: unknown[]
    ) => unknown;
    return this.quietly(() => outcomeOf(() => call.apply(this, read.args))) === read.outcome;
  }

  override value(id: string, target?: Parameters<ValueEvaluator['value']>[1]): ExprValue {
    return this.record('value', [id, target], () => super.value(id, target));
  }

  override parameter(id: string): ExprValue {
    return this.record('parameter', [id], () => super.parameter(id));
  }

  override number(v: unknown, target: Parameters<ValueEvaluator['number']>[1]): number {
    return this.record('number', [v, target], () => super.number(v, target));
  }

  override literal(v: unknown, target: Parameters<ValueEvaluator['literal']>[1]): JsonValue {
    return this.record('literal', [v, target], () => super.literal(v, target));
  }

  override definition(id: string): Json | undefined {
    return this.record('definition', [id], () => super.definition(id));
  }
}

/**
 * A name table that remembers the order the evaluation first interned names
 * in, whether or not the document's table already held them: a build taken
 * over later must bring every name its features made, since the document it
 * is taken into may not hold them.
 */
export class RecordingNames extends NameTable {
  readonly order: string[] = [];
  private readonly interned = new Set<string>();

  override intern(name: JsonValue): string {
    const hash = super.intern(name);
    this.note(hash);
    return hash;
  }

  override adopt(entries: Iterable<readonly [string, JsonValue]>): void {
    for (const entry of entries) {
      super.adopt([entry]);
      this.note(entry[0]);
    }
  }

  private note(hash: string): void {
    if (!this.interned.has(hash)) {
      this.interned.add(hash);
      this.order.push(hash);
    }
  }

  /** A document's table; malformed or mismatched entries are refused. */
  static load(table: unknown): RecordingNames {
    const checked = NameTable.fromJson(table);
    const names = new RecordingNames();
    for (const name of Object.values(checked.toJson())) NameTable.prototype.intern.call(names, name);
    return names;
  }
}

/**
 * The asset table as the builders read it: each row a feature reads is
 * recorded by its content (a hash of the whole row, so its bytes, size and
 * whether it is loaded), or as missing.
 */
class AssetReads {
  private readonly open: Map<string, string>[] = [];
  private readonly prints = new Map<string, string>();
  readonly table: Json;

  constructor(private readonly rows: Json) {
    this.table = new Proxy(rows, {
      get: (target, p, receiver) => {
        if (typeof p === 'string') this.open[this.open.length - 1]?.set(p, this.print(p));
        return Reflect.get(target, p, receiver) as unknown;
      },
    });
  }

  begin(): void {
    this.open.push(new Map());
  }

  end(): [string, string][] {
    return [...(this.open.pop() ?? [])];
  }

  /** A row's content as this document holds it, once per evaluation. */
  print(hash: string): string {
    let known = this.prints.get(hash);
    if (known === undefined) {
      known = Object.hasOwn(this.rows, hash) ? rowPrint(hash, this.rows[hash]) : 'missing';
      this.prints.set(hash, known);
    }
    return known;
  }
}

/** Asset rows printed lately, by key: a row's inline bytes run to megabytes, and comparing them is cheaper than hashing them again. */
const printed = new Map<string, { row: unknown; bytes: unknown; rest: string; print: string }>();
const PRINTED_ROWS = 256;

/** A hash of an asset row's whole content; a row whose bytes and other fields read the same as when last printed keeps that print. */
function rowPrint(key: string, row: unknown): string {
  const bytes =
    isPlainObject(row) && isPlainObject(row.data) && isPlainObject(row.data.inline)
      ? row.data.inline.base64
      : undefined;
  if (typeof bytes !== 'string') return hashOf(row);
  const rest = canonicalize({
    ...(row as Json),
    data: { inline: { ...(((row as Json).data as Json).inline as Json), base64: '' } },
  } as JsonValue);
  const known = printed.get(key);
  if (known && (known.row === row || (known.rest === rest && known.bytes === bytes))) return known.print;
  const print = hashOf(row);
  if (printed.size >= PRINTED_ROWS) printed.clear();
  printed.set(key, { row, bytes, rest, print });
  return print;
}

/** What one feature of a part built from, and what it gave. */
interface FeatureRecord {
  /** The feature and the input overrides that reach it, canonical. */
  key: string;
  /** The name hashes it holds, whether or not the document's table had them. */
  holds: string[];
  /** Whether a later evaluation may take it over. */
  reusable: boolean;
  reads: Read[];
  /** The asset rows it read: hash, and the row's content or "missing". */
  assets: [string, string][];
  /** The results it gave values or withheld from them, in order. */
  effects: Effect[];
  pauses: Pause[];
  stale: Pause[];
  /** Names it was the first to intern. */
  names: [string, JsonValue][];
  /** The part as it stood after it. */
  after: PartResult;
}

/** A kept evaluation and what the cache recorded of it. */
export interface Recorded {
  ev: Evaluation;
  /** The adapter its shapes are registered with, without any prefix. */
  adapter: NamingAdapter;
  /** Per part of the document, by ordinal. */
  features: Map<string, FeatureRecord[]>;
  /** The document-wide dependencies, and each part's, by hash. */
  documentKey: string;
  partKeys: Map<string, string>;
  /** How many evaluations in a row have resumed from this one's shapes. */
  carried: number;
  /** Features taken over from the evaluation before. */
  resumed: number;
  /** Why a part took over no more than it did, for each part that built any feature. */
  misses: string[];
  /** The parts of the document in the order they built. */
  order: string[];
  /** The placed copies its assemblies made or took over, for the next evaluation to take over. */
  placements: Map<string, PlacedRecord>;
  /** How many placings it took over. */
  placedKept: number;
}

const hashOf = (v: unknown) => toHex(sha256(canonicalBytes(v as JsonValue)));

/**
 * Canonical text and hashes of document subtrees, by object: a document
 * sent as a change from the one before (`docPatch.ts`) shares every subtree
 * the change left alone, so these are worked out once per subtree.
 */
const canonicalTexts = new WeakMap<object, string>();
const hashes = new WeakMap<object, string>();
const canonicalOf = (v: unknown): string => {
  if (typeof v !== 'object' || v === null) return canonicalize(v as JsonValue);
  let text = canonicalTexts.get(v);
  if (text === undefined) canonicalTexts.set(v, (text = canonicalize(v as JsonValue)));
  return text;
};
const hashOfPart = (v: unknown): string => {
  if (typeof v !== 'object' || v === null) return hashOf(v);
  let hash = hashes.get(v);
  if (hash === undefined) hashes.set(v, (hash = hashOf(v)));
  return hash;
};

/** The document-wide dependencies. Assets are not among them: each feature records the rows it reads. */
function documentKey(doc: Json): string {
  return [doc.schemaVersion, doc.namingRules, doc.settings ?? {}, doc.library ?? []].map(hashOfPart).join('|');
}

function partKey(row: Json): string {
  return [row.sets ?? [], row.contexts ?? []].map(hashOfPart).join('|');
}

/** The name hashes `v` holds. */
function heldNames(v: unknown, out: Set<string>): Set<string> {
  if (typeof v === 'string') {
    if (isNameHash(v)) out.add(v);
  } else if (Array.isArray(v)) for (const item of v) heldNames(item, out);
  else if (isPlainObject(v)) for (const item of Object.values(v)) heldNames(item, out);
  return out;
}

const heldByFeature = new WeakMap<Json, string[]>();

/** A feature, the input overrides that reach it, and which of the names it holds the document lacks, canonical; and those names. */
function featureKey(values: ValueEvaluator, names: NameTable, feature: Json): { key: string; holds: string[] } {
  const overrides = values.inputOverrides.filter((o) => o.feature === feature.id);
  let holds = heldByFeature.get(feature);
  if (!holds) heldByFeature.set(feature, (holds = [...heldNames(feature, new Set())].sort()));
  const missing = holds.filter((hash) => !names.has(hash));
  return {
    key: `${canonicalOf(feature)}|${canonicalize(overrides as unknown as JsonValue)}|${missing.join(',')}`,
    holds,
  };
}

/** A feature that reads another part's build is built every time. */
function reusable(feature: Json): boolean {
  return feature.type !== 'core.derive' && !canonicalOf(feature.inputs).includes('"inContext"');
}

let generation = 0;

/** How an evaluation runs besides its document. */
export interface CachedOptions {
  /** Hears of each feature of a part of the document before it builds, and of the assemblies' placement. */
  progress?: (p: Progress) => void;
  /**
   * Another evaluation on the same shapes the parts may resume from (the
   * committed one, while a preview is kept): each part takes over the
   * longer run of unchanged features of the two.
   */
  alternative?: Recorded;
  /** Builds each part of the document only up to its rollback (`EvaluateOptions.until`). */
  toRollback?: boolean;
}

/** The ordinal of the feature a part row is rolled back to just before; undefined at the end. */
function rollbackOrdinal(row: Json): number | undefined {
  const before = (row.rollback as Json | undefined)?.before as Json | undefined;
  if (!before) return undefined;
  const i = ((row.timeline as Json[] | undefined) ?? []).findIndex((f) => f.id === before.id);
  return i < 0 ? undefined : i;
}

/**
 * Evaluates `doc`, taking over what it can from `previous`; without one, a
 * fresh evaluation on a new adapter.
 */
export function evaluateCached(
  doc: Json,
  kernel: OcctKernel,
  solver: GcsWrapper | undefined,
  previous?: Recorded,
  options: CachedOptions = {},
): Recorded {
  const { progress } = options;
  const values = new RecordingValues(doc);
  const names = RecordingNames.load(doc.names);
  const docNames = NameTable.fromJson(doc.names);
  const assets = new AssetReads(isPlainObject(doc.assets) ? doc.assets : {});
  const diagnostics = readDocument(doc).diagnostics;
  const unread = readerPauses(doc, diagnostics);
  const key = documentKey(doc);
  const from = previous && previous.documentKey === key ? previous : undefined;
  const misses: string[] = [];
  const order: string[] = [];
  if (previous && !from) misses.push('the library, settings or naming rules changed');
  const adapter = from ? from.adapter : new NamingAdapter(kernel);
  const other = options.alternative;
  // Evaluations a part may resume from: the one before and, on the same shapes, the alternative.
  const sources = from
    ? [from, ...(other && other !== from && other.documentKey === key && other.adapter === adapter ? [other] : [])]
    : [];
  const keyOf = new Map<Json, string>();
  const featureKeyOf = (feature: Json) => {
    let k = keyOf.get(feature);
    if (k === undefined) keyOf.set(feature, (k = featureKey(values, docNames, feature).key));
    return k;
  };
  const until = options.toRollback ? (part: string) => rollbackOrdinal(rows.get(part) as Json) : undefined;
  const features = new Map<string, FeatureRecord[]>();
  const partKeys = new Map<string, string>();
  const marks: number[] = [];
  let resumed = 0;
  const rows = new Map(((doc.parts as Json[]) ?? []).map((p) => [p.id as string, p]));
  const total = [...rows.values()].reduce(
    (n, p) => n + (until?.(p.id as string) ?? ((p.timeline as Json[] | undefined) ?? []).length),
    0,
  );
  let done = 0;
  const placements = new Map<string, PlacedRecord>();
  let placedKept = 0;
  const recordsOf = (part: string) => {
    let list = features.get(part);
    if (!list) features.set(part, (list = []));
    return list;
  };

  const ev = evaluateDocument(doc, kernel, {
    ...(solver ? { solver } : {}),
    values,
    names,
    diagnostics,
    assets: assets.table,
    adapter: from ? prefixed(adapter, `resumed${++generation}/`) : adapter,
    // A placing of a build this evaluation shares with the one before is that one's, copies and names.
    ...(until ? { until } : {}),
    placements: {
      get: (k) => {
        const known = sources.map((s) => s.placements.get(k)).find((r) => r !== undefined);
        if (known) {
          placements.set(k, known);
          placedKept++;
        }
        return known;
      },
      set: (k, record) => placements.set(k, record),
    },
    resume: (e, part) => {
      const row = rows.get(part) as Json;
      order.push(part);
      partKeys.set(part, partKey(row));
      if (!from) return undefined;
      const timeline = row.timeline as Json[];
      // A part built only up to its rollback resumes no further than that either.
      const end = Math.min(timeline.length, until?.(part) ?? timeline.length);
      // Of the evaluations to resume from, the one whose unchanged features run longest.
      let source: Recorded | undefined;
      let longest = -1;
      for (const s of sources) {
        const list = s.features.get(part);
        if (!list || s.partKeys.get(part) !== partKeys.get(part)) continue;
        let n = 0;
        while (n < end && list[n]?.reusable && list[n]?.key === featureKeyOf(timeline[n] as Json)) n++;
        if (n > longest) [source, longest] = [s, n];
      }
      const old = source?.features.get(part);
      if (!old) {
        misses.push(
          `part ${part}: ${from.features.get(part) ? 'its selection sets or contexts changed' : 'it is new'}`,
        );
        return undefined;
      }
      const list = recordsOf(part);
      let i = 0;
      for (; i < end; i++) {
        const record = old[i];
        const feature = timeline[i] as Json;
        const miss = !record
          ? 'is new'
          : !record.reusable
            ? 'reads another part, or holds content not understood'
            : unread.has(feature)
              ? 'holds content not understood'
              : record.key !== featureKeyOf(feature)
                ? 'changed'
                : !record.reads.every((r) => values.agrees(r))
                  ? 'reads a value that changed'
                  : !record.assets.every(([hash, print]) => assets.print(hash) === print)
                    ? 'reads an asset that changed'
                    : undefined;
        if (miss !== undefined) {
          misses.push(
            `part ${part}: feature ${i + 1} (${typeof feature.name === 'string' ? feature.name : String(feature.id)}) ${miss}`,
          );
          break;
        }
        const kept = record as FeatureRecord;
        values.apply(kept.effects);
        e.pauses.push(...kept.pauses);
        e.stale.push(...kept.stale);
        names.adopt(kept.names);
        list[i] = kept;
      }
      if (i === 0) return undefined;
      resumed += i;
      done += i;
      return { from: i, part: (old[i - 1] as FeatureRecord).after };
    },
    start: (part, ordinal) => {
      if (progress) {
        const feature = ((rows.get(part)?.timeline as Json[] | undefined) ?? [])[ordinal];
        const name = typeof feature?.name === 'string' ? feature.name : '';
        progress({
          phase: 'building',
          done,
          total,
          kept: resumed,
          part,
          feature: String(feature?.id ?? ''),
          name,
          type: String(feature?.type ?? ''),
        });
      }
      values.begin();
      assets.begin();
      marks.push(names.order.length);
    },
    placing: () => progress?.({ phase: 'placing' }),
    step: (s) => {
      done++;
      const { reads, effects } = values.end();
      const mark = marks.pop() ?? names.order.length;
      const { key: featureAt, holds } = featureKey(values, docNames, s.feature);
      recordsOf(s.part)[s.ordinal] = {
        key: featureAt,
        holds,
        reusable: reusable(s.feature) && !unread.has(s.feature),
        reads,
        assets: assets.end(),
        effects,
        pauses: s.pauses,
        stale: s.stale,
        names: names.order.slice(mark).map((h) => [h, names.get(h) as JsonValue]),
        after: s.after,
      };
    },
  });
  for (const part of rows.keys()) if (!partKeys.has(part)) partKeys.set(part, partKey(rows.get(part) as Json));
  return {
    ev,
    adapter,
    features,
    documentKey: key,
    partKeys,
    carried: from ? from.carried + 1 : 0,
    resumed,
    misses,
    order,
    placements,
    placedKept,
  };
}

/** The name hashes the recorded features hold: a name table that gains or loses one of them changes their keys. */
export function namesHeld(recorded: Recorded): Set<string> {
  const out = new Set<string>();
  for (const list of recorded.features.values())
    for (const record of list) for (const hash of record?.holds ?? []) out.add(hash);
  return out;
}

/**
 * A value evaluator of `doc` holding what the recorded features gave values,
 * as a resumed evaluation of `doc` that took every feature over would hold
 * it; undefined when a value some feature read comes out otherwise in `doc`.
 */
export function valuesFor(recorded: Recorded, doc: Json): RecordingValues | undefined {
  const values = new RecordingValues(doc);
  for (const part of recorded.order) {
    for (const record of recorded.features.get(part) ?? []) {
      if (!record) continue;
      if (!record.reads.every((r) => values.agrees(r))) return undefined;
      values.apply(record.effects);
    }
  }
  return values;
}

/** The part as it stood after each feature, by ordinal, as recorded; holes for features of parts built elsewhere. */
export function stepsOf(recorded: Recorded, part: string): readonly (PartResult | undefined)[] {
  return (recorded.features.get(part) ?? []).map((f) => f?.after);
}

/**
 * Capturing a context (12.4) and telling when one is out of date. A capture
 * stores each instance a part's in-context references point into, in its
 * own part's frame with the names it had there (their `chain` extended by
 * the instance path), and its placement relative to the part's own instance.
 */
import type { OcctKernel } from 'occt-wasm';
import { canonicalize, makeSet, manifestHash, withChain, writeShapeMap, type CopyStep } from '@tweakcad/format';
import type { Json, PartResult } from './context';
import { evaluateDocument, type EvaluateOptions, type Evaluation } from './evaluate';
import { storedShape } from './freeze';
import { quaternionOf } from './builders/frozen';
import { compose, difference, inverse, readRigid, writeRigid, type Rigid } from './rigid';
import type { AssemblyNode, AssemblyResult } from './assembly';

/** Why a context cannot be captured from this build. */
export class CaptureError extends Error {}

/** One way a context differs from the assembly it was captured from. */
export interface OutOfDate {
  part: string;
  context: string;
  reason: string;
}

/** The instance paths a part's `inContext` references into `context` point at, canonical, in first-use order. */
export function referencedInstances(part: Json, context: string): Json[] {
  const found = new Map<string, Json>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Json;
    const ic = o.inContext as Json | undefined;
    if (ic && (ic.context as Json | undefined)?.id === context) {
      const key = canonicalize(ic.instance);
      if (!found.has(key)) found.set(key, ic.instance as Json);
    }
    for (const [k, x] of Object.entries(o)) if (k !== 'contexts') walk(x);
  };
  walk(part.timeline);
  walk(part.sets);
  return [...found.values()];
}

const nodeAt = (asm: AssemblyResult, path: unknown) =>
  asm.nodes.find((n) => canonicalize(n.path) === canonicalize(path));

/** The document with the assembly set to the pose a context asks for. */
function posed(doc: Json, row: Json): Json {
  const position = row.position as Json | undefined;
  if (!position || 'current' in position) return doc;
  const copy = structuredClone(doc);
  const asm = ((copy.assemblies as Json[]) ?? []).find((a) => a.id === (row.assembly as Json).id) as Json | undefined;
  if (!asm) return copy;
  if ('position' in position) asm.activePosition = { position: { id: (position.position as Json).id } };
  else {
    const state = (position.captured as Json).state as Record<string, Json>;
    asm.activePosition = { current: {} };
    for (const joint of (asm.joints as Json[]) ?? [])
      if (state[joint.id as string]) joint.state = state[joint.id as string];
  }
  return copy;
}

/** A construction output, in its own part's frame, as a captured entry's `construction` (12.4). */
function constructionRows(ev: Evaluation, own: Pick<PartResult, 'construction'>, steps: readonly CopyStep[]): Json[] {
  return [...own.construction.values()].map((c) => {
    const { origin, x, normal } = c.frame;
    const geometry =
      c.kind === 'plane'
        ? { plane: { origin, normal, x } }
        : c.kind === 'axis'
          ? { axis: { origin, direction: normal } }
          : c.kind === 'point'
            ? { point: { at: origin } }
            : { frame: { position: origin, rotation: quaternionOf(c.frame) } };
    return { ladder: c.ladder.map((h) => withChain(h, steps, ev.names)), aliases: makeSet([]), geometry };
  });
}

/** One captured entry: an instance's geometry in its own part's frame, and where it stands from the part's own instance. */
function entryOf(ev: Evaluation, at: AssemblyNode, node: AssemblyNode, assets: Json, label: string): Json {
  if (node.variant.kind !== 'part')
    throw new CaptureError('capturing a nested assembly as one instance is not built yet');
  const own = node.variant.result;
  const solids = [...own.state.bodies.keys()];
  if (solids.length === 0) throw new CaptureError('a referenced instance has no bodies');
  const stored = storedShape(ev, own.state, solids, assets, label, { chain: node.steps, names: ev.names });
  const placement: Rigid = compose(inverse(at.placement), node.placement);
  return {
    instance: node.path,
    stored,
    construction: constructionRows(ev, own, node.steps),
    placement: writeRigid(placement),
  };
}

export interface CaptureOptions extends EvaluateOptions {
  capturedAt?: string;
  /** Instance paths to capture besides those the part's references point into: one a reference is about to be written into. */
  include?: readonly Json[];
}

/**
 * Captures context `context` of part `part` from the document's current
 * state (or the position the context asks for), and returns the document
 * with the context rewritten, its stored shapes added to `assets` and every
 * name it uses in `names`.
 */
export function captureContext(
  doc: Json,
  kernel: OcctKernel,
  part: string,
  context: string,
  options: CaptureOptions = {},
): { document: Json; evaluation: Evaluation } {
  const partRow = ((doc.parts as Json[]) ?? []).find((p) => p.id === part);
  const row = ((partRow?.contexts as Json[] | undefined) ?? []).find((c) => c.id === context);
  if (!partRow || !row) throw new CaptureError(`no context ${context} in part ${part}`);
  const ev = evaluateDocument(posed(doc, row), kernel, options);
  const asm = ev.assemblies.get((row.assembly as Json).id as string);
  if (!asm) throw new CaptureError('the context assembly did not build');
  const at = nodeAt(asm, row.at);
  if (!at) throw new CaptureError('the part is not at the context instance path');
  const assets: Json = {};
  const paths = referencedInstances(partRow, context);
  for (const extra of options.include ?? [])
    if (!paths.some((p) => canonicalize(p) === canonicalize(extra))) paths.push(extra);
  const entries = paths.map((path, i) => {
    const node = nodeAt(asm, path);
    if (!node) throw new CaptureError('a referenced instance is not in the assembly');
    if (canonicalize(node.path) === canonicalize(at.path))
      throw new CaptureError('a part does not capture its own instance');
    return entryOf(ev, at, node, assets, `capture:${part}:${context}:${i}`);
  });

  const document = structuredClone(doc);
  const target = ((document.parts as Json[]).find((p) => p.id === part) as Json).contexts as Json[];
  const index = target.findIndex((c) => c.id === context);
  target[index] = {
    ...row,
    captured: makeSet(entries),
    source: manifestHash(doc, (row.assembly as Json).id as string),
    capturedAt: options.capturedAt ?? (row.capturedAt as string),
  };
  document.assets = { ...(document.assets as Json), ...assets };
  document.names = { ...(document.names as Json), ...(ev.names.toJson() as Json) };
  return { document, evaluation: ev };
}

/** The tight tolerance of 9.6: positions 1e-6 × size + 1e-9 mm, directions 1e-9 deg. */
function moved(a: Rigid, b: Rigid, size: number): boolean {
  const d = difference(a, b);
  const shift = Math.hypot(d[0] as number, d[1] as number, d[2] as number);
  const turn = (Math.hypot(d[3] as number, d[4] as number, d[5] as number) * 180) / Math.PI;
  return shift > 1e-6 * size + 1e-9 || turn > 1e-9;
}

/** The shape map a capture of these bodies would write, without writing its BREP. */
function mapOf(
  ev: Evaluation,
  state: PartResult['state'],
  solids: readonly number[],
  steps: readonly CopyStep[],
): Json[] {
  const { kernel: k, adapter } = ev;
  const root = k.makeCompound(solids.map((s) => adapter.handleOf(s)));
  const ref = adapter.addShape(root);
  return JSON.parse(JSON.stringify(writeShapeMap(state, ref, adapter, { chain: steps, names: ev.names }))) as Json[];
}

/** The shape-map topology a capture compares: ladders, aliases, branch and children, never snapshot numbers. */
const topology = (map: Json[]) =>
  canonicalize(map.map((e) => ({ ladder: e.ladder, aliases: e.aliases, branch: e.branch, children: e.children })));

/**
 * The contexts of `doc`'s parts that differ from the assembly as `ev` built
 * it (12.4): a changed manifest, a gone assembly or instance, or a captured
 * instance whose placement or shape-map topology changed. Contexts taken at
 * another position than the current one are checked by manifest only.
 */
export function contextsOutOfDate(ev: Evaluation, doc: Json): OutOfDate[] {
  const out: OutOfDate[] = [];
  for (const partRow of (doc.parts as Json[]) ?? []) {
    for (const row of (partRow.contexts as Json[] | undefined) ?? []) {
      const note = (reason: string) => out.push({ part: partRow.id as string, context: row.id as string, reason });
      const asmId = (row.assembly as Json).id as string;
      if (!((doc.assemblies as Json[]) ?? []).some((a) => a.id === asmId)) {
        note('the assembly is gone');
        continue;
      }
      if (row.source !== manifestHash(doc, asmId)) note('the assembly changed since the capture');
      const position = row.position as Json | undefined;
      if (position && !('current' in position)) continue;
      const asm = ev.assemblies.get(asmId);
      const at = asm && nodeAt(asm, row.at);
      if (!asm || !at) {
        note('the instance the part was captured at is gone');
        continue;
      }
      for (const entry of ((row.captured as Json).set as Json[]) ?? []) {
        const node = nodeAt(asm, entry.instance);
        if (!node) {
          note('a captured instance is gone');
          continue;
        }
        const own = node.variant.result;
        const solids = [...own.state.bodies.keys()];
        const box = solids.length > 0 ? ev.kernel.getBoundingBox(ev.adapter.handleOf(solids[0] as number)) : undefined;
        const size = box ? Math.hypot(box.xmax - box.xmin, box.ymax - box.ymin, box.zmax - box.zmin) : 1;
        if (moved(compose(inverse(at.placement), node.placement), readRigid(entry.placement), size))
          note('a captured instance moved');
        if (node.variant.kind === 'part' && solids.length > 0) {
          const now = mapOf(ev, own.state, solids, node.steps);
          if (topology(now) !== topology((entry.stored as Json).map as Json[])) note('a captured instance changed');
        }
      }
    }
  }
  return out;
}

/** One context to re-capture, and the instances it should hold besides those referenced. */
export interface ContextRequest {
  part: string;
  context: string;
  include?: readonly Json[];
}

export interface ContextUpdate {
  /** The document with every requested context re-captured. */
  document: Json;
  /** False when the passes did not reach a state that re-capturing leaves unchanged. */
  settled: boolean;
  passes: number;
}

/**
 * Re-captures contexts (12.4). One pass captures every requested context
 * from the same document state and then writes them all. With `passes`
 * above one, passes repeat until one leaves every requested context in date
 * with its assembly (the stop rule of automatic updates); when that is not
 * reached within `passes`, the document comes back as it was given, with
 * `settled` false. Each evaluation it makes goes to `done` once it is no
 * longer needed.
 */
export function updateContexts(
  doc: Json,
  kernel: OcctKernel,
  requests: readonly ContextRequest[],
  options: CaptureOptions & { passes?: number; done?: (ev: Evaluation) => void } = {},
): ContextUpdate {
  const passes = Math.max(1, options.passes ?? 1);
  const wanted = new Set(requests.map((r) => `${r.part}|${r.context}`));
  let current = doc;
  for (let pass = 1; pass <= passes; pass++) {
    const next = structuredClone(current);
    for (const r of requests) {
      const { document, evaluation } = captureContext(current, kernel, r.part, r.context, {
        ...options,
        ...(r.include ? { include: r.include } : {}),
      });
      options.done?.(evaluation);
      const row = (((document.parts as Json[]).find((p) => p.id === r.part) as Json).contexts as Json[]).find(
        (c) => c.id === r.context,
      ) as Json;
      const target = ((next.parts as Json[]).find((p) => p.id === r.part) as Json).contexts as Json[];
      target[target.findIndex((c) => c.id === r.context)] = row;
      next.assets = { ...(next.assets as Json), ...(document.assets as Json) };
      next.names = { ...(next.names as Json), ...(document.names as Json) };
    }
    current = next;
    if (passes === 1) return { document: current, settled: true, passes: 1 };
    const ev = evaluateDocument(current, kernel, options);
    const left = ev.outOfDate.filter((o) => wanted.has(`${o.part}|${o.context}`));
    options.done?.(ev);
    if (left.length === 0) return { document: current, settled: true, passes: pass };
  }
  return { document: doc, settled: false, passes };
}

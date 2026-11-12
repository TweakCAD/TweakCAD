/**
 * Turns the kernel's run-length history lists into an `OperationHistory`.
 *
 * Works on positions and keys only, so it runs without the kernel. The kernel
 * names a sub-shape by its input, its kind and its position among that kind of
 * sub-shape of its shape, in the order the adapter's walk enters them, so two
 * sub-shapes are never mixed up, whatever their hashes. The rules follow what
 * occt-wasm actually reports:
 *
 * - the kernel's delete lists are unreliable and never read: an input is
 *   deleted when it is not in the result and has no image of its own kind;
 * - `generated` lists mix faces, edges and other kinds: entries are sorted by
 *   kind and the rest dropped;
 * - a generated face does not save its source from being deleted, the same as
 *   OCCT's own `BRepTools_History`.
 */

import type { OperationHistory, ShapeKey, ShapeRef, SubShapeHistory } from '@tweakcad/format';
import type { EvolutionData } from 'occt-wasm';

export type NamingAdapterErrorCode =
  /** The kernel has no call that gives this data exactly. */
  | 'unsupported'
  /** A key or shape reference this adapter does not hold. */
  | 'unknown'
  /** A kernel list or wire that does not have the expected form. */
  | 'malformed';

export class NamingAdapterError extends Error {
  readonly code: NamingAdapterErrorCode;

  constructor(code: NamingAdapterErrorCode, message: string) {
    super(message);
    this.name = 'NamingAdapterError';
    this.code = code;
  }
}

/** The position lists `OperationHistory` is built from. */
export type HistoryLists = Pick<
  EvolutionData,
  'modifiedIndexed' | 'generatedIndexed' | 'edgeModifiedIndexed' | 'edgeGeneratedIndexed'
>;

/**
 * A sub-shape's key, and `same`, an id every key of that sub-shape shares: a
 * face held both ways round has two keys and one `same`.
 */
export interface HeldKey {
  key: ShapeKey;
  same: number;
}

/** One input's faces and edges, each at its kernel position. */
export interface InputSubShapes {
  faces: readonly HeldKey[];
  edges: readonly HeldKey[];
}

/** The kernel's kind numbers: a sub-shape's kind is its index here. */
export const KERNEL_KINDS = ['compound', 'compsolid', 'solid', 'shell', 'face', 'wire', 'edge', 'vertex'] as const;
const FACE = KERNEL_KINDS.indexOf('face');
const EDGE = KERNEL_KINDS.indexOf('edge');

/** The result's sub-shapes of each kernel kind, each at its kernel position. */
export type ResultSubShapes = readonly (readonly HeldKey[])[];

/** One run: an input sub-shape and the result sub-shapes listed for it, as `[kind, position]`. */
export interface IndexedRun {
  input: number;
  position: number;
  images: [kind: number, position: number][];
}

/**
 * Decode `[input, position, count, kind, position, …]`. A count running past
 * the end means the list is not in this form: an error, since dropping the
 * tail would lose history without a trace.
 */
export function decodeIndexed(encoded: readonly number[]): IndexedRun[] {
  const runs: IndexedRun[] = [];
  let i = 0;
  while (i < encoded.length) {
    const [input, position, count] = [encoded[i], encoded[i + 1], encoded[i + 2]];
    if (input === undefined || position === undefined || count === undefined || i + 3 + 2 * count > encoded.length) {
      throw new NamingAdapterError('malformed', `Indexed history list ends inside the entry at ${i}`);
    }
    const images: [number, number][] = [];
    for (let j = 0; j < count; j++) images.push([encoded[i + 3 + 2 * j] as number, encoded[i + 4 + 2 * j] as number]);
    runs.push({ input, position, images });
    i += 3 + 2 * count;
  }
  return runs;
}

type Kind = 'face' | 'edge';

/** The input sub-shape a run names. */
function inputHeld(run: IndexedRun, kind: Kind, inputs: readonly InputSubShapes[]): HeldKey {
  const held = inputs[run.input]?.[kind === 'face' ? 'faces' : 'edges'][run.position];
  if (!held) throw new NamingAdapterError('malformed', `Input ${run.input} has no ${kind} at ${run.position}`);
  return held;
}

/** The keys of a run's images of one kind. */
function imageKeys(run: IndexedRun, kind: number, result: ResultSubShapes): ShapeKey[] {
  return run.images.flatMap(([k, position]) => {
    const held = result[k]?.[position];
    if (!held) throw new NamingAdapterError('malformed', `The result has no ${KERNEL_KINDS[k] ?? k} at ${position}`);
    return k === kind ? [held.key] : [];
  });
}

function appendUnique(map: Map<ShapeKey, ShapeKey[]>, key: ShapeKey, values: readonly ShapeKey[]): void {
  const list = map.get(key) ?? [];
  for (const value of values) {
    if (!list.includes(value)) list.push(value);
  }
  map.set(key, list);
}

/** What the inputs of one kind became, with images of their own kind only. */
function subShapeHistory(
  inputs: readonly InputSubShapes[],
  result: ResultSubShapes,
  modified: readonly number[],
  kind: Kind,
): { history: Omit<SubShapeHistory, 'added'>; images: Set<ShapeKey> } {
  const kernelKind = kind === 'face' ? FACE : EDGE;
  const held = inputs.flatMap((input) => (kind === 'face' ? input.faces : input.edges));
  const results = result[kernelKind] ?? [];

  const images = new Map<ShapeKey, ShapeKey[]>();
  for (const run of decodeIndexed(modified)) {
    appendUnique(images, inputHeld(run, kind, inputs).key, imageKeys(run, kernelKind, result));
  }

  // The same sub-shape held the other way round has its own key: it is that
  // input's image even though the kernel reports nothing for it.
  const resultBySame = new Map<number, HeldKey[]>();
  for (const r of results) resultBySame.set(r.same, [...(resultBySame.get(r.same) ?? []), r]);
  for (const { key, same } of held) {
    for (const image of resultBySame.get(same) ?? []) {
      if (image.key !== key) appendUnique(images, key, [image.key]);
    }
  }

  const inResult = new Set(results.map((r) => r.key));
  const kept: ShapeKey[] = [];
  const became = new Map<ShapeKey, readonly ShapeKey[]>();
  const deleted: ShapeKey[] = [];
  const seen = new Set<ShapeKey>();
  for (const { key } of held) {
    if (seen.has(key)) continue;
    seen.add(key);
    const others = (images.get(key) ?? []).filter((image) => image !== key);
    if (others.length > 0) became.set(key, inResult.has(key) ? [key, ...others] : others);
    else if (inResult.has(key)) kept.push(key);
    else deleted.push(key);
  }
  return {
    history: { kept, modified: became, deleted },
    images: new Set([...became.values()].flat()),
  };
}

/** Result faces generated from each input, leaving out what the input side kept. */
function generatedFaces(
  encoded: readonly number[],
  inputs: readonly InputSubShapes[],
  kind: Kind,
  kept: ReadonlySet<ShapeKey>,
  result: ResultSubShapes,
): Map<ShapeKey, ShapeKey[]> {
  const generated = new Map<ShapeKey, ShapeKey[]>();
  for (const run of decodeIndexed(encoded)) {
    const source = inputHeld(run, kind, inputs).key;
    const faces = imageKeys(run, FACE, result).filter((face) => !kept.has(face));
    if (faces.length > 0) appendUnique(generated, source, faces);
  }
  return generated;
}

/** Result edges named in a `generated` list: they have history, just no slot. */
function generatedEdges(
  encoded: readonly number[],
  inputs: readonly InputSubShapes[],
  kind: Kind,
  result: ResultSubShapes,
): ShapeKey[] {
  return decodeIndexed(encoded).flatMap((run) => {
    inputHeld(run, kind, inputs);
    return imageKeys(run, EDGE, result);
  });
}

/** One operation's history, in the keys of its inputs and result. */
export function buildOperationHistory(
  lists: HistoryLists,
  inputs: readonly InputSubShapes[],
  result: ResultSubShapes,
  head: { result: ShapeRef; inputs: OperationHistory['inputs'] },
): OperationHistory {
  const faces = subShapeHistory(inputs, result, lists.modifiedIndexed, 'face');
  const edges = subShapeHistory(inputs, result, lists.edgeModifiedIndexed, 'edge');

  const keptFaces = new Set(faces.history.kept);
  const facesFromFace = generatedFaces(lists.generatedIndexed, inputs, 'face', keptFaces, result);
  const facesFromEdge = generatedFaces(lists.edgeGeneratedIndexed, inputs, 'edge', keptFaces, result);

  const facesWithHistory = new Set([
    ...keptFaces,
    ...faces.images,
    ...[...facesFromFace.values()].flat(),
    ...[...facesFromEdge.values()].flat(),
  ]);
  const edgesWithHistory = new Set([
    ...edges.history.kept,
    ...edges.images,
    ...generatedEdges(lists.generatedIndexed, inputs, 'face', result),
    ...generatedEdges(lists.edgeGeneratedIndexed, inputs, 'edge', result),
  ]);

  const keysOf = (kind: number) => (result[kind] ?? []).map((r) => r.key);
  return {
    result: head.result,
    inputs: head.inputs,
    faces: { ...faces.history, added: keysOf(FACE).filter((k) => !facesWithHistory.has(k)) },
    edges: { ...edges.history, added: keysOf(EDGE).filter((k) => !edgesWithHistory.has(k)) },
    facesFromFace,
    facesFromEdge,
  };
}

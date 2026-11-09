/**
 * Turns the kernel's run-length history lists into an `OperationHistory`.
 *
 * Works on hashes and keys only, so it runs without the kernel. The rules
 * follow what occt-wasm actually reports:
 *
 * - the kernel's delete lists are unreliable and never read: an input is
 *   deleted when it is not in the result and has no image of its own kind;
 * - `generated` lists mix faces, edges and hashes that are not in the result:
 *   entries are sorted by kind against the result and the rest dropped;
 * - a generated face does not save its source from being deleted, the same as
 *   OCCT's own `BRepTools_History`;
 * - the lists name sub-shapes by hash alone, so a listed hash that stands for
 *   more than one sub-shape, of the inputs or of the result, has no answer and
 *   is refused. A shared hash nothing lists is no problem.
 */

import type { OperationHistory, ShapeKey, ShapeRef, SubShapeHistory } from '@tweakcad/format';
import type { EvolutionData } from 'occt-wasm';

export type NamingAdapterErrorCode =
  /** A hash the kernel's history lists stands for more than one sub-shape. */
  | 'collision'
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

/** The hash lists `OperationHistory` is built from. */
export type HistoryLists = Pick<EvolutionData, 'modified' | 'generated' | 'edgeModified' | 'edgeGenerated'>;

/**
 * A sub-shape's key, and `same`, an id every key of that sub-shape shares: a
 * face held both ways round has two keys and one `same`.
 */
export interface HeldKey {
  key: ShapeKey;
  same: number;
}

/** Input sub-shapes by hash. Keys with different `same` share a hash only by chance. */
export interface InputIndex {
  faces: ReadonlyMap<number, readonly HeldKey[]>;
  edges: ReadonlyMap<number, readonly HeldKey[]>;
}

/** Result sub-shapes by hash, one key per sub-shape. */
export interface ResultIndex {
  faces: ReadonlyMap<number, readonly HeldKey[]>;
  edges: ReadonlyMap<number, readonly HeldKey[]>;
  /** Hashes of every other kind, so a listed hash can be told apart from these. */
  others: ReadonlySet<number>;
}

/**
 * Decode `[input, count, result_0 … result_count-1, input, count, …]`. A count
 * running past the end means the list is not in this form: an error, since
 * dropping the tail would lose history without a trace.
 */
export function decodeRunLength(encoded: readonly number[]): [number, number[]][] {
  const entries: [number, number[]][] = [];
  let i = 0;
  while (i < encoded.length) {
    const input = encoded[i];
    const count = encoded[i + 1];
    if (input === undefined || count === undefined || i + 2 + count > encoded.length) {
      throw new NamingAdapterError('malformed', `Run-length list ends inside the entry at ${i}`);
    }
    entries.push([input, encoded.slice(i + 2, i + 2 + count)]);
    i += 2 + count;
  }
  return entries;
}

type Kind = 'face' | 'edge';

/** The key of a listed hash in the result, if it is a sub-shape of that kind. */
function resultKey(hash: number, kind: Kind, result: ResultIndex): ShapeKey | undefined {
  const faces = result.faces.get(hash) ?? [];
  const edges = result.edges.get(hash) ?? [];
  if (faces.length + edges.length + (result.others.has(hash) ? 1 : 0) > 1) {
    throw new NamingAdapterError('collision', `Listed hash ${hash} stands for several sub-shapes of the result`);
  }
  return (kind === 'face' ? faces : edges)[0]?.key;
}

/** The keys of the one input sub-shape a listed hash stands for, if any. */
function inputKeys(hash: number, kind: Kind, inputs: ReadonlyMap<number, readonly HeldKey[]>): ShapeKey[] | undefined {
  const held = inputs.get(hash);
  if (!held) return undefined;
  if (new Set(held.map((h) => h.same)).size > 1) {
    throw new NamingAdapterError('collision', `Listed hash ${hash} stands for several input ${kind}s`);
  }
  return held.map((h) => h.key);
}

const keysOf = (held: ReadonlyMap<number, readonly HeldKey[]>): ShapeKey[] =>
  [...held.values()].flat().map((h) => h.key);

function appendUnique(map: Map<ShapeKey, ShapeKey[]>, key: ShapeKey, values: readonly ShapeKey[]): void {
  const list = map.get(key) ?? [];
  for (const value of values) {
    if (!list.includes(value)) list.push(value);
  }
  map.set(key, list);
}

/** What an input of one kind became, with images of its own kind only. */
function subShapeHistory(
  inputs: ReadonlyMap<number, readonly HeldKey[]>,
  results: ReadonlyMap<number, readonly HeldKey[]>,
  modified: readonly number[],
  kind: Kind,
  result: ResultIndex,
): { history: Omit<SubShapeHistory, 'added'>; images: Set<ShapeKey> } {
  const images = new Map<ShapeKey, ShapeKey[]>();
  for (const [hash, listed] of decodeRunLength(modified)) {
    const keys = inputKeys(hash, kind, inputs);
    if (!keys) continue;
    const found = listed.flatMap((h) => resultKey(h, kind, result) ?? []);
    for (const key of keys) appendUnique(images, key, found);
  }

  // The same sub-shape held the other way round has its own key: it is that
  // input's image even though the kernel reports nothing for it.
  for (const [hash, held] of inputs) {
    for (const image of results.get(hash) ?? []) {
      for (const { key, same } of held) {
        if (same === image.same && key !== image.key) appendUnique(images, key, [image.key]);
      }
    }
  }

  const inResult = new Set(keysOf(results));
  const kept: ShapeKey[] = [];
  const became = new Map<ShapeKey, readonly ShapeKey[]>();
  const deleted: ShapeKey[] = [];
  const seen = new Set<ShapeKey>();
  for (const held of inputs.values()) {
    for (const { key } of held) {
      if (seen.has(key)) continue;
      seen.add(key);
      const others = (images.get(key) ?? []).filter((image) => image !== key);
      if (others.length > 0) became.set(key, inResult.has(key) ? [key, ...others] : others);
      else if (inResult.has(key)) kept.push(key);
      else deleted.push(key);
    }
  }
  return {
    history: { kept, modified: became, deleted },
    images: new Set([...became.values()].flat()),
  };
}

/** Result faces generated from each input, leaving out what the input side kept. */
function generatedFaces(
  encoded: readonly number[],
  inputs: ReadonlyMap<number, readonly HeldKey[]>,
  kind: Kind,
  kept: ReadonlySet<ShapeKey>,
  result: ResultIndex,
): Map<ShapeKey, ShapeKey[]> {
  const generated = new Map<ShapeKey, ShapeKey[]>();
  for (const [hash, listed] of decodeRunLength(encoded)) {
    const keys = inputKeys(hash, kind, inputs);
    if (!keys) continue;
    const faces = listed.flatMap((h) => resultKey(h, 'face', result) ?? []).filter((face) => !kept.has(face));
    if (faces.length === 0) continue;
    for (const key of keys) appendUnique(generated, key, faces);
  }
  return generated;
}

/** Result edges named in a `generated` list of a known input: they have history, just no slot. */
function generatedEdges(
  encoded: readonly number[],
  inputs: ReadonlyMap<number, readonly HeldKey[]>,
  kind: Kind,
  result: ResultIndex,
): ShapeKey[] {
  return decodeRunLength(encoded).flatMap(([hash, listed]) =>
    inputKeys(hash, kind, inputs) ? listed.flatMap((h) => resultKey(h, 'edge', result) ?? []) : [],
  );
}

/** One operation's history, in the keys of its inputs and result. */
export function buildOperationHistory(
  lists: HistoryLists,
  input: InputIndex,
  result: ResultIndex,
  head: { result: ShapeRef; inputs: OperationHistory['inputs'] },
): OperationHistory {
  const faces = subShapeHistory(input.faces, result.faces, lists.modified, 'face', result);
  const edges = subShapeHistory(input.edges, result.edges, lists.edgeModified, 'edge', result);

  const keptFaces = new Set(faces.history.kept);
  const facesFromFace = generatedFaces(lists.generated, input.faces, 'face', keptFaces, result);
  const facesFromEdge = generatedFaces(lists.edgeGenerated, input.edges, 'edge', keptFaces, result);

  const facesWithHistory = new Set([
    ...keptFaces,
    ...faces.images,
    ...[...facesFromFace.values()].flat(),
    ...[...facesFromEdge.values()].flat(),
  ]);
  const edgesWithHistory = new Set([
    ...edges.history.kept,
    ...edges.images,
    ...generatedEdges(lists.generated, input.faces, 'face', result),
    ...generatedEdges(lists.edgeGenerated, input.edges, 'edge', result),
  ]);

  return {
    result: head.result,
    inputs: head.inputs,
    faces: { ...faces.history, added: keysOf(result.faces).filter((k) => !facesWithHistory.has(k)) },
    edges: { ...edges.history, added: keysOf(result.edges).filter((k) => !edgesWithHistory.has(k)) },
    facesFromFace,
    facesFromEdge,
  };
}

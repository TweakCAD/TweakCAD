/**
 * Freezing a feature (7.2): its whole effect as last built, written so that a
 * replay gives every body and sub-shape the identity it had. Each body the
 * feature created, modified or removed becomes one effect; a body's stored
 * shape is a root compound holding it, written as BREP without any mesh, with
 * the shape map of the state after the feature (13.2).
 */
import type { OcctKernel } from 'occt-wasm';
import {
  canonicalize,
  contentHash,
  finest,
  makeSet,
  quantityOf,
  writeShapeMap,
  type ExprValue,
  type JsonValue,
  type NamedEntity,
  NamedState,
  type ShapeKey,
  type CaptureChain,
} from '@tweakcad/format';
import { type Json, type PartResult } from './context';
import { evaluateDocument, type Built, type EvaluateOptions, type Evaluation } from './evaluate';
import { bodyHash, quaternionOf } from './builders/frozen';
import { valueObjects } from './builders/measure';

export interface FrozenFeature {
  /** The feature's `frozen` field. */
  frozen: Json;
  /** Asset rows the effects' stored shapes use, for the document's `assets`. */
  assets: Json;
  /** The name table of the build, holding every hash the effects write (9.8). */
  names: Json;
}

/** Why a feature cannot be frozen from this build. */
export class FreezeError extends Error {}

const keyOf = (e: NamedEntity) => ({
  hash: finest(e.ladder),
  branch: e.branch.map((b) => ({ split: { id: b.split }, side: b.side })),
});
const keyText = (e: NamedEntity) => canonicalize(keyOf(e) as unknown as JsonValue);

function bodiesOf(state: NamedState): NamedEntity[] {
  return [...state.bodies.keys()].map((solid) => state.get(solid) as NamedEntity);
}

/** The stored shape of one body: a root compound holding it (13.2). */
function storedBody(ev: Evaluation, state: NamedState, solid: ShapeKey, assets: Json, index: number): Json {
  return storedShape(ev, state, [solid], assets, `freeze:${index}:${solid}`);
}

/**
 * A stored shape (13.2): a root compound holding `solids`, written as BREP
 * without its mesh, its asset added to `assets`, with the shape map of
 * `state`; `capture` extends every name's chain, as a captured context's do.
 */
export function storedShape(
  ev: Evaluation,
  state: NamedState,
  solids: readonly ShapeKey[],
  assets: Json,
  label: string,
  capture?: CaptureChain,
): Json {
  const { kernel: k, adapter } = ev;
  const root = k.makeCompound(solids.map((s) => adapter.handleOf(s)));
  const bare = k.copy(root);
  try {
    const ref = adapter.addShape(root, label);
    const map = writeShapeMap(state, ref, adapter, capture);
    const bytes = new TextEncoder().encode(k.toBREP(bare));
    const hash = contentHash(bytes);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    assets[hash] = {
      mediaType: 'model/x-brep',
      name: `${hash.slice(0, 12)}.brep`,
      size: bytes.length,
      data: { inline: { base64: btoa(binary) } },
    };
    return { asset: hash, representation: { name: 'brep', version: 1 }, map: JSON.parse(JSON.stringify(map)) as Json };
  } finally {
    k.release(bare);
    k.release(root);
  }
}

/** A value's last result as a typed literal (7.2). */
function typedLiteral(ev: Evaluation, id: string, result: ExprValue): Json {
  const target = ev.values.targetOf(id);
  switch (result.kind) {
    case 'scalar':
      if (target?.type === 'integer') return { type: 'integer', value: result.value };
      return {
        type: 'number',
        quantity: target?.quantity ?? quantityOf(result.dim)?.name ?? 'ratio',
        value: result.value,
      };
    case 'vector':
      return {
        type: 'vector',
        quantity: target?.quantity ?? quantityOf(result.dim)?.name ?? 'ratio',
        value: [...result.value],
      };
    case 'boolean':
      return { type: 'boolean', value: result.value };
    case 'text':
      return { type: target?.type === 'choice' || target?.type === 'date' ? target.type : 'text', value: result.value };
    case 'placement':
      return { type: 'placement', value: { position: [...result.position], rotation: [...result.rotation] } };
    case 'library':
      return { type: 'library', value: result.id };
    default:
      throw new FreezeError(`a ${result.kind} value cannot be frozen`);
  }
}

function constructionEntry(part: PartResult, feature: string): Json[] {
  const output = part.construction.get(feature);
  if (!output) return [];
  const { origin, x, normal } = output.frame;
  const geometry =
    output.kind === 'plane'
      ? { plane: { origin, normal, x } }
      : output.kind === 'axis'
        ? { axis: { origin, direction: normal } }
        : output.kind === 'point'
          ? { point: { at: origin } }
          : { frame: { position: origin, rotation: quaternionOf(output.frame) } };
  return [{ ladder: [...output.ladder], aliases: makeSet([]), geometry }];
}

/** An entity key as JSON (7.2). */
const entityKeyJson = (k: { hash: string; branch: readonly { split: string; side: unknown }[] }) => ({
  hash: k.hash,
  branch: k.branch.map((b) => ({ split: { id: b.split }, side: b.side })),
});

/**
 * The feature's outputs other than bodies, values and construction (7.2
 * `outputs`): its cosmetic threads, and the tool it applied with its
 * operation, which a feature pattern copies; a feature pattern does not
 * copy a kept tool, so that is not written.
 */
function outputsOf(ev: Evaluation, after: PartResult, feature: string, assets: Json): Json[] {
  const outputs: Json[] = [];
  for (const t of after.threads.get(feature) ?? []) {
    outputs.push({
      thread: { ...t, faces: makeSet(t.faces.map(entityKeyJson) as unknown as JsonValue[]) } as unknown as Json,
    });
  }
  const tool = after.tools.get(feature);
  if (tool && !tool.keepTools) {
    const state = new NamedState(new Map(tool.names), new Map(), new Set(), new Map());
    const solids = ev.adapter.topology(tool.shape).solids.map((s) => s.solid);
    const stored = storedShape(ev, state, solids, assets, `freeze:tool:${feature}`);
    outputs.push({ tool: { stored, op: tool.op, targets: tool.targets } });
  }
  return outputs;
}

/** The `frozen` field of one feature from a build: create, modify and remove effects, values and construction outputs. */
export function frozenOf(built: Built): FrozenFeature {
  const { ev, before, after, feature } = built;
  const type = feature.type as string;
  if (type === 'core.sketch' || type === 'core.measure' || type.startsWith('core.asm.')) {
    throw new FreezeError(`a ${type} feature cannot be frozen`);
  }
  const assets: Json = {};
  const earlier = new Map(bodiesOf(before.state).map((b) => [keyText(b), b]));
  const later = bodiesOf(after.state);
  const kept = new Set(later.map(keyText));
  const sorted = (list: NamedEntity[]) => [...list].sort((a, b) => (keyText(a) < keyText(b) ? -1 : 1));

  const effects: Json[] = [];
  for (const body of sorted(later)) {
    const entering = earlier.get(keyText(body));
    // A body that is the very sub-shape it was is untouched.
    if (entering?.key === body.key) continue;
    const stored = storedBody(ev, after.state, body.key, assets, effects.length);
    effects.push(
      entering
        ? { modify: { body: keyOf(entering), stored, input: bodyHash({ ev }, entering.key) } }
        : { create: { ladder: [...body.ladder], branch: keyOf(body).branch, stored } },
    );
  }
  for (const body of sorted([...earlier.values()]))
    if (!kept.has(keyText(body))) effects.push({ remove: { body: keyOf(body) } });

  const values: Json = {};
  for (const v of valueObjects(feature.inputs)) {
    if (v.name === undefined) continue;
    const id = v.id as string;
    values[id] = typedLiteral(ev, id, ev.values.value(id));
  }
  const outputs = outputsOf(ev, after, feature.id as string, assets);
  const payload: Json = {
    effects,
    construction: constructionEntry(after, feature.id as string),
    values,
    ...(outputs.length > 0 ? { outputs } : {}),
  };
  return { frozen: { frozen: payload }, assets, names: ev.names.toJson() as Json };
}

/**
 * Freezes feature `id` of `doc`: builds the document, takes the feature's
 * effect from that build and returns the document with the feature frozen,
 * its assets and the names its effects use added.
 */
export function freezeFeature(
  doc: Json,
  kernel: OcctKernel,
  id: string,
  options: Omit<EvaluateOptions, 'observe'> = {},
): { document: Json; evaluation: Evaluation } {
  let frozen: FrozenFeature | undefined;
  const evaluation = evaluateDocument(doc, kernel, {
    ...options,
    observe: (built) => {
      if (built.feature.id === id) frozen = frozenOf(built);
    },
  });
  if (!frozen) {
    const pause = evaluation.pauses.find((p) => p.feature === id);
    throw new FreezeError(pause ? `the feature did not build: ${pause.message}` : 'the feature did not build live');
  }
  const document = structuredClone(doc);
  for (const part of document.parts as Json[]) {
    for (const f of part.timeline as Json[]) if (f.id === id) f.frozen = frozen.frozen;
  }
  Object.assign(document.assets as Json, frozen.assets);
  Object.assign(document.names as Json, frozen.names);
  return { document, evaluation };
}

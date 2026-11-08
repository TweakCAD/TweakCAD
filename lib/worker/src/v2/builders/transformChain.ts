/**
 * `core.transformChain` (appendix A): each step's layout or mirror applied to
 * what the steps before it made, so copies are the steps' product, each named
 * with its place in that product. Features' tools are copied as a pattern's
 * are; each feature's own operation applies.
 */
import {
  startFeature,
  type FeatureNamer,
  type NamedEntity,
  type OperationHistory,
  type ShapeKey,
} from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { FeaturePause, kv, registerBuilder, type BuildContext, type Json, type V3 } from '../context';
import { composed, runMotion, type Motion } from '../copies';
import { applyFeatureCopies, featureTools, mirrorMaps, motionMaps, type FeatureCopy } from '../featureCopies';
import type { Live } from '../operation';
import { planeOf } from './mirror';
import { slotsOf } from './pattern';

type Move = { motion: Motion } | { mirror: { point: V3; normal: V3 } };

/** A step's moves, without the seed. */
function movesOf(ctx: BuildContext, step: Json): Move[] {
  if ('mirror' in step) return [{ mirror: planeOf(ctx, (step.mirror as Json).plane as Json) }];
  if ('scale' in step) throw new FeaturePause('a scale in a transform chain is not built yet');
  return slotsOf(ctx, step).map((s) => ({ motion: s.motion }));
}

/** Every product of the steps' moves, each step's seed included, the all-seed one left out. */
function products(stages: readonly Move[][]): Move[][] {
  let out: Move[][] = [[]];
  for (const moves of stages) out = out.flatMap((done) => [done, ...moves.map((m) => [...done, m])]);
  return out.filter((p) => p.length > 0);
}

function copyOf(
  ctx: BuildContext,
  namer: FeatureNamer,
  tool: Live,
  moves: readonly Move[],
  step: FeatureCopy['step'],
  recorded: ReadonlyMap<ShapeKey, NamedEntity>,
): Pick<FeatureCopy, 'live' | 'point' | 'vector'> {
  const { kernel: k, adapter } = ctx.ev;
  const histories: OperationHistory[] = [];
  let at = tool;
  let point = (p: V3): V3 => p;
  let vector = (v: V3): V3 => v;
  for (const move of moves) {
    const [p, v] = [point, vector];
    if ('mirror' in move) {
      const { point: on, normal } = move.mirror;
      const evolution = k.mirrorWithHistory(at.handle, kv(on), kv(normal), adapter.faceHashes([at.shape]), HASH_BOUND);
      const history = adapter.history(evolution, [{ shape: at.shape, use: 'target' }]);
      histories.push(history);
      at = { shape: history.result, handle: evolution.result };
      const maps = mirrorMaps(move.mirror);
      point = (x) => maps.point(p(x));
      vector = (x) => maps.vector(v(x));
    } else {
      const ran = runMotion(ctx, at, move.motion);
      histories.push(...ran.histories);
      at = ran.moved;
      const maps = motionMaps(move.motion);
      point = (x) => maps.point(p(x));
      vector = (x) => maps.vector(v(x));
    }
  }
  if (histories.length === 0) throw new FeaturePause('a copy lands exactly on its source');
  namer.copy(composed(histories), step, recorded);
  return { live: at, point, vector };
}

registerBuilder('core.transformChain', (ctx) => {
  const { inputs, id, ordinal } = ctx;
  const { adapter, names } = ctx.ev;
  const of = inputs.of as Json;
  if (!('features' in of)) throw new FeaturePause('a transform chain of bodies or faces is not built yet');
  const combos = products((inputs.steps as Json[]).map((row) => movesOf(ctx, row.step as Json)));
  const namer = startFeature(ctx.part.state, { feature: id, ordinal }, adapter, names);
  const from = featureTools(ctx, of, 'chains');
  const copies = from.tools.flatMap((tool) =>
    combos.map((moves, n): FeatureCopy => {
      const step = { op: { id }, key: { slot: { i: n + 1, j: 0 } } };
      return { ...copyOf(ctx, namer, tool, moves, step, tool.names), feature: tool.feature, step };
    }),
  );
  applyFeatureCopies(ctx, namer, copies, from);
});

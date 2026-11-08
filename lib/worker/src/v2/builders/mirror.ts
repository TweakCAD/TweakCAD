/**
 * `core.mirror` (appendix A): one reflected copy of each body, or of each
 * feature's tool, about a default plane, a construction plane or a planar
 * face, named as its source with the `mirror` step (9.5).
 */
import { startFeature } from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  FeaturePause,
  kv,
  registerBuilder,
  type BuildContext,
  type Json,
  type RecordedTool,
  type V3,
} from '../context';
import { entitiesOf } from '../references';
import { STANDARD, constructionOf } from '../places';
import { applyToCopies, sourcesOf } from '../copies';
import { applyFeatureCopies, featureTools, mirrorMaps } from '../featureCopies';
import type { Live } from '../operation';

export function planeOf(ctx: BuildContext, ref: Json): { point: V3; normal: V3 } {
  const { part, ev } = ctx;
  if ('standard' in ref) {
    const frame = STANDARD[(ref.standard as Json).name as string];
    if (!frame) throw new FeaturePause('the mirror plane is not a plane');
    return { point: frame.origin, normal: frame.normal };
  }
  const output = constructionOf({ ev, part }, ref);
  if (output) {
    if (output.kind !== 'plane') throw new FeaturePause(`a construction ${output.kind} is not a mirror plane`);
    return { point: output.frame.origin, normal: output.frame.normal };
  }
  const found = entitiesOf({ ev, part }, ref, 'the mirror plane');
  const [face] = found;
  if (found.length !== 1 || face?.kind !== 'face') throw new FeaturePause('the mirror plane is not a planar face');
  const { surface } = ev.adapter.faceGeometry(face.key);
  if (surface.kind !== 'plane') throw new FeaturePause('the mirror plane is not a planar face');
  return { point: surface.point as V3, normal: surface.normal as V3 };
}

registerBuilder('core.mirror', (ctx) => {
  const { inputs, id, ordinal } = ctx;
  const { kernel: k, adapter, names } = ctx.ev;
  const plane = planeOf(ctx, inputs.plane as Json);

  const namer = startFeature(ctx.part.state, { feature: id, ordinal }, adapter, names);

  const step = { op: { id }, key: { mirror: {} } };
  const mirrored = (source: Live, recorded?: RecordedTool['names']): Live => {
    const evolution = k.mirrorWithHistory(
      source.handle,
      kv(plane.point),
      kv(plane.normal),
      adapter.faceHashes([source.shape]),
      HASH_BOUND,
    );
    const history = adapter.history(evolution, [{ shape: source.shape, use: 'target' }]);
    namer.copy(history, step, recorded);
    return { shape: history.result, handle: evolution.result };
  };
  const of = inputs.of as Json;
  if ('features' in of) {
    // Each feature's own operation applies; the mirror's `operation` is not used.
    const from = featureTools(ctx, of, 'mirrors');
    const maps = mirrorMaps(plane);
    applyFeatureCopies(
      ctx,
      namer,
      from.tools.map((tool) => ({ live: mirrored(tool, tool.names), feature: tool.feature, step, ...maps })),
      from,
    );
    return;
  }
  const copies = sourcesOf(ctx, namer, of, 'mirrors').map((source) => mirrored(source));
  applyToCopies(ctx, namer, copies, inputs.operation as Json);
});

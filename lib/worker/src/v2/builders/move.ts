/**
 * `core.move` (appendix A): a rigid placement of whole bodies. Moving only
 * carries names; with `copy` the source stays and the moved copy is slot 1
 * (9.5).
 */
import { startFeature, type BodyOutcome } from '@tweakcad/format';
import { FLAG, FeaturePause, PLACEMENT, norm, registerBuilder, scale, type Json, type V3 } from '../context';
import { copyByMotion, runMotion, sourcesOf, type Motion } from '../copies';
import type { Live } from '../operation';

/** The placement `p → R·p + T` as a turn about the origin, then a translation. */
function motionOf(placement: { position: V3; rotation: number[] }): Motion {
  const [x, y, z, w] = placement.rotation as [number, number, number, number];
  const axis: V3 = [x, y, z];
  const sine = norm(axis);
  const motion: Motion = { shift: placement.position };
  if (sine > 0) motion.turn = { point: [0, 0, 0], direction: scale(axis, 1 / sine), radians: 2 * Math.atan2(sine, w) };
  return motion;
}

registerBuilder('core.move', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { adapter, names, values } = ctx.ev;
  const transform = inputs.transform as Json;
  if ('align' in transform) throw new FeaturePause('aligning one reference to another is not built yet');
  const motion = motionOf(values.literal(transform, PLACEMENT) as { position: V3; rotation: number[] });

  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);

  const sources = sourcesOf(ctx, namer, inputs.of as Json, 'moves');
  if (values.literal(inputs.copy, FLAG) === true) {
    const copies = sources.map((source) =>
      copyByMotion(ctx, namer, source, motion, { op: { id }, key: { slot: { i: 1, j: 0 } } }),
    );
    part.state = namer.finish([]);
    for (const copy of copies) part.shapes.set(copy.shape, copy.handle);
    return;
  }
  const outcomes: BodyOutcome[] = [];
  const replaced: { source: Live; moved: Live }[] = [];
  for (const source of sources) {
    const { histories, moved } = runMotion(ctx, source, motion);
    if (histories.length === 0) continue;
    for (const history of histories) namer.step(history, { outputs: [], dividers: [] });
    replaced.push({ source, moved });
    for (const solid of adapter.topology(moved.shape).solids)
      outcomes.push({ solid: solid.solid, from: { carry: [source.shape] } });
  }
  part.state = namer.finish(outcomes);
  for (const { source, moved } of replaced) {
    part.shapes.delete(source.shape);
    part.shapes.set(moved.shape, moved.handle);
  }
});

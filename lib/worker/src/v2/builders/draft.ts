/**
 * `core.draft` (appendix A): faces tilted by an angle about where they meet
 * the neutral plane, away from the pull direction. Each face keeps its name.
 */
import { OcctError, type EvolutionData } from 'occt-wasm';
import { startFeature, type BodyOutcome, type NamedEntity, type ShapeKey, type ShapeRef } from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { ANGLE, FeaturePause, kv, registerBuilder, type Json } from '../context';
import { directionOf } from '../places';
import { entitiesOf } from '../references';
import { planeOf } from './mirror';

registerBuilder('core.draft', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { kernel: k, adapter, values, names } = ctx.ev;
  const radians = (values.number(inputs.angle, ANGLE) * Math.PI) / 180;
  const pull = directionOf(ctx, inputs.pull as Json);
  const plane = planeOf(ctx, inputs.neutral as Json);
  const faces: NamedEntity[] = ((inputs.faces as Json).set as Json[]).flatMap((ref) =>
    entitiesOf(ctx, ref, 'a drafted face'),
  );
  if (faces.some((f) => f.kind !== 'face')) throw new FeaturePause('a drafted entity is not a face');

  const owners = new Map<ShapeRef, ShapeKey[]>();
  for (const face of faces) {
    const owner = [...part.shapes.keys()].find((s) => adapter.topology(s).faces.includes(face.key));
    if (owner === undefined) throw new FeaturePause('a drafted face is not on a live body');
    owners.set(owner, [...(owners.get(owner) ?? []), face.key]);
  }

  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const outcomes: BodyOutcome[] = [];
  for (const [shape, keys] of owners) {
    const handle = part.shapes.get(shape);
    if (handle === undefined) throw new FeaturePause('a drafted body is not live');
    let evolution: EvolutionData;
    try {
      evolution = k.draftWithHistory(
        handle,
        keys.map((f) => adapter.handleOf(f)),
        radians,
        kv(pull),
        adapter.faceHashes([shape]),
        HASH_BOUND,
        { origin: kv(plane.point), normal: kv(plane.normal) },
      );
    } catch (e) {
      if (e instanceof OcctError) throw new FeaturePause(`the kernel could not draft these faces: ${e.message}`);
      throw e;
    }
    if (!k.isValid(evolution.result)) throw new FeaturePause('the draft makes an invalid solid');
    const history = adapter.history(evolution, [{ shape, use: 'target' }]);
    namer.step(history, { outputs: [], dividers: [] });
    part.shapes.delete(shape);
    part.shapes.set(history.result, evolution.result);
    for (const solid of adapter.topology(history.result).solids)
      outcomes.push({ solid: solid.solid, from: { carry: [shape] } });
  }
  part.state = namer.finish(outcomes);
});

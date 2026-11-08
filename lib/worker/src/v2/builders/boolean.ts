/**
 * `core.boolean` and `core.removeBody` (appendix A): live bodies of the part
 * combined or taken out. A boolean adds no roles: faces keep their names, tool
 * faces inside the target included (9.4). With `keepTools` each tool stays,
 * names and all, and the boolean uses up a copy of it made in place, whose
 * names carry the step `{op: this feature, key: {tool: {}}}` (9.5), so the
 * faces it leaves in the target never share a name with the kept tool's.
 */
import { startFeature } from '@tweakcad/format';
import { FLAG, FeaturePause, TEXT, registerBuilder, type Json } from '../context';
import { copyInPlace, keptToolStep, liveBodies, namedBoolean, namedJoin } from '../operation';

registerBuilder('core.boolean', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { adapter, values, names } = ctx.ev;
  const op = values.literal(inputs.op, TEXT) as 'join' | 'cut' | 'intersect';
  const keep = values.literal(inputs.keepTools, FLAG) === true;

  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const refs = [inputs.target as Json, ...((inputs.tools as Json).set as Json[])];
  const bodies = liveBodies(ctx, namer, refs);
  if (bodies.length !== refs.length) throw new FeaturePause('a body is both the target and a tool');
  const [target, ...kept] = bodies;
  if (!target) throw new FeaturePause('the boolean has no target');
  const tools = keep ? kept.map((tool) => copyInPlace(ctx, namer, tool, keptToolStep(id))) : kept;

  let result = target;
  if (op === 'join') {
    if (tools.length > 0) result = namedJoin(ctx, namer, target, tools);
  } else {
    for (const tool of tools) result = namedBoolean(ctx, namer, op, result, tool, 'tool').live;
  }

  const { solids } = adapter.topology(result.shape);
  if (op === 'join' && solids.length !== 1) throw new FeaturePause('the joined bodies do not touch');
  part.state = namer.finish(solids.map((s) => ({ solid: s.solid, from: { carry: [target.shape] } })));
  for (const body of keep ? [target] : bodies) part.shapes.delete(body.shape);
  if (solids.length > 0) part.shapes.set(result.shape, result.handle);
});

registerBuilder('core.removeBody', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const namer = startFeature(part.state, { feature: id, ordinal }, ctx.ev.adapter, ctx.ev.names);
  for (const body of liveBodies(ctx, namer, (inputs.bodies as Json).set as Json[])) {
    namer.retire(body.shape);
    part.shapes.delete(body.shape);
  }
  part.state = namer.finish([]);
});

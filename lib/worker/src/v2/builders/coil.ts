/**
 * `core.coil` (appendix A): a section swept along a helix about the axis. The
 * helix passes through the section's centre, so the section sets its radius
 * and where it starts; `diameter`, when given, must agree. The body is named
 * as a new tool: walls by section, as made.
 */
import { OcctError, SweepMode, type ShapeHandle } from 'occt-wasm';
import { startFeature, type OperationHistory, type ShapeRef } from '@tweakcad/format';
import {
  FeaturePause,
  LENGTH,
  TEXT,
  add,
  cross,
  dot,
  kv,
  norm,
  registerBuilder,
  scale,
  sub,
  type BuildContext,
  type Json,
  type V3,
} from '../context';
import { applyOperation, type Tool } from '../operation';
import { axisOf } from '../places';
import { buildProfiles } from '../profiles';

/** A new shape's history: every face and edge is added. */
function madeHistory(ctx: BuildContext, shape: ShapeRef): OperationHistory {
  const t = ctx.ev.adapter.topology(shape);
  const none = { kept: [], modified: new Map(), deleted: [] };
  return {
    result: shape,
    inputs: [],
    faces: { ...none, added: t.faces },
    edges: { ...none, added: t.edges.map((e) => e.edge) },
    facesFromFace: new Map(),
    facesFromEdge: new Map(),
  };
}

registerBuilder('core.coil', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { kernel: k, adapter, values, names } = ctx.ev;
  const axis = axisOf(ctx, inputs.axis as Json);
  const pitch = values.number(((inputs.advance as Json).pitch as Json).p, LENGTH);
  const height = values.number(inputs.height, LENGTH);
  if (!(pitch > 0) || !(height > 0)) throw new FeaturePause('a coil has a pitch and a height of more than 0');
  const left = inputs.handedness !== undefined && values.literal(inputs.handedness, TEXT) === 'left';

  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const tools: Tool[] = buildProfiles(ctx, (inputs.section as Json).profiles as Json).map((profile, n) => {
    const box = k.getBoundingBox(profile.face);
    const centre: V3 = [(box.xmin + box.xmax) / 2, (box.ymin + box.ymax) / 2, (box.zmin + box.zmax) / 2];
    const along = dot(sub(centre, axis.point), axis.direction);
    const foot = add(axis.point, scale(axis.direction, along));
    const radial = sub(centre, foot);
    const radius = norm(radial);
    if (!(radius > 0)) throw new FeaturePause('a coil section lies on its axis');
    const made: ShapeHandle[] = [];
    try {
      const wire = k.makeHelixWireHanded(kv(foot), kv(axis.direction), pitch, height, radius, left);
      made.push(wire);
      // The helix starts where the kernel puts it; turn it to the section.
      const first = k.getSubShapes(wire, 'edge')[0] as ShapeHandle;
      const { first: t0 } = k.curveParameters(first);
      const at = k.curvePointAtParam(first, t0);
      const start = sub([at.x, at.y, at.z], foot);
      const turn = Math.atan2(dot(cross(start, radial), axis.direction), dot(start, radial));
      const spine = k.rotate(wire, { point: kv(foot), direction: kv(axis.direction) }, turn);
      made.push(spine);
      const tool = k.sweepFull(k.outerWire(profile.face), spine, { mode: SweepMode.Frenet });
      if (!k.isValid(tool) || k.getVolume(tool) <= 0) throw new FeaturePause('the coil makes no solid');
      const ref = adapter.addShape(tool, `coil:${id}:${n}`);
      const history = madeHistory(ctx, ref);
      namer.step(history, {
        outputs: adapter
          .topology(ref)
          .faces.map((entity) => ({ entity, role: 'side', src: [{ id: profile.regionId }] })),
        dividers: [],
      });
      return { shape: ref, handle: tool, src: [{ id: profile.regionId }] };
    } catch (e) {
      if (e instanceof OcctError) throw new FeaturePause(`the kernel could not sweep the coil: ${e.message}`);
      throw e;
    }
  });
  applyOperation(ctx, namer, tools, inputs.operation as Json);
});

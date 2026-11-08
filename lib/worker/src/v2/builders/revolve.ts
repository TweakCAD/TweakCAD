/**
 * `core.revolve` (appendix A): each profile region, or its thin band, turned
 * about the axis into a tool body, its walls named after the sketch curve each
 * came from, then the operation. A full revolve has no caps.
 */
import { OcctError, type EvolutionData, type ShapeHandle } from 'occt-wasm';
import { startFeature, type ShapeKey, type SrcFact } from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import {
  ANGLE,
  FeaturePause,
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
import { axisOf, type Line } from '../places';
import { applyOperation, type Tool } from '../operation';
import { buildProfiles, segmentOf, sketchTolerance, type Profile } from '../profiles';
import { sweptFaces, thinOf, wallOf } from '../thin';

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** How far the sides turn, in degrees: `forward` by the right hand about the axis, `back` against it. */
function turnOf(ctx: BuildContext, sides: Json[]): { back: number; forward: number } {
  const { values } = ctx.ev;
  const first = sides[0] as Json;
  if ('full' in first) {
    if (sides.length !== 1) throw new FeaturePause('a full revolve is the only side');
    return { back: 0, forward: 360 };
  }
  let back = 0;
  let forward: number;
  if ('symmetric' in first) {
    if (sides.length !== 1) throw new FeaturePause('a symmetric angle is the only side');
    const s = first.symmetric as Json;
    const a = values.number(s.a, ANGLE);
    forward = values.literal(s.measure, TEXT) === 'half' ? a : a / 2;
    back = forward;
  } else {
    const one = (side: Json) => {
      if (!('angle' in side)) throw new FeaturePause('a symmetric or full extent is the only side');
      return values.number((side.angle as Json).a, ANGLE);
    };
    forward = one(first);
    if (sides[1]) back = one(sides[1]);
  }
  if (back < 0 || forward < 0) throw new FeaturePause('a revolve side turns by a negative angle');
  if (back + forward <= 0) throw new FeaturePause('the revolve turns by no angle');
  // The kernel closes a whole turn and wraps anything past it.
  if (back + forward >= 360 - 1e-9) throw new FeaturePause('a partial revolve turns by less than a full turn');
  return { back, forward };
}

/** Pauses unless the axis lies in the profile's plane, with the whole profile on one side of it or on it. */
function checkAxis(profile: Profile, axis: Line): void {
  const { frame } = profile.sketch;
  const tolerance = sketchTolerance(profile.sketch);
  const rel = sub(axis.point, frame.origin);
  if (Math.abs(dot(axis.direction, frame.normal)) > 1e-9 || Math.abs(dot(rel, frame.normal)) > tolerance) {
    throw new FeaturePause('only an axis in the plane of the profile is built yet');
  }
  const across = cross(axis.direction, frame.normal);
  const along = [dot(across, frame.x), dot(across, frame.y)] as const;
  const offset = dot(rel, across);
  const spans = profile.edges.map((e) => e.span(along));
  const low = Math.min(...spans.map((s) => s[0])) - offset;
  const high = Math.max(...spans.map((s) => s[1])) - offset;
  if (low < -tolerance && high > tolerance) throw new FeaturePause('the axis crosses the profile');
}

/** Pauses when the axis divides a thin band, which an offset can push across it. */
function checkBand(ctx: BuildContext, face: ShapeHandle, axis: Line, reach: number): void {
  const k = ctx.ev.kernel;
  const line = k.makeLineEdge(
    kv(add(axis.point, scale(axis.direction, -reach))),
    kv(add(axis.point, scale(axis.direction, reach))),
  );
  if (k.getSubShapes(k.split(face, [line]), 'face').length > 1)
    throw new FeaturePause('the axis crosses the thin wall');
}

/** `p` turned about `axis` by `angle` radians, by the right hand. */
function turned(p: V3, axis: Line, angle: number): V3 {
  const r = sub(p, axis.point);
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const along = scale(axis.direction, dot(axis.direction, r) * (1 - c));
  return add(axis.point, add(add(scale(r, c), scale(cross(axis.direction, r), s)), along));
}

registerBuilder('core.revolve', (ctx) => {
  const { inputs, id, ordinal } = ctx;
  const { kernel: k, adapter, names } = ctx.ev;
  const { back, forward } = turnOf(ctx, inputs.sides as Json[]);
  const thin = thinOf(ctx, inputs.thin as Json);
  const axis = axisOf(ctx, inputs.axis as Json);
  const line = { point: kv(axis.point), direction: kv(axis.direction) };

  const namer = startFeature(ctx.part.state, { feature: id, ordinal }, adapter, names);
  const tools: Tool[] = [];
  buildProfiles(ctx, inputs.profiles as Json).forEach((profile, n) => {
    checkAxis(profile, axis);
    sweptFaces(ctx, profile, thin).forEach((swept, m) => {
      if (thin) {
        const b = k.getBoundingBox(swept.face);
        const size =
          Math.hypot(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin) +
          norm(sub([b.xmin, b.ymin, b.zmin], axis.point));
        checkBand(ctx, swept.face, axis, 2 * size + 1);
      }
      const tag = thin ? `${id}:${n}:${m}` : `${id}:${n}`;
      // A profile reaching back is turned back first, so one sweep covers both sides.
      const face = back > 0 ? k.rotate(swept.face, line, -radians(back)) : swept.face;
      const profileRef = adapter.addShape(face, `profile:${tag}`);
      let evolution: EvolutionData;
      try {
        evolution = k.revolveWithHistory(
          face,
          line,
          radians(back + forward),
          adapter.faceHashes([profileRef]),
          HASH_BOUND,
        );
      } catch (e) {
        if (e instanceof OcctError) throw new FeaturePause(`the kernel could not revolve the profile: ${e.message}`);
        throw e;
      }

      const history = adapter.sweepHistory(evolution, profileRef, `tool:${tag}`);

      const outputs: { entity: ShapeKey; role: string; src: SrcFact[] }[] = [];
      for (const [edge, walls] of history.facesFromEdge) {
        const point = adapter.samplePoint(edge);
        if (!point) throw new FeaturePause('a profile edge has no sample point');
        // A turned profile's edges lie `back` behind the sketch plane; look on the sketch plane.
        const { role, root } = wallOf(ctx, profile, swept, turned(point as V3, axis, radians(back)));
        for (const wall of walls)
          outputs.push({ entity: wall, role, src: [...segmentOf(profile, root), { id: profile.regionId }] });
      }
      const start = history.caps?.first ?? [];
      for (const f of start) outputs.push({ entity: f, role: 'start', src: [{ id: profile.regionId }] });
      for (const f of history.caps?.last ?? [])
        outputs.push({ entity: f, role: 'end', src: [{ id: profile.regionId }] });
      namer.step(history, { outputs, dividers: [] });
      tools.push({ shape: history.result, handle: evolution.result, src: [{ id: profile.regionId }] });
    });
  });
  applyOperation(ctx, namer, tools, inputs.operation as Json);
});

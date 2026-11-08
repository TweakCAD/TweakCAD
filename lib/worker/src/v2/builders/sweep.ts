/**
 * `core.sweep` (appendix A): a section run along a path into a tool body,
 * each wall named after its section segment and the path segment it runs
 * along, then the operation. Corners of the path are mitred. The holes of a
 * section are swept too and cut out of it, so they follow the same mitres.
 */
import {
  OcctError,
  SweepLaw,
  SweepMode,
  TransitionMode,
  type EvolutionData,
  type ShapeHandle,
  type SweepFullOptions,
} from 'occt-wasm';
import { startFeature, type FeatureNamer, type ShapeKey, type SrcFact } from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { ANGLE, FeaturePause, LENGTH, RATIO, kv, registerBuilder, type BuildContext, type Json } from '../context';
import { applyOperation, namedBoolean, type Live, type Tool } from '../operation';
import { pathEdgeAt, pathOf, type Path } from '../paths';
import { buildProfiles, edgeRoot, segmentOf } from '../profiles';

/** Below this volume (mm³) a sweep made no solid: its section lies along the path. */
const NO_VOLUME = 1e-9;

interface Job {
  ctx: BuildContext;
  namer: FeatureNamer;
  section: string;
  path: Path;
  pathRef: string;
  options: SweepFullOptions;
}

/** What a wire's walls are named after, by the edge each swept from, and what its caps are. */
interface WireNames {
  segment: (edge: ShapeKey) => readonly SrcFact[];
  cap: readonly SrcFact[];
}

/** The kernel options an `orientation` and a `scale` ask for. */
function optionsOf(ctx: BuildContext, path: Path): SweepFullOptions {
  const { kernel: k, values } = ctx.ev;
  const { inputs } = ctx;
  if (inputs.twist !== undefined && values.number(inputs.twist, ANGLE) !== 0)
    throw new FeaturePause('a twisting sweep is not built yet');
  const orientation = inputs.orientation as Json;
  const options: SweepFullOptions = { transitionMode: TransitionMode.RightCorner };
  if ('fixed' in orientation) options.mode = SweepMode.Parallel;
  else if ('guide' in orientation) {
    options.mode = SweepMode.Auxiliary;
    options.auxSpine = pathOf(ctx, (orientation.guide as Json).chain as Json[]).wire;
  } else options.mode = SweepMode.Fixed;
  const scale = inputs.scale === undefined ? 1 : values.number(inputs.scale, RATIO);
  if (!(scale > 0)) throw new FeaturePause('a sweep scales to more than 0');
  if (scale !== 1) {
    options.law = SweepLaw.Linear;
    options.lawLength = k.getLength(path.wire);
    options.lawEndFactor = scale;
  }
  return options;
}

/** One closed wire run along the path, its faces named as a step. */
function sweepWire(job: Job, wire: ShapeHandle, tag: string, names: WireNames): Live {
  const { ctx, namer, section, path, pathRef, options } = job;
  const { kernel: k, adapter } = ctx.ev;
  const wireRef = adapter.addShape(wire, `section:${tag}`);
  let evolution: EvolutionData;
  try {
    evolution = k.sweepWithHistory(wire, path.wire, [], HASH_BOUND, options);
  } catch (e) {
    if (e instanceof OcctError) throw new FeaturePause(`the kernel could not sweep the section: ${e.message}`);
    throw e;
  }
  if (
    k.getShapeType(evolution.result) !== 'solid' ||
    !k.isValid(evolution.result) ||
    k.getVolume(evolution.result) <= NO_VOLUME
  ) {
    throw new FeaturePause('the sweep makes no solid: the section lies along the path, or runs into itself');
  }
  const history = adapter.sweepHistory(evolution, wireRef, `tool:${tag}`, pathRef);
  const along = new Map<ShapeKey, ShapeKey>(
    (history.spine ?? []).flatMap((p) => p.faces.map((f) => [f, p.path] as const)),
  );
  const pathSrc = (face: ShapeKey): readonly SrcFact[] => {
    const edge = along.get(face);
    const point = edge === undefined ? null : adapter.samplePoint(edge);
    return (point && pathEdgeAt(ctx, path, point)?.src) ?? [];
  };
  const outputs: { entity: ShapeKey; role: string; src: SrcFact[] }[] = [];
  for (const [edge, walls] of history.facesFromEdge) {
    for (const wall of walls)
      outputs.push({ entity: wall, role: 'side', src: [{ id: section }, ...names.segment(edge), ...pathSrc(wall)] });
  }
  for (const f of history.caps?.first ?? [])
    outputs.push({ entity: f, role: 'start', src: [{ id: section }, ...names.cap] });
  for (const f of history.caps?.last ?? [])
    outputs.push({ entity: f, role: 'end', src: [{ id: section }, ...names.cap] });
  namer.step(history, { outputs, dividers: [] });
  return { shape: history.result, handle: evolution.result };
}

/** The outer wire run along the path, with each inner wire's sweep cut out of it. */
function holed(job: Job, outer: ShapeHandle, inner: readonly ShapeHandle[], tag: string, names: WireNames): Live {
  return inner.reduce(
    (tool, wire, i) => {
      const hole = sweepWire(job, wire, `${tag}:hole${i}`, names);
      return namedBoolean(job.ctx, job.namer, 'cut', tool, hole, 'tool').live;
    },
    sweepWire(job, outer, tag, names),
  );
}

/** The tools of a section of sketch profiles: one for each region. */
function profileTools(job: Job, profiles: Json): Tool[] {
  const { ctx } = job;
  const { kernel: k, adapter } = ctx.ev;
  return buildProfiles(ctx, profiles).map((profile, n) => {
    const outer = k.outerWire(profile.face);
    const inner = k.getSubShapes(profile.face, 'wire').filter((w) => !k.isSame(w, outer));
    const segment = (edge: ShapeKey) => {
      const point = adapter.samplePoint(edge);
      if (!point) throw new FeaturePause('a section edge has no sample point');
      return segmentOf(profile, edgeRoot(profile, point));
    };
    const live = holed(job, outer, inner, `${ctx.id}:${n}`, { segment, cap: [{ id: profile.regionId }] });
    return { ...live, src: [{ id: profile.regionId }] };
  });
}

/** The tool of a circle standing across the path at its start. */
function circleTool(job: Job, circle: Json): Tool {
  const { ctx, path, section } = job;
  const { kernel: k, values } = ctx.ev;
  const diameter = values.number(circle.diameter, LENGTH);
  const hollow = values.number(circle.hollow, LENGTH);
  if (!(diameter > 0)) throw new FeaturePause('a section circle has a diameter of more than 0');
  if (hollow < 0 || 2 * hollow >= diameter)
    throw new FeaturePause('the wall of a hollow circle is less than its radius');
  const wire = (d: number) => k.makeWire([k.makeCircleEdge(kv(path.start.point), kv(path.start.direction), d / 2)]);
  const inner = hollow > 0 ? [wire(diameter - 2 * hollow)] : [];
  const live = holed(job, wire(diameter), inner, ctx.id, { segment: () => [], cap: [] });
  return { ...live, src: [{ id: section }] };
}

registerBuilder('core.sweep', (ctx) => {
  const { inputs, id, ordinal } = ctx;
  const { adapter, names } = ctx.ev;
  const rows = inputs.sections as Json[];
  if (rows.length !== 1) throw new FeaturePause('a sweep through several sections is not built yet');
  const row = rows[0] as Json;
  const path = pathOf(ctx, inputs.path as Json[]);
  const options = optionsOf(ctx, path);
  const namer = startFeature(ctx.part.state, { feature: id, ordinal }, adapter, names);
  const job: Job = {
    ctx,
    namer,
    section: row.id as string,
    path,
    pathRef: adapter.addShape(path.wire, `path:${id}`),
    options,
  };
  const section = row.section as Json;
  const tools =
    'profiles' in section ? profileTools(job, section.profiles as Json) : [circleTool(job, section.circle as Json)];
  applyOperation(ctx, namer, tools, inputs.operation as Json);
});

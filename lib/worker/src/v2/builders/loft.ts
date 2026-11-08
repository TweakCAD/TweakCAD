/**
 * `core.loft` (appendix A): a solid through ordered sections, its walls named
 * after the segments of the sections each spans, then the operation. A section
 * is a closed loop; the holes of a region are not lofted. A point may start or
 * end the loft. A closed loft runs on from its last section back to its first
 * and has no caps.
 */
import { OcctError, type EvolutionData, type ShapeHandle } from 'occt-wasm';
import { startFeature, type ShapeKey, type SrcFact } from '@tweakcad/format';
import { HASH_BOUND } from '@tweakcad/kernel/src/namingAdapter.ts';
import { FLAG, FeaturePause, TEXT, registerBuilder, type BuildContext, type Json } from '../context';
import { applyOperation, type Tool } from '../operation';
import { pointOf } from '../places';
import { buildProfiles, edgeRoot, segmentOf } from '../profiles';
import { entitiesOf } from '../references';

/** Below this volume (mm³) a loft made no solid. */
const NO_VOLUME = 1e-9;

/** One row of `sections`, as the kernel takes it. */
interface Section {
  id: string;
  /** Null for a point. */
  wire: { ref: string; handle: ShapeHandle } | null;
  vertex?: ShapeHandle;
  /** The `src` items of what an edge of the wire stands for. */
  segment: (edge: ShapeKey) => readonly SrcFact[];
  /** The `src` items of the region or face, for its cap and the body. */
  source: readonly SrcFact[];
}

function profileSection(ctx: BuildContext, id: string, profiles: Json): Section {
  const { kernel: k, adapter } = ctx.ev;
  const found = buildProfiles(ctx, profiles);
  if (found.length !== 1) throw new FeaturePause('a loft section is one region');
  const profile = found[0] as (typeof found)[number];
  const handle = k.outerWire(profile.face);
  return {
    id,
    wire: { ref: adapter.addShape(handle, `section:${id}`), handle },
    segment: (edge) => {
      const point = adapter.samplePoint(edge);
      if (!point) throw new FeaturePause('a section edge has no sample point');
      return segmentOf(profile, edgeRoot(profile, point));
    },
    source: [{ id: profile.regionId }],
  };
}

function faceSection(ctx: BuildContext, id: string, ref: Json): Section {
  const { kernel: k, adapter } = ctx.ev;
  const found = entitiesOf(ctx, ref, 'a loft section');
  const face = found[0];
  if (found.length !== 1 || face?.kind !== 'face')
    throw new FeaturePause('a loft section names something that is not a face');
  const handle = k.outerWire(adapter.handleOf(face.key));
  return {
    id,
    wire: { ref: adapter.addShape(handle, `section:${id}`), handle },
    segment: (edge) => [{ entity: adapter.keyIn(face.body, adapter.handleOf(edge)) }],
    source: [{ entity: face.key }],
  };
}

function pointSection(ctx: BuildContext, id: string, point: Json): Section {
  const [x, y, z] = pointOf(ctx, point);
  return { id, wire: null, vertex: ctx.ev.kernel.makeVertex(x, y, z), segment: () => [], source: [{ id }] };
}

function sectionOf(ctx: BuildContext, row: Json): Section {
  const id = row.id as string;
  const section = row.section as Json;
  if ('profiles' in section) return profileSection(ctx, id, section.profiles as Json);
  if ('face' in section) return faceSection(ctx, id, section.face as Json);
  return pointSection(ctx, id, section.point as Json);
}

/** Pauses on what the kernel's loft cannot do. */
function checkInputs(ctx: BuildContext): void {
  const { inputs } = ctx;
  const { values } = ctx.ev;
  if ((inputs.rails as Json[]).length > 0) throw new FeaturePause('a loft along rails is not built yet');
  if (((inputs.centerline as Json[] | undefined) ?? []).length > 0)
    throw new FeaturePause('a loft along a centerline is not built yet');
  const tangency = inputs.endTangency as Json | undefined;
  if (tangency && (values.literal(tangency.start, TEXT) !== 'free' || values.literal(tangency.end, TEXT) !== 'free')) {
    throw new FeaturePause('a loft with end tangency is not built yet');
  }
}

/**
 * The faces of one section edge that touch the section, each with its number
 * among those of its pair of sections. The list of a ruled loft runs from the
 * first pair of sections to the last, and a section touches the pair on each
 * side of it; on any other loft a face spans every section.
 */
export function touching(
  list: readonly ShapeKey[],
  index: number,
  pairs: number,
  ruled: boolean,
  closed: boolean,
): { face: ShapeKey; ordinal: number }[] {
  if (!ruled || pairs === 1) return list.map((face, ordinal) => ({ face, ordinal }));
  const size = list.length / pairs;
  const near = new Set(closed ? [(index + pairs - 1) % pairs, index % pairs] : [index - 1, index]);
  return list.flatMap((face, i) => (near.has(Math.floor(i / size)) ? [{ face, ordinal: i % size }] : []));
}

registerBuilder('core.loft', (ctx) => {
  const { inputs, id, ordinal } = ctx;
  const { kernel: k, adapter, names, values } = ctx.ev;
  checkInputs(ctx);
  const ruled = values.literal(inputs.ruled, FLAG) === true;
  const closed = values.literal(inputs.closed, FLAG) === true;
  const sections = (inputs.sections as Json[]).map((row) => sectionOf(ctx, row));
  if (closed && sections.length < 3) throw new FeaturePause('a closed loft has at least three sections');
  if (sections.some((s, i) => !s.wire && ((i > 0 && i < sections.length - 1) || closed))) {
    throw new FeaturePause('a point only starts or ends a loft');
  }
  const wires = sections.flatMap((s) => (s.wire ? [s.wire] : []));
  if (wires.length === 0) throw new FeaturePause('a loft has a section that is not a point');
  const handles = wires.map((w) => w.handle);
  // The kernel lines up a closed loft's sections edge by edge, and without that they can twist into a smaller solid.
  if (closed && new Set(handles.map((h) => k.getSubShapes(h, 'edge').length)).size > 1) {
    throw new FeaturePause('the sections of a closed loft have the same number of edges');
  }
  const [first, last] = [sections[0] as Section, sections[sections.length - 1] as Section];

  const namer = startFeature(ctx.part.state, { feature: id, ordinal }, adapter, names);
  let evolution: EvolutionData;
  try {
    evolution = k.loftWithHistory(
      closed ? [...handles, handles[0] as ShapeHandle] : handles,
      true,
      ruled,
      [],
      HASH_BOUND,
      {
        ...(first.vertex === undefined ? {} : { start: first.vertex }),
        ...(last.vertex === undefined ? {} : { end: last.vertex }),
      },
    );
  } catch (e) {
    if (e instanceof OcctError) throw new FeaturePause(`the kernel could not loft the sections: ${e.message}`);
    throw e;
  }
  if (
    k.getShapeType(evolution.result) !== 'solid' ||
    !k.isValid(evolution.result) ||
    k.getVolume(evolution.result) <= NO_VOLUME
  ) {
    throw new FeaturePause('the loft makes no solid: its sections twist against each other');
  }
  const history = adapter.sweepHistory(
    evolution,
    wires.map((w) => w.ref),
    `tool:${id}`,
  );

  // Each face's `src`: its sections in table order, then its number in the first.
  const pairs = sections.length - 1 + (closed ? 1 : 0);
  const spans = new Map<ShapeKey, { src: SrcFact[]; ordinal: number }>();
  sections.forEach((section, index) => {
    if (!section.wire) return;
    for (const { key, kind } of adapter.subShapes(section.wire.ref)) {
      if (kind !== 'edge') continue;
      for (const { face, ordinal: at } of touching(history.facesFromEdge.get(key) ?? [], index, pairs, ruled, closed)) {
        const span = spans.get(face) ?? { src: [], ordinal: at };
        span.src.push({ id: section.id }, ...section.segment(key));
        spans.set(face, span);
      }
    }
  });
  const outputs: { entity: ShapeKey; role: string; src: SrcFact[] }[] = [];
  for (const [face, { src, ordinal: at }] of spans)
    outputs.push({ entity: face, role: 'side', src: [...src, { index: at }] });
  for (const f of history.caps?.first ?? [])
    outputs.push({ entity: f, role: 'start', src: [{ id: first.id }, ...first.source] });
  for (const f of history.caps?.last ?? [])
    outputs.push({ entity: f, role: 'end', src: [{ id: last.id }, ...last.source] });
  namer.step(history, { outputs, dividers: [] });

  const tool: Tool = { shape: history.result, handle: evolution.result, src: sections.flatMap((s) => s.source) };
  applyOperation(ctx, namer, [tool], inputs.operation as Json);
});

/**
 * Features that act on whole bodies or repeat other features, as feature rows:
 * combine, remove body, move, mirror, patterns and shell.
 *
 * A body here has no name to take from the file: the file says which operations
 * made it, and those lead to the feature rows that were written for them. So a
 * step lists those features, and the worker answers with the live bodies they
 * made, once the document is built up to that point. A mirror or pattern of
 * features that join or cut repeats the features themselves; one of features
 * that make bodies repeats those bodies.
 */
import { makeSet } from '@tweakcad/format';
import type { SurfaceSpec } from '@tweakcad/worker/src/v2/service/onSurfaces';
import { OPERATIONS, surfaceOf, surfaceSpec } from './features';
import { LENGTH, type ParameterPlan } from './parameters';
import type { FaceIndex } from './parser/brep';
import type {
  F3dBodyOps,
  F3dCombine,
  F3dCopySource,
  F3dLine3,
  F3dMirror,
  F3dMove,
  F3dParameter,
  F3dPattern,
  F3dPrimitive,
  F3dRemoveBody,
  F3dShell,
} from './parser/types';
import {
  CM_TO_MM,
  cross,
  deg,
  frameOfMatrix,
  mm,
  multiplyMatrix,
  placementOfFrame,
  placementText,
  unit,
  vectorText,
  type Placement,
  type Vec3,
} from './placement';
import type { Json, Writer } from './writer';

export interface WrittenFeature {
  id: string;
  part: string;
  op: string;
}

export interface TransformContext {
  w: Writer;
  plan: ParameterPlan;
  faces: FaceIndex;
  /** The feature row written for a file record. */
  written(record: number): WrittenFeature | undefined;
  recordOfOp(op: number): number | undefined;
  /** The file copies or moves bodies by steps left out, so a body removed here may live on in a copy that was not made. */
  copiesLeftOut: boolean;
}

/** A feature row waiting for live bodies and faces. */
export interface BodyPlan {
  part: string;
  /** Per body: the features that may have made it. */
  groups: string[][];
  surfaces: SurfaceSpec[];
  /** Found nothing to do is not worth a note: what it removes is already gone. */
  quiet?: boolean;
  row(groups: Json[][], faces: { face: Json; body: Json }[], id: string): Json | null;
}

/** A row that needs nothing from the build, a plan that does, or why it is left out. */
export type Outcome =
  ({ row: (id: string) => Json; part: string; first?: Json } | { plan: BodyPlan; first?: Json }) | { leftOut: string };

/** The features behind a body's operations, and the part they are in. */
function featuresOf(c: TransformContext, body: F3dBodyOps): WrittenFeature[] {
  const out: WrittenFeature[] = [];
  for (const op of body.ops) {
    const record = c.recordOfOp(op);
    const written = record === undefined ? undefined : c.written(record);
    if (written && !out.some((f) => f.id === written.id)) out.push(written);
  }
  return out;
}

/** The groups of several bodies, all in one part, or null. */
function groupsOf(c: TransformContext, bodies: readonly F3dBodyOps[]): { groups: string[][]; part: string } | null {
  const lists = bodies.map((b) => featuresOf(c, b));
  const part = lists[0]?.[0]?.part;
  if (part === undefined || lists.some((l) => l.length === 0 || l.some((f) => f.part !== part))) return null;
  return { groups: lists.map((l) => l.map((f) => f.id)), part };
}

const unique = (refs: Json[]): Json[] => [...new Map(refs.map((r) => [JSON.stringify(r), r])).values()];

export function combineOutcome(c: TransformContext, f: F3dCombine, name: string): Outcome {
  const { w } = c;
  if (f.newComponent) return { leftOut: 'combine into a new component' };
  if (f.tools.length === 0) return { leftOut: 'combine with no tools' };
  const found = groupsOf(c, [f.target, ...f.tools]);
  if (!found) return { leftOut: 'combine of bodies not imported or in another component' };
  return {
    plan: {
      ...found,
      surfaces: [],
      row: ([target = [], ...tools], _faces, id) => {
        const [first] = target;
        const others = unique(tools.flat()).filter((t) => JSON.stringify(t) !== JSON.stringify(first));
        if (!first || others.length === 0) return null;
        return w.feature(
          'core.boolean',
          name,
          { target: first, tools: makeSet(others), op: w.choice(f.op), keepTools: w.flag(f.keepTools) },
          id,
        );
      },
    },
  };
}

export function removeOutcome(c: TransformContext, f: F3dRemoveBody, name: string): Outcome {
  const found = groupsOf(c, f.bodies);
  if (!found) return { leftOut: 'remove body of a body not imported' };
  if (c.copiesLeftOut) return { leftOut: 'remove body in a design whose copies are not imported' };
  return {
    plan: {
      ...found,
      surfaces: [],
      quiet: true,
      row: (groups, _faces, id) => {
        const bodies = unique(groups.flat());
        return bodies.length > 0 ? c.w.feature('core.removeBody', name, { bodies: makeSet(bodies) }, id) : null;
      },
    },
  };
}

export function moveOutcome(c: TransformContext, f: F3dMove, name: string): Outcome {
  const { w } = c;
  if (!f.matrix) return { leftOut: 'move with no transform read' };
  if (f.bodies.length === 0) return { leftOut: 'move of faces' };
  const found = groupsOf(c, f.bodies);
  if (!found) return { leftOut: 'move of bodies not imported' };
  const transform = placementText(frameOfMatrix(f.matrix).placement);
  return {
    plan: {
      ...found,
      surfaces: [],
      row: (groups, _faces, id) => {
        const bodies = unique(groups.flat());
        return bodies.length > 0
          ? w.feature(
              'core.move',
              name,
              { of: { bodies: makeSet(bodies) }, transform: w.val(transform), copy: w.flag(false) },
              id,
            )
          : null;
      },
    },
  };
}

/** What a mirror or pattern takes as its source: features to repeat, or bodies to find. */
function sourceOf(
  c: TransformContext,
  of: F3dCopySource,
  what: string,
): { features: WrittenFeature[] } | { groups: string[][]; part: string } | { leftOut: string } {
  if (of.other) return { leftOut: `${what} of faces` };
  // A fillet among what it repeats is not repeated: the feature it rounds still is.
  const written = of.features.flatMap((id) => c.written(id) ?? []).filter((f) => f.op !== 'round');
  if (of.features.length > 0 && written.length === 0) return { leftOut: `${what} of features not imported` };
  if (of.bodies.length > 0) {
    const found = groupsOf(c, of.bodies);
    if (!found) return { leftOut: `${what} of bodies not imported` };
    if (written.length > 0) return { leftOut: `${what} of both bodies and features` };
    return found;
  }
  if (written.length === 0) return { leftOut: `${what} of nothing read` };
  if (written.some((f) => f.part !== (written[0] as WrittenFeature).part))
    return { leftOut: `${what} across components` };
  const makers = written.filter((f) => f.op === 'new');
  if (makers.length === written.length)
    return { groups: written.map((f) => [f.id]), part: (written[0] as WrittenFeature).part };
  if (makers.length > 0 || written.some((f) => f.op !== (written[0] as WrittenFeature).op))
    return { leftOut: `${what} of features that differ in what they do` };
  return { features: written };
}

const featureSet = (features: readonly WrittenFeature[]): Json => ({
  features: makeSet(features.map((f) => ({ object: { feature: { id: f.id } } }))),
});

/** A row over a source: at once for features, once bodies are found otherwise. */
function overSource(
  source: { features: WrittenFeature[] } | { groups: string[][]; part: string },
  make: (of: Json, op: 'new' | 'join', id: string) => Json,
): Outcome {
  if ('features' in source)
    return {
      part: (source.features[0] as WrittenFeature).part,
      row: (id) => make(featureSet(source.features), 'join', id),
    };
  return {
    plan: {
      groups: source.groups,
      part: source.part,
      surfaces: [],
      row: (groups, _faces, id) => {
        const bodies = unique(groups.flat());
        return bodies.length > 0 ? make({ bodies: makeSet(bodies) }, 'new', id) : null;
      },
    },
  };
}

/** The placement of a plane a mirror stored or a face it picked. */
function mirrorPlane(c: TransformContext, f: F3dMirror): Placement | null {
  if (f.frame) return placementOfFrame(mmOf(f.frame.origin), unit(f.frame.x), unit(f.frame.normal));
  const surface = f.planeFace && surfaceOf(c.faces, f.planeFace);
  if (surface?.kind !== 'plane') return null;
  const normal = unit(surface.normal);
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return placementOfFrame(mmOf(surface.origin), unit(cross(seed, normal)), normal);
}

export function mirrorOutcome(c: TransformContext, f: F3dMirror, name: string): Outcome {
  const { w } = c;
  const source = sourceOf(c, f.of, 'mirror');
  if ('leftOut' in source) return source;
  const at = f.plane ? null : mirrorPlane(c, f);
  if (!f.plane && !at) return { leftOut: 'mirror about a plane not read' };
  const planeFeature = at
    ? w.feature('core.constructionPlane', `${name} plane`, {
        frame: { fixed: { placement: w.val(placementText(at)) } },
      })
    : null;
  const plane = planeFeature
    ? { object: { feature: { id: planeFeature.id as string } } }
    : { standard: { name: f.plane } };
  const outcome = overSource(source, (of, op, id) =>
    w.feature('core.mirror', name, { of, plane, operation: w.operation(op) }, id),
  );
  return planeFeature ? { ...outcome, first: planeFeature } : outcome;
}

const mmOf = (v: readonly [number, number, number]): [number, number, number] => [
  v[0] * CM_TO_MM,
  v[1] * CM_TO_MM,
  v[2] * CM_TO_MM,
];

function linearRow(c: TransformContext, line: F3dLine3, count: number, spacing: number): Json {
  const { w } = c;
  return {
    direction: { vector: { v: w.val(vectorText(unit(line.direction))), reversed: w.flag(spacing < 0) } },
    count: w.val(String(count)),
    spacing: { equal: { s: w.val(mm(Math.abs(spacing))) } },
  };
}

export function patternOutcome(c: TransformContext, f: F3dPattern, name: string): Outcome {
  const { w } = c;
  const what = f.layout === 'rectangular' ? 'rectangular pattern' : 'circular pattern';
  const source = sourceOf(c, f.of, what);
  if ('leftOut' in source) return source;
  const [line, second] = f.directions;
  const [n = 1, m = 1] = f.counts;
  if (!line) return { leftOut: `${what} about an axis not read` };
  let layout: Json;
  if (f.layout === 'rectangular') {
    if (!f.uSpacing) return { leftOut: `${what} with no spacing read` };
    const directions = [linearRow(c, line, n, f.uSpacing.value * CM_TO_MM)];
    if (m > 1) {
      if (!second || !f.vSpacing) return { leftOut: `${what} with its second direction not read` };
      directions.push(linearRow(c, second, m, f.vSpacing.value * CM_TO_MM));
    }
    layout = { linear: { directions } };
  } else {
    if (!f.angle) return { leftOut: `${what} with no angle read` };
    const axis = {
      through: {
        point: { at: { v: w.val(vectorText(mmOf(line.origin))) } },
        direction: { vector: { v: w.val(vectorText(unit(line.direction))), reversed: w.flag(false) } },
      },
    };
    layout = {
      circular: {
        axis,
        count: w.val(String(n)),
        angle: w.val(deg((f.angle.value * 180) / Math.PI)),
        symmetric: w.flag(false),
      },
    };
  }
  return overSource(source, (of, op, id) =>
    w.feature('core.pattern', name, { of, layout, skip: makeSet([]), vary: [], operation: w.operation(op) }, id),
  );
}

export function shellOutcome(c: TransformContext, f: F3dShell, name: string, part: string): Outcome {
  const { w, plan } = c;
  if (!f.inner) return { leftOut: 'shell with no thickness read' };
  const thickness = f.inner;
  const surfaces = f.faces.flatMap((face) => {
    const s = surfaceOf(c.faces, face);
    return s ? [surfaceSpec(s)] : [];
  });
  if (surfaces.length === 0 || surfaces.length < f.faces.length)
    return { leftOut: 'shell of faces not found in the stored bodies' };
  return {
    plan: {
      part,
      groups: [],
      surfaces,
      row: (_groups, faces, id) => {
        if (faces.length === 0) return null;
        return w.feature(
          'core.shell',
          name,
          {
            bodies: makeSet(unique(faces.map((x) => x.body))),
            remove: makeSet(unique(faces.map((x) => x.face))),
            thickness: plan.value(
              thickness.value > 0 ? thickness : null,
              mm(Math.abs(thickness.value * CM_TO_MM)),
              LENGTH,
            ),
            direction: w.choice('inside'),
          },
          id,
        );
      },
    },
  };
}

/** A size in mm, kept as the parameter when it is the same number and not negative. */
function sized(c: TransformContext, p: F3dParameter): Json {
  return c.plan.value(p.value > 0 ? p : null, mm(Math.abs(p.value * CM_TO_MM)), LENGTH);
}

const halved = (c: TransformContext, p: F3dParameter): Json => c.w.val(mm((Math.abs(p.value) * CM_TO_MM) / 2));

/**
 * A primitive row. The file stands a box on a corner and a cylinder on its
 * base, and a row centres them, so the frame moves by half their sizes; a
 * negative size runs the other way.
 */
export function primitiveOutcome(c: TransformContext, f: F3dPrimitive, name: string, part: string): Outcome {
  const { w } = c;
  const s = f.sizes;
  const at = (x: number, y: number, z: number): number[] => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
  let shape: Json;
  let centre = at(0, 0, 0);
  if (f.shape === 'box') {
    const [x, y, z] = [s['DistanceX'], s['DistanceY'], s['DistanceZ']];
    if (!x || !y || !z) return { leftOut: 'box with its sizes not read' };
    shape = { box: { width: sized(c, x), depth: sized(c, y), height: sized(c, z) } };
    if (s['OffsetDistanceX']?.value || s['OffsetDistanceY']?.value) return { leftOut: 'box with an offset' };
    centre = at(x.value / 2, y.value / 2, z.value / 2);
  } else if (f.shape === 'cylinder') {
    const [d, h] = [s['Diameter'], s['Height']];
    if (!d || !h) return { leftOut: 'cylinder with its sizes not read' };
    shape = { cylinder: { radius: halved(c, d), height: sized(c, h) } };
    centre = at(0, 0, h.value / 2);
  } else if (f.shape === 'sphere') {
    const d = s['Diameter'];
    if (!d) return { leftOut: 'sphere with its size not read' };
    shape = { sphere: { radius: halved(c, d) } };
  } else {
    const [major, minor] = [s['MajorDiameter'], s['MinorDiameter']];
    if (!major || !minor) return { leftOut: 'torus with its sizes not read' };
    shape = { torus: { majorRadius: halved(c, major), minorRadius: halved(c, minor) } };
  }
  const placement = frameOfMatrix(multiplyMatrix(multiplyMatrix(f.plane, f.onPlane), centre)).placement;
  return {
    part,
    row: (id) =>
      w.feature(
        'core.primitive',
        name,
        {
          shape,
          frame: { fixed: { placement: w.val(placementText(placement)) } },
          operation: w.operation(OPERATIONS[f.operation]),
        },
        id,
      ),
  };
}

/**
 * Extrudes, revolves, fillets and chamfers as feature rows.
 *
 * An extrude's sides, tapers and start map straight onto `core.extrude`. A face
 * the file extrudes from or up to is read from the stored bodies: a plane
 * parallel to the sketch is a distance, anything else is left out. A fillet
 * names an edge by the two faces either side of it as they stood when it was
 * picked, so those faces' surfaces go to the worker, which finds the edges that
 * lie on both in the model as built.
 */
import { makeSet } from '@tweakcad/format';
import type { SurfaceSpec } from '@tweakcad/worker/src/v2/service/onSurfaces';
import { ANGLE, LENGTH, type ParameterPlan } from './parameters';
import type { BrepSurface, FaceIndex } from './parser/brep';
import type {
  F3dChamfer,
  F3dEdgeRecipe,
  F3dExtrude,
  F3dFaceName,
  F3dFillet,
  F3dParameter,
  F3dProfile,
  F3dRevolve,
  F3dRoundSet,
} from './parser/types';
import { CM_TO_MM, deg, dot, mm, vectorText, type Vec3 } from './placement';
import type { ConvertedSketch } from './sketch';
import type { Json, Writer } from './writer';

export interface PlacedSketch {
  feature: string;
  rows: ConvertedSketch;
  /** The sketch plane's normal and origin, in mm. */
  normal: Vec3;
  origin: Vec3;
}

export type SketchLookup = (fileSketchId: number) => PlacedSketch | undefined;

export interface FeatureContext {
  w: Writer;
  plan: ParameterPlan;
  sketch: SketchLookup;
  faces: FaceIndex;
}

export type LeftOut = 'surface' | 'noProfile' | 'noRegion' | 'startsFromFace' | 'toObject' | 'noDistance' | 'thin';

export const OPERATIONS = { newBody: 'new', join: 'join', cut: 'cut', intersect: 'intersect' } as const;

/** The region references of the profiles found, and the first sketch among them. */
function profileRefs(
  c: FeatureContext,
  profiles: readonly F3dProfile[],
): { refs: Json[]; sketch: PlacedSketch } | null {
  const refs: Json[] = [];
  const seen = new Set<string>();
  let first: PlacedSketch | undefined;
  for (const p of profiles) {
    const s = c.sketch(p.sketchId);
    if (!s) continue;
    first ??= s;
    for (const region of p.regions) {
      for (const id of s.rows.regionsOf(region)) {
        if (seen.has(id)) continue;
        seen.add(id);
        refs.push(c.w.regionRef(s.feature, id));
      }
    }
  }
  return refs.length > 0 && first ? { refs, sketch: first } : null;
}

const size = (p: F3dParameter): number => p.value * CM_TO_MM;
const angleOf = (p: F3dParameter | null): number => (p ? (p.value * 180) / Math.PI : 0);

export function surfaceOf(faces: FaceIndex, name: F3dFaceName): BrepSurface | null {
  for (const face of faces.find(name)) if (face.surface) return face.surface;
  return null;
}

/** Height above the sketch plane of a stored plane parallel to it, in mm, or null for anything else. */
function parallelHeight(c: FeatureContext, name: F3dFaceName | undefined, s: PlacedSketch): number | null {
  if (!name) return null;
  const surface = surfaceOf(c.faces, name);
  if (surface?.kind !== 'plane') return null;
  const [a, b, d] = surface.normal;
  const length = Math.hypot(a, b, d) || 1;
  if (Math.abs(Math.abs(dot([a / length, b / length, d / length], s.normal)) - 1) > 1e-9) return null;
  const [x, y, z] = surface.origin;
  return dot([x * CM_TO_MM, y * CM_TO_MM, z * CM_TO_MM], s.normal) - dot(s.origin, s.normal);
}

export function extrudeRow(c: FeatureContext, e: F3dExtrude, name: string): Json | LeftOut {
  const { w, plan } = c;
  if (!e.solid) return 'surface';
  if (e.wall) return 'thin';
  if (e.profiles.length === 0) return 'noProfile';
  const found = profileRefs(c, e.profiles);
  if (!found) return 'noRegion';
  const { refs, sketch } = found;

  /** +1 when the file's vector runs along the sketch's normal. */
  const facing = dot(e.vector, sketch.normal) >= 0 ? 1 : -1;
  const forward = e.reversed ? -1 : 1;
  // How far the start sits from the sketch plane, along the normal.
  let startHeight = 0;
  let startFace = 0;
  if (e.start === 'face') {
    const height = parallelHeight(c, e.faces[0], sketch);
    if (height === null) return 'startsFromFace';
    startHeight = height;
    startFace = 1;
  }
  if (e.profileOffset && Math.abs(e.profileOffset.value) > 1e-12) startHeight += size(e.profileOffset) * facing;

  const taper = (p: F3dParameter | null): Json => plan.value(p, deg(angleOf(p)), ANGLE);
  const distance = (d: number, p: F3dParameter | null): Json => ({
    distance: { d: plan.value(p && p.value > 0 ? p : null, mm(d), LENGTH) },
  });
  const build = (sign: number, sides: Json[]): Json => {
    const reversed = sign < 0;
    const inputs: Json = {
      profiles: makeSet(refs),
      sides,
      direction: { normal: { ref: { object: { feature: { id: sketch.feature } } }, reversed: w.flag(reversed) } },
      thin: { solid: {} },
      operation: w.operation(OPERATIONS[e.operation]),
    };
    if (startHeight !== 0) inputs.start = { offset: { d: w.val(mm(reversed ? -startHeight : startHeight)) } };
    return w.feature('core.extrude', name, inputs);
  };
  const side = (extent: Json, p: F3dParameter | null = e.taper): Json => ({ extent, taper: taper(p) });
  const flip = facing * forward;

  // Up to a face: a plane parallel to the sketch is a distance.
  if (e.side1Offset) {
    if (e.sides !== 'one') return 'toObject';
    const target = parallelHeight(c, e.faces[startFace], sketch);
    if (target === null) return 'toObject';
    const gap = target - startHeight;
    const reach = gap >= 0 ? gap + size(e.side1Offset) : gap - size(e.side1Offset);
    if (Math.abs(reach) < 1e-9) return 'noDistance';
    return build(reach >= 0 ? 1 : -1, [side(distance(Math.abs(reach), null))]);
  }

  if (e.sides === 'symmetric') {
    if (!e.along) return build(1, [side({ throughAll: {} }), side({ throughAll: {} })]);
    if (e.along.value === 0) return 'noDistance';
    const half = Math.abs(size(e.along));
    return build(1, [
      side({
        symmetric: { d: plan.value(e.along.value > 0 ? e.along : null, mm(half), LENGTH), measure: w.choice('half') },
      }),
    ]);
  }

  if (e.sides === 'two') {
    const extent = (p: F3dParameter | null): Json =>
      p ? { distance: { d: plan.value(p.value > 0 ? p : null, mm(size(p)), LENGTH) } } : { throughAll: {} };
    // The first side runs a positive distance: one that does not is the second side the other way round.
    if (e.along && e.along.value <= 0) {
      if (e.against && e.against.value <= 0) return 'noDistance';
      return build(-flip, [side(extent(e.against), e.side2Taper), side(extent(e.along))]);
    }
    return build(flip, [side(extent(e.along)), side(extent(e.against), e.side2Taper)]);
  }

  if (!e.along) return build(flip, [side({ throughAll: {} })]);
  const along = size(e.along);
  if (along === 0) return 'noDistance';
  return build(along < 0 ? -flip : flip, [side(distance(Math.abs(along), e.along))]);
}

export function revolveRow(c: FeatureContext, r: F3dRevolve, name: string): Json | LeftOut {
  const { w, plan } = c;
  if (!r.axis) return 'noProfile';
  const found = profileRefs(c, r.profiles);
  if (!found) return 'noRegion';
  const { origin, direction } = r.axis;
  const degrees = r.angle ? angleOf(r.angle) : 360;
  const sign = degrees < 0 ? -1 : 1;
  const length = Math.hypot(...direction) || 1;
  const axis = {
    through: {
      point: { at: { v: w.val(vectorText([origin[0] * CM_TO_MM, origin[1] * CM_TO_MM, origin[2] * CM_TO_MM])) } },
      direction: {
        vector: {
          v: w.val(
            vectorText([
              (sign * direction[0]) / length,
              (sign * direction[1]) / length,
              (sign * direction[2]) / length,
            ]),
          ),
          reversed: w.flag(false),
        },
      },
    },
  };
  const full = Math.abs(degrees) >= 360 - 1e-9;
  const sides = [
    full
      ? { full: {} }
      : { angle: { a: plan.value(r.angle && r.angle.value > 0 ? r.angle : null, deg(Math.abs(degrees)), ANGLE) } },
  ];
  return w.feature('core.revolve', name, {
    profiles: makeSet(found.refs),
    axis,
    sides,
    thin: { solid: {} },
    operation: w.operation(OPERATIONS[r.operation]),
  });
}

export function surfaceSpec(s: BrepSurface): SurfaceSpec {
  const scaled = (v: Vec3): Vec3 => [v[0] * CM_TO_MM, v[1] * CM_TO_MM, v[2] * CM_TO_MM];
  switch (s.kind) {
    case 'plane':
      return { kind: 'plane', origin: scaled(s.origin), normal: s.normal };
    case 'cone':
      return {
        kind: 'cone',
        origin: scaled(s.origin),
        axis: s.axis,
        radius: s.radius * CM_TO_MM,
        sine: s.sine,
        cosine: s.cosine,
      };
    case 'sphere':
      return { kind: 'sphere', center: scaled(s.center), radius: s.radius * CM_TO_MM };
    case 'torus':
      return {
        kind: 'torus',
        center: scaled(s.center),
        axis: s.axis,
        major: s.major * CM_TO_MM,
        minor: s.minor * CM_TO_MM,
      };
  }
}

function edgePair(faces: FaceIndex, recipe: F3dEdgeRecipe): [SurfaceSpec, SurfaceSpec] | null {
  const [a, b] = [surfaceOf(faces, recipe.faces[0] as F3dFaceName), surfaceOf(faces, recipe.faces[1] as F3dFaceName)];
  return a && b ? [surfaceSpec(a), surfaceSpec(b)] : null;
}

/** A set of edges to find, and how to write the set given what was found. */
export interface RoundSet {
  pairs: [SurfaceSpec, SurfaceSpec][];
  row(refs: Json[]): Json;
}

export interface RoundFeature {
  sets: RoundSet[];
  /** Edges whose faces the stored bodies do not hold. */
  lost: number;
  /** Sets that have no size or no edges. */
  empty: number;
  row(sets: Json[]): Json;
}

function roundSets(
  c: FeatureContext,
  sets: readonly F3dRoundSet[],
  write: (targets: Json[], size: F3dParameter) => Json,
): Pick<RoundFeature, 'sets' | 'lost' | 'empty'> {
  const out: RoundSet[] = [];
  let lost = 0;
  let empty = 0;
  for (const set of sets) {
    const sized = set.size;
    if (!sized) {
      empty++;
      continue;
    }
    const pairs: [SurfaceSpec, SurfaceSpec][] = [];
    for (const recipe of set.edges) {
      const pair = edgePair(c.faces, recipe);
      if (pair) pairs.push(pair);
      else lost++;
    }
    if (pairs.length === 0) empty++;
    else out.push({ pairs, row: (refs) => write(refs, sized) });
  }
  return { sets: out, lost, empty };
}

export function filletFeature(c: FeatureContext, f: F3dFillet, name: string, id: string): RoundFeature {
  const { w, plan } = c;
  const sets = roundSets(c, f.sets, (targets, size) => ({
    targets: makeSet(targets),
    radius: { constant: { s: plan.value(size.value > 0 ? size : null, mm(Math.abs(size.value * CM_TO_MM)), LENGTH) } },
    setback: w.val('0 mm'),
  }));
  return { ...sets, row: (rows) => w.feature('core.fillet', name, { sets: rows }, id) };
}

export function chamferFeature(c: FeatureContext, f: F3dChamfer, name: string, id: string): RoundFeature | 'uneven' {
  if (f.uneven) return 'uneven';
  const { w, plan } = c;
  const sets = roundSets(c, f.sets, (targets, size) => ({
    targets: makeSet(targets),
    size: { distance: { d: plan.value(size.value > 0 ? size : null, mm(Math.abs(size.value * CM_TO_MM)), LENGTH) } },
  }));
  return { ...sets, row: (rows) => w.feature('core.chamfer', name, { sets: rows }, id) };
}

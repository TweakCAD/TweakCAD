/**
 * Holes as `core.hole`. The file stores each centre and the plane of the face
 * the hole starts on. The hole is placed on that face, found in the model as
 * built, so it drills into the material from the face, as `core.hole` does; a
 * hole whose face is not found is placed on the stored plane, drilling against
 * its normal. Its centres are written in the placement's frame.
 */
import type { SurfaceSpec } from '@tweakcad/worker/src/v2/service/onSurfaces';
import { ANGLE, LENGTH, type ParameterPlan } from './parameters';
import type { F3dHole, F3dParameter } from './parser/types';
import {
  CM_TO_MM,
  cross,
  deg,
  dot,
  mm,
  placementOfFrame,
  placementText,
  sub,
  unit,
  vectorText,
  type Vec3,
} from './placement';
import type { Outcome } from './transforms';
import type { Json, Writer } from './writer';

/** Part-frame axes within this angle of a face's normal are not projected onto it (7.3 `plane`). */
const PARALLEL = 1e-9;

const scaled = (v: readonly number[]): Vec3 => [
  (v[0] as number) * CM_TO_MM,
  (v[1] as number) * CM_TO_MM,
  (v[2] as number) * CM_TO_MM,
];

/** The frame `plane` attachment makes on a face (7.3): z the normal, origin the part origin projected, x the part's x projected. */
function faceFrame(point: Vec3, normal: Vec3): { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 } {
  const z = unit(normal);
  const projected = (a: Vec3): Vec3 => sub(a, z.map((c) => c * dot(a, z)) as unknown as Vec3);
  let x = projected([1, 0, 0]);
  if (Math.hypot(...x) < Math.sin(PARALLEL)) x = projected([0, 1, 0]);
  x = unit(x);
  const origin = z.map((c) => c * dot(point, z)) as unknown as Vec3;
  return { origin, x, y: cross(z, x), z };
}

/** Of the faces found on the hole's plane, the one whose box holds every centre, else the largest. */
function faceFor(faces: readonly Json[], centres: readonly Vec3[]): Json | undefined {
  const snapshot = (f: Json) => (f.entity as { snapshot?: Json } | undefined)?.snapshot ?? {};
  const holds = (f: Json) => {
    const box = snapshot(f).bbox as [Vec3, Vec3] | undefined;
    if (!box) return false;
    const [low, high] = box;
    return centres.every((c) => c.every((v, a) => v >= (low[a] as number) - 1e-6 && v <= (high[a] as number) + 1e-6));
  };
  const area = (f: Json) => (snapshot(f).area as number | undefined) ?? 0;
  return (
    faces.find(holds) ??
    faces.reduce<Json | undefined>((best, f) => (!best || area(f) > area(best) ? f : best), undefined)
  );
}

/**
 * The hole as a plan that finds its face, or why it is not translated. `toPart`
 * takes model points into the part's own coordinates, for a component's part.
 */
export function holeOutcome(
  w: Writer,
  plan: ParameterPlan,
  f: F3dHole,
  name: string,
  part: string,
  toPart: (p: Vec3) => Vec3 = (p) => p,
  toPartDirection: (v: Vec3) => Vec3 = (v) => v,
): Outcome {
  if (f.centres.length === 0) return { leftOut: 'a hole placed by its distances to edges' };
  if (!f.plane) return { leftOut: 'its starting face was not read' };
  const { sizes } = f;
  const diameter = sizes.HoleDiameter;
  if (!diameter) return { leftOut: 'its diameter was not read' };
  const centres = f.centres.map((c) => toPart(scaled(c)));
  const origin = toPart(scaled(f.plane.origin));
  const normal = unit(toPartDirection(f.plane.normal as Vec3));
  const length = (p: F3dParameter) => plan.value(p.value > 0 ? p : null, mm(Math.abs(p.value * CM_TO_MM)), LENGTH);
  const angle = (p: F3dParameter) => plan.value(p, deg((p.value * 180) / Math.PI), ANGLE);

  const inputs = (placement: Json, frame: { origin: Vec3; x: Vec3; y: Vec3 }): Json => {
    const tip = sizes.TipAngle;
    const out: Json = {
      placement,
      positions: centres.map((c) => {
        const d = sub(c, frame.origin);
        return { id: w.ids('hp'), at: { at: { v: w.val(vectorText([dot(d, frame.x), dot(d, frame.y), 0])) } } };
      }),
      kind: w.choice(sizes.CSDiameter ? 'countersink' : sizes.CBDiameter ? 'counterbore' : 'simple'),
      diameter: length(diameter),
      depth: sizes.HoleDepth ? { distance: { d: length(sizes.HoleDepth) } } : { throughAll: {} },
      tip: tip && Math.abs(tip.value - Math.PI) > 1e-9 ? { angle: { a: angle(tip) } } : { flat: {} },
      thread: { none: {} },
    };
    if (sizes.CSDiameter && sizes.CSAngle)
      out.countersink = { diameter: length(sizes.CSDiameter), angle: angle(sizes.CSAngle) };
    if (sizes.CBDiameter && sizes.CBDepth)
      out.counterbore = { diameter: length(sizes.CBDiameter), depth: length(sizes.CBDepth) };
    return out;
  };

  const surface: SurfaceSpec = { kind: 'plane', origin, normal };
  return {
    plan: {
      part,
      groups: [],
      surfaces: [surface],
      row: (_groups, faces, id) => {
        const face = faceFor(
          faces.map((x) => x.face),
          centres,
        );
        const outward = (face?.entity as { snapshot?: { normal?: Vec3 } } | undefined)?.snapshot?.normal;
        if (face && outward) return w.feature('core.hole', name, inputs({ face }, faceFrame(origin, outward)), id);
        // No face: the stored plane, drilling against its normal (the hole runs along the frame's −z).
        const x = faceFrame(origin, normal).x;
        const frame = { origin, x, y: cross(normal, x) };
        const fixed = { frame: { fixed: { placement: w.val(placementText(placementOfFrame(origin, x, normal))) } } };
        return w.feature('core.hole', name, inputs(fixed, frame), id);
      },
    },
  };
}

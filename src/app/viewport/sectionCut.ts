/**
 * Where a section view cuts, from what the Section panel holds: the plane it
 * starts from (a standard plane, or a flat face or construction plane
 * picked), a distance along that plane's normal, a turn about the plane's
 * own x axis, and which half is kept.
 */
import type { SectionView } from '../appState';

type V3 = readonly [number, number, number];

/** The standard planes: their normal and their own x axis. */
export const SECTION_FRAMES: Record<'XY' | 'XZ' | 'YZ', { normal: V3; x: V3 }> = {
  XY: { normal: [0, 0, 1], x: [1, 0, 0] },
  XZ: { normal: [0, 1, 0], x: [1, 0, 0] },
  YZ: { normal: [1, 0, 0], x: [0, 0, -1] },
};

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const add = (a: V3, b: V3): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): [number, number, number] => [a[0] * s, a[1] * s, a[2] * s];

/** The plane a section starts from: a point on it, its normal and its x axis. */
export function sectionBase(view: SectionView): { origin: V3; normal: V3; x: V3 } {
  if (typeof view.plane === 'string') return { origin: [0, 0, 0], ...SECTION_FRAMES[view.plane] };
  return view.plane;
}

/**
 * The cut: the base plane moved `distance` along its normal, turned `angle`
 * degrees about its x axis there, the normal reversed when flipped (the
 * normal points to the half that stays). With no distance yet the viewport
 * places the cut through the bodies' centre.
 */
export function sectionCut(view: SectionView): { normal: [number, number, number]; point?: [number, number, number] } {
  const base = sectionBase(view);
  const a = (view.angle * Math.PI) / 180;
  // Rodrigues' turn of the normal about x (a unit vector in the plane).
  const turned = add(
    add(scale(base.normal, Math.cos(a)), scale(cross(base.x, base.normal), Math.sin(a))),
    scale(base.x, dot(base.x, base.normal) * (1 - Math.cos(a))),
  );
  const normal = scale(turned, view.flipped ? -1 : 1);
  if (view.distance === null) return { normal };
  return { normal, point: add(base.origin, scale(base.normal, view.distance)) };
}

/** The distance that puts the cut, at its angle, through `point` (where a drag left it). */
export function sectionDistance(view: SectionView, point: V3): number {
  const base = sectionBase(view);
  const { normal } = sectionCut(view);
  const rel: V3 = [point[0] - base.origin[0], point[1] - base.origin[1], point[2] - base.origin[2]];
  return dot(rel, normal) / dot(base.normal, normal);
}

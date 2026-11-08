/**
 * Drawing a primitive's base in the view: after the plane, a box takes two
 * opposite corners of its base; a cylinder and a cone their centre, then a
 * point on the base's rim; a sphere its centre, then a point at its radius; a
 * torus its centre, then a point on the ring through its tube's centre.
 * Points are in the plane's frame (its x and y), and the clicks fill the
 * panel's fields, to the hundredth of a millimetre: the centre's x and y, and
 * the sizes. The height then stands on the plane, dragged by an arrow on top
 * or typed.
 */
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import type { Arrow } from './arrowHandle';
import { hasHeight, isStanding, standingZ, type PrimitiveForm, type PrimitiveShape } from './primitive';

export type UV = readonly [number, number];

/** What the first click places: a corner of a box's base, or the centre of the others. */
export const FIRST_CLICK: Record<PrimitiveShape, 'corner' | 'centre'> = {
  box: 'corner',
  cylinder: 'centre',
  sphere: 'centre',
  cone: 'centre',
  torus: 'centre',
};

/** The field the second click sets on a round shape: the distance from the centre. */
const RADIUS_FIELD: Record<Exclude<PrimitiveShape, 'box'>, string> = {
  cylinder: 'radius',
  sphere: 'radius',
  cone: 'bottomRadius',
  torus: 'majorRadius',
};

/** The smallest size a click makes; a second click closer to the first is not taken. */
const SMALLEST = 0.01;

const hundredth = (n: number): number => Math.round(n * 100) / 100 + 0;
const text = (n: number): string => String(hundredth(n));

/** What the panel says to click next while the base is drawn. */
export function nextClick(shape: PrimitiveShape, first: UV | null): string {
  if (!first) return FIRST_CLICK[shape] === 'corner' ? 'Click the first corner' : 'Click the centre';
  if (shape === 'box') return 'Click the opposite corner';
  if (shape === 'torus') return 'Click on the ring';
  return shape === 'sphere' ? 'Click to set the radius' : 'Click on the rim';
}

/** The sizes and centre the two clicks give, standing on the plane where the shape has a height; null for clicks too close together. */
export function drawnBase(form: PrimitiveForm, first: UV, second: UV): Partial<PrimitiveForm> | null {
  let dims: Record<string, string>;
  let centre: [number, number];
  if (form.shape === 'box') {
    const [width, depth] = [Math.abs(second[0] - first[0]), Math.abs(second[1] - first[1])];
    if (hundredth(width) < SMALLEST || hundredth(depth) < SMALLEST) return null;
    dims = { ...form.dims, width: text(width), depth: text(depth) };
    centre = [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
  } else {
    const radius = Math.hypot(second[0] - first[0], second[1] - first[1]);
    if (hundredth(radius) < SMALLEST) return null;
    dims = { ...form.dims, [RADIUS_FIELD[form.shape]]: text(radius) };
    centre = [first[0], first[1]];
  }
  return { dims, x: text(centre[0]), y: text(centre[1]), z: standingZ(form.shape, dims), drawing: false };
}

/**
 * Where a primitive stands when its sizes are typed after only the first
 * click: centred on that click, or with that corner as a box's lower one.
 * Sizes that are not numbers leave a box centred on its corner.
 */
export function placedByFirst(form: PrimitiveForm, first: UV): Partial<PrimitiveForm> {
  const half = (field: string) => {
    const v = Number(form.dims[field]);
    return form.shape === 'box' && Number.isFinite(v) ? v / 2 : 0;
  };
  return { x: text(first[0] + half('width')), y: text(first[1] + half('depth')) };
}

/** The base as drawn so far, as a closed loop in the plane: from the first click to the pointer. */
export function baseOutline(shape: PrimitiveShape, first: UV, at: UV, segments = 48): UV[] {
  if (shape === 'box') return [first, [at[0], first[1]], at, [first[0], at[1]]];
  const r = Math.hypot(at[0] - first[0], at[1] - first[1]);
  return Array.from({ length: segments }, (_, i): UV => {
    const a = (i / segments) * Math.PI * 2;
    return [first[0] + r * Math.cos(a), first[1] + r * Math.sin(a)];
  });
}

/** A point of the plane, from its frame coordinates. */
export function onPlane(frame: FrameDisplay, uv: UV, h = 0): [number, number, number] {
  const p = (i: 0 | 1 | 2) => frame.origin[i] + frame.x[i] * uv[0] + frame.y[i] * uv[1] + frame.normal[i] * h;
  return [p(0), p(1), p(2)];
}

/**
 * The arrow that drags the height: on top of a box, cylinder or cone that
 * stands on its plane, pointing away from it. Null when the shape has no
 * height, does not stand on the plane, or its position or height is not a
 * plain number.
 */
export function heightArrow(form: PrimitiveForm, frame: FrameDisplay): Arrow | null {
  if (!hasHeight(form.shape) || !isStanding(form)) return null;
  const height = Number(form.dims.height);
  const [x, y] = [Number(form.x.trim() === '' ? '0' : form.x), Number(form.y.trim() === '' ? '0' : form.y)];
  if (!(height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { at: onPlane(frame, [x, y], height), direction: [...frame.normal], distance: height };
}

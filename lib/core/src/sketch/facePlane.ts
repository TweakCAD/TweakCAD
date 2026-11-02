/**
 * The sketch frame of a sketch placed on a planar body face.
 *
 * The worker (`buildSketch`, every rebuild) and the editor (sketch entry,
 * before the first rebuild) both derive the frame from the face's plane
 * through this function, so a sketch's 2D coordinates mean the same world
 * points on both sides.
 *
 * The frame depends only on the plane, not on the face's outline:
 *  - origin: the world origin projected onto the plane. Sketch coordinates
 *    stay put when the face grows, shrinks or gains holes; only a move of
 *    the plane itself moves the sketch.
 *  - vAxis: world +Y projected onto the plane. For a face whose normal is
 *    mostly ±Y, world ∓Z instead.
 *  - uAxis: vAxis × normal, so u × v = normal and the sketch reads
 *    unmirrored from the side the normal points to.
 *
 * On a face parallel to a default plane the frame matches that plane's
 * axes: a +Y face (a box's top) maps sketch x / y to world +X / −Z exactly
 * as XZ does, so its coordinates are those of an XZ sketch lifted onto the
 * face. The opposite face flips one axis to stay unmirrored from its side.
 */

import type { Vec3 } from '../math.ts';

export type FaceSketchFrame = {
  origin: Vec3;
  uAxis: Vec3;
  vAxis: Vec3;
  normal: Vec3;
};

/** Normals with |n.y| above this take their v reference from world Z. */
const MOSTLY_Y = 0.9;

/**
 * Sketch frame for the plane through `pointOnPlane` with normal `normal`.
 * Throws for a zero-length normal.
 */
export function sketchFrameOnPlane(normal: Vec3, pointOnPlane: Vec3): FaceSketchFrame {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(len > 1e-12)) throw new Error('Face plane has a zero-length normal');
  const n: Vec3 = [normal[0] / len, normal[1] / len, normal[2] / len];

  const ref: Vec3 = Math.abs(n[1]) > MOSTLY_Y ? [0, 0, n[1] > 0 ? -1 : 1] : [0, 1, 0];
  const along = dot(ref, n);
  const vRaw: Vec3 = [ref[0] - n[0] * along, ref[1] - n[1] * along, ref[2] - n[2] * along];
  const vLen = Math.hypot(vRaw[0], vRaw[1], vRaw[2]);
  const vAxis: Vec3 = [clean(vRaw[0] / vLen), clean(vRaw[1] / vLen), clean(vRaw[2] / vLen)];
  const uAxis: Vec3 = [
    clean(vAxis[1] * n[2] - vAxis[2] * n[1]),
    clean(vAxis[2] * n[0] - vAxis[0] * n[2]),
    clean(vAxis[0] * n[1] - vAxis[1] * n[0]),
  ];

  const d = dot(pointOnPlane, n);
  const origin: Vec3 = [clean(n[0] * d), clean(n[1] * d), clean(n[2] * d)];
  return { origin, uAxis, vAxis, normal: [clean(n[0]), clean(n[1]), clean(n[2])] };
}

/** Closest default-plane name for a normal (labels and view fallbacks only). */
export function nearestDefaultPlaneName(normal: Vec3): 'XY' | 'XZ' | 'YZ' {
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  if (az >= ax && az >= ay) return 'XY';
  if (ay >= ax && ay >= az) return 'XZ';
  return 'YZ';
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Flush float noise (−0, 1e-17) so axis-aligned frames come out exact. */
function clean(x: number): number {
  return Math.abs(x) < 1e-12 ? 0 : x;
}

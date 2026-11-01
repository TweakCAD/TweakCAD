/**
 * Camera framing for the orbit camera: where to put the orbit target and how
 * far back to sit so a bounding box fills the view. Shared by Fit All and
 * Home, which frame the model the same way and differ only in whether the
 * view angles change.
 */

import * as THREE from 'three';

/** Home view angles (THREE.Spherical: theta = azimuth from +Z, phi = polar from +Y). */
export const HOME_THETA = Math.PI / 4;
export const HOME_PHI = Math.PI / 3;

/** Home distance from the origin when there is nothing to frame. */
export const HOME_EMPTY_RADIUS = 50;

/** Closest the camera sits when fitting a box. */
const MIN_FIT_RADIUS = 5;

/** Extra room around the fitted box. */
const FIT_PADDING = 1.5;

export interface CameraFraming {
  target: THREE.Vector3;
  radius: number;
}

/**
 * Framing that shows the whole box with padding, or null when the box is
 * empty or its extents are non-finite (a degenerate box would otherwise send
 * the camera to NaN).
 */
export function fitFraming(box: THREE.Box3, fovDegrees: number): CameraFraming | null {
  if (box.isEmpty()) return null;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDim) || !Number.isFinite(center.length())) return null;

  const fov = fovDegrees * (Math.PI / 180);
  const distance = maxDim / (2 * Math.tan(fov / 2)) * FIT_PADDING;
  return { target: center, radius: Math.max(distance, MIN_FIT_RADIUS) };
}

/** Home framing: fit the box, or the origin at the default distance when there is nothing to fit. */
export function homeFraming(box: THREE.Box3, fovDegrees: number): CameraFraming {
  return fitFraming(box, fovDegrees)
    ?? { target: new THREE.Vector3(0, 0, 0), radius: HOME_EMPTY_RADIUS };
}

/** Blend two framings at `t` in [0, 1], writing into `out`. */
export function lerpFraming(
  from: CameraFraming,
  to: CameraFraming,
  t: number,
  out: CameraFraming,
): CameraFraming {
  out.target.lerpVectors(from.target, to.target, t);
  out.radius = from.radius + (to.radius - from.radius) * t;
  return out;
}

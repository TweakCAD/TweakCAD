import { resolveSketchPlane, type SketchPlaneInput } from './SketchSceneManager';

/** Keeps the camera off the orbit poles, where the Y-up lookAt degenerates. */
const POLE_EPSILON = 0.01;

/**
 * Spherical-coordinates view (the viewport controller's convention: theta
 * from +Z around Y, phi from +Y) that looks straight down a sketch plane's
 * normal, from the side the normal points to. Used both when ENTERING sketch
 * mode and when the user clicks Home in the viewport toolbar while a sketch
 * is open — same view in both cases keeps muscle memory consistent.
 *
 * Works for any plane: the three default planes land on their standard
 * front / top / right views, and a construction plane at an arbitrary
 * orientation (e.g. a Plane from Face on a slanted face) is viewed square-on.
 */
export function sketchViewForPlane(input: SketchPlaneInput): { theta: number; phi: number } {
  const n = resolveSketchPlane(input).normal.clone().normalize();
  const phi = Math.min(Math.PI - POLE_EPSILON, Math.max(POLE_EPSILON, Math.acos(Math.min(1, Math.max(-1, n.y)))));
  const theta = Math.atan2(n.x, n.z);
  return { theta, phi };
}

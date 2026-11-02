/**
 * Whether a body face under the cursor takes the click from a sketch plane.
 *
 * A face hides a plane behind it only when the face can itself be sketched
 * on (it is flat). A curved face in front lets the plane behind it through,
 * so an origin plane inside a round body (a vase, a pipe) stays pickable.
 * With no plane under the cursor the face is reported either way, so the
 * picker can still show it as not sketchable.
 */
export function faceTakesPick(
  face: { distance: number; flat: boolean } | null,
  planeDistance: number | null,
): boolean {
  if (!face) return false;
  if (planeDistance === null) return true;
  return face.flat && face.distance < planeDistance;
}

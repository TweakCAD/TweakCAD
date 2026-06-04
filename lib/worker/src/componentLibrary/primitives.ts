/**
 * Reusable geometry helpers for the component library.
 *
 * Each helper composes the kernel's primitive ops (createSketchFace +
 * extrudeFace, makeCylinder, booleanCut, booleanFuse) into a shape that
 * isn't a kernel primitive but is a recurring building block in standard
 * mechanical parts — hex prism, annulus, etc.
 *
 * All helpers assume millimetres + the part's working coordinate system
 * (we don't apply the component's `placement.offset` here; the builder
 * passes a translated origin in).
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, ResolvedProfile } from '@tweakcad/kernel/src/types.ts';

/**
 * Build a regular hex prism centered on `origin`, extruded along
 * `axis` for `height` units.
 *
 * @param acrossFlats Distance between opposite flats (s in ISO tables).
 *   The circumscribed-circle radius is `acrossFlats / sqrt(3)`.
 * @param rotationOffset Optional rotation around the axis in radians; lets
 *   bolts and nuts line up flat-to-flat in assemblies. Defaults to 0
 *   (first vertex on the +X-equivalent direction).
 */
export async function makeHexPrism(
  kernel: CadKernel,
  origin: Vec3,
  axis: Vec3,
  acrossFlats: number,
  height: number,
  rotationOffset = 0,
): Promise<KernelBody> {
  if (acrossFlats <= 0) throw new Error(`Hex prism acrossFlats must be > 0 (got ${acrossFlats})`);
  if (height <= 0) throw new Error(`Hex prism height must be > 0 (got ${height})`);

  // Distance from center to a vertex (circumscribed-circle radius).
  // For a regular hexagon, acrossCorners = 2 * (acrossFlats / sqrt(3)).
  const circumR = acrossFlats / Math.sqrt(3);

  const { uAxis, vAxis } = orthonormalBasis(axis);

  const vertices: Vec3[] = [];
  for (let i = 0; i < 6; i++) {
    const theta = rotationOffset + (i * Math.PI) / 3;
    const u = circumR * Math.cos(theta);
    const v = circumR * Math.sin(theta);
    vertices.push([
      origin[0] + u * uAxis[0] + v * vAxis[0],
      origin[1] + u * uAxis[1] + v * vAxis[1],
      origin[2] + u * uAxis[2] + v * vAxis[2],
    ]);
  }

  const profile: ResolvedProfile = {
    type: 'polygon',
    vertices,
    center: origin,
    normal: axis,
    origin,
    uAxis,
    vAxis,
  };

  const faceResult = await kernel.createSketchFace(profile);
  if (!faceResult.ok) {
    throw new Error(`Hex prism face creation failed: ${faceResult.error.message}`);
  }

  const extrudeVec: Vec3 = [axis[0] * height, axis[1] * height, axis[2] * height];
  const bodyResult = await kernel.extrudeFace(faceResult.value, extrudeVec);
  if (!bodyResult.ok) {
    throw new Error(`Hex prism extrude failed: ${bodyResult.error.message}`);
  }
  return bodyResult.value;
}

/**
 * Annulus — a cylindrical washer: outer cylinder minus inner bore.
 * Used for nut bodies (before the hex outline) and bearing rings.
 *
 * @param origin Center of the bottom face.
 * @param axis Direction the annulus is extruded along (unit vector).
 */
export async function makeAnnulus(
  kernel: CadKernel,
  origin: Vec3,
  axis: Vec3,
  outerRadius: number,
  innerRadius: number,
  height: number,
): Promise<KernelBody> {
  if (outerRadius <= innerRadius) {
    throw new Error(`Annulus outerRadius (${outerRadius}) must be > innerRadius (${innerRadius})`);
  }
  if (innerRadius <= 0) throw new Error(`Annulus innerRadius must be > 0 (got ${innerRadius})`);
  if (height <= 0) throw new Error(`Annulus height must be > 0 (got ${height})`);

  const outerResult = await kernel.makeCylinder({
    center: origin,
    axis,
    radius: outerRadius,
    height,
  });
  if (!outerResult.ok) {
    throw new Error(`Annulus outer cylinder failed: ${outerResult.error.message}`);
  }

  const innerResult = await kernel.makeCylinder({
    center: origin,
    axis,
    radius: innerRadius,
    height,
  });
  if (!innerResult.ok) {
    throw new Error(`Annulus inner cylinder failed: ${innerResult.error.message}`);
  }

  const cutResult = await kernel.booleanCut(outerResult.value, [innerResult.value]);
  if (!cutResult.ok) {
    throw new Error(`Annulus boolean cut failed: ${cutResult.error.message}`);
  }
  return cutResult.value;
}

/**
 * Build an orthonormal basis (u, v) perpendicular to `axis`.
 *
 * `axis` is treated as already normalized — kernel primitives expect unit
 * vectors and our builders only ever pass [0,0,1] / [1,0,0] / [0,1,0].
 * If the axis happens to align with world-Z we pick world-X as the seed;
 * otherwise we pick world-Z. This keeps the resulting hex profile axis-
 * aligned in the common upright case so head flats line up with X.
 */
function orthonormalBasis(axis: Vec3): { uAxis: Vec3; vAxis: Vec3 } {
  const [ax, ay, az] = axis;
  const seed: Vec3 = Math.abs(az) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  // u = normalize(seed - (seed·axis) * axis)
  const dot = seed[0] * ax + seed[1] * ay + seed[2] * az;
  const ux = seed[0] - dot * ax;
  const uy = seed[1] - dot * ay;
  const uz = seed[2] - dot * az;
  const ulen = Math.hypot(ux, uy, uz) || 1;
  const u: Vec3 = [ux / ulen, uy / ulen, uz / ulen];
  // v = axis × u
  const v: Vec3 = [
    ay * u[2] - az * u[1],
    az * u[0] - ax * u[2],
    ax * u[1] - ay * u[0],
  ];
  return { uAxis: u, vAxis: v };
}

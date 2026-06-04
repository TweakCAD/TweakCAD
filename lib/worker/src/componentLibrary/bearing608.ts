/**
 * 608-class deep-groove ball bearing.
 *
 * Geometry: outer ring + inner ring as two separate annular bodies with
 * a small axial offset so a section view shows the raceway. Balls are
 * intentionally omitted — modelling them sextuples the face count for a
 * detail nobody looks at in CAD work. A future Cosmetic Thread / Ball
 * Visualization pass can render them as instanced meshes.
 *
 * The bearing sits axis-along-Z with its lower face on Z = 0.
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { BEARING_608 } from './standards.ts';
import { makeAnnulus } from './primitives.ts';
import { readNumberParameter } from './paramReaders.ts';

type BuildArgs = {
  parameters: Record<string, unknown>;
  origin: Vec3;
};

export const BALL_BEARING_SLUGS = new Set<string>(['ball-bearing-608']);

export async function buildBallBearing(
  _slug: string,
  args: BuildArgs,
  kernel: CadKernel,
): Promise<KernelBody[]> {
  // For 608 all dimensions are fixed in the standard, but allow overrides
  // so a future "deep-groove 6000-series" component can share this code.
  const outerDiameter =
    readNumberParameter(args.parameters, 'outerDiameter', 'od', 'OD') ?? BEARING_608.outerDiameter;
  const innerDiameter =
    readNumberParameter(args.parameters, 'innerDiameter', 'id', 'bore') ?? BEARING_608.innerDiameter;
  const width = readNumberParameter(args.parameters, 'width', 'thickness') ?? BEARING_608.width;
  const raceDepth =
    readNumberParameter(args.parameters, 'raceDepth') ?? BEARING_608.raceDepth;

  if (outerDiameter <= innerDiameter) {
    throw new Error(
      `Bearing OD (${outerDiameter}) must be > ID (${innerDiameter})`,
    );
  }
  if (width <= 0) throw new Error(`Bearing width must be > 0 (got ${width})`);

  const axis: Vec3 = [0, 0, 1];
  const o = args.origin;

  // Pick rough race radii from the OD/ID gap; the 608 standard's raceway
  // sits roughly in the middle of the gap.
  const outerR = outerDiameter / 2;
  const innerR = innerDiameter / 2;
  const gap = outerR - innerR;
  const outerRaceR = innerR + gap * 0.65;
  const innerRaceR = innerR + gap * 0.35;

  // Outer ring: outerDiameter → outerRaceR, full width.
  const outerRing = await makeAnnulus(kernel, o, axis, outerR, outerRaceR, width);

  // Inner ring: innerRaceR → innerDiameter, full width.
  const innerRing = await makeAnnulus(kernel, o, axis, innerRaceR, innerR, width);

  // Cosmetic race step: shave a thin annulus off the top of the outer
  // ring so a section view shows a visible raceway. Skipped if raceDepth
  // is non-positive (lets tests turn it off).
  let outerFinal = outerRing;
  if (raceDepth > 0 && raceDepth < width) {
    const topOrigin: Vec3 = [o[0], o[1], o[2] + width - raceDepth];
    const stepResult = await kernel.makeCylinder({
      center: topOrigin,
      axis,
      radius: outerRaceR + (gap * 0.1), // slightly into the outer ring
      height: raceDepth,
    });
    if (stepResult.ok) {
      const cut = await kernel.booleanCut(outerRing, [stepResult.value]);
      if (cut.ok) outerFinal = cut.value;
    }
  }

  return [outerFinal, innerRing];
}

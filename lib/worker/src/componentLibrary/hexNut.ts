/**
 * ISO 4032 standard hex nut.
 *
 * A hex prism with a through-hole at the major thread diameter. As with
 * the bolt builder, we don't model the actual thread helix.
 *
 * The bottom face sits on Z = 0 so the nut can be dropped onto a host
 * face without further translation (matches the bolt convention so a
 * stack of nut + part + bolt aligns by default).
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { HEX_NUTS, type HexThread } from './standards.ts';
import { makeHexPrism } from './primitives.ts';
import { readNumberParameter, readEnumParameter } from './paramReaders.ts';

type BuildArgs = {
  parameters: Record<string, unknown>;
  origin: Vec3;
};

export const HEX_NUT_SLUGS = new Set<string>([
  'iso-4032-hex-nut-m3',
  'iso-4032-hex-nut-m4',
  'iso-4032-hex-nut-m5',
  'iso-4032-hex-nut-m6',
  'iso-4032-hex-nut-m8',
]);

const SLUG_TO_THREAD: Record<string, HexThread> = {
  'iso-4032-hex-nut-m3': 'M3',
  'iso-4032-hex-nut-m4': 'M4',
  'iso-4032-hex-nut-m5': 'M5',
  'iso-4032-hex-nut-m6': 'M6',
  'iso-4032-hex-nut-m8': 'M8',
};

export async function buildHexNut(
  slug: string,
  args: BuildArgs,
  kernel: CadKernel,
): Promise<KernelBody[]> {
  const thread = resolveThread(slug, args.parameters);
  const dims = HEX_NUTS[thread];

  const diameter = readNumberParameter(args.parameters, 'diameter', 'd') ?? dims.diameter;
  const thickness =
    readNumberParameter(args.parameters, 'thickness', 'height', 'h') ?? dims.thickness;

  if (diameter <= 0) throw new Error(`Nut diameter must be > 0 (got ${diameter})`);
  if (thickness <= 0) throw new Error(`Nut thickness must be > 0 (got ${thickness})`);
  if (diameter >= dims.acrossFlats) {
    // Through-hole would breach the flats — not a real nut.
    throw new Error(
      `Nut bore (${diameter}) >= across-flats (${dims.acrossFlats}); pick a smaller diameter`,
    );
  }

  const axis: Vec3 = [0, 0, 1];
  const o = args.origin;

  const prism = await makeHexPrism(kernel, o, axis, dims.acrossFlats, thickness);

  const boreResult = await kernel.makeCylinder({
    center: o,
    axis,
    radius: diameter / 2,
    height: thickness,
  });
  if (!boreResult.ok) {
    throw new Error(`Nut bore failed: ${boreResult.error.message}`);
  }

  const cut = await kernel.booleanCut(prism, [boreResult.value]);
  if (!cut.ok) {
    throw new Error(`Nut prism − bore failed: ${cut.error.message}`);
  }
  return [cut.value];
}

function resolveThread(slug: string, parameters: Record<string, unknown>): HexThread {
  const fromParam = readEnumParameter(parameters, ['thread', 'size']);
  if (fromParam && isHexThread(fromParam)) return fromParam;
  return SLUG_TO_THREAD[slug] ?? 'M5';
}

function isHexThread(value: string): value is HexThread {
  return value === 'M3' || value === 'M4' || value === 'M5' || value === 'M6' || value === 'M8';
}

/**
 * ISO 4017 fully-threaded hex bolt — simplified (no thread spiral).
 *
 * The shank is a smooth cylinder at the major thread diameter; modelling
 * the actual thread helix is intentionally deferred (it 100x'es face count
 * for no real benefit at our display scale). When users want a "real"
 * thread visualization we'll add a thread-cosmetic pass that produces a
 * texture/render hint rather than baked geometry.
 *
 * Coordinate convention:
 *   - bolt axis is +Z
 *   - head sits at the origin (head bottom face on the XY plane)
 *   - shank extends downward (head sits "on top of" the host face)
 *
 * This matches the seed `installHint` of "snaps head-down onto the
 * selected face" — a Phase A insert at the origin draws a bolt with its
 * underside flush with XY.
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { HEX_BOLTS, type HexThread } from './standards.ts';
import { makeHexPrism } from './primitives.ts';
import { readNumberParameter, readEnumParameter } from './paramReaders.ts';

type BuildArgs = {
  parameters: Record<string, unknown>;
  origin: Vec3;
};

/** Slugs the bolt builder handles. */
export const HEX_BOLT_SLUGS = new Set<string>([
  'iso-4017-hex-bolt-m3',
  'iso-4017-hex-bolt-m4',
  'iso-4017-hex-bolt-m5',
  'iso-4017-hex-bolt-m6',
  'iso-4017-hex-bolt-m8',
]);

/** Map slug → default thread size (used when the manifest didn't ship a `thread` param). */
const SLUG_TO_THREAD: Record<string, HexThread> = {
  'iso-4017-hex-bolt-m3': 'M3',
  'iso-4017-hex-bolt-m4': 'M4',
  'iso-4017-hex-bolt-m5': 'M5',
  'iso-4017-hex-bolt-m6': 'M6',
  'iso-4017-hex-bolt-m8': 'M8',
};

export async function buildHexBolt(
  slug: string,
  args: BuildArgs,
  kernel: CadKernel,
): Promise<KernelBody[]> {
  const thread = resolveThread(slug, args.parameters);
  const dims = HEX_BOLTS[thread];

  // Diameter parameter overrides the standard's value (useful for
  // non-standard threads or close-tolerance fits). Length is the shank
  // length only — head height is added on top.
  const diameter = readNumberParameter(args.parameters, 'diameter', 'd') ?? dims.diameter;
  const length = readNumberParameter(args.parameters, 'length', 'l') ?? 20;

  if (diameter <= 0) throw new Error(`Bolt diameter must be > 0 (got ${diameter})`);
  if (length <= 0) throw new Error(`Bolt length must be > 0 (got ${length})`);

  const axis: Vec3 = [0, 0, 1];
  const o = args.origin;

  // Head sits with its bottom face at the origin; extrude *up* along +Z.
  const head = await makeHexPrism(
    kernel,
    o,
    axis,
    dims.acrossFlats,
    dims.headHeight,
  );

  // Shank starts at the head bottom face and extends *down* along -Z so
  // the user sees a bolt sticking into the part when dropped on a face.
  const shankResult = await kernel.makeCylinder({
    center: o,
    axis: [0, 0, -1],
    radius: diameter / 2,
    height: length,
  });
  if (!shankResult.ok) {
    throw new Error(`Bolt shank failed: ${shankResult.error.message}`);
  }

  const fused = await kernel.booleanFuse([head, shankResult.value]);
  if (!fused.ok) {
    throw new Error(`Bolt head+shank fuse failed: ${fused.error.message}`);
  }
  return [fused.value];
}

function resolveThread(slug: string, parameters: Record<string, unknown>): HexThread {
  const fromParam = readEnumParameter(parameters, ['thread', 'size']);
  if (fromParam && isHexThread(fromParam)) return fromParam;
  return SLUG_TO_THREAD[slug] ?? 'M5';
}

function isHexThread(value: string): value is HexThread {
  return value === 'M3' || value === 'M4' || value === 'M5' || value === 'M6' || value === 'M8';
}

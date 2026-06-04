/**
 * Component library dispatcher.
 *
 * Maps a component slug (e.g. `iso-4017-hex-bolt-m5`) to a TypeScript
 * builder that calls the `CadKernel` to produce the body or bodies for
 * that standard.
 *
 * Why slug-keyed dispatch (rather than each component shipping its own
 * `.cadjson` feature timeline):
 *   - the seed catalog is curated and small (~12 SKUs); a per-slug
 *     function is shorter and faster to debug than a stored timeline
 *   - until the components panel publishes user-authored components,
 *     there's no other source of geometry to evaluate
 *   - it gives us a single, audited surface for the geometry the staff
 *     catalog ships — important for the parts that real users will rely on
 *
 * When the SaaS catalog grows to accept user-authored components, this
 * dispatcher gets a second branch: "no slug match → evaluate the stored
 * nested timeline".
 *
 * If a slug doesn't match any registered builder we fall back to a small
 * placeholder cylinder so the timeline still has a visible node. This
 * keeps "new component published before the worker bundle ships the
 * builder" from breaking everyone's editor.
 */

import type { Vec3 } from '@tweakcad/core/src/math.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { buildHexBolt, HEX_BOLT_SLUGS } from './hexBolt.ts';
import { buildHexNut, HEX_NUT_SLUGS } from './hexNut.ts';
import { buildBallBearing, BALL_BEARING_SLUGS } from './bearing608.ts';
import { readNumberParameter } from './paramReaders.ts';

/** Inputs shared by every component builder. */
export type ComponentBuildArgs = {
  parameters: Record<string, unknown>;
  origin: Vec3;
};

export type ComponentBuilder = (
  slug: string,
  args: ComponentBuildArgs,
  kernel: CadKernel,
) => Promise<KernelBody[]>;

/** Look up the builder for a slug, or return null when no builder exists. */
export function lookupComponentBuilder(slug: string): ComponentBuilder | null {
  if (HEX_BOLT_SLUGS.has(slug)) return buildHexBolt;
  if (HEX_NUT_SLUGS.has(slug)) return buildHexNut;
  if (BALL_BEARING_SLUGS.has(slug)) return buildBallBearing;
  return null;
}

/** True iff the slug has a real (non-placeholder) builder. Exposed for tests + UI. */
export function hasComponentBuilder(slug: string): boolean {
  return lookupComponentBuilder(slug) !== null;
}

/**
 * Placeholder body for slugs that don't yet have a builder.
 *
 * Mirrors the old `buildComponentInstance` behavior so users still see
 * something in the viewport when a brand-new component lands in the
 * catalog before its builder ships in the worker bundle.
 */
export async function buildPlaceholder(
  args: ComponentBuildArgs,
  kernel: CadKernel,
): Promise<KernelBody[]> {
  const diameter =
    readNumberParameter(args.parameters, 'diameter', 'd', 'size', 'width') ?? 8;
  const height =
    readNumberParameter(args.parameters, 'length', 'height', 'l', 'h') ?? 16;
  const radius = Math.max(diameter / 2, 0.5);
  const safeHeight = Math.max(height, 1);

  const result = await kernel.makeCylinder({
    center: args.origin,
    axis: [0, 0, 1],
    radius,
    height: safeHeight,
  });
  if (!result.ok) {
    throw new Error(`Component placeholder build failed: ${result.error.message}`);
  }
  return [result.value];
}

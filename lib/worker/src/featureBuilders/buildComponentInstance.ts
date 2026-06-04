/**
 * Component instance feature builder.
 *
 * Dispatches to the slug-keyed component library (`componentLibrary/`).
 * Each known standard slug — `iso-4017-hex-bolt-m5`, `iso-4032-hex-nut-m5`,
 * `ball-bearing-608`, etc. — has a TypeScript builder that calls the
 * `CadKernel` to produce the body or bodies for that part. Unknown slugs
 * fall back to a placeholder cylinder so the timeline still has a visible
 * node while a new standard is being implemented.
 *
 * Boolean mode (`inputs.boolean`):
 *   - `newBody` (default): the component bodies are kept as-is.
 *   - `cut`:    the component bodies are subtracted from every existing
 *               host body in the part. Lets a screw / dowel-pin component
 *               punch its own hole.
 *   - `join`:   the component bodies are fused with every existing host
 *               body. Lets a boss / mounting-tab component graft onto a
 *               part without a separate Combine feature.
 *
 * Mirrors the boolean semantics of `ExtrudeFeatureInputs.operation`.
 */

import type { FeatureNode, ComponentInstanceFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { bodyId } from '@tweakcad/core/src/ids.ts';
import type { BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { lookupComponentBuilder, buildPlaceholder } from '../componentLibrary/index.ts';

export async function buildComponentInstance(
  node: FeatureNode,
  _params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as ComponentInstanceFeatureInputs;
  const slug = inputs.componentSlug;
  const parameters = inputs.parameters ?? {};
  const origin = inputs.placement?.offset ?? [0, 0, 0];
  const mode = inputs.boolean ?? 'newBody';

  // Produce the component's own bodies via the slug-keyed library.
  const builder = lookupComponentBuilder(slug);
  const componentBodies = builder
    ? await builder(slug, { parameters, origin }, kernel)
    : await buildPlaceholder({ parameters, origin }, kernel);

  if (componentBodies.length === 0) {
    throw new Error(`Component builder produced no bodies for ${slug}`);
  }

  // Apply boolean operation against existing host bodies (if any).
  // The feature id is forwarded so the helpers can build deterministic
  // body ids — random ids would break user-captured FaceRef/EdgeRef on
  // a component body across rebuilds.
  if (mode === 'newBody' || context.bodies.size === 0) {
    return wrapBodies(componentBodies, node.id);
  }

  if (mode === 'cut') {
    return cutFromHosts(componentBodies, context, kernel, node.id);
  }
  return joinWithHosts(componentBodies, context, kernel, node.id);
}

function wrapBodies(bodies: KernelBody[], featureIdValue: FeatureId): BuildResult {
  return {
    bodies: bodies.map((handle, i) => ({
      bodyId: bodyId(`body_${featureIdValue}_${i}`),
      handle,
    })),
  };
}

/**
 * Subtract every component body from every host body, in-place.
 *
 * We delete each consumed host from `context.bodies` and re-insert the
 * cut result under a fresh id — same convention as `buildFillet` /
 * `buildExtrude(cut)`. This lets the rebuilder's consumed/created body
 * tracker detect the swap automatically.
 */
async function cutFromHosts(
  componentBodies: KernelBody[],
  context: BuildContext,
  kernel: CadKernel,
  featureIdValue: FeatureId,
): Promise<BuildResult> {
  const builtBodies: { bodyId: BodyId; handle: unknown }[] = [];
  const hostEntries = Array.from(context.bodies.entries()) as Array<[BodyId, KernelBody]>;

  let idx = 0;
  for (const [hostId, hostHandle] of hostEntries) {
    const result = await kernel.booleanCut(hostHandle, componentBodies);
    if (!result.ok) {
      throw new Error(`Component cut against host body failed: ${result.error.message}`);
    }
    context.bodies.delete(hostId);
    builtBodies.push({ bodyId: bodyId(`body_${featureIdValue}_${idx++}`), handle: result.value });
  }

  return { bodies: builtBodies };
}

/** Fuse every component body with every host body into a single combined body. */
async function joinWithHosts(
  componentBodies: KernelBody[],
  context: BuildContext,
  kernel: CadKernel,
  featureIdValue: FeatureId,
): Promise<BuildResult> {
  const hostEntries = Array.from(context.bodies.entries()) as Array<[BodyId, KernelBody]>;
  const allTargets: KernelBody[] = [
    ...hostEntries.map(([, handle]) => handle),
    ...componentBodies,
  ];

  const fused = await kernel.booleanFuse(allTargets);
  if (!fused.ok) {
    throw new Error(`Component join with hosts failed: ${fused.error.message}`);
  }

  // Mark every host consumed.
  for (const [hostId] of hostEntries) {
    context.bodies.delete(hostId);
  }
  return {
    bodies: [{ bodyId: bodyId(`body_${featureIdValue}_0`), handle: fused.value }],
  };
}

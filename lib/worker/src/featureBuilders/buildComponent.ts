/**
 * `component` feature builder.
 *
 * Rebuilds an embedded parametric component instance into the host
 * part. Pipeline:
 *
 *   1. Look up `project.embeddedComponents[componentRef]`. Missing =
 *      feature fails with a clear "source component missing from
 *      embedded store" diagnostic.
 *   2. Cycle defense: if `componentRef` is already in `visited` we'd
 *      recurse forever. Fail the feature and let downstream block.
 *   3. Take the embedded source's first part (a .cadcomponent has
 *      exactly one part by convention).
 *   4. Compute the effective parameter table:
 *        a. start with the embedded part's `parameters`
 *        b. overlay the active configuration row's overrides
 *           (per-instance `configurationId` wins over the embedded
 *            component's own `configurations.active`)
 *        c. overlay the per-instance `parameterOverrides`
 *   5. Run that part's timeline through the same builder dispatch the
 *      host part uses (`runSubTimeline`). Cycle defense set is threaded
 *      through so nested components also get checked.
 *   6. Collect the final bodies from the sub-build's context. Each
 *      becomes a body of THIS feature with a deterministic id
 *      (`body_imported_<featureId>_<i>`) so user-captured face/edge
 *      refs survive subsequent rebuilds.
 *   7. Apply `inputs.transform` to each body, before any boolean — a
 *      `cut` instance has to be where the user put it for the subtraction
 *      to land in the right place.
 *   8. Apply `inputs.boolean` against existing host bodies — same
 *      cut/join/newBody semantics as `ExtrudeFeatureInputs.operation`.
 *      A cut or join keeps the host bodies' ids; only `newBody` publishes
 *      the step-6 ids.
 */

import type {
  FeatureNode,
  CadProject,
  CadPart,
  ComponentFeatureInputs,
  ParameterTable,
  ParameterValue,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import type { Transform3D } from '@tweakcad/core/src/math.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import type { BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { runSubTimeline } from '../subTimelineRunner.ts';
import { carryBodyId } from './bodyIdentity.ts';
import { releaseShapes } from './releaseShapes.ts';

export async function buildComponent(
  node: FeatureNode,
  _params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
  project: CadProject,
  visited: Set<string>,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as ComponentFeatureInputs;
  const ref = inputs.componentRef;
  if (!ref) {
    throw new Error('component feature missing componentRef');
  }

  const def = project.embeddedComponents?.[ref];
  if (!def) {
    throw new Error(
      `Embedded component "${ref}" not found in project.embeddedComponents. ` +
      `The component may have been removed or the project file is corrupt.`,
    );
  }

  // Cycle defense. A component embedding itself (directly or via a
  // chain) would recurse forever; here we cut the recursion and let
  // cascade-block flag downstream.
  if (visited.has(ref)) {
    throw new Error(
      `COMPONENT_CYCLE: embedded component "${def.name}" (ref ${ref.slice(0, 8)}…) ` +
      `transitively contains itself`,
    );
  }
  const subVisited = new Set(visited);
  subVisited.add(ref);

  // The embedded source has exactly one part by convention. If it grew
  // multiple, the first part wins (the "main part"); we
  // could revisit this if multi-part components become a real need.
  const sourcePartIds = Object.keys(def.source.parts);
  const sourcePartId = sourcePartIds[0];
  if (!sourcePartId) {
    throw new Error(`Embedded component "${def.name}" has no parts`);
  }
  const sourcePart = def.source.parts[sourcePartId as keyof typeof def.source.parts];
  if (!sourcePart) {
    throw new Error(`Embedded component "${def.name}" first part not resolvable`);
  }

  // Build the effective parameter tables (project + part scope) for
  // this instance. The configuration ID from the feature inputs takes
  // precedence over the component's own `configurations.active` so
  // two instances can use different configs (e.g. one M3 and one M4
  // from the same Bolt component).
  //
  // Overrides flow into whichever scope holds the parameter — author-
  // friendly: most .cadcomponent files (including the dowel_pin /
  // washer / bolt stubs in /components/) declare their public params
  // at the PROJECT scope rather than the part scope, because the
  // component IS the project from the author's perspective.
  const { source: effectiveSource, part: effectivePart } = applyInstanceOverrides(
    def.source,
    sourcePart,
    inputs.parameterOverrides ?? {},
    inputs.configurationId,
  );

  // Recursively build the sub-timeline. The recursive call uses its
  // OWN BuildContext (a fresh map) so sub-feature body IDs don't
  // collide with host body IDs; we re-issue stable IDs below.
  const subResult = await runSubTimeline(
    effectivePart,
    effectiveSource,
    kernel,
    subVisited,
  );
  if (subResult.error) {
    throw new Error(
      `Component "${def.name}" build failed: ${subResult.error}`,
    );
  }

  const componentBodies = subResult.bodies;
  if (componentBodies.length === 0) {
    throw new Error(
      `Component "${def.name}" produced no bodies — check its timeline`,
    );
  }

  // Place the component before any boolean runs. A `cut` instance has to be
  // where the user put it for the subtraction to land in the right place —
  // transforming afterwards would move the hole instead of making it.
  const placedBodies = await placeBodies(componentBodies, inputs.transform, kernel);

  const mode = inputs.boolean ?? 'newBody';
  if (mode === 'newBody' || context.bodies.size === 0) {
    return wrapBodies(placedBodies, node.id);
  }
  try {
    return mode === 'cut'
      ? await cutFromHosts(placedBodies, context, kernel)
      : await joinWithHosts(placedBodies, context, kernel, node.id);
  } finally {
    // Cut out of or fused into the hosts, the component's own bodies are
    // spent — and on a failed boolean they are not published either.
    releaseShapes(kernel, placedBodies);
  }
}

/**
 * Build the effective parameter tables (project AND part scope) for
 * this component instance. Merge order (later wins):
 *   part defaults → active config row → per-instance overrides.
 *
 * Returns NEW CadProject + CadPart objects with the merged parameters;
 * the originals from the embedded source are not mutated (Immer's
 * frozen-by-default contract — we must not clobber the cached
 * embedded payload).
 *
 * Per-instance overrides flow into whichever scope holds the
 * parameter — author-friendly: most .cadcomponent files (including
 * the stubs in /components/) declare their public params at the
 * PROJECT scope rather than the part scope, because the component IS
 * the project from the author's perspective. Configuration row
 * overrides stay PART-scoped (validation in configurationCommands.ts
 * already rejects rows that try to override project-scope params).
 */
function applyInstanceOverrides(
  source: CadProject,
  part: CadPart,
  perInstance: Record<string, string>,
  perInstanceConfigId: string | null | undefined,
): { source: CadProject; part: CadPart } {
  let partParams: ParameterTable = part.parameters;
  let projectParams: ParameterTable = source.parameters;

  // 1) active configuration row's overrides. A per-instance row id wins over
  //    the embedded part's `configurations.active`; `null` means the
  //    parameter defaults, ignoring the component's active row; absent means
  //    inherit that active row. `null` used to inherit too, so the dialog's
  //    "(use defaults)" — which saves `null` — built the active preset.
  const configTable = part.configurations;
  if (configTable) {
    const activeId = perInstanceConfigId === undefined
      ? configTable.active
      : perInstanceConfigId;
    if (activeId !== null) {
      const row = configTable.rows.find(r => r.id === activeId);
      if (row) {
        partParams = applyOverrides(partParams, row.overrides);
      }
    }
  }

  // 2) per-instance parameter overrides (highest precedence). Walk the
  //    override map and apply to whichever scope holds the param;
  //    overrides for unknown names are silently dropped (the dialog
  //    only exposes existing names, so unknown names = stale UI / hand-
  //    edited JSON).
  for (const [name, expr] of Object.entries(perInstance)) {
    if (expr.trim() === '') continue;
    if (partParams.values[name]) {
      partParams = {
        values: {
          ...partParams.values,
          [name]: { ...partParams.values[name]!, expression: expr },
        },
      };
    } else if (projectParams.values[name]) {
      projectParams = {
        values: {
          ...projectParams.values,
          [name]: { ...projectParams.values[name]!, expression: expr },
        },
      };
    }
  }

  // The merge above is final for this instance, so the effective part must
  // not look like it still has a configuration waiting to be applied:
  // `runSubTimeline` calls `applyActiveConfiguration` on whatever part it is
  // given, and that would re-apply the component's OWN active row on top —
  // silently discarding the per-instance `configurationId` the user picked.
  // Clearing `active` makes that call a no-op while keeping the rows, which
  // the dialog still reads to offer the choice.
  const settledConfigurations = part.configurations
    ? { ...part.configurations, active: null }
    : undefined;

  return {
    source: { ...source, parameters: projectParams },
    part: {
      ...part,
      parameters: partParams,
      ...(settledConfigurations ? { configurations: settledConfigurations } : {}),
    },
  };
}

/**
 * Mirror of `applyOverrides` in configurationCommands.ts — kept local
 * to avoid pulling a worker-side dependency on the core handler
 * module. Overrides REPLACE the parameter's `expression`, leaving
 * unit/kind/options/etc. intact so a numeric override of `D=3` doesn't
 * accidentally also change unit or kind.
 */
function applyOverrides(
  table: Readonly<ParameterTable>,
  overrides: Record<string, string>,
): ParameterTable {
  const next: Record<string, ParameterValue> = {};
  for (const [name, param] of Object.entries(table.values)) {
    const override = overrides[name];
    if (override !== undefined) {
      next[name] = { ...param, expression: override };
    } else {
      next[name] = param;
    }
  }
  return { values: next };
}

function isIdentityTransform(t: Transform3D | undefined): boolean {
  if (!t) return true;
  const [px, py, pz] = t.position;
  const [rx, ry, rz, rw] = t.rotation;
  return px === 0 && py === 0 && pz === 0 && rx === 0 && ry === 0 && rz === 0 && rw === 1;
}

/**
 * Move every body of the component into its placement.
 *
 * Applied per body rather than to a fused compound: the component may emit
 * several bodies and fusing them to place them would destroy that separation,
 * which the user can see in the tree.
 *
 * The identity case returns the handles untouched — `kernel.transform`
 * produces a *derived* body, and a component sitting at the origin (the
 * common case) has nothing to derive. The transform is rigid, so stable
 * face/edge ids carry across it by hash-match and user-captured refs on a
 * component body survive being moved.
 */
async function placeBodies(
  bodies: KernelBody[],
  transform: Transform3D | undefined,
  kernel: CadKernel,
): Promise<KernelBody[]> {
  if (isIdentityTransform(transform) || !transform) return bodies;
  const placed: KernelBody[] = [];
  try {
    for (const body of bodies) {
      const result = await kernel.transform(body, transform);
      if (!result.ok) {
        throw new Error(`Failed to place component: ${result.error.message}`);
      }
      placed.push(result.value);
    }
  } catch (error) {
    releaseShapes(kernel, placed);
    throw error;
  } finally {
    // `transform` derives new bodies; the copies at the origin are spent.
    releaseShapes(kernel, bodies);
  }
  return placed;
}

function wrapBodies(bodies: KernelBody[], featureIdValue: FeatureId): BuildResult {
  return {
    bodies: bodies.map((handle, i) => ({
      bodyId: bodyIdBrand(`body_imported_${featureIdValue}_${i}`),
      handle,
    })),
  };
}

/**
 * Subtract every component body from every host body.
 *
 * Each host keeps its id (`bodyIdentity.ts`: a modifier carries the id of
 * the body it changes). Minting `body_imported_…` ids here retired the host's
 * id, so every downstream feature holding a ref to the host — a Move, a
 * fillet's edges — lost its target as soon as a cut instance was inserted
 * upstream of it.
 *
 * All or nothing: hosts leave the build context only once every cut has
 * succeeded, so a failed cut leaves the part as it was.
 */
async function cutFromHosts(
  componentBodies: KernelBody[],
  context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const builtBodies: { bodyId: BodyId; handle: KernelBody }[] = [];
  const hostEntries = Array.from(context.bodies.entries()) as Array<[BodyId, KernelBody]>;

  try {
    for (const [hostId, hostHandle] of hostEntries) {
      const result = await kernel.booleanCut(hostHandle, componentBodies);
      if (!result.ok) {
        throw new Error(`Component cut against host body failed: ${result.error.message}`);
      }
      builtBodies.push({ bodyId: carryBodyId(hostId), handle: result.value });
    }
  } catch (error) {
    // Free the cuts already made; the hosts are still in the context.
    releaseShapes(kernel, builtBodies.map(b => b.handle));
    throw error;
  }
  for (const [hostId] of hostEntries) context.bodies.delete(hostId);
  return { bodies: builtBodies };
}

/**
 * Fuse the component into the host bodies. The result carries the first
 * host's id (`bodyIdentity.ts`: a merge keeps the primary target's id, the
 * first body in build order when nothing is picked); the other hosts are
 * consumed. With no host to join, the component's bodies fuse into a body of
 * this feature's own.
 */
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
  for (const [hostId] of hostEntries) {
    context.bodies.delete(hostId);
  }
  const primary = hostEntries[0];
  return {
    bodies: [{
      bodyId: primary ? carryBodyId(primary[0]) : bodyIdBrand(`body_imported_${featureIdValue}_0`),
      handle: fused.value,
    }],
  };
}

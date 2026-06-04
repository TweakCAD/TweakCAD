/**
 * `importedComponent` feature builder.
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
 *   7. Apply `inputs.transform`. v1 ships identity-only; the transform
 *      UX is not yet wired. Non-identity transforms are logged as a
 *      build warning but not applied (no UX to produce them yet).
 *   8. Apply `inputs.boolean` against existing host bodies — same
 *      cut/join/newBody semantics as the legacy `componentInstance`
 *      builder (mirrors `ExtrudeFeatureInputs.operation`).
 */

import type {
  FeatureNode,
  CadProject,
  CadPart,
  ImportedComponentFeatureInputs,
  ParameterTable,
  ParameterValue,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import type { BodyId, FeatureId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import { runSubTimeline } from '../subTimelineRunner.ts';

export async function buildImportedComponent(
  node: FeatureNode,
  _params: ResolvedParams,
  context: BuildContext,
  kernel: CadKernel,
  project: CadProject,
  visited: Set<string>,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as ImportedComponentFeatureInputs;
  const ref = inputs.componentRef;
  if (!ref) {
    throw new Error('importedComponent feature missing componentRef');
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
    inputs.configurationId ?? null,
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

  // v1 transform: log only. Applying the actual gp_Trsf will need a
  // new kernel call. For now any non-identity transform sits at
  // origin like identity does.
  if (!isIdentityTransform(inputs.transform)) {
    console.warn(
      `[buildImportedComponent] Non-identity transform on "${def.name}" — ` +
      `Phase 6 will apply it; component currently lands at origin`,
    );
  }

  const mode = inputs.boolean ?? 'newBody';
  if (mode === 'newBody' || context.bodies.size === 0) {
    return wrapBodies(componentBodies, node.id);
  }
  if (mode === 'cut') {
    return cutFromHosts(componentBodies, context, kernel, node.id);
  }
  return joinWithHosts(componentBodies, context, kernel, node.id);
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
  perInstanceConfigId: string | null,
): { source: CadProject; part: CadPart } {
  let partParams: ParameterTable = part.parameters;
  let projectParams: ParameterTable = source.parameters;

  // 1) active configuration row's overrides. Per-instance configurationId
  //    overrides the embedded part's `configurations.active`; pass `null`
  //    explicitly to mean "ignore any active config the component picked".
  const configTable = part.configurations;
  if (configTable) {
    const activeId = perInstanceConfigId !== null
      ? perInstanceConfigId
      : configTable.active;
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

  return {
    source: { ...source, parameters: projectParams },
    part: { ...part, parameters: partParams },
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

function isIdentityTransform(t: { position: [number, number, number]; rotation: [number, number, number, number] }): boolean {
  if (!t) return true;
  const [px, py, pz] = t.position;
  const [rx, ry, rz, rw] = t.rotation;
  return px === 0 && py === 0 && pz === 0 && rx === 0 && ry === 0 && rz === 0 && rw === 1;
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
 * Subtract every component body from every host body, in-place — same
 * pattern as `buildComponentInstance.cutFromHosts`.
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
    builtBodies.push({ bodyId: bodyIdBrand(`body_imported_${featureIdValue}_${idx++}`), handle: result.value });
  }
  return { bodies: builtBodies };
}

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
  return {
    bodies: [{ bodyId: bodyIdBrand(`body_imported_${featureIdValue}_0`), handle: fused.value }],
  };
}

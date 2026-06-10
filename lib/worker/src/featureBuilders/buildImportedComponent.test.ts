/**
 * buildImportedComponent tests — unit-level, MockKernel-backed.
 *
 * Three properties pinned down here:
 *   1. Happy path — a tiny embedded component with one sketch + one
 *      extrude produces a body that surfaces under the host feature's
 *      `body_imported_<featureId>_0` id.
 *   2. Missing componentRef in embeddedComponents → throws a clear
 *      message (the rebuilder turns this into a feature-level failure).
 *   3. Cycle defense — when the visited set already contains the ref,
 *      throw COMPONENT_CYCLE without recursing.
 *
 * Per-instance parameter overrides and configurationId merge logic are
 * covered indirectly by these tests + the handler-level tests; full
 * end-to-end is verified separately in the browser.
 */
import { describe, expect, it } from 'vitest';
import { buildImportedComponent } from './buildImportedComponent.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { emptyProject, createPart } from '@tweakcad/core/src/document/factory.ts';
import type {
  CadProject,
  CadPart,
  ComponentDefinition,
  FeatureNode,
  ImportedComponentFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { featureId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

/** Build an embedded source with one sketch + extrude producing one body. */
function makeSourceWithBody(name: string): CadProject {
  const proj = emptyProject(name);
  const part = createPart(name);
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  part.timeline.push({
    id: 'sketch_inner' as never,
    type: 'sketch',
    name: 'profile',
    version: 1,
    enabled: true,
    visible: true,
    dependsOn: [],
    inputs: {
      plane: { type: 'defaultPlane', name: 'XY' },
      buildGeometry: {
        c1: { id: 'c1', type: 'circle', center: ['0', '0'], diameter: '10' },
      },
    },
    createdAt: now,
    updatedAt: now,
  });
  part.timeline.push({
    id: 'ext_inner' as never,
    type: 'extrude',
    name: 'body',
    version: 1,
    enabled: true,
    visible: true,
    dependsOn: ['sketch_inner' as never],
    inputs: {
      profiles: [{ sketchId: 'sketch_inner', wireEntityIds: ['c1'] }],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '4' },
    },
    createdAt: now,
    updatedAt: now,
  });
  proj.parts[part.id] = part;
  return proj;
}

function makeDef(hash: string, source: CadProject, name = 'Test'): ComponentDefinition {
  return {
    hash,
    name,
    embeddedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    source,
  };
}

function makeFeature(componentRef: string, mode: 'newBody' | 'cut' | 'join' = 'newBody'): FeatureNode {
  const inputs: ImportedComponentFeatureInputs = {
    componentRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    parameterOverrides: {},
    boolean: mode,
  };
  return {
    id: featureId('imp_1'),
    type: 'importedComponent',
    name: 'Test instance',
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  };
}

async function freshKernel(): Promise<MockKernel> {
  const kernel = new MockKernel();
  await kernel.init();
  return kernel;
}

describe('buildImportedComponent', () => {
  it('rebuilds an embedded component and surfaces its body under the host featureId', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    const source = makeSourceWithBody('Dowel');
    const def = makeDef('hash-dowel', source, 'Dowel');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { 'hash-dowel': def };

    const feature = makeFeature('hash-dowel', 'newBody');
    const result = await buildImportedComponent(
      feature,
      {} as ResolvedParams,
      ctx,
      kernel,
      project,
      new Set(),
    );

    expect(result.bodies).toHaveLength(1);
    expect(String(result.bodies[0]!.bodyId)).toBe('body_imported_imp_1_0');
  });

  it('fails with a clear message when componentRef is missing from embeddedComponents', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);
    const project: CadProject = emptyProject('Host');
    // intentionally NOT setting embeddedComponents

    const feature = makeFeature('hash-missing', 'newBody');
    await expect(
      buildImportedComponent(feature, {} as ResolvedParams, ctx, kernel, project, new Set()),
    ).rejects.toThrow(/hash-missing.*not found/);
  });

  it('throws COMPONENT_CYCLE when the ref is already in the visited set', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    const source = makeSourceWithBody('Self');
    const def = makeDef('hash-self', source, 'Self');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { 'hash-self': def };

    const feature = makeFeature('hash-self', 'newBody');
    const visited = new Set(['hash-self']);
    await expect(
      buildImportedComponent(feature, {} as ResolvedParams, ctx, kernel, project, visited),
    ).rejects.toThrow(/COMPONENT_CYCLE/);
  });

  it('fails when the source has no parts', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    const source = emptyProject('Empty');
    // no parts added
    const def = makeDef('hash-empty', source, 'Empty');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { 'hash-empty': def };

    const feature = makeFeature('hash-empty', 'newBody');
    await expect(
      buildImportedComponent(feature, {} as ResolvedParams, ctx, kernel, project, new Set()),
    ).rejects.toThrow(/no parts/);
  });

  it('applies overrides to PROJECT-scope params too (stubs author public knobs at that scope)', async () => {
    // Regression: most .cadcomponent stubs (dowel_pin, washer, bolt…)
    // declare `D` / `L` at the embedded project scope, not the part
    // scope, because the component IS the project from the author's
    // pov. Earlier versions of applyInstanceOverrides only touched
    // PART scope so dialog edits silently no-op'd. The dialog now
    // surfaces both scopes and the builder applies to whichever holds
    // the name.
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    // Source mirroring the dowel_pin stub shape: D at project scope,
    // part timeline references it via expression.
    const source = emptyProject('Dowel');
    source.parameters.values['D'] = { name: 'D', expression: 'NONEXISTENT', unit: 'mm', public: true };
    const part: CadPart = createPart('Dowel');
    const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    part.timeline.push({
      id: 'sk' as never, type: 'sketch', name: 'sk', version: 1, enabled: true, visible: true,
      dependsOn: [],
      inputs: {
        plane: { type: 'defaultPlane', name: 'XY' },
        buildGeometry: { c: { id: 'c', type: 'circle', center: ['0', '0'], diameter: 'D' } },
      },
      createdAt: now, updatedAt: now,
    });
    part.timeline.push({
      id: 'ex' as never, type: 'extrude', name: 'ex', version: 1, enabled: true, visible: true,
      dependsOn: ['sk' as never],
      inputs: {
        profiles: [{ sketchId: 'sk', wireEntityIds: ['c'] }],
        operation: 'newBody',
        direction: { type: 'normal' },
        extent: { type: 'distance', value: '5' },
      },
      createdAt: now, updatedAt: now,
    });
    source.parts[part.id] = part;

    const def = makeDef('hash-pdowel', source, 'Dowel');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { 'hash-pdowel': def };

    // Without override → broken expression at project scope fails build.
    const featureNoOverride = makeFeature('hash-pdowel', 'newBody');
    await expect(
      buildImportedComponent(featureNoOverride, {} as ResolvedParams, ctx, kernel, project, new Set()),
    ).rejects.toThrow();

    // With override for D (project-scope param) → succeeds. Builder
    // must route the override into source.parameters because that's
    // where D lives; before this fix the override silently no-op'd.
    const featureOverridden = makeFeature('hash-pdowel', 'newBody');
    (featureOverridden.inputs as unknown as ImportedComponentFeatureInputs).parameterOverrides = { D: '8' };
    const result = await buildImportedComponent(
      featureOverridden,
      {} as ResolvedParams,
      ctx,
      kernel,
      project,
      new Set(),
    );
    expect(result.bodies).toHaveLength(1);
  });

  it('applies per-instance parameterOverrides — a broken default expression succeeds when overridden', async () => {
    // We can't observe the geometric effect of an override via MockKernel
    // (it fixes the body bbox at unit-size regardless of inputs). So we
    // pick a property the resolver DOES care about: a parameter whose
    // default expression is unresolvable until the override fixes it.
    //
    // Without the override, resolveAllParameters fails → the sub-build
    // returns an error and the builder throws. With the override applied
    // first (which REPLACES the expression), it resolves and the sub-
    // build succeeds. This exercises the same overlay code path real
    // numeric overrides go through.
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    const source = emptyProject('Cyl');
    const part: CadPart = createPart('Cyl');
    // Bad default expression that the override will rescue.
    part.parameters.values['D'] = { name: 'D', expression: 'NONEXISTENT_PARAM', unit: 'mm' };
    const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    part.timeline.push({
      id: 'sk' as never, type: 'sketch', name: 'sk', version: 1, enabled: true, visible: true,
      dependsOn: [],
      inputs: {
        plane: { type: 'defaultPlane', name: 'XY' },
        buildGeometry: { c: { id: 'c', type: 'circle', center: ['0', '0'], diameter: 'D' } },
      },
      createdAt: now, updatedAt: now,
    });
    part.timeline.push({
      id: 'ex' as never, type: 'extrude', name: 'ex', version: 1, enabled: true, visible: true,
      dependsOn: ['sk' as never],
      inputs: {
        profiles: [{ sketchId: 'sk', wireEntityIds: ['c'] }],
        operation: 'newBody',
        direction: { type: 'normal' },
        extent: { type: 'distance', value: '5' },
      },
      createdAt: now, updatedAt: now,
    });
    source.parts[part.id] = part;

    const def = makeDef('hash-cyl', source, 'Cyl');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { 'hash-cyl': def };

    // Without the override → fails.
    const featureNoOverride = makeFeature('hash-cyl', 'newBody');
    await expect(
      buildImportedComponent(featureNoOverride, {} as ResolvedParams, ctx, kernel, project, new Set()),
    ).rejects.toThrow();

    // With the override that replaces D's expression → succeeds.
    const featureOverridden = makeFeature('hash-cyl', 'newBody');
    (featureOverridden.inputs as unknown as ImportedComponentFeatureInputs).parameterOverrides = { D: '10' };
    const result = await buildImportedComponent(
      featureOverridden,
      {} as ResolvedParams,
      ctx,
      kernel,
      project,
      new Set(),
    );
    expect(result.bodies).toHaveLength(1);
  });
});

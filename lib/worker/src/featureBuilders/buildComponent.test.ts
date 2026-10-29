/**
 * buildComponent tests — unit-level, MockKernel-backed.
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
 * Per-instance parameter overrides and configuration selection are covered
 * directly below, against the dimensions that actually reach the kernel —
 * "covered indirectly" is what let a dropped configurationId ship.
 */
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildComponent } from './buildComponent.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { emptyProject, createPart } from '@tweakcad/core/src/document/factory.ts';
import type {
  CadProject,
  CadPart,
  ComponentDefinition,
  FeatureNode,
  ComponentFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { featureId, bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import { err } from '@tweakcad/core/src/result.ts';
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
      editorModel: {
        points: [{ id: 'p1', x: 0, y: 0, fixed: true }],
        geometries: [{ id: 'c1', type: 'circle', centerId: 'p1', radius: 5, construction: false }],
        constraints: [],
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
  const inputs: ComponentFeatureInputs = {
    componentRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    parameterOverrides: {},
    boolean: mode,
  };
  return {
    id: featureId('imp_1'),
    type: 'component',
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

describe('buildComponent', () => {
  beforeAll(attachTestSolver, 30_000);

  it('rebuilds an embedded component and surfaces its body under the host featureId', async () => {
    const kernel = await freshKernel();
    const ctx = emptyBuildContext({} as ResolvedParams);

    const source = makeSourceWithBody('Dowel');
    const def = makeDef('hash-dowel', source, 'Dowel');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { 'hash-dowel': def };

    const feature = makeFeature('hash-dowel', 'newBody');
    const result = await buildComponent(
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
      buildComponent(feature, {} as ResolvedParams, ctx, kernel, project, new Set()),
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
      buildComponent(feature, {} as ResolvedParams, ctx, kernel, project, visited),
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
      buildComponent(feature, {} as ResolvedParams, ctx, kernel, project, new Set()),
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
        // D drives the radius through a dimension the solver enforces —
        // the replacement for an Expression baked into a coordinate.
        editorModel: {
          points: [{ id: 'pc', x: 0, y: 0, fixed: true }],
          geometries: [{ id: 'c', type: 'circle', centerId: 'pc', radius: 5, construction: false }],
          constraints: [{ id: 'cr', type: 'radius', geometryId: 'c', value: 5, expression: 'D / 2' }],
        },
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
    // Matched on the cause, not on "it threw": a bare toThrow() here
    // would also accept a missing component ref or a kernel error.
    const featureNoOverride = makeFeature('hash-pdowel', 'newBody');
    await expect(
      buildComponent(featureNoOverride, {} as ResolvedParams, ctx, kernel, project, new Set()),
    ).rejects.toThrow(/Parameter resolution failed.*NONEXISTENT/);

    // With override for D (project-scope param) → succeeds. Builder
    // must route the override into source.parameters because that's
    // where D lives; before this fix the override silently no-op'd.
    const featureOverridden = makeFeature('hash-pdowel', 'newBody');
    (featureOverridden.inputs as unknown as ComponentFeatureInputs).parameterOverrides = { D: '8' };
    const result = await buildComponent(
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
        // D drives the radius through a dimension the solver enforces —
        // the replacement for an Expression baked into a coordinate.
        editorModel: {
          points: [{ id: 'pc', x: 0, y: 0, fixed: true }],
          geometries: [{ id: 'c', type: 'circle', centerId: 'pc', radius: 5, construction: false }],
          constraints: [{ id: 'cr', type: 'radius', geometryId: 'c', value: 5, expression: 'D / 2' }],
        },
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

    // Without the override → fails, and on the broken expression
    // specifically rather than on anything that happens to throw.
    const featureNoOverride = makeFeature('hash-cyl', 'newBody');
    await expect(
      buildComponent(featureNoOverride, {} as ResolvedParams, ctx, kernel, project, new Set()),
    ).rejects.toThrow(/Parameter resolution failed.*NONEXISTENT/);

    // With the override that replaces D's expression → succeeds.
    const featureOverridden = makeFeature('hash-cyl', 'newBody');
    (featureOverridden.inputs as unknown as ComponentFeatureInputs).parameterOverrides = { D: '10' };
    const result = await buildComponent(
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

/**
 * A component whose geometry is driven entirely by two public parameters,
 * with two named sizes. A primitive is used rather than sketch+extrude so the
 * dimensions reach the kernel as plain numbers the spy can read directly.
 */
function makeParametricSource(): CadProject {
  const proj = emptyProject('Spacer');
  const part = createPart('Spacer');
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  part.parameters = {
    values: {
      width: { name: 'width', expression: '20', unit: 'mm', public: true },
      height: { name: 'height', expression: '10', unit: 'mm', public: true },
    },
  };
  part.configurations = {
    active: 'small',
    rows: [
      { id: 'small', name: 'Small', overrides: { width: '20', height: '10' } },
      { id: 'large', name: 'Large', overrides: { width: '60', height: '30' } },
    ],
  };
  part.timeline.push({
    id: 'block' as never,
    type: 'primitive',
    name: 'Box 1',
    version: 1,
    enabled: true,
    visible: true,
    dependsOn: [],
    inputs: {
      shape: { kind: 'box', width: 'width', height: 'height', depth: 'width' },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      operation: 'newBody',
    },
    createdAt: now,
    updatedAt: now,
  });
  proj.parts[part.id] = part;
  return proj;
}

/** Build one instance and report the box dimensions that reached the kernel. */
async function dimensionsFor(
  overrides: Partial<ComponentFeatureInputs>,
): Promise<{ width: number; height: number; depth: number }> {
  const kernel = await freshKernel();
  const spy = vi.spyOn(kernel, 'makeBox');
  const source = makeParametricSource();
  const project: CadProject = emptyProject('Host');
  project.embeddedComponents = { spacer: makeDef('spacer', source, 'Spacer') };

  const feature = makeFeature('spacer');
  Object.assign(feature.inputs, overrides);
  await buildComponent(
    feature,
    {} as ResolvedParams,
    emptyBuildContext({} as ResolvedParams),
    kernel,
    project,
    new Set(),
  );
  const spec = spy.mock.calls[0]?.[0];
  if (!spec) throw new Error('component did not reach makeBox');
  return { width: spec.width, height: spec.height, depth: spec.depth };
}

describe('buildComponent — per-instance configuration', () => {
  it("uses the component's own active row when the instance picks nothing", async () => {
    expect(await dimensionsFor({ configurationId: undefined }))
      .toEqual({ width: 20, height: 10, depth: 20 });
  });

  it('honours the configuration the instance picked', async () => {
    // Regression: the sub-timeline runner re-applied the component's own
    // active row over the merged parameters, so a user picking "Large" got
    // "Small" geometry — the instance's choice was stored, round-tripped in
    // the dialog, and then silently discarded at build time.
    expect(await dimensionsFor({ configurationId: 'large' }))
      .toEqual({ width: 60, height: 30, depth: 60 });
  });

  it('lets an explicit null mean "ignore the component\'s active row"', async () => {
    expect(await dimensionsFor({ configurationId: null }))
      .toEqual({ width: 20, height: 10, depth: 20 });
  });

  it('applies per-instance overrides on top of the chosen configuration', async () => {
    expect(await dimensionsFor({
      configurationId: 'large',
      parameterOverrides: { height: '7' },
    })).toEqual({ width: 60, height: 7, depth: 60 });
  });

  it('two instances of one component can use different configurations', async () => {
    // The point of configurations: one M3 and one M5 from the same Bolt.
    const [small, large] = await Promise.all([
      dimensionsFor({ configurationId: 'small' }),
      dimensionsFor({ configurationId: 'large' }),
    ]);
    expect(small.width).toBe(20);
    expect(large.width).toBe(60);
  });
});

describe('buildComponent — placement', () => {
  it('leaves bodies untouched at the origin', async () => {
    // `kernel.transform` derives a new body; an identity placement has
    // nothing to derive, and the common case should not pay for one.
    const kernel = await freshKernel();
    const spy = vi.spyOn(kernel, 'transform');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { d: makeDef('d', makeSourceWithBody('Dowel'), 'Dowel') };

    await buildComponent(
      makeFeature('d'), {} as ResolvedParams,
      emptyBuildContext({} as ResolvedParams), kernel, project, new Set(),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies a non-identity placement to every body', async () => {
    // Regression: the transform was stored, shown in the dialog and then
    // only logged, so every component landed on top of every other one.
    const kernel = await freshKernel();
    const spy = vi.spyOn(kernel, 'transform');
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { d: makeDef('d', makeSourceWithBody('Dowel'), 'Dowel') };

    const placement = {
      position: [30, 0, 12.5] as [number, number, number],
      rotation: [0, 0.7071068, 0, 0.7071068] as [number, number, number, number],
    };
    const feature = makeFeature('d');
    Object.assign(feature.inputs, { transform: placement });
    await buildComponent(
      feature, {} as ResolvedParams,
      emptyBuildContext({} as ResolvedParams), kernel, project, new Set(),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toEqual(placement);
  });

  it('places before cutting, so the hole lands where the component is', async () => {
    // Transforming after the boolean would move the *result* — the host body
    // with its hole — rather than positioning the tool that makes it.
    const kernel = await freshKernel();
    const order: string[] = [];
    vi.spyOn(kernel, 'transform').mockImplementation(async (body) => {
      order.push('transform');
      return { ok: true as const, value: body };
    });
    vi.spyOn(kernel, 'booleanCut').mockImplementation(async (target) => {
      order.push('cut');
      return { ok: true as const, value: target };
    });

    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { d: makeDef('d', makeSourceWithBody('Dowel'), 'Dowel') };
    const ctx = emptyBuildContext({} as ResolvedParams);
    ctx.bodies.set(bodyIdBrand('body_host'), { handle: 'host', source: 'mock' });

    const feature = makeFeature('d', 'cut');
    Object.assign(feature.inputs, {
      transform: { position: [10, 0, 0], rotation: [0, 0, 0, 1] },
    });
    await buildComponent(
      feature, {} as ResolvedParams, ctx, kernel, project, new Set(),
    );
    expect(order).toEqual(['transform', 'cut']);
  });

  it('fails the feature with a clear message when placement fails', async () => {
    const kernel = await freshKernel();
    vi.spyOn(kernel, 'transform').mockResolvedValue(
      err({ category: 'kernel', code: 'TRANSFORM_FAILED', message: 'bad matrix' }),
    );
    const project: CadProject = emptyProject('Host');
    project.embeddedComponents = { d: makeDef('d', makeSourceWithBody('Dowel'), 'Dowel') };
    const feature = makeFeature('d');
    Object.assign(feature.inputs, {
      transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1] },
    });
    await expect(buildComponent(
      feature, {} as ResolvedParams,
      emptyBuildContext({} as ResolvedParams), kernel, project, new Set(),
    )).rejects.toThrow(/Failed to place component: bad matrix/);
  });
});

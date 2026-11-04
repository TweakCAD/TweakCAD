/**
 * Rebuilding the same part over and over must not grow the WASM heap.
 *
 * The worker rebuilds the whole timeline on every edit and frees the previous
 * rebuild's bodies first (`sweepPreviousRebuild`). Anything else a rebuild
 * allocates and keeps — a sketch face, a resolved edge, the un-moved copy of
 * a placed body, a component's own bodies — stays in OCCT's arena for the life
 * of the worker. Each such leak is small; repeated on every keystroke of a
 * drag it is the out-of-memory that made bodies vanish.
 *
 * Counts come from occt-wasm's own arena (`shapeCount`), so they cover every
 * shape handle, not only the ones the adapter tracks.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import type { CadPart, CadProject, FeatureNode, SketchEditorSnapshot } from '@tweakcad/core/src/document/schema.ts';
import { drawRectangle, emptyEditorState, makeCounterIdFactory, toSnapshot } from '@tweakcad/core/src/sketch/operations.ts';
import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { detectSketchRegions, regionToProfileRef } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { featureId } from '@tweakcad/core/src/ids.ts';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { loadCadDocument } from '@tweakcad/core/src/document/loader.ts';
import { emptyProject, createPart, newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { clearRebuildCache, incrementalRebuild, sweepPreviousRebuild } from './rebuilder.ts';

const here = dirname(fileURLToPath(import.meta.url));

function liveShapes(kernel: OcctKernel): number {
  return (kernel as unknown as { kernel: { shapeCount: number } }).kernel.shapeCount;
}

/** Rebuild `part` `rounds` times the way the worker does; return the live count after each. */
async function rebuildCounts(part: CadPart, project: CadProject, rounds = 4): Promise<number[]> {
  clearRebuildCache();
  const kernel = new OcctKernel();
  await kernel.init();
  const counts: number[] = [];
  for (let i = 0; i < rounds; i++) {
    sweepPreviousRebuild(kernel, String(part.id));
    const result = await incrementalRebuild(part, project, kernel, 0);
    const failed = result.featureResults.filter((r) => r.status !== 'success');
    if (failed.length > 0) throw new Error(`fixture did not build: ${JSON.stringify(failed)}`);
    // Freeing too much would show up here: a body whose shape was released
    // early fails to tessellate (caught, so it would not fail the feature).
    expect(result.meshes).toHaveLength(result.bodies.length);
    expect(result.meshes.every((m) => m.indices.length > 0)).toBe(true);
    expect(result.diagnostics.filter((d) => d.startsWith('Tessellation failed'))).toEqual([]);
    counts.push(liveShapes(kernel));
  }
  return counts;
}

function node(id: string, type: FeatureNode['type'], inputs: unknown): FeatureNode {
  return {
    id, type, name: id, version: 1, enabled: true, visible: true,
    inputs: inputs as Record<string, unknown>, dependsOn: [],
    createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
  } as unknown as FeatureNode;
}

function boxAt(id: string, position: [number, number, number], operation: 'newBody' | 'cut' = 'newBody'): FeatureNode {
  return node(id, 'primitive', {
    shape: { kind: 'box', width: '10', height: '10', depth: '10' },
    transform: { position, rotation: [0, 0, 0, 1] },
    operation,
  });
}

function onePart(timeline: FeatureNode[], project = newProjectWithPart('P', 'Part 1')): { part: CadPart; project: CadProject } {
  const part = Object.values(project.parts)[0]!;
  part.timeline = timeline;
  return { part, project };
}

describe('rebuild leaves no shapes behind', () => {
  it('sketch + extrude + cut (plate with hole)', async () => {
    const text = readFileSync(resolve(here, '../../testing/fixtures/plate-with-hole.cadjson'), 'utf8');
    const loaded = loadCadDocument(text);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const project = loaded.value.project;
    const counts = await rebuildCounts(Object.values(project.parts)[0]!, project);
    // One body: the plate with its hole.
    expect(counts).toEqual([1, 1, 1, 1]);
  }, 60_000);

  it('a primitive placed away from the origin', async () => {
    const { part, project } = onePart([boxAt('box', [20, 0, 0])]);
    expect(await rebuildCounts(part, project)).toEqual([1, 1, 1, 1]);
  }, 60_000);

  it('a fillet on picked edges', async () => {
    // Build once to read real stable edge ids, then fillet two of them.
    const { part, project } = onePart([boxAt('box', [0, 0, 0])]);
    const probe = new OcctKernel();
    await probe.init();
    clearRebuildCache();
    const first = await incrementalRebuild(part, project, probe, 0);
    const edges = first.topologyMaps[0]!.edges.slice(0, 2).map((e) => ({
      type: 'stableTopology',
      bodyRef: { partId: part.id, bodyId: first.topologyMaps[0]!.bodyId },
      stableEdgeId: e.stableEdgeId,
    }));
    part.timeline = [boxAt('box', [0, 0, 0]), node('fillet', 'fillet', { edges, radius: '1' })];
    expect(await rebuildCounts(part, project)).toEqual([1, 1, 1, 1]);
  }, 60_000);

  it('a placed component cut into a host', async () => {
    const source = emptyProject('Peg');
    const sourcePart = createPart('Peg');
    sourcePart.timeline = [boxAt('peg', [0, 0, 0])];
    source.parts[sourcePart.id] = sourcePart;
    const { part, project } = onePart([
      boxAt('host', [0, 0, 0]),
      node('comp', 'component', {
        componentRef: 'peg',
        transform: { position: [3, 3, 3], rotation: [0, 0, 0, 1] },
        parameterOverrides: {},
        boolean: 'cut',
      }),
    ]);
    project.embeddedComponents = { peg: { hash: 'peg', name: 'Peg', embeddedAt: '2026-11-02T00:00:00.000Z', source } };
    // One body: the host with the peg cut out of it.
    expect(await rebuildCounts(part, project)).toEqual([1, 1, 1, 1]);
  }, 60_000);

  it('a component whose own timeline cuts one body from another', async () => {
    const source = emptyProject('Notched');
    const sourcePart = createPart('Notched');
    sourcePart.timeline = [boxAt('block', [0, 0, 0]), boxAt('notch', [5, 5, 5], 'cut')];
    source.parts[sourcePart.id] = sourcePart;
    const { part, project } = onePart([
      node('comp', 'component', {
        componentRef: 'notched',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        parameterOverrides: {},
        boolean: 'newBody',
      }),
    ]);
    project.embeddedComponents = { notched: { hash: 'notched', name: 'Notched', embeddedAt: '2026-11-02T00:00:00.000Z', source } };
    expect(await rebuildCounts(part, project)).toEqual([1, 1, 1, 1]);
  }, 60_000);
});

describe('OcctKernel — resolved faces and edges go with their body', () => {
  it('disposing a body releases every face and edge resolved on it', async () => {
    const kernel = new OcctKernel();
    await kernel.init();
    const box = await kernel.makeBox({ origin: [0, 0, 0], width: 10, height: 10, depth: 10 });
    if (!box.ok) throw new Error('box');
    const topo = await kernel.getTopology(box.value);
    for (const e of topo.edges.slice(0, 4)) await kernel.resolveEdgeRef(box.value, e.stableEdgeId!);
    for (const f of topo.faces.slice(0, 2)) await kernel.resolveFaceRef(box.value, f.stableFaceId!);
    expect(liveShapes(kernel)).toBe(1 + 4 + 2);

    kernel.dispose(box.value);
    // Fillet, chamfer, shell, sketch-on-face and measure all resolve these
    // and none release them; they used to outlive the body.
    expect(liveShapes(kernel)).toBe(0);
  });
});

describe('rebuild leaves no shapes behind — a cut that splits a body', () => {
  it('publishes the pieces and frees the compound they came from', async () => {
    const { part, project } = onePart([
      node('host', 'primitive', {
        shape: { kind: 'box', width: '10', height: '10', depth: '10' },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
        operation: 'newBody',
      }),
      node('slot', 'primitive', {
        shape: { kind: 'box', width: '2', height: '20', depth: '20' },
        transform: { position: [2, 0, 0], rotation: [0, 0, 0, 1] },
        operation: 'cut',
      }),
    ]);
    // Two bodies: the two pieces.
    expect(await rebuildCounts(part, project)).toEqual([2, 2, 2, 2]);
  }, 60_000);
});

describe('rebuild leaves no shapes behind — an extrude of disjoint profiles', () => {
  beforeAll(attachTestSolver, 30_000);

  it('publishes one body per profile and frees the compound they were fused into', async () => {
    const ids = makeCounterIdFactory();
    let state = drawRectangle(emptyEditorState(), { corner: [0, 0], width: 10, height: 10 }, { idFactory: ids }).state;
    state = drawRectangle(state, { corner: [20, 0], width: 10, height: 10 }, { idFactory: ids }).state;
    const sketch = toSnapshot(state) as unknown as SketchEditorSnapshot;
    const regions = detectSketchRegions(sketchBuildGeometry({ editorModel: sketch }));
    const { part, project } = onePart([
      node('sk', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel: sketch }),
      node('ext', 'extrude', {
        profiles: regions.map(r => regionToProfileRef(featureId('sk'), r, regions)),
        operation: 'newBody',
        direction: { type: 'normal' },
        extent: { type: 'distance', value: '10' },
      }),
    ]);
    // Two bodies: one per rectangle.
    expect(await rebuildCounts(part, project)).toEqual([2, 2, 2, 2]);
  }, 60_000);
});

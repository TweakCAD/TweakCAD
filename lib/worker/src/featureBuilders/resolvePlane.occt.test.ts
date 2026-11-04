/**
 * Face anchors against the real occt-wasm kernel: a sketch on a body face,
 * an extrude started from a face, and extrudes up to a face. Each must
 * follow its face when an upstream dimension moves it.
 *
 * The base is a 60 × 40 rectangle on XZ (x −30..30, z −20..20) extruded
 * `height` up +Y, so its top face is its end cap, `sf_extrude_box~end(<region>)`,
 * at y = height.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import { FINE_TESSELLATION } from '@tweakcad/kernel/src/types.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { emptyProject, createPart } from '@tweakcad/core/src/document/factory.ts';
import {
  emptyEditorState,
  drawRectangle,
  drawCircle,
  toSnapshot,
  makeCounterIdFactory,
} from '@tweakcad/core/src/sketch/operations.ts';
import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { detectSketchRegions, regionToProfileRef } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { regionKey } from '@tweakcad/core/src/sketch/provenance.ts';
import type { CadPart, FeatureNode, PlaneRef, SketchEditorSnapshot } from '@tweakcad/core/src/document/schema.ts';
import { featureId, partId } from '@tweakcad/core/src/ids.ts';
import { attachTestSolver } from '@tweakcad/testing/src/solver.ts';
import { incrementalRebuild } from '../rebuilder.ts';

const PART = partId('part_1');
const BOX = 'body_extrude_box_0';
const TOP = cap('extrude_box', rectangle([-30, -20], 60, 40), 'end');
const BOTTOM = cap('extrude_box', rectangle([-30, -20], 60, 40), 'start');

/** The ID of the start or end cap an extrude of a one-region sketch makes. */
function cap(extrudeId: string, editorModel: SketchEditorSnapshot, role: 'start' | 'end'): string {
  const regions = detectSketchRegions(sketchBuildGeometry({ editorModel }));
  return `sf_${extrudeId}~${role}(${regionKey(regions[0]!, regions)})`;
}

function feature(id: string, type: string, inputs: unknown): FeatureNode {
  return {
    id: featureId(id),
    type,
    name: id,
    version: 1,
    enabled: true,
    visible: true,
    dependsOn: [],
    inputs,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  } as unknown as FeatureNode;
}

function rectangle(corner: [number, number], width: number, height: number): SketchEditorSnapshot {
  return toSnapshot(
    drawRectangle(emptyEditorState(), { corner, width, height }, { idFactory: makeCounterIdFactory() }).state,
  ) as unknown as SketchEditorSnapshot;
}

function circles(centers: [number, number][], radius: number): SketchEditorSnapshot {
  let state = emptyEditorState();
  const ids = makeCounterIdFactory();
  for (const center of centers) state = drawCircle(state, { center, radius }, { idFactory: ids }).state;
  return toSnapshot(state) as unknown as SketchEditorSnapshot;
}

function profiles(sketchId: string, editorModel: SketchEditorSnapshot) {
  const regions = detectSketchRegions(sketchBuildGeometry({ editorModel }));
  return regions.map(r => regionToProfileRef(featureId(sketchId), r, regions));
}

const face = (stableFaceId: string, bodyId = BOX): PlaneRef => ({
  type: 'stableTopology',
  bodyRef: { partId: PART, bodyId: bodyId as never },
  stableFaceId: stableFaceId as never,
});

/** The box, then whatever features a test appends. */
function boxPart(height: number, extra: FeatureNode[]): CadPart {
  const base = rectangle([-30, -20], 60, 40);
  const part = createPart('Faces');
  part.id = PART;
  part.timeline = [
    feature('sketch_box', 'sketch', { plane: { type: 'defaultPlane', name: 'XZ' }, editorModel: base }),
    feature('extrude_box', 'extrude', {
      profiles: profiles('sketch_box', base),
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: String(height) },
    }),
    ...extra,
  ];
  return part;
}

async function rebuild(part: CadPart) {
  const project = emptyProject('Faces');
  project.parts[part.id] = part;
  const kernel = new OcctKernel();
  await kernel.init();
  const result = await incrementalRebuild(part, project, kernel, 0);
  const failed = result.featureResults.filter(r => r.status !== 'success');
  return { kernel, result, failed };
}

function bodyHandle(result: Awaited<ReturnType<typeof rebuild>>['result'], id: string): KernelBody {
  const body = result.bodies.find(b => String(b.bodyId) === id);
  if (!body) throw new Error(`no body ${id}`);
  return body.handle;
}

/** Distinct y values of the tessellation's vertices within `r` of (x, z). */
async function yLevelsNear(kernel: OcctKernel, body: KernelBody, x: number, z: number, r: number): Promise<number[]> {
  const mesh = await kernel.tessellate(body, FINE_TESSELLATION);
  const ys = new Set<number>();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    if (Math.hypot(mesh.positions[i]! - x, mesh.positions[i + 2]! - z) <= r) {
      ys.add(Math.round(mesh.positions[i + 1]! * 1000) / 1000);
    }
  }
  return [...ys].sort((a, b) => a - b);
}

describe('face anchors (OCCT)', () => {
  beforeAll(attachTestSolver, 30_000);

  const holes = circles([[18, 12], [-18, 12], [18, -12], [-18, -12]], 1.6);
  const holeFeatures = (stableFaceId = TOP) => [
    feature('sketch_top', 'sketch', { plane: face(stableFaceId), editorModel: holes }),
    feature('extrude_holes', 'extrude', {
      profiles: profiles('sketch_top', holes),
      operation: 'cut',
      direction: { type: 'reversed' },
      extent: { type: 'distance', value: '6' },
    }),
  ];

  it('sketches on the top face and keeps the holes on it when the box height changes', async () => {
    for (const height of [20, 35]) {
      const { kernel, result, failed } = await rebuild(boxPart(height, holeFeatures()));
      expect(failed).toEqual([]);
      // Published frame: the XZ axes lifted to the face height.
      expect(result.sketchPlanes).toEqual([{
        featureId: 'sketch_top',
        origin: [0, height, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 0, -1],
        normal: [0, 1, 0],
      }]);
      // Sketch (18, 12) is world (18, height, −12); the hole runs 6 mm down.
      expect(await yLevelsNear(kernel, bodyHandle(result, BOX), 18, -12, 1.61)).toEqual([height - 6, height]);
    }
  }, 60_000);

  it('fails the sketch with a clear message when its face no longer exists', async () => {
    const { result } = await rebuild(boxPart(20, holeFeatures('sf_extrude_box_99')));
    const sketch = result.featureResults.find(r => r.featureId === 'sketch_top');
    expect(sketch?.status).toBe('failed');
    if (sketch?.status === 'failed') {
      expect(sketch.error.message).toMatch(/Sketch face sf_extrude_box_99 no longer exists/);
    }
    expect(result.sketchPlanes).toEqual([]);
  }, 60_000);

  it('starts an extrude from a face and follows it', async () => {
    const pad = rectangle([-5, -5], 10, 10);
    for (const height of [20, 35]) {
      const { kernel, result, failed } = await rebuild(boxPart(height, [
        feature('sketch_pad', 'sketch', { plane: { type: 'defaultPlane', name: 'XZ' }, editorModel: pad }),
        feature('extrude_pad', 'extrude', {
          profiles: profiles('sketch_pad', pad),
          operation: 'newBody',
          direction: { type: 'normal' },
          extent: { type: 'distance', value: '10' },
          startFrom: face(TOP),
        }),
      ]));
      expect(failed).toEqual([]);
      const bbox = await kernel.getBoundingBox(bodyHandle(result, 'body_extrude_pad_0'));
      expect(bbox.min[1]).toBeCloseTo(height, 2);
      expect(bbox.max[1]).toBeCloseTo(height + 10, 2);
    }
  }, 60_000);

  it('adds the start offset on top of the start face', async () => {
    const pad = rectangle([-5, -5], 10, 10);
    const { kernel, result, failed } = await rebuild(boxPart(20, [
      feature('sketch_pad', 'sketch', { plane: { type: 'defaultPlane', name: 'XZ' }, editorModel: pad }),
      feature('extrude_pad', 'extrude', {
        profiles: profiles('sketch_pad', pad),
        operation: 'newBody',
        direction: { type: 'normal' },
        extent: { type: 'distance', value: '10' },
        startFrom: face(TOP),
        startOffset: '3',
      }),
    ]));
    expect(failed).toEqual([]);
    const bbox = await kernel.getBoundingBox(bodyHandle(result, 'body_extrude_pad_0'));
    expect(bbox.min[1]).toBeCloseTo(23, 2);
  }, 60_000);

  it('extrudes a new body up to a face and follows it', async () => {
    const post = circles([[50, 0]], 4);
    for (const height of [20, 35]) {
      const { kernel, result, failed } = await rebuild(boxPart(height, [
        feature('sketch_post', 'sketch', { plane: { type: 'defaultPlane', name: 'XZ' }, editorModel: post }),
        feature('extrude_post', 'extrude', {
          profiles: profiles('sketch_post', post),
          operation: 'newBody',
          direction: { type: 'normal' },
          extent: { type: 'toPlane', plane: face(TOP) },
        }),
      ]));
      expect(failed).toEqual([]);
      const bbox = await kernel.getBoundingBox(bodyHandle(result, 'body_extrude_post_0'));
      expect(bbox.min[1]).toBeCloseTo(0, 2);
      expect(bbox.max[1]).toBeCloseTo(height, 2);
    }
  }, 60_000);

  it('joins and cuts up to a face and follows it', async () => {
    // A lid floats at y 50..55. A post sketched on the box's top face is
    // joined up to the lid's underside, fusing box, post and lid; a bore
    // sketched on the floor is cut up to the box's top face.
    const lid = rectangle([-30, -20], 60, 40);
    const post = circles([[0, 0]], 5);
    const bore = circles([[20, 0]], 2);
    for (const height of [20, 35]) {
      const { kernel, result, failed } = await rebuild(boxPart(height, [
        feature('sketch_lid', 'sketch', { plane: { type: 'defaultPlane', name: 'XZ' }, editorModel: lid }),
        feature('extrude_lid', 'extrude', {
          profiles: profiles('sketch_lid', lid),
          operation: 'newBody',
          direction: { type: 'normal' },
          startOffset: '50',
          extent: { type: 'distance', value: '5' },
        }),
        feature('sketch_post', 'sketch', { plane: face(TOP), editorModel: post }),
        feature('extrude_post', 'extrude', {
          profiles: profiles('sketch_post', post),
          operation: 'join',
          direction: { type: 'normal' },
          extent: { type: 'toPlane', plane: face(cap('extrude_lid', lid, 'start'), 'body_extrude_lid_0') },
        }),
        feature('sketch_bore', 'sketch', { plane: { type: 'defaultPlane', name: 'XZ' }, editorModel: bore }),
        feature('extrude_bore', 'extrude', {
          profiles: profiles('sketch_bore', bore),
          operation: 'cut',
          direction: { type: 'normal' },
          extent: { type: 'toPlane', plane: face(TOP) },
        }),
      ]));
      expect(failed).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0]!.handle;
      const bbox = await kernel.getBoundingBox(body);
      expect(bbox.min[1]).toBeCloseTo(0, 2);
      expect(bbox.max[1]).toBeCloseTo(55, 2);
      // The post spans the gap between the box top and the lid.
      expect(await yLevelsNear(kernel, body, 0, 0, 5.01)).toEqual([height, 50]);
      // The bore runs from the floor to the top face, whatever the height.
      expect(await yLevelsNear(kernel, body, 20, 0, 2.01)).toEqual([0, height]);
    }
  }, 60_000);

  it('fails an extrude whose end face is behind its start', async () => {
    const pad = circles([[0, 0]], 5);
    const { result } = await rebuild(boxPart(20, [
      feature('sketch_pad', 'sketch', { plane: face(TOP), editorModel: pad }),
      feature('extrude_pad', 'extrude', {
        profiles: profiles('sketch_pad', pad),
        operation: 'join',
        direction: { type: 'normal' },
        extent: { type: 'toPlane', plane: face(BOTTOM) },
      }),
    ]));
    const pad2 = result.featureResults.find(r => r.featureId === 'extrude_pad');
    expect(pad2?.status).toBe('failed');
    if (pad2?.status === 'failed') expect(pad2.error.message).toMatch(/at or behind the start/);
  }, 60_000);
});

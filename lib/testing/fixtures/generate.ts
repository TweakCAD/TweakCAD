/**
 * Regenerate the golden `.cadjson` fixtures.
 *
 *   npx tsx lib/testing/fixtures/generate.ts
 *
 * Hand-written fixtures go stale silently: both of these still declared
 * `schemaVersion: "0.1"` with a `displayUnits` field and a composite
 * `"type": "rectangle"` sketch entity — a schema the loader refuses and an
 * entity kind invariant #11 says does not exist. Building them through the
 * real `operations.ts` builders and checking the result through the real
 * `loadCadDocument` means a fixture cannot encode a document the app would
 * reject.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyProject, createPart } from '../../core/src/document/factory.ts';
import { loadCadDocument } from '../../core/src/document/loader.ts';
import { CURRENT_SCHEMA_VERSION } from '../../core/src/document/version.ts';
import {
  emptyEditorState,
  drawRectangle,
  drawCircle,
  toSnapshot,
  makeCounterIdFactory,
} from '../../core/src/sketch/operations.ts';
import { sketchBuildGeometry } from '../../core/src/sketch/derivedGeometry.ts';
import { detectSketchRegions, regionToProfileRef } from '../../core/src/sketch/profileRegions.ts';
import type { CadProject, FeatureNode, ProfileRef, SketchEditorSnapshot } from '../../core/src/document/schema.ts';
import { featureId, partId } from '../../core/src/ids.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAMP = '2026-05-17T12:00:00Z';

function feature(
  id: string,
  type: string,
  name: string,
  dependsOn: string[],
  inputs: unknown,
): FeatureNode {
  return {
    id: featureId(id),
    type,
    name,
    version: 1,
    enabled: true,
    visible: true,
    dependsOn: dependsOn.map(featureId),
    inputs,
    createdAt: STAMP,
    updatedAt: STAMP,
  } as unknown as FeatureNode;
}

/** A rectangle sketch, as the editor would actually store it. */
function rectangleSketch(width: number, height: number): SketchEditorSnapshot {
  const factory = makeCounterIdFactory();
  const state = drawRectangle(
    emptyEditorState(),
    { corner: [-width / 2, -height / 2], width, height },
    { idFactory: factory },
  ).state;
  return toSnapshot(state) as unknown as SketchEditorSnapshot;
}

function circleSketch(radius: number): SketchEditorSnapshot {
  const factory = makeCounterIdFactory();
  const state = drawCircle(emptyEditorState(), { center: [0, 0], radius }, { idFactory: factory }).state;
  return toSnapshot(state) as unknown as SketchEditorSnapshot;
}

/**
 * The profile a sketch's single closed region makes, resolved the same way
 * the editor resolves it. Writing `wireEntityIds: []` by hand produces a
 * fixture that loads and then builds nothing.
 */
function soleProfile(sketchId: string, editorModel: SketchEditorSnapshot): ProfileRef {
  const entities = sketchBuildGeometry({ editorModel });
  const regions = detectSketchRegions(entities);
  if (regions.length !== 1) {
    throw new Error(`${sketchId}: expected exactly one region, got ${regions.length}`);
  }
  return regionToProfileRef(featureId(sketchId), regions[0]!, regions);
}

function build(name: string, description: string, timeline: FeatureNode[]): CadProject {
  const project = emptyProject(name);
  project.metadata.description = description;
  project.metadata.createdAt = STAMP;
  project.metadata.updatedAt = STAMP;
  const part = createPart('Plate');
  part.id = partId('part_1');
  part.timeline = timeline;
  project.parts[part.id] = part;
  return project;
}

function emit(file: string, project: CadProject): void {
  const json = JSON.stringify(project, null, 2);
  const loaded = loadCadDocument(JSON.parse(json));
  if (!loaded.ok) {
    throw new Error(`${file} would be refused by the loader: ${JSON.stringify(loaded.error)}`);
  }
  writeFileSync(join(HERE, file), `${json}\n`);
  console.log(`wrote ${file} (schemaVersion ${CURRENT_SCHEMA_VERSION})`);
}

// --- simple-box: one sketch, one extrude -----------------------------------
const boxSketch = rectangleSketch(100, 60);
emit('simple-box.cadjson', build(
  'Simple Box',
  'One rectangle extruded — the smallest document that builds a body.',
  [
    feature('sketch_1', 'sketch', 'Base Sketch', [], {
      plane: { type: 'defaultPlane', name: 'XY' },
      editorModel: boxSketch,
    }),
    feature('extrude_1', 'extrude', 'Base Extrude', ['sketch_1'], {
      profiles: [soleProfile('sketch_1', boxSketch)],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '20' },
    }),
  ],
));

// --- plate-with-hole: the same, cut by a circle -----------------------------
const plateSketch = rectangleSketch(100, 60);
const holeSketch = circleSketch(5);
emit('plate-with-hole.cadjson', build(
  'Plate with Hole',
  'A plate with a centred through hole, cut by a second sketch.',
  [
    feature('sketch_1', 'sketch', 'Base Sketch', [], {
      plane: { type: 'defaultPlane', name: 'XY' },
      editorModel: plateSketch,
    }),
    feature('extrude_1', 'extrude', 'Base Extrude', ['sketch_1'], {
      profiles: [soleProfile('sketch_1', plateSketch)],
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: '20' },
    }),
    feature('sketch_2', 'sketch', 'Hole Sketch', [], {
      plane: { type: 'defaultPlane', name: 'XY' },
      editorModel: holeSketch,
    }),
    feature('extrude_2', 'extrude', 'Hole Cut', ['sketch_2', 'extrude_1'], {
      profiles: [soleProfile('sketch_2', holeSketch)],
      operation: 'cut',
      direction: { type: 'normal' },
      extent: { type: 'throughAll' },
    }),
  ],
));

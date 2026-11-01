/**
 * Text → solid, end to end against the real occt-wasm kernel: "ANNA" laid out
 * in a bundled font at 10 mm, placed in a sketch, and extruded 2 mm gives four
 * separate solids whose counters stay open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'opentype.js';
import { textToPrimitives } from '@tweakcad/core/src/sketch/text/textOutline.ts';
import { buildEditorStateFromPrimitives } from '@tweakcad/core/src/sketch/io/dxfImport.ts';
import { toSnapshot } from '@tweakcad/core/src/sketch/operations.ts';
import { editorModelToBuildGeometry } from '@tweakcad/core/src/sketch/serialization.ts';
import {
  assignHoles,
  detectSketchRegions,
  regionNetArea,
  regionToProfileRef,
} from '@tweakcad/core/src/sketch/profileRegions.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { featureId } from '@tweakcad/core/src/ids.ts';
import type { FeatureNode, SketchEditorSnapshot } from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { buildSketch } from '@tweakcad/worker/src/featureBuilders/buildSketch.ts';
import { buildExtrude } from '@tweakcad/worker/src/featureBuilders/buildExtrude.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { SKETCH_FONTS } from './sketchFonts.ts';

const SKETCH_ID = featureId('sketch_text');
const DEPTH = 2;

function node(id: string, type: 'sketch' | 'extrude', inputs: unknown, dependsOn: string[]): FeatureNode {
  return {
    id: featureId(id),
    type,
    name: id,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as Record<string, unknown>,
    dependsOn: dependsOn.map(featureId),
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

describe('text extrude (real kernel)', () => {
  it('"ANNA" at 10 mm, extruded 2 mm: four solids with open counters', async () => {
    const def = SKETCH_FONTS[0]!;
    const buf = readFileSync(fileURLToPath(new URL(`../../assets/fonts/${def.file}`, import.meta.url)));
    const font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

    const state = buildEditorStateFromPrimitives(textToPrimitives(font, 'ANNA', { height: 10 }));
    const editorModel = toSnapshot(state) as unknown as SketchEditorSnapshot;
    const regions = assignHoles(detectSketchRegions(editorModelToBuildGeometry(state)));
    const counterIds = new Set(regions.flatMap((r) => (r.holes ?? []).map((h) => h.id)));
    const letters = regions.filter((r) => !counterIds.has(r.id));
    expect(letters).toHaveLength(4);

    const kernel = new OcctKernel();
    await kernel.init();
    const context = emptyBuildContext({} as ResolvedParams);
    const sketch = node('sketch_text', 'sketch', { plane: { type: 'defaultPlane', name: 'XY' }, editorModel }, []);
    const sketchResult = await buildSketch(sketch, {}, context, kernel);
    context.featureOutputs.set(sketch.id, sketchResult.outputs!);

    const extrude = node('ex_text', 'extrude', {
      profiles: letters.map((r) => regionToProfileRef(SKETCH_ID, r, regions)),
      operation: 'newBody',
      direction: { type: 'normal' },
      extent: { type: 'distance', value: String(DEPTH) },
    }, ['sketch_text']);
    const result = await buildExtrude(extrude, {}, context, kernel);
    expect(result.bodies).toHaveLength(4);

    const expected = letters.map((r) => regionNetArea(r) * DEPTH).sort((a, b) => a - b);
    const volumes: number[] = [];
    for (const b of result.bodies) {
      const body = b.handle as KernelBody;
      const bbox = await kernel.getBoundingBox(body);
      expect(bbox.max[2] - bbox.min[2]).toBeCloseTo(DEPTH, 6);
      expect(bbox.max[1] - bbox.min[1]).toBeGreaterThan(9.7);
      expect(bbox.max[1] - bbox.min[1]).toBeLessThan(10.3);
      volumes.push((await kernel.getMassProperties(body)).volume);
    }
    volumes.sort((a, b) => a - b);
    // Net region area × depth: an A's volume excludes its counter.
    for (let i = 0; i < 4; i++) expect(volumes[i]!).toBeCloseTo(expected[i]!, 1);
  }, 60_000);
});

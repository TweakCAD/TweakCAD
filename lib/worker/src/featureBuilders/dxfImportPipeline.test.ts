/**
 * End-to-end DXF-import pipeline test.
 *
 * Reproduces the live flow a user hits: parse a DXF, dispatch
 * `CreateSketchFromImport`, then exercise the two paths that render the
 * resulting sketch AFTER the editor closes —
 *
 *   - `detectSketchRegions(buildGeometry)` — what `SketchViewer` runs to
 *     draw the readonly overlay once sketch mode is exited. A throw here
 *     blanks the whole viewer (it sits inside an ErrorBoundary), which
 *     looks like "the drawing disappeared on exit".
 *   - `buildSketch(...)` — the worker feature builder.
 *
 * The point is to prove the imported geometry survives the
 * editorModel → buildGeometry projection AND is consumable by the
 * post-exit render/build paths without throwing.
 */

import { describe, expect, it } from 'vitest';
import { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { createSketchFromImportHandler } from '@tweakcad/core/src/commands/handlers/featureCommands.ts';
import { dxfToEditorState } from '@tweakcad/core/src/sketch/io/dxfImport.ts';
import { toSnapshot, makeCounterIdFactory } from '@tweakcad/core/src/sketch/operations.ts';
import { detectSketchRegions } from '@tweakcad/core/src/sketch/profileRegions.ts';
import type {
  SketchFeatureInputs,
  SketchEditorSnapshot,
  SketchEntity,
  FeatureNode,
} from '@tweakcad/core/src/document/schema.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import { MockKernel } from '@tweakcad/kernel/src/mockKernel.ts';
import { buildSketch } from './buildSketch.ts';

// A DXF mixing every supported primitive:
//   - a closed LWPOLYLINE square (→ 4 lines, one closed region)
//   - a standalone CIRCLE
//   - a standalone ARC
//   - an ELLIPSE
//   - a SPLINE (control polygon)
const DXF = [
  '0', 'SECTION', '2', 'ENTITIES',
  // closed square 0,0 → 10,0 → 10,10 → 0,10
  '0', 'LWPOLYLINE',
  '90', '4',
  '70', '1',
  '10', '0', '20', '0',
  '10', '10', '20', '0',
  '10', '10', '20', '10',
  '10', '0', '20', '10',
  // circle
  '0', 'CIRCLE', '10', '50', '20', '50', '40', '5',
  // arc (quarter, CCW)
  '0', 'ARC', '10', '30', '20', '30', '40', '5', '50', '0', '51', '90',
  // ellipse: center 70,70, major vector (10,0), ratio 0.5
  '0', 'ELLIPSE', '10', '70', '20', '70', '11', '10', '21', '0', '40', '0.5',
  // spline control polygon
  '0', 'SPLINE', '10', '0', '20', '50', '10', '5', '20', '55', '10', '10', '20', '50',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

function importSketch(): { inputs: SketchFeatureInputs; feature: FeatureNode } {
  const project = newProjectWithPart('Test');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketchFromImport', createSketchFromImportHandler);
  const partId = Object.keys(project.parts)[0] as PartId;

  const { state, skipped } = dxfToEditorState(DXF, { idFactory: makeCounterIdFactory() });
  expect(skipped).toEqual([]);

  const result = bus.dispatch({
    type: 'CreateSketchFromImport',
    partId,
    plane: { type: 'defaultPlane', name: 'XY' },
    editorState: toSnapshot(state) as unknown as SketchEditorSnapshot,
    name: 'Import',
  });
  expect(result.ok).toBe(true);

  const part = store.getState().parts[partId]!;
  const feature = part.timeline.find((f) => f.type === 'sketch')!;
  return { inputs: feature.inputs as unknown as SketchFeatureInputs, feature };
}

function isFiniteCoord(v: unknown): boolean {
  return Number.isFinite(parseFloat(String(v)));
}

describe('DXF import pipeline (post-exit render + build)', () => {
  it('projects every supported primitive into buildGeometry', () => {
    const { inputs } = importSketch();
    const entities = Object.values(inputs.buildGeometry) as SketchEntity[];
    const byType = (t: string) => entities.filter((e) => e.type === t).length;
    // 4 lines (square) + 1 circle + 1 arc + 1 ellipse + 1 spline = 8
    expect(byType('line')).toBe(4);
    expect(byType('circle')).toBe(1);
    expect(byType('arc')).toBe(1);
    expect(byType('ellipse')).toBe(1);
    expect(byType('spline')).toBe(1);
    expect(entities).toHaveLength(8);
  });

  it('every line/circle/arc entity has finite, renderable coordinates', () => {
    const { inputs } = importSketch();
    for (const e of Object.values(inputs.buildGeometry) as SketchEntity[]) {
      if (e.type === 'line') {
        expect(isFiniteCoord(e.start[0]) && isFiniteCoord(e.start[1])).toBe(true);
        expect(isFiniteCoord(e.end[0]) && isFiniteCoord(e.end[1])).toBe(true);
      } else if (e.type === 'circle') {
        expect(isFiniteCoord(e.center[0]) && isFiniteCoord(e.diameter)).toBe(true);
      } else if (e.type === 'arc') {
        expect(isFiniteCoord(e.center[0]) && isFiniteCoord(e.radius)).toBe(true);
        expect(isFiniteCoord(e.startAngle) && isFiniteCoord(e.endAngle)).toBe(true);
      }
    }
  });

  it('detectSketchRegions does not throw on imported geometry and finds the closed square', () => {
    const { inputs } = importSketch();
    const regions = detectSketchRegions(inputs.buildGeometry);
    // The square is a closed loop → at least one region. (The circle is
    // also closed; arc/ellipse/spline are open and contribute none.)
    expect(regions.length).toBeGreaterThanOrEqual(1);
  });

  it('buildSketch does not throw and yields resolved regions', async () => {
    const { feature } = importSketch();
    const kernel = new MockKernel();
    await kernel.init();
    const result = await buildSketch(
      feature,
      {} as ResolvedParams,
      emptyBuildContext({} as ResolvedParams),
      kernel,
    );
    expect(result.outputs?.data?.resolvedRegions).toBeTruthy();
  });
});

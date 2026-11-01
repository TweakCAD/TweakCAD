/**
 * Circular and linear body patterns against the real occt-wasm kernel.
 *
 * `count` includes the source: a pattern publishes `count - 1` new bodies,
 * one per copy, and leaves the source in place under its own id. Every copy
 * is a separate solid, so it lists, renders and works as a boolean tool on
 * its own.
 *
 * Layout: the source is a 10 × 10 × 4 box at x 20..30, y 0..10, z −2..2 —
 * what a 10 × 4 rectangle on XZ at [20, −2] extruded 10 mm gives. Its centre
 * sits at radius 25 from the Y axis.
 */
import { describe, expect, it } from 'vitest';
import { buildCircularPattern } from './buildCircularPattern.ts';
import { buildLinearPattern } from './buildLinearPattern.ts';
import { buildBoolean } from './buildBoolean.ts';
import { OcctKernel } from '@tweakcad/kernel/src/occtKernel.ts';
import type { KernelBody } from '@tweakcad/kernel/src/types.ts';
import { emptyBuildContext } from '@tweakcad/core/src/features/contracts.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';
import type {
  BooleanFeatureInputs,
  CircularPatternInputs,
  FeatureNode,
  LinearPatternInputs,
} from '@tweakcad/core/src/document/schema.ts';
import { featureId, bodyId, partId } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';

const PART = partId('p1');
const SRC = bodyId('body_src');
const PLATE = bodyId('body_plate');
const NO_PARAMS = {} as ResolvedParams;
const SRC_VOLUME = 10 * 10 * 4;

function node(id: string, type: FeatureNode['type'], inputs: unknown): FeatureNode {
  return {
    id: featureId(id),
    type,
    name: id,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as Record<string, unknown>,
    dependsOn: [],
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
  };
}

async function setup(): Promise<{ kernel: OcctKernel; context: BuildContext }> {
  const kernel = new OcctKernel();
  await kernel.init();
  const context = emptyBuildContext(NO_PARAMS);
  const src = await kernel.makeBox({ origin: [20, 0, -2], width: 10, height: 10, depth: 4 });
  if (!src.ok) throw new Error(src.error.message);
  context.bodies.set(SRC, src.value);
  return { kernel, context };
}

/** Publish a build result into the context the way the rebuilder does. */
function publish(context: BuildContext, result: BuildResult): void {
  for (const b of result.bodies) context.bodies.set(b.bodyId, b.handle);
}

function handle(context: BuildContext, id: BodyId): KernelBody {
  const h = context.bodies.get(id);
  if (!h) throw new Error(`no body ${String(id)}`);
  return h as KernelBody;
}

async function circular(kernel: OcctKernel, context: BuildContext, count: number): Promise<BuildResult> {
  const inputs: CircularPatternInputs = {
    patternType: 'circular',
    sourceBody: { partId: PART, bodyId: SRC },
    axis: { type: 'y' },
    count: String(count),
  };
  const result = await buildCircularPattern(node('circpat', 'circularPattern', inputs), NO_PARAMS, context, kernel);
  publish(context, result);
  return result;
}

/** Angle in degrees [0, 360) of a body's bounding-box centre about +Y. */
async function angleAboutY(kernel: OcctKernel, body: KernelBody): Promise<number> {
  const bb = await kernel.getBoundingBox(body);
  const cx = (bb.min[0] + bb.max[0]) / 2;
  const cz = (bb.min[2] + bb.max[2]) / 2;
  return Math.round(((Math.atan2(cz, cx) * 180) / Math.PI + 360) % 360);
}

describe('buildCircularPattern (OcctKernel)', () => {
  it('count 6 gives the source plus 5 copies, one body each, around the full turn', async () => {
    const { kernel, context } = await setup();
    const result = await circular(kernel, context, 6);

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(
      [0, 1, 2, 3, 4].map(i => `body_circpat_${i}`),
    );
    expect(context.bodies.size).toBe(6);

    const angles = await Promise.all([...context.bodies.values()].map(h => angleAboutY(kernel, h as KernelBody)));
    expect(angles.sort((a, b) => a - b)).toEqual([0, 60, 120, 180, 240, 300]);

    for (const b of result.bodies) {
      const mp = await kernel.getMassProperties(b.handle as KernelBody);
      expect(mp.volume).toBeCloseTo(SRC_VOLUME, 3);
    }

    // Together the six instances span the whole ring: the 180° copy reaches
    // x = −30 and the 60° / 300° copies reach |z| ≈ 26.
    const boxes = await Promise.all([...context.bodies.values()].map(h => kernel.getBoundingBox(h as KernelBody)));
    expect(Math.min(...boxes.map(bb => bb.min[0]))).toBeCloseTo(-30, 3);
    expect(Math.max(...boxes.map(bb => bb.max[0]))).toBeCloseTo(30, 3);
    expect(Math.min(...boxes.map(bb => bb.min[2]))).toBeLessThan(-25);
    expect(Math.max(...boxes.map(bb => bb.max[2]))).toBeGreaterThan(25);
  });

  it('count 12 gives 11 copies 30° apart', async () => {
    const { kernel, context } = await setup();
    const result = await circular(kernel, context, 12);
    expect(result.bodies).toHaveLength(11);
    const angles = await Promise.all(result.bodies.map(b => angleAboutY(kernel, b.handle as KernelBody)));
    expect(angles.sort((a, b) => a - b)).toEqual([30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);
  });

  it('the source body is untouched and every copy works as a boolean tool', async () => {
    const { kernel, context } = await setup();
    const srcBefore = handle(context, SRC);
    const result = await circular(kernel, context, 6);
    expect(handle(context, SRC)).toBe(srcBefore);

    // An 80 × 10 × 80 plate around the whole ring, minus all six instances.
    const plate = await kernel.makeBox({ origin: [-40, 0, -40], width: 80, height: 10, depth: 80 });
    if (!plate.ok) throw new Error(plate.error.message);
    context.bodies.set(PLATE, plate.value);
    const inputs: BooleanFeatureInputs = {
      operation: 'subtract',
      targetBody: { partId: PART, bodyId: PLATE },
      toolBodies: [SRC, ...result.bodies.map(b => b.bodyId)].map(id => ({ partId: PART, bodyId: id })),
    };
    const cut = await buildBoolean(node('cut', 'boolean', inputs), NO_PARAMS, context, kernel);
    const out = cut.bodies.find(b => b.bodyId === PLATE);
    expect(out).toBeDefined();
    const mp = await kernel.getMassProperties(out!.handle as KernelBody);
    expect(mp.volume).toBeCloseTo(80 * 10 * 80 - 6 * SRC_VOLUME, 2);
  });

  it('count 1 adds nothing', async () => {
    const { kernel, context } = await setup();
    const result = await circular(kernel, context, 1);
    expect(result.bodies).toEqual([]);
    expect(context.bodies.size).toBe(1);
  });
});

describe('buildLinearPattern (OcctKernel)', () => {
  it('count 4 gives the source plus 3 copies spaced along the direction', async () => {
    const { kernel, context } = await setup();
    const inputs: LinearPatternInputs = {
      patternType: 'linear',
      sourceBody: { partId: PART, bodyId: SRC },
      direction: { type: 'z' },
      count: '4',
      spacing: '15',
    };
    const result = await buildLinearPattern(node('linpat', 'linearPattern', inputs), NO_PARAMS, context, kernel);
    publish(context, result);

    expect(result.bodies.map(b => String(b.bodyId))).toEqual(['body_linpat_0', 'body_linpat_1', 'body_linpat_2']);
    expect(context.bodies.size).toBe(4);
    const zRanges = await Promise.all(
      result.bodies.map(async b => {
        const bb = await kernel.getBoundingBox(b.handle as KernelBody);
        return [bb.min[2], bb.max[2]];
      }),
    );
    expect(zRanges).toEqual([
      [expect.closeTo(13, 4), expect.closeTo(17, 4)],
      [expect.closeTo(28, 4), expect.closeTo(32, 4)],
      [expect.closeTo(43, 4), expect.closeTo(47, 4)],
    ]);
    for (const b of result.bodies) {
      const mp = await kernel.getMassProperties(b.handle as KernelBody);
      expect(mp.volume).toBeCloseTo(SRC_VOLUME, 3);
    }
  });
});

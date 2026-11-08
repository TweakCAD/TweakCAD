/**
 * Edges found by the surfaces either side of them, and sketch constraints
 * vetted, on the real kernel and solver.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { DocBuilder } from '../docBuilder';
import { MAX_SOLVER_SYSTEM_SIZE, solverSystemSize } from '../sketchSolve';
import type { Json } from '../context';
import { distanceToSurface, type SurfaceSpec } from './onSurfaces';
import { EvaluationService } from './service';

const here = dirname(fileURLToPath(import.meta.url));

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5, 6]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  service = new EvaluationService(k, gcs);
});
afterAll(() => {
  service.release();
  k.releaseAll();
});

/** A 20 × 10 × 30 mm block from the origin. */
function block(): { doc: Json; part: string; sketch: Json } {
  const d = new DocBuilder();
  const s = d.sketch('xy', (draw) => void draw.rect(0, 0, 20, 10));
  d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '30 mm' }] });
  const doc = d.document();
  const part = (doc.parts as Json[])[0] as Json;
  const sketch = (part.timeline as Json[])[0]?.inputs as Json;
  return { doc, part: part.id as string, sketch };
}

const plane = (origin: [number, number, number], normal: [number, number, number]): SurfaceSpec => ({
  kind: 'plane',
  origin,
  normal,
});

describe('distanceToSurface', () => {
  it('measures from a plane, either side', () => {
    expect(distanceToSurface([0, 0, -2], plane([0, 0, 1], [0, 0, 2]))).toBeCloseTo(3);
  });

  it('measures from a cylinder, a cone of no slope', () => {
    expect(
      distanceToSurface([7, 0, 4], { kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 1], radius: 5, sine: 0, cosine: 1 }),
    ).toBeCloseTo(2);
  });

  it('measures from a cone along its slope', () => {
    const c = Math.SQRT1_2;
    expect(
      distanceToSurface([6, 0, 1], { kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 1], radius: 5, sine: c, cosine: c }),
    ).toBeCloseTo(0);
  });

  it('measures from a sphere and a torus', () => {
    expect(distanceToSurface([0, 3, 0], { kind: 'sphere', center: [0, 0, 0], radius: 2 })).toBeCloseTo(1);
    expect(
      distanceToSurface([6, 0, 1], { kind: 'torus', center: [0, 0, 0], axis: [0, 0, 1], major: 5, minor: 2 }),
    ).toBeCloseTo(2 - Math.SQRT2);
  });
});

describe('locateOnSurfaces', () => {
  it('finds the one edge between two faces', () => {
    const { doc, part } = block();
    service.evaluate(doc);
    const [found] = service.locateOnSurfaces(part, undefined, [
      [plane([20, 0, 0], [1, 0, 0]), plane([0, 10, 0], [0, 1, 0])],
    ]);
    expect(found).toHaveLength(1);
    expect(found?.[0]?.reference.entity).toBeDefined();
  });

  it('answers each pair on its own, and nothing for surfaces no edge lies on', () => {
    const { doc, part } = block();
    service.evaluate(doc);
    const found = service.locateOnSurfaces(part, undefined, [
      [plane([20, 0, 0], [1, 0, 0]), plane([0, 10, 0], [0, 1, 0])],
      [plane([99, 0, 0], [1, 0, 0]), plane([0, 99, 0], [0, 1, 0])],
    ]);
    expect(found.map((f) => f.length)).toEqual([1, 0]);
  });

  it('finds edges in a build that meshed nothing', () => {
    const { doc, part } = block();
    let meshed = 0;
    const meshShape = k.meshShape.bind(k);
    (k as unknown as { meshShape: typeof meshShape }).meshShape = (...a: Parameters<typeof meshShape>) => (
      meshed++,
      meshShape(...a)
    );
    try {
      const display = service.evaluate(doc, { meshes: false });
      expect([display.definitions.flatMap((d) => d.bodies), meshed]).toEqual([[], 0]);
    } finally {
      delete (k as unknown as { meshShape?: unknown }).meshShape;
    }
    const [found] = service.locateOnSurfaces(part, undefined, [
      [plane([20, 0, 0], [1, 0, 0]), plane([0, 10, 0], [0, 1, 0])],
    ]);
    expect(found).toHaveLength(1);
  });
});

describe('vetSketch', () => {
  it('passes constraints the geometry already meets', () => {
    const { doc, sketch } = block();
    service.evaluate(doc);
    expect(service.vetSketch(sketch)).toEqual([]);
  });

  it('names a constraint that would move a point, and only that one', () => {
    const { doc, sketch } = block();
    service.evaluate(doc);
    const [a, b] = sketch.points as { id: string }[];
    const d = new DocBuilder();
    const wrong = {
      id: d.id('con'),
      kind: 'distance',
      active: d.val('true'),
      a: { point: { id: a?.id } },
      b: { point: { id: b?.id } },
      value: d.val('35 mm'),
      solved: 35,
      label: { auto: {} },
    };
    const with1 = { ...sketch, constraints: [...(sketch.constraints as Json[]), wrong] };
    expect(service.vetSketch(with1)).toEqual([wrong.id]);
  });

  it('vets the sketches of a document against its values alone, as after a build, and evaluates nothing', () => {
    const { doc, sketch } = block();
    const [a, b] = sketch.points as { id: string }[];
    const d = new DocBuilder();
    const constraint = (id: string, value: Json) => ({
      id,
      kind: 'distance',
      active: d.val('true'),
      a: { point: { id: a?.id } },
      b: { point: { id: b?.id } },
      value,
      solved: 35,
      label: { auto: {} },
    });
    const wrong = constraint(d.id('con'), d.val('35 mm'));
    const timeline = (doc.parts as Json[])[0]!.timeline as Json[];
    const first = timeline[0]!;
    (first.inputs as Json).constraints = [...((first.inputs as Json).constraints as Json[]), wrong];
    // A second sketch with a dimension whose value names a value the document lacks: it needs a build to be vetted.
    const second = structuredClone(first);
    second.id = d.id('feat');
    ((second.inputs as Json).constraints as Json[]).push(
      constraint(d.id('con'), {
        id: d.id('val'),
        def: { expr: { text: 'm', grammar: 1, refs: { m: { value: { id: 'val_nowhere' } } } } },
      }),
    );
    timeline.push(second);
    const kept = service.evaluation;
    expect(service.vetSketches(doc, [first.id as string, second.id as string, 'feat_none'])).toEqual([
      [wrong.id],
      null,
      null,
    ]);
    expect(service.evaluation).toBe(kept);
  });
});

describe('a sketch too large to solve', () => {
  /** `n` separate vertical lines: 4n unknowns and n equations. */
  function lines(n: number): Json {
    const d = new DocBuilder();
    d.sketch('xy', (draw) => {
      for (let i = 0; i < n; i++) draw.vertical(draw.line(draw.point(i * 2, 0), draw.point(i * 2, 1)));
    });
    return (((d.document().parts as Json[])[0] as Json).timeline as Json[])[0]?.inputs as Json;
  }

  it('measures a sketch by unknowns and equations', () => {
    expect(solverSystemSize(lines(3))).toBe(12 * 3);
  });

  it('builds as stored, and leaves the solver working', () => {
    const d = new DocBuilder();
    d.sketch('xy', (draw) => {
      for (let i = 0; i < 700; i++) draw.vertical(draw.line(draw.point(i * 2, 0), draw.point(i * 2, 1)));
    });
    expect(service.evaluate(d.document()).pauses).toEqual([]);
    const { doc } = block();
    expect(service.evaluate(doc).pauses).toEqual([]);
  });

  it('keeps only the constraints that fit', () => {
    const { doc } = block();
    service.evaluate(doc);
    const big = lines(700);
    expect(solverSystemSize(big)).toBeGreaterThan(MAX_SOLVER_SYSTEM_SIZE);
    const out = service.vetSketch(big);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(700);
  });
});

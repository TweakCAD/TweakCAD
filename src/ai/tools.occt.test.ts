/**
 * The tool catalogue end to end on the real kernel and solver, as a model
 * would call it: the app's services over an evaluation service in this
 * thread, tools run through the executor. A plate with a hole is sketched,
 * dimensioned and extruded; its top edges filleted; holes drilled; the plate
 * widened through a parameter, with the handles still naming their bodies
 * and faces; then a revolve, a mirror, a primitive with a shell, and the
 * refusals a model meets.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { bootApp, type AppServiceClient, type AppServices } from '../app/services';
import { MemoryWorkingCopy } from '../app/storage/workingCopy';
import { createAiContext, type AiContext } from './context';
import { storeTransactions } from './document';
import { executeTool, type ToolRun } from './executor';

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [2, 3, 4]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  service = new EvaluationService(k, gcs);
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

function client(): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(service.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(service.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(service.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(service.properties(key)),
    measure: (kind, targets) => Promise.resolve(service.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(service.resolve(record, scope)),
    externalCurves: (key, mode, frame) => Promise.resolve(service.externalCurves(key, mode, frame)),
  };
}

async function boot(seed: number): Promise<{ s: AppServices; ctx: AiContext; run: ToolRun }> {
  const { services: s } = await bootApp({
    client: client(),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(seed),
    name: () => 'tools',
  });
  const ctx = createAiContext({ services: s, solver: () => Promise.resolve(gcs) });
  return { s, ctx, run: { ctx, transactions: storeTransactions(ctx) } };
}

/** Runs a tool; a refusal fails the test with its message. */
async function call<T = Json>(run: ToolRun, name: string, input: Json = {}): Promise<T> {
  const r = await executeTool(name, input, run);
  if (!r.ok) throw new Error(`${name}: ${r.error.code}: ${r.error.message}`);
  return r.value as T;
}

async function refusal(run: ToolRun, name: string, input: Json = {}): Promise<{ code: string; message: string }> {
  const r = await executeTool(name, input, run);
  if (r.ok) throw new Error(`${name} was not refused`);
  return r.error;
}

const close = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

interface Body {
  handle: string;
  volume: number;
  min: number[];
  max: number[];
}

describe('the tool catalogue on the kernel', { timeout: 120_000 }, () => {
  it('models a plate with a hole, fillets, drills and resizes it through handles that keep naming their entities', async () => {
    const { s, run } = await boot(31);

    const outline = await call<{ parts: { id: string; features: unknown[] }[] }>(run, 'list_features');
    expect(outline.parts).toHaveLength(1);
    expect(outline.parts[0]?.features).toEqual([]);

    await call(run, 'begin_transaction', { label: 'Plate' });
    const sketch = await call<{ sketch: string; frame: { normal: number[] } }>(run, 'sketch_create', { on: 'xy' });
    expect(sketch.frame.normal).toEqual([0, 0, 1]);
    const rect = await call<{ curves: string[]; points: string[]; dof: number }>(run, 'sketch_draw_rectangle', {
      sketch: sketch.sketch,
      from: [0, 0],
      to: [60, 30],
    });
    expect(rect.curves).toHaveLength(4);
    const width = await call<{ name: string; constraints: string[] }>(run, 'sketch_constrain', {
      sketch: sketch.sketch,
      kind: 'dimension',
      entities: [rect.curves[0]],
      value: 60,
    });
    const height = await call<{ dof: number }>(run, 'sketch_constrain', {
      sketch: sketch.sketch,
      kind: 'dimension',
      entities: [rect.curves[1]],
      value: '30',
    });
    expect(height.dof).toBe(0);
    await call(run, 'sketch_draw_circle', { sketch: sketch.sketch, center: [30, 15], radius: 5 });

    const read = await call<{ regions: { handle: string; area: number; holes?: string[][] }[]; dof: number }>(
      run,
      'get_sketch',
      { sketch: sketch.sketch },
    );
    expect(read.regions).toHaveLength(2);
    const ring = read.regions.find((r) => r.holes && r.holes.length === 1);
    expect(ring && close(ring.area, 60 * 30 - Math.PI * 25, 1e-2)).toBe(true);

    const plate = await call<{ feature: string; status: string }>(run, 'feature_extrude', {
      profiles: [ring?.handle],
      distance: 5,
    });
    expect(plate.status).toBe('ok');
    await call(run, 'end_transaction');
    // The whole plate is one undo step.
    expect(s.editor.store.undoLabel()).toBe('Plate');

    const bodies = await call<{ bodies: Body[] }>(run, 'list_bodies');
    expect(bodies.bodies).toHaveLength(1);
    const body = bodies.bodies[0] as Body;
    expect(close(body.volume, (60 * 30 - Math.PI * 25) * 5, 1e-3)).toBe(true);
    expect(body.max).toEqual([60, 30, 5]);

    const top = await call<{ faces: { handle: string; centroid: number[] }[] }>(run, 'list_faces', {
      body: body.handle,
      normal: [0, 0, 1],
    });
    expect(top.faces).toHaveLength(1);
    const topFace = top.faces[0]?.handle as string;
    const edges = await call<{ edges: { handle: string; curve: string; faces: string[] }[] }>(run, 'list_edges', {
      body: body.handle,
      face: topFace,
    });
    expect(edges.edges.map((e) => e.curve).sort()).toEqual(['circle', 'line', 'line', 'line', 'line']);
    for (const e of edges.edges) expect(e.faces).toContain(topFace);
    const straight = edges.edges.filter((e) => e.curve === 'line').map((e) => e.handle);
    const between = await call<{ edges: { handle: string }[] }>(run, 'list_edges', {
      body: body.handle,
      between: [topFace, (edges.edges[0] as { faces: string[] }).faces.find((f) => f !== topFace)],
    });
    expect(between.edges).toHaveLength(1);

    const fillet = await call<{ status: string }>(run, 'feature_fillet', { edges: straight, radius: 1 });
    expect(fillet.status).toBe('ok');
    const filleted = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    // The body keeps its handle: it is the same body, now filleted.
    expect(filleted.handle).toBe(body.handle);
    expect(filleted.volume).toBeLessThan(body.volume);

    // The top face handle still names the top face after the fillet.
    const hole = await call<{ status: string; frame: { origin: number[]; x: number[] } }>(run, 'feature_hole', {
      face: topFace,
      positions: [
        [10, 10],
        [50, 10],
      ],
      diameter: 4,
      throughAll: true,
    });
    expect(hole.status).toBe('ok');
    expect(hole.frame.x).toEqual([1, 0, 0]);
    const drilled = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    expect(close(drilled.volume, filleted.volume - 2 * Math.PI * 4 * 5, 1e-3)).toBe(true);

    const measured = await call<{ value: number }>(run, 'measure', { kind: 'volume', entities: [body.handle] });
    expect(close(measured.value, drilled.volume, 1e-4)).toBe(true);

    // Wider through a parameter the width dimension uses.
    await call(run, 'set_parameter', { name: 'plateWidth', expression: 80 });
    const dims = (
      await call<{ constraints: { id: string; kind: string; value?: { name?: string } }[] }>(run, 'get_sketch', {
        sketch: sketch.sketch,
      })
    ).constraints;
    const widthDim = dims.find((c) => c.value?.name === width.name);
    await call(run, 'sketch_set_dimension', { sketch: sketch.sketch, constraint: widthDim?.id, value: 'plateWidth' });
    const wide = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    expect(wide.max[0]).toBeCloseTo(80, 4);
    const diagnostics = await call<{ paused: unknown[] }>(run, 'get_diagnostics');
    expect(diagnostics.paused).toEqual([]);

    // The value of the extrude's distance, by its id, as a model reads it from the document.
    const doc = await call<Json>(run, 'get_document');
    const extrude = (((doc.parts as Json[])[0] as Json).timeline as Json[]).find((f) => f.id === plate.feature) as Json;
    const distance = ((((extrude.inputs as Json).sides as Json[])[0] as Json).extent as Json).distance as Json;
    await call(run, 'set_value', { value: (distance.d as Json).id, expression: 8 });
    const thick = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    expect(thick.max[2]).toBeCloseTo(8, 4);

    const removed = await call<{ changed: boolean }>(run, 'run_command', {
      command: {
        type: 'removeFeature',
        feature: hole.frame
          ? (
              await call<{ parts: { features: { id: string; type: string }[] }[] }>(run, 'list_features')
            ).parts[0]?.features.find((f) => f.type === 'core.hole')?.id
          : '',
      },
    });
    expect(removed.changed).toBe(true);
    const group = await call<{ ids: Record<string, string> }>(run, 'run_command', {
      command: {
        type: 'addGroup',
        part: (await call<{ parts: { id: string }[] }>(run, 'list_features')).parts[0]?.id,
        group: { id: 'new:grp', name: 'Plate', members: [sketch.sketch, plate.feature] },
      },
    });
    expect(group.ids['new:grp']).toMatch(/^grp_/);
  });

  it('starts an extrude on a face, with an offset past it, and at an offset from the sketch plane', async () => {
    const { run } = await boot(34);
    const base = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    await call(run, 'sketch_draw_rectangle', { sketch: base.sketch, from: [0, 0], to: [20, 10] });
    await call(run, 'feature_extrude', { sketch: base.sketch, distance: 5, operation: 'new' });
    const plate = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    const top = (
      await call<{ faces: { handle: string }[] }>(run, 'list_faces', { body: plate.handle, normal: [0, 0, 1] })
    ).faces[0]?.handle;

    const post = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    await call(run, 'sketch_draw_rectangle', { sketch: post.sketch, from: [8, 3], to: [12, 7] });
    const onTop = await call<{ status: string }>(run, 'feature_extrude', {
      sketch: post.sketch,
      distance: 4,
      startFace: top,
      startOffset: 1,
      operation: 'new',
    });
    expect(onTop.status).toBe('ok');
    const raised = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find(
      (b) => b.handle !== plate.handle,
    ) as Body;
    expect(close(raised.min[2] as number, 6)).toBe(true);
    expect(close(raised.max[2] as number, 10)).toBe(true);

    const side = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    await call(run, 'sketch_draw_rectangle', { sketch: side.sketch, from: [30, 0], to: [34, 4] });
    const lifted = await call<{ status: string }>(run, 'feature_extrude', {
      sketch: side.sketch,
      distance: 2,
      startOffset: 3,
      operation: 'new',
    });
    expect(lifted.status).toBe('ok');
    const block = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find(
      (b) => (b.min[0] as number) > 25,
    ) as Body;
    expect(close(block.min[2] as number, 3)).toBe(true);
    expect(close(block.max[2] as number, 5)).toBe(true);

    const pocket = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    await call(run, 'sketch_draw_rectangle', { sketch: pocket.sketch, from: [2, 2], to: [4, 4] });
    const cut = await call<{ status: string }>(run, 'feature_extrude', {
      sketch: pocket.sketch,
      distance: 5,
      operation: 'cut',
      targets: [plate.handle],
    });
    expect(cut.status).toBe('ok');
    const cutPlate = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find(
      (b) => b.handle === plate.handle,
    ) as Body;
    expect(close(cutPlate.volume, 20 * 10 * 5 - 2 * 2 * 5)).toBe(true);
  });

  it('lofts two sketches and sweeps a section along a drawn path', async () => {
    const { run } = await boot(33);
    const low = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    await call(run, 'sketch_draw_rectangle', { sketch: low.sketch, from: [-5, -5], to: [5, 5] });
    const plane = async (offset: number) => {
      const made = await call<{ feature: string }>(run, 'feature_construction', {
        kind: 'plane',
        mode: 'plane',
        supports: ['xy'],
        offset,
      });
      return (
        await call<{ construction: { handle: string; feature?: string }[] }>(run, 'list_construction')
      ).construction.find((c) => c.feature === made.feature)?.handle;
    };
    const high = await call<{ sketch: string }>(run, 'sketch_create', { on: await plane(10) });
    await call(run, 'sketch_draw_rectangle', { sketch: high.sketch, from: [-3, -3], to: [3, 3] });
    const regionOf = async (sketch: string) =>
      (await call<{ regions: { handle: string }[] }>(run, 'get_sketch', { sketch })).regions[0]?.handle;
    const lofted = await call<{ status: string }>(run, 'feature_loft', {
      sections: [await regionOf(low.sketch), await regionOf(high.sketch)],
      operation: 'new',
    });
    expect(lofted.status).toBe('ok');
    const frustum = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    expect(close(frustum.volume, (10 / 3) * (100 + 36 + 60), 1e-6)).toBe(true);

    const section = await call<{ sketch: string }>(run, 'sketch_create', { on: await plane(40) });
    await call(run, 'sketch_draw_rectangle', { sketch: section.sketch, from: [38, -2], to: [42, 2] });
    const route = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xz' });
    await call(run, 'sketch_draw_line', {
      sketch: route.sketch,
      points: [
        [40, -40],
        [40, -60],
        [60, -60],
      ],
    });
    const curves = (
      await call<{ curves: { handle: string }[] }>(run, 'get_sketch', { sketch: route.sketch })
    ).curves.map((c) => c.handle);
    const swept = await call<{ status: string }>(run, 'feature_sweep', {
      sketch: section.sketch,
      path: curves,
      operation: 'new',
    });
    expect(swept.status).toBe('ok');
    const bodies = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies;
    expect(bodies).toHaveLength(2);
    expect(close((bodies[1] as Body).volume, 16 * 40, 1e-6)).toBe(true);
  });

  it('revolves, mirrors, shells a primitive and threads a shaft', async () => {
    const { run } = await boot(32);
    const sketch = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    await call(run, 'sketch_draw_rectangle', { sketch: sketch.sketch, from: [10, 0], to: [15, 20] });
    const turned = await call<{ status: string }>(run, 'feature_revolve', {
      sketch: sketch.sketch,
      axis: 'y',
      angle: 180,
      operation: 'new',
    });
    expect(turned.status).toBe('ok');
    const ring = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    expect(close(ring.volume, (Math.PI * (15 * 15 - 10 * 10) * 20) / 2, 1e-3)).toBe(true);

    const mirrored = await call<{ status: string }>(run, 'feature_mirror', {
      bodies: [ring.handle],
      plane: 'xz',
      operation: 'new',
    });
    expect(mirrored.status).toBe('ok');
    expect((await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies).toHaveLength(2);

    const box = await call<{ status: string }>(run, 'feature_primitive', {
      shape: 'box',
      width: 20,
      depth: 20,
      height: 10,
      position: [60, 0, 0],
      operation: 'new',
    });
    expect(box.status).toBe('ok');
    const boxBody = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find((b) => b.min[0] > 40) as Body;
    const lid = await call<{ faces: { handle: string }[] }>(run, 'list_faces', {
      body: boxBody.handle,
      normal: [0, 0, 1],
    });
    const shell = await call<{ status: string }>(run, 'feature_shell', { faces: [lid.faces[0]?.handle], thickness: 1 });
    expect(shell.status).toBe('ok');
    const hollow = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find((b) => b.min[0] > 40) as Body;
    expect(close(hollow.volume, 20 * 20 * 10 - 18 * 18 * 9, 1e-3)).toBe(true);

    const shaft = await call<{ status: string }>(run, 'feature_primitive', {
      shape: 'cylinder',
      radius: 3,
      height: 12,
      position: [0, 0, 60],
      operation: 'new',
    });
    expect(shaft.status).toBe('ok');
    const shaftBody = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find((b) => b.min[2] > 40) as Body;
    const round = (
      await call<{ faces: { handle: string; surface: string; radius?: number }[] }>(run, 'list_faces', {
        body: shaftBody.handle,
        surface: 'cylinder',
      })
    ).faces;
    expect(round[0]?.radius).toBeCloseTo(3, 4);
    const thread = await call<{ status: string; designation: string; threadClass: string }>(run, 'feature_thread', {
      face: round[0]?.handle,
    });
    expect(thread).toMatchObject({ status: 'ok', designation: 'M6', threadClass: '6g' });
  });

  it('flips a distance-and-angle chamfer, and shells a body closed and a box on both sides', async () => {
    const { run } = await boot(36);
    const bodies = async () => (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies;
    const topOf = async (b: Body) =>
      (
        await call<{ faces: { handle: string; area: number }[] }>(run, 'list_faces', {
          body: b.handle,
          normal: [0, 0, 1],
        })
      ).faces;

    await call(run, 'feature_primitive', { shape: 'box', width: 20, depth: 20, height: 10, operation: 'new' });
    const [block] = (await bodies()) as [Body];
    const top = (await topOf(block))[0]?.handle;
    expect(
      await call(run, 'feature_chamfer', { edges: [top], distance: 2, second: 1, flipped: true }).catch(
        (e: Error) => e.message,
      ),
    ).toMatch(/flipped/);
    expect(
      (await call<{ status: string }>(run, 'feature_chamfer', { edges: [top], distance: 2, angle: 30, flipped: true }))
        .status,
    ).toBe('ok');
    // The distance runs down the sides; the top keeps all but the angle's setback.
    const setback = 2 * Math.tan(Math.PI / 6);
    expect(close((await topOf((await bodies())[0] as Body))[0]?.area as number, (20 - 2 * setback) ** 2, 1e-4)).toBe(
      true,
    );

    await call(run, 'feature_primitive', {
      shape: 'box',
      width: 20,
      depth: 20,
      height: 20,
      position: [60, 0, 0],
      operation: 'new',
    });
    const cube = (await bodies()).find((b) => b.min[0] > 40) as Body;
    expect((await call<{ status: string }>(run, 'feature_shell', { bodies: [cube.handle], thickness: 2 })).status).toBe(
      'ok',
    );
    const hollow = (await bodies()).find((b) => b.min[0] > 40) as Body;
    expect(close(hollow.volume, 20 ** 3 - 16 ** 3, 1e-4)).toBe(true);

    await call(run, 'feature_primitive', {
      shape: 'box',
      width: 20,
      depth: 20,
      height: 20,
      position: [0, 60, 0],
      operation: 'new',
    });
    const open = (await bodies()).find((b) => b.min[1] > 40) as Body;
    const lid = (await topOf(open))[0]?.handle;
    expect(
      await call(run, 'feature_shell', { faces: [lid], bodies: [open.handle], thickness: 2 }).catch(
        (e: Error) => e.message,
      ),
    ).toMatch(/one or the other/);
    expect(
      (
        await call<{ status: string }>(run, 'feature_shell', {
          faces: [lid],
          thickness: 2,
          direction: 'both',
          outsideThickness: 3,
        })
      ).status,
    ).toBe('ok');
    const walled = (await bodies()).find((b) => b.min[1] > 40) as Body;
    expect(close(walled.volume, 26 * 26 * 23 - 16 * 16 * 18, 1e-4)).toBe(true);
  });

  it('measures a hole position from an edge of its face', async () => {
    const { run, s: app } = await boot(36);
    await call(run, 'feature_primitive', { shape: 'box', width: 20, depth: 20, height: 8, operation: 'new' });
    const [box] = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies as [Body];
    const top = (
      await call<{ faces: { handle: string }[] }>(run, 'list_faces', { body: box.handle, normal: [0, 0, 1] })
    ).faces[0]!.handle;
    const edges = (
      await call<{ edges: { handle: string; midpoint: number[] }[] }>(run, 'list_edges', {
        body: box.handle,
        face: top,
        curve: 'line',
      })
    ).edges;
    const left = edges.reduce((a, b) => ((b.midpoint[0] as number) < (a.midpoint[0] as number) ? b : a));
    const at = [box.min[0] + 10, box.min[1] + 10];
    expect(
      (
        await refusal(run, 'feature_hole', {
          face: top,
          positions: [at],
          diameter: 3,
          throughAll: true,
          from: [{ position: 1, edge: left.handle, distance: 4 }],
        })
      ).message,
    ).toContain('position');
    const hole = await call<{ status: string; feature: string }>(run, 'feature_hole', {
      face: top,
      positions: [at],
      diameter: 3,
      throughAll: true,
      from: [{ position: 0, edge: left.handle, distance: 4 }],
    });
    expect(hole.status).toBe('ok');
    const inputs = (app.editor.document.parts as Json[])
      .flatMap((p) => p.timeline as Json[])
      .find((f) => f.id === hole.feature)?.inputs as Json;
    const from = ((inputs.positions as Json[])[0] as Json).from as Json[];
    expect(from).toHaveLength(1);
    expect((from[0] as Json).d).toMatchObject({ def: { expr: { text: '4 mm' } } });
    const [drilled] = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies as [Body];
    expect(close(drilled.volume, box.volume - Math.PI * 1.5 ** 2 * 8, 1e-3)).toBe(true);
  });

  it('cuts a modelled thread into a shaft and a hole', async () => {
    const { run, s: app } = await boot(35);
    await call(run, 'feature_primitive', { shape: 'cylinder', radius: 3, height: 12, operation: 'new' });
    const [body] = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies as [Body];
    const round = (
      await call<{ faces: { handle: string }[] }>(run, 'list_faces', { body: body.handle, surface: 'cylinder' })
    ).faces;
    expect((await refusal(run, 'feature_thread', { face: round[0]?.handle, hand: 'up' })).message).toContain('hand');
    const thread = await call<{ status: string; feature: string }>(run, 'feature_thread', {
      face: round[0]?.handle,
      modelled: true,
      hand: 'left',
    });
    expect(thread.status).toBe('ok');
    const inputsOf = (id: string) =>
      (app.editor.document.parts as Json[]).flatMap((p) => p.timeline as Json[]).find((f) => f.id === id)
        ?.inputs as Json;
    expect(inputsOf(thread.feature).hand).toMatchObject({ def: { expr: { text: '"left"' } } });
    const [threaded] = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies as [Body];
    expect(threaded.volume).toBeLessThan(body.volume - 30);

    await call(run, 'feature_primitive', {
      shape: 'box',
      width: 20,
      depth: 20,
      height: 8,
      position: [40, 0, 0],
      operation: 'new',
    });
    const box = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find((b) => b.min[0] > 20) as Body;
    const top = await call<{ faces: { handle: string }[] }>(run, 'list_faces', { body: box.handle, normal: [0, 0, 1] });
    const hole = await call<{ status: string }>(run, 'feature_hole', {
      face: top.faces[0]?.handle,
      positions: [[box.min[0] + 10, box.min[1] + 10]],
      diameter: 5,
      throughAll: true,
      thread: 'M8x1',
      modelled: true,
      hand: 'left',
    });
    expect(hole.status).toBe('ok');
    const tapped = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find((b) => b.min[0] > 20) as Body;
    expect(tapped.volume).toBeLessThan(box.volume - Math.PI * 3.5 ** 2 * 8 - 20);
  });

  it('draws every shape, patterns, chamfers, combines and sketches on a construction plane', async () => {
    const { run } = await boot(34);
    const sketch = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    const S = sketch.sketch;
    await call(run, 'sketch_draw_slot', { sketch: S, from: [0, 0], to: [20, 0], width: 6 });
    await call(run, 'sketch_draw_polygon', { sketch: S, center: [40, 0], corner: [45, 0], sides: 6 });
    await call(run, 'sketch_draw_ellipse', { sketch: S, center: [60, 0], majorEnd: [66, 0], minorRadius: 3 });
    await call(run, 'sketch_draw_line', {
      sketch: S,
      points: [
        [0, 20],
        [10, 20],
        [10, 30],
      ],
      closed: true,
    });
    await call(run, 'sketch_draw_arc', { sketch: S, start: [20, 20], through: [25, 25], end: [30, 20] });
    await call(run, 'sketch_draw_arc', { sketch: S, center: [40, 20], start: [44, 20], end: [40, 26] });
    await call(run, 'sketch_draw_spline', {
      sketch: S,
      points: [
        [50, 20],
        [55, 25],
        [60, 20],
      ],
    });
    await call(run, 'sketch_draw_point', { sketch: S, at: [70, 20] });
    const read = await call<{ regions: { area: number }[]; curves: { kind: string }[]; dof: number | null }>(
      run,
      'get_sketch',
      { sketch: S },
    );
    // The slot, the hexagon, the ellipse and the triangle close; the arcs and spline are open.
    expect(read.regions).toHaveLength(4);
    const areas = read.regions.map((r) => r.area).sort((a, b) => a - b);
    expect(close(areas[0] as number, 50, 1e-3)).toBe(true);
    expect(close(areas[1] as number, Math.PI * 18, 1e-2)).toBe(true);
    expect(close(areas[2] as number, ((3 * Math.sqrt(3)) / 2) * 25, 1e-2)).toBe(true);
    expect(close(areas[3] as number, 20 * 6 + Math.PI * 9, 1e-2)).toBe(true);
    expect(read.dof).not.toBeNull();

    const plate = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xz' });
    await call(run, 'sketch_draw_rectangle', { sketch: plate.sketch, from: [0, 0], to: [10, -10] });
    await call(run, 'feature_extrude', { sketch: plate.sketch, distance: 10, operation: 'new' });
    const cube = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    expect(cube.max).toEqual([10, 10, 10]);
    const pattern = await call<{ status: string }>(run, 'feature_pattern', {
      bodies: [cube.handle],
      layout: 'linear',
      direction: 'x',
      count: 3,
      spacing: 20,
    });
    expect(pattern.status).toBe('ok');
    const copies = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies;
    expect(copies).toHaveLength(3);
    const vertical = await call<{ edges: { handle: string }[] }>(run, 'list_edges', {
      body: cube.handle,
      parallel: [0, 1, 0],
    });
    expect(vertical.edges).toHaveLength(4);
    const chamfer = await call<{ status: string }>(run, 'feature_chamfer', {
      edges: vertical.edges.map((e) => e.handle),
      distance: 1,
    });
    expect(chamfer.status).toBe('ok');
    const chamfered = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies.find(
      (b) => b.handle === cube.handle,
    ) as Body;
    expect(close(chamfered.volume, 1000 - 4 * 0.5 * 10, 1e-3)).toBe(true);

    const [first, second] = copies.filter((b) => b.handle !== cube.handle);
    const moved = await call<{ status: string }>(run, 'feature_move', {
      bodies: [second?.handle],
      translate: [-15, 0, 0],
    });
    expect(moved.status).toBe('ok');
    const join = await call<{ status: string }>(run, 'feature_boolean', {
      target: first?.handle,
      tools: [second?.handle],
      op: 'join',
    });
    expect(join).toMatchObject({ status: 'ok' });
    expect((await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies).toHaveLength(2);

    const offset = await call<{ feature: string; status: string }>(run, 'feature_construction', {
      kind: 'plane',
      mode: 'plane',
      supports: ['xy'],
      offset: 25,
    });
    expect(offset.status).toBe('ok');
    const planes = (
      await call<{ construction: { handle: string; feature?: string; frame?: { origin: number[] } }[] }>(
        run,
        'list_construction',
      )
    ).construction;
    const made = planes.find((p) => p.feature === offset.feature);
    expect(made?.frame?.origin).toEqual([0, 0, 25]);
    const along = await call<{ feature: string; status: string }>(run, 'feature_construction', {
      kind: 'axis',
      mode: 'alongLine',
      supports: ['z'],
      offset: 5,
    });
    expect(along.status).toBe('ok');
    const axis = (
      await call<{ construction: { feature?: string; frame?: { origin: number[] } }[] }>(run, 'list_construction')
    ).construction.find((c) => c.feature === along.feature);
    expect(axis?.frame?.origin).toEqual([0, 0, 5]);
    const high = await call<{ sketch: string; frame: { origin: number[]; normal: number[] } }>(run, 'sketch_create', {
      on: made?.handle,
    });
    expect(high.frame.origin).toEqual([0, 0, 25]);

    // The cube's top edges projected up onto that plane make a closed square there.
    const topEdges = await call<{ edges: { handle: string }[] }>(run, 'list_edges', {
      body: chamfered.handle,
      curve: 'line',
      parallel: [1, 0, 0],
    });
    const zAxisEdges = await call<{ edges: { handle: string }[] }>(run, 'list_edges', {
      body: chamfered.handle,
      curve: 'line',
      parallel: [0, 0, 1],
    });
    for (const e of [...topEdges.edges, ...zAxisEdges.edges].slice(0, 2))
      await call(run, 'sketch_project', { sketch: high.sketch, entity: e.handle });
    const cut = await call<{ curves: string[] }>(run, 'sketch_project', {
      sketch: high.sketch,
      entity: chamfered.handle,
      mode: 'intersect',
    }).catch((e: Error) => e);
    expect(cut instanceof Error ? cut.message : '').toMatch(/does not cut/);
    const projected = await call<{ curves: { kind: string }[] }>(run, 'get_sketch', { sketch: high.sketch });
    expect(projected.curves.filter((c) => c.kind === 'external').length).toBeGreaterThanOrEqual(2);
  });

  it('patterns symmetrically and combines keeping the tools', async () => {
    const { run } = await boot(35);
    const plate = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xz' });
    await call(run, 'sketch_draw_rectangle', { sketch: plate.sketch, from: [0, 0], to: [10, -10] });
    await call(run, 'feature_extrude', { sketch: plate.sketch, distance: 10, operation: 'new' });
    const cube = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies[0] as Body;
    const pattern = await call<{ status: string }>(run, 'feature_pattern', {
      bodies: [cube.handle],
      layout: 'linear',
      direction: 'x',
      count: 3,
      spacing: 20,
      symmetric: true,
    });
    expect(pattern.status).toBe('ok');
    const row = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies;
    expect(row.map((b) => b.min[0]).sort((a, b) => (a as number) - (b as number))).toEqual([-20, 0, 20]);

    const [left, , right] = [...row].sort((a, b) => (a.min[0] as number) - (b.min[0] as number));
    const moved = await call<{ status: string }>(run, 'feature_move', {
      bodies: [right?.handle],
      translate: [-35, 0, 0],
    });
    expect(moved.status).toBe('ok');
    const cut = await call<{ status: string }>(run, 'feature_boolean', {
      target: left?.handle,
      tools: [right?.handle],
      op: 'cut',
      keepTools: true,
    });
    expect(cut.status).toBe('ok');
    const after = (await call<{ bodies: Body[] }>(run, 'list_bodies')).bodies;
    // The tool, now at x -15 to -5, stays; the target lost the half it overlapped.
    expect(after.map((b) => Math.round(b.volume)).sort((a, b) => a - b)).toEqual([500, 1000, 1000]);
  });

  it('trims, extends, fillets, offsets and mirrors sketch curves, and constrains to the sketch origin and axes', async () => {
    const { run } = await boot(35);
    const S = (await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' })).sketch;
    const rect = await call<{ curves: string[]; points: string[] }>(run, 'sketch_draw_rectangle', {
      sketch: S,
      from: [0, 0],
      to: [40, 20],
    });
    // A corner rounded: the two lines keep their ids, an arc and a radius dimension come in.
    const fillet = await call<{ name: string }>(run, 'sketch_fillet', { sketch: S, corner: rect.points[2], radius: 4 });
    expect(fillet.name).toMatch(/^d\d+$/);
    let read = await call<{ curves: { id: string; kind: string }[]; regions: { area: number }[] }>(run, 'get_sketch', {
      sketch: S,
    });
    expect(read.curves.filter((c) => c.kind === 'arc')).toHaveLength(1);
    expect(close(read.regions[0]?.area as number, 800 - (16 - Math.PI * 4), 1e-3)).toBe(true);

    // The outline offset outward by 2 mm makes a ring around it.
    await call(run, 'sketch_offset', { sketch: S, curve: rect.curves[0], side: [20, -5], distance: 2 });
    read = await call(run, 'get_sketch', { sketch: S });
    expect(read.regions).toHaveLength(2);

    // A line across, trimmed back at the outline, then a free line extended to it.
    const across = await call<{ curves: string[] }>(run, 'sketch_draw_line', {
      sketch: S,
      points: [
        [20, 10],
        [60, 10],
      ],
    });
    // The curve at a position, as the in-app picker finds it: a point first, then the nearest curve, within the tolerance.
    expect(await call(run, 'sketch_pick_geometry', { sketch: S, at: [50, 10.5] })).toEqual({
      id: across.curves[0],
      kind: 'line',
      distance: 0.5,
    });
    expect(await call(run, 'sketch_pick_geometry', { sketch: S, at: [0.3, 0] })).toEqual({
      id: rect.points[0],
      kind: 'point',
      distance: 0.3,
    });
    expect(await call(run, 'sketch_pick_geometry', { sketch: S, at: [50, 14] })).toEqual({ id: null });
    expect(
      (await call<{ id: string }>(run, 'sketch_pick_geometry', { sketch: S, at: [50, 14], tolerance: 5 })).id,
    ).toBe(across.curves[0]);
    await call(run, 'sketch_trim', { sketch: S, curve: across.curves[0], at: [50, 10] });
    const free = await call<{ curves: string[] }>(run, 'sketch_draw_line', {
      sketch: S,
      points: [
        [10, 5],
        [10, 15],
      ],
    });
    await call(run, 'sketch_extend', { sketch: S, curve: free.curves[0], at: [10, 14] });
    const extended = await call<{ points: { id: string; y: number }[]; curves: { id: string; end?: string }[] }>(
      run,
      'get_sketch',
      { sketch: S },
    );
    const end = extended.curves.find((c) => c.id === free.curves[0])?.end;
    expect(extended.points.find((p) => p.id === end)?.y).toBeCloseTo(20, 6);

    // A circle mirrored across the sketch's y axis, and held on the x axis.
    const circle = await call<{ curve: string; center: string }>(run, 'sketch_draw_circle', {
      sketch: S,
      center: [60, 3],
      radius: 2,
    });
    await call(run, 'sketch_mirror', { sketch: S, curves: [circle.curve], axis: 'yAxis' });
    await call(run, 'sketch_constrain', { sketch: S, kind: 'coincident', entities: [circle.center, 'xAxis'] });
    const after = await call<{
      points: { id: string; x: number; y: number }[];
      curves: { kind: string; center?: string }[];
    }>(run, 'get_sketch', { sketch: S });
    const centers = after.curves
      .filter((c) => c.kind === 'circle')
      .map((c) => after.points.find((p) => p.id === c.center));
    expect(centers.map((c) => [Math.round(c?.x ?? NaN), Math.round(c?.y ?? NaN)]).sort()).toEqual(
      [
        [-60, 0],
        [60, 0],
      ].sort(),
    );
  });

  it('says why when a call cannot be made', async () => {
    const { s, run } = await boot(33);
    expect((await refusal(run, 'no_such_tool')).code).toBe('UNKNOWN_TOOL');
    expect((await refusal(run, 'feature_fillet', { edges: ['e:99'], radius: 1 })).code).toBe('NOT_FOUND');
    expect(
      (
        await refusal(run, 'run_command', {
          command: { type: 'writeReference', feature: 'x', pointer: '', reference: {}, names: {} },
        })
      ).code,
    ).toBe('INVALID_INPUT');
    expect(
      (
        await refusal(run, 'run_command', {
          command: { type: 'removeFeature', feature: 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA' },
        })
      ).code,
    ).toBe('REFUSED');

    const sketch = await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' });
    const line = await call<{ curves: string[] }>(run, 'sketch_draw_line', {
      sketch: sketch.sketch,
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    await call(run, 'sketch_constrain', { sketch: sketch.sketch, kind: 'horizontal', entities: [line.curves[0]] });
    const over = await refusal(run, 'sketch_constrain', {
      sketch: sketch.sketch,
      kind: 'horizontal',
      entities: [line.curves[0]],
    });
    expect(over.message).toMatch(/over-constrain/);
    expect((await refusal(run, 'feature_extrude', { sketch: sketch.sketch, distance: 5 })).message).toMatch(
      /no closed region/,
    );

    // An open feature panel previews its own document: edits wait for it.
    s.app.setState({ panel: { kind: 'extrude' } });
    expect((await refusal(run, 'sketch_draw_circle', { sketch: sketch.sketch, center: [0, 0], radius: 1 })).code).toBe(
      'BUSY',
    );
    s.app.setState({ panel: null });
    expect((await refusal(run, 'view_fit_all')).code).toBe('UNSUPPORTED_BY_HOST');
  });
});

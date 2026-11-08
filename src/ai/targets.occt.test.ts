/**
 * Where the tools act and what they report, on the real kernel and solver:
 * the part the app works in as the default destination, patterns and
 * mirrors of features in their own part, assembly values bound in the
 * assembly's scope, instances placed in the assembly named, a sketch read
 * as it solves now, and an edit whose rebuild fails.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTool } from '@tweakcad/cad-tools';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { findFeature, partOfFeature } from '../app/features';
import { bootApp, type AppServiceClient, type AppServices } from '../app/services';
import { MemoryWorkingCopy } from '../app/storage/workingCopy';
import { createAiContext } from './context';
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

/** The evaluation service in this thread; `fail` makes its evaluates throw. */
function client(fail: { on: boolean }): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) =>
      fail.on ? Promise.reject(new Error('the worker stopped')) : Promise.resolve(service.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(service.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(service.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(service.properties(key)),
    measure: (kind, targets) => Promise.resolve(service.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(service.resolve(record, scope)),
    externalCurves: (key, mode, frame) => Promise.resolve(service.externalCurves(key, mode, frame)),
  };
}

interface Booted {
  s: AppServices;
  run: ToolRun;
  fail: { on: boolean };
  bracket: string;
  second: string;
  secondBoss: string;
  outer: string;
  inner: string;
  gap: string;
}

/**
 * Two parts, Bracket (the root) with a box and Second with a box and a boss joined to it; a document
 * parameter `width` = 40 mm; assembly Outer with `width` = 15 mm and `gap`;
 * assembly Inner holding Second.
 */
async function boot(): Promise<Booted> {
  const fail = { on: false };
  const { services: s } = await bootApp({
    client: client(fail),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(61),
    name: () => 'targets',
  });
  const d = new Docs(9);
  d.parameters.push({ id: d.id('tbl'), name: 'Parameters', parameters: [d.parameter('width', '40 mm')] });
  const bracket = d.part('Bracket');
  bracket.box('20 mm', '20 mm', '10 mm', [0, 0, 5]);
  const second = d.part('Second');
  second.box('10 mm', '10 mm', '10 mm', [0, 0, 5]);
  const secondBoss = second.box('4 mm', '4 mm', '4 mm', [3, 0, 11], 'join');
  const outer = d.assembly('Outer');
  const gap = d.parameter('gap', '1 mm');
  outer.json.parameters = [{ id: d.id('tbl'), name: 'Parameters', parameters: [d.parameter('width', '15 mm'), gap] }];
  outer.instance({ part: { id: bracket.id } }, { grounded: true });
  const inner = d.assembly('Inner');
  inner.instance({ part: { id: second.id } }, { grounded: true });
  s.editor.store.replace(d.document({ part: { id: bracket.id } }));
  const ctx = createAiContext({ services: s, solver: () => Promise.resolve(gcs) });
  return {
    s,
    run: { ctx, transactions: storeTransactions(ctx) },
    fail,
    bracket: bracket.id,
    second: second.id,
    secondBoss,
    outer: outer.id,
    inner: inner.id,
    gap: (gap.value as Json).id as string,
  };
}

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

describe('where the tools act', { timeout: 120_000 }, () => {
  it('adds a feature to the part the app works in, or the part named', async () => {
    const { s, run, bracket, second } = await boot();
    expect((findTool('feature_primitive')?.inputSchema.properties as Json).part).toBeDefined();
    s.app.setState({ focus: { part: second } });
    const box = await call<{ feature: string; status: string }>(run, 'feature_primitive', { shape: 'box' });
    expect(box.status).toBe('ok');
    expect(partOfFeature(s.editor.document, box.feature)).toBe(second);
    const named = await call<{ feature: string }>(run, 'feature_primitive', { shape: 'box', part: bracket });
    expect(partOfFeature(s.editor.document, named.feature)).toBe(bracket);
  });

  it('patterns and mirrors features in their own part, a mirror joining by default', async () => {
    const { s, run, bracket, second, secondBoss } = await boot();
    const mirror = await call<{ feature: string; status: string }>(run, 'feature_mirror', {
      features: [secondBoss],
      plane: 'yz',
    });
    expect(mirror.status).toBe('ok');
    expect(partOfFeature(s.editor.document, mirror.feature)).toBe(second);
    const op = ((findFeature(s.editor.document, mirror.feature)?.inputs as Json).operation as Json).op as Json;
    expect(((op.def as Json).expr as Json).text).toBe('"join"');
    const pattern = await call<{ feature: string; status: string }>(run, 'feature_pattern', {
      features: [secondBoss],
      layout: 'linear',
      direction: 'y',
      count: 2,
      spacing: 2,
    });
    expect(pattern.status).toBe('ok');
    expect(partOfFeature(s.editor.document, pattern.feature)).toBe(second);
    const box = await call<{ feature: string }>(run, 'feature_primitive', { shape: 'box', part: bracket });
    expect(
      (await refusal(run, 'feature_mirror', { features: [secondBoss, box.feature], plane: 'yz' })).message,
    ).toMatch(/one part/);
  });

  it("binds an assembly value's expression in the assembly's scope", async () => {
    const { s, run, gap } = await boot();
    const set = await call<{ stored: unknown }>(run, 'set_value', { value: gap, expression: 'width * 2' });
    expect(set.stored).toBe(30);
    const def = (JSON.stringify(s.editor.document.assemblies).match(
      /"refs":\{"width":\{"parameter":\{"id":"(par_[a-z2-7]+)"/,
    ) ?? [])[1];
    const outerWidth = (((s.editor.document.assemblies as Json[])[0]?.parameters as Json[])[0]?.parameters as Json[])[0]
      ?.id;
    expect(def).toBe(outerWidth);
  });

  it('places an instance in the assembly named, of a part or of another assembly', async () => {
    const { s, run, outer, inner, second } = await boot();
    const part = await call<{ instance: string }>(run, 'assembly_insert', {
      assembly: inner,
      part: second,
      position: [0, 30, 0],
    });
    const sub = await call<{ instance: string }>(run, 'assembly_insert', {
      assembly: outer,
      subassembly: inner,
      position: [50, 0, 0],
    });
    const rows = (id: string) =>
      (((s.editor.document.assemblies as Json[]).find((a) => a.id === id) as Json).instances as Json[]).map(
        (i) => i.id,
      );
    expect(rows(inner)).toContain(part.instance);
    expect(rows(outer)).toContain(sub.instance);
    expect(
      ((s.editor.document.assemblies as Json[]).find((a) => a.id === outer)?.instances as Json[]).find(
        (i) => i.id === sub.instance,
      )?.of,
    ).toEqual({ assembly: { id: inner } });
    expect((await refusal(run, 'assembly_insert', { assembly: inner, subassembly: inner })).code).toBe('INVALID_INPUT');
    expect((await refusal(run, 'assembly_insert', { assembly: inner, part: second, subassembly: outer })).code).toBe(
      'INVALID_INPUT',
    );
  });
});

describe('what the tools report', { timeout: 120_000 }, () => {
  it('reads a sketch as it solves with the values the document has now', async () => {
    const { run } = await boot();
    await call(run, 'set_parameter', { name: 'span', expression: 40 });
    const sketch = (await call<{ sketch: string }>(run, 'sketch_create', { on: 'xy' })).sketch;
    const rect = await call<{ curves: string[]; points: string[] }>(run, 'sketch_draw_rectangle', {
      sketch,
      from: [0, 0],
      to: [40, 20],
    });
    await call(run, 'sketch_constrain', { sketch, kind: 'dimension', entities: [rect.curves[0]], value: 'span' });
    await call(run, 'set_parameter', { name: 'span', expression: 60 });
    const read = await call<{
      points: { id: string; x: number; y: number }[];
      curves: { id: string; start?: string; end?: string }[];
      constraints: { kind: string; solved?: number }[];
    }>(run, 'get_sketch', { sketch });
    const bottom = read.curves.find((c) => c.id === rect.curves[0]);
    const at = (id: unknown) => read.points.find((p) => p.id === id) as { x: number; y: number };
    expect(Math.hypot(at(bottom?.end).x - at(bottom?.start).x, at(bottom?.end).y - at(bottom?.start).y)).toBeCloseTo(
      60,
      6,
    );
    // A position read back names the point there: a line drawn from it starts at that point.
    const corner = at(bottom?.end);
    const line = await call<{ points: string[] }>(run, 'sketch_draw_line', {
      sketch,
      points: [
        [corner.x, corner.y],
        [corner.x + 10, corner.y - 10],
      ],
      tolerance: 1e-3,
    });
    expect(line.points[0]).toBe(bottom?.end);
  });

  it('refuses to report an added feature as built when its rebuild failed', async () => {
    const { s, run, fail } = await boot();
    await call(run, 'list_features');
    fail.on = true;
    const failed = await refusal(run, 'feature_primitive', { shape: 'box' });
    expect(failed.code).toBe('HOST_ERROR');
    expect(failed.message).toMatch(/the worker stopped/);
    // The feature was written; the diagnostics show the rebuild error beside the display before it.
    expect(s.editor.store.canUndo()).toBe(true);
    const diagnostics = await call<{ rebuildError?: string }>(run, 'get_diagnostics');
    expect(diagnostics.rebuildError).toMatch(/the worker stopped/);
  });
});

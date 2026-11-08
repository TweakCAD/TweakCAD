/**
 * The assembly tools end to end on the real kernel, as a model would call
 * them: an assembly of two parts, the second inserted and hinged on the
 * first by faces listed from each part, driven, posed and exploded; a part
 * derived; a hole through both parts, and its context brought up to date
 * after the start part's hole moves; copies of an instance by a pattern, a
 * mirror and a replicate, each edited; a feature frozen and unfrozen.
 */
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { bootApp, type AppServiceClient, type AppServices } from '../app/services';
import { MemoryWorkingCopy } from '../app/storage/workingCopy';
import { createAiContext } from './context';
import { storeTransactions } from './document';
import { executeTool, toolsWithoutRunner, type ToolRun } from './executor';
import { assemblyOf } from '../app/assembly/assembly';

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  service = new EvaluationService(k);
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
    neighbours: (key) => Promise.resolve(service.neighbours(key)),
    updateContexts: (doc, requests, options) => Promise.resolve(service.updateContexts(doc as Json, requests, options)),
    freeze: (doc, feature) => Promise.resolve(service.freeze(doc as Json, feature)),
  };
}

async function boot(): Promise<{ s: AppServices; run: ToolRun; base: string; arm: string }> {
  const { services: s } = await bootApp({
    client: client(),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(41),
    name: () => 'assembly tools',
  });
  const d = new Docs(5);
  const base = d.part('Base');
  base.box('60 mm', '40 mm', '10 mm', [0, 0, 5]);
  const arm = d.part('Arm');
  arm.box('40 mm', '10 mm', '6 mm', [0, 0, 3]);
  s.editor.store.replace(d.document({ part: { id: base.id } }));
  const ctx = createAiContext({ services: s, solver: () => Promise.reject(new Error('no sketches here')) });
  return { s, run: { ctx, transactions: storeTransactions(ctx) }, base: base.id, arm: arm.id };
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

/** A planar face of a part facing `normal`, as a handle. */
async function faceFacing(run: ToolRun, part: string, normal: number[]): Promise<string> {
  const { bodies } = await call<{ bodies: { handle: string }[] }>(run, 'list_bodies', { part });
  const { faces } = await call<{ faces: { handle: string }[] }>(run, 'list_faces', {
    body: bodies[0]?.handle as string,
    normal,
  });
  return faces[0]?.handle as string;
}

interface Assembly {
  assembly: string;
  instances: { id: string; label: string; position: number[]; rotation: number[] }[];
  joints: { id: string; values: Record<string, number> }[];
  positions: { id: string; name: string }[];
  activePosition: string | null;
  explodedViews: { id: string }[];
  outOfDate: { context: string }[];
  features: { id: string; type: string; name: string; copies: number }[];
}

describe('the assembly tools on the kernel', { timeout: 120_000 }, () => {
  it('runs every tool of the catalogue', () => {
    expect(toolsWithoutRunner()).toEqual([]);
  });

  it('makes, joins, drives, poses and explodes an assembly, derives a part, and drills through two parts', async () => {
    const { s, run, base, arm } = await boot();
    const made = await call<Assembly>(run, 'assembly_create', { parts: [base] });
    expect(made.instances.map((i) => i.label)).toEqual(['Base:1']);
    const inserted = await call<{ instance: string; label: string }>(run, 'assembly_insert', {
      part: arm,
      position: [100, 0, 0],
    });
    expect(inserted.label).toBe('Arm:1');
    const baseInstance = made.instances[0]?.id as string;

    const top = await faceFacing(run, base, [0, 0, 1]);
    const under = await faceFacing(run, arm, [0, 0, -1]);
    // An end names geometry of the part its instance places.
    expect(
      (
        await refusal(run, 'assembly_joint', {
          kind: 'revolute',
          a: { instance: baseInstance, at: under },
          b: { instance: inserted.instance, at: top },
        })
      ).code,
    ).toBe('INVALID_INPUT');
    const joined = await call<{ joint: string; assembly: Assembly }>(run, 'assembly_joint', {
      kind: 'revolute',
      a: { instance: baseInstance, at: top },
      b: { instance: inserted.instance, at: under },
    });
    const armAt = joined.assembly.instances.find((i) => i.id === inserted.instance);
    expect(armAt?.position).toEqual([0, 0, 10]);

    const driven = await call<Assembly>(run, 'assembly_drive', { joint: joined.joint, values: { rz: 45 } });
    expect(driven.joints[0]?.values.rz).toBeCloseTo(45, 6);
    expect((await refusal(run, 'assembly_drive', { joint: joined.joint, values: { tz: 1 } })).code).toBe(
      'INVALID_INPUT',
    );

    // A joint is renamed and locked; a locked one is not driven, and holds where it stands.
    const named = await call<Assembly & { joints: { label: string; locked?: boolean }[] }>(run, 'assembly_set_joint', {
      joint: joined.joint,
      name: 'Hinge',
      locked: true,
    });
    expect(named.joints[0]).toMatchObject({ label: 'Hinge', locked: true });
    expect((await refusal(run, 'assembly_drive', { joint: joined.joint, values: { rz: 10 } })).code).toBe('REFUSED');
    const unlocked = await call<Assembly & { joints: { label: string; locked?: boolean }[] }>(
      run,
      'assembly_set_joint',
      { joint: joined.joint, name: '', locked: false },
    );
    expect(unlocked.joints[0]).toMatchObject({ label: 'Revolute 1' });
    expect(unlocked.joints[0]?.locked).toBeUndefined();
    expect(unlocked.joints[0]?.values.rz).toBeCloseTo(45, 6);
    expect(assemblyOf(s.editor.document, made.assembly)?.attributes).toEqual([]);

    const captured = await call<{ position: string }>(run, 'assembly_position', { action: 'capture', name: 'Open' });
    await call(run, 'assembly_drive', { joint: joined.joint, values: { rz: 0 } });
    const posed = await call<Assembly>(run, 'assembly_position', { action: 'activate', position: captured.position });
    expect(posed.activePosition).toBe(captured.position);
    expect(posed.joints[0]?.values.rz).toBeCloseTo(45, 6);
    const current = await call<Assembly>(run, 'assembly_position', { action: 'current' });
    expect(current.activePosition).toBeNull();

    const exploded = await call<{ explodedView: string }>(run, 'assembly_exploded_view', {
      steps: [{ instances: [inserted.instance], move: [0, 0, 40] }],
    });
    expect(s.app.getState().exploded).toBe(exploded.explodedView);

    const derived = await call<{ status: string }>(run, 'feature_derive', {
      part: arm,
      fromPart: base,
      offset: [0, 0, -20],
    });
    expect(derived.status).toBe('ok');
    expect(readDocument(s.editor.document).refused).toBe(false);
  });

  it("drills one hole through two parts and brings the second part's context up to date", async () => {
    const { s, run, base, arm } = await boot();
    const made = await call<Assembly>(run, 'assembly_create', { parts: [base] });
    const inserted = await call<{ instance: string }>(run, 'assembly_insert', { part: arm });
    const baseInstance = made.instances[0]?.id as string;
    await call(run, 'assembly_joint', {
      kind: 'rigid',
      a: { instance: baseInstance, at: await faceFacing(run, base, [0, 0, 1]) },
      b: { instance: inserted.instance, at: await faceFacing(run, arm, [0, 0, -1]) },
    });
    const armTop = await faceFacing(run, arm, [0, 0, 1]);
    await call(run, 'assembly_hole_through', {
      instance: inserted.instance,
      face: armTop,
      points: [[12, 0]],
      diameter: 4,
      through: [baseInstance],
    });
    const bore = async (part: string) => {
      const { bodies } = await call<{ bodies: { handle: string }[] }>(run, 'list_bodies', { part });
      const { faces } = await call<{ faces: { centroid: number[] }[] }>(run, 'list_faces', {
        body: bodies[0]?.handle as string,
        surface: 'cylinder',
      });
      return faces[0]?.centroid[0];
    };
    expect(await bore(base)).toBeCloseTo(12, 4);

    // The start part's hole moves; the base's context reports it, and updating it moves the base's hole too.
    const hole = ((s.editor.document.parts as Json[]).find((p) => p.id === arm)?.timeline as Json[]).find(
      (f) => f.type === 'core.hole',
    ) as Json;
    const at = ((((hole.inputs as Json).positions as Json[])[0] as Json).at as Json).at as Json;
    await call(run, 'set_value', { value: (at.v as Json).id as string, expression: 'vector(-6 mm, 0 mm, 0 mm)' });
    const stale = await call<Assembly>(run, 'get_assembly');
    expect(stale.outOfDate).toHaveLength(1);
    const updated = await call<{ updated: string[]; outOfDate: unknown[] }>(run, 'assembly_update_contexts');
    expect(updated.updated).toHaveLength(1);
    expect(updated.outOfDate).toEqual([]);
    expect(await bore(base)).toBeCloseTo(-6, 4);
  });

  it('copies an instance by a pattern, a mirror and a replicate, and edits each', async () => {
    const { run, base, arm } = await boot();
    const made = await call<Assembly>(run, 'assembly_create', { parts: [base] });
    const baseInstance = made.instances[0]?.id as string;
    const inserted = await call<{ instance: string }>(run, 'assembly_insert', { part: arm, position: [100, 0, 0] });

    const pattern = await call<{ feature: string; copies: number; status: string; assembly: Assembly }>(
      run,
      'assembly_pattern',
      {
        instances: [inserted.instance],
        layout: 'linear',
        directions: [{ axis: 'y', count: 3, spacing: 20 }],
      },
    );
    expect([pattern.copies, pattern.status]).toEqual([2, 'ok']);
    expect(pattern.assembly.features).toEqual([
      { id: pattern.feature, type: 'core.asm.pattern', name: 'Pattern 1', copies: 2 },
    ]);
    const widened = await call<{ copies: number }>(run, 'assembly_pattern', {
      feature: pattern.feature,
      directions: [{ axis: 'y', count: 5, spacing: 20 }],
    });
    expect(widened.copies).toBe(4);
    const both = await call<{ copies: number }>(run, 'assembly_pattern', {
      feature: pattern.feature,
      directions: [{ axis: 'y', count: 5, spacing: 20, symmetric: true }],
    });
    expect(both.copies).toBe(4);
    expect(
      (await refusal(run, 'assembly_pattern', { layout: 'linear', directions: [{ axis: 'y', count: 2, spacing: 5 }] }))
        .code,
    ).toBe('INVALID_INPUT');

    // A circular pattern about a vertical edge of the base, seen through the base's instance.
    const { bodies } = await call<{ bodies: { handle: string }[] }>(run, 'list_bodies', { part: base });
    const { edges } = await call<{ edges: { handle: string }[] }>(run, 'list_edges', {
      body: bodies[0]?.handle as string,
      parallel: [0, 0, 1],
    });
    const turned = await call<{ copies: number }>(run, 'assembly_pattern', {
      instances: [inserted.instance],
      layout: 'circular',
      axis: { instance: baseInstance, at: edges[0]?.handle },
      count: 4,
    });
    expect(turned.copies).toBe(3);

    const plusX = await faceFacing(run, base, [1, 0, 0]);
    const mirror = await call<{ feature: string; copies: number }>(run, 'assembly_mirror', {
      instances: [inserted.instance],
      plane: { instance: baseInstance, at: plusX },
    });
    expect(mirror.copies).toBe(1);
    const opposite = await call<{ status: string; copies: number }>(run, 'assembly_mirror', {
      feature: mirror.feature,
      hand: 'opposite',
    });
    expect([opposite.status, opposite.copies]).toEqual(['ok', 1]);

    const top = await faceFacing(run, base, [0, 0, 1]);
    const under = await faceFacing(run, base, [0, 0, -1]);
    const replicate = await call<{ feature: string; copies: number }>(run, 'assembly_replicate', {
      instances: [inserted.instance],
      seed: { instance: baseInstance, at: top },
      targets: [{ instance: baseInstance, at: under }],
    });
    expect(replicate.copies).toBe(1);
    const more = await call<{ copies: number }>(run, 'assembly_replicate', {
      feature: replicate.feature,
      targets: [{ instance: baseInstance, at: under }, { standard: 'xz' }],
    });
    expect(more.copies).toBe(2);
    expect((await refusal(run, 'assembly_mirror', { feature: replicate.feature })).code).toBe('INVALID_INPUT');
  });

  it('freezes a feature, which keeps its result through an edit before it, and makes it live again', async () => {
    const { s, run, base } = await boot();
    const box = ((s.editor.document.parts as Json[]).find((p) => p.id === base)?.timeline as Json[])[0] as Json;
    const added = await call<{ feature: string }>(run, 'feature_primitive', {
      shape: 'box',
      width: 20,
      depth: 20,
      height: 5,
      position: [0, 0, 12.5],
      operation: 'join',
    });
    const frozen = await call<{ frozen: boolean; status: string }>(run, 'feature_freeze', { feature: added.feature });
    expect([frozen.frozen, frozen.status]).toEqual([true, 'ok']);
    const volume = async () => {
      const { bodies } = await call<{ bodies: { volume: number }[] }>(run, 'list_bodies', { part: base });
      return bodies.reduce((v, b) => v + b.volume, 0);
    };
    const before = await volume();
    expect(before).toBeCloseTo(60 * 40 * 10 + 20 * 20 * 5, 3);

    // The base box widens; the frozen join still shows the body it stored, and is listed as blocked by the change.
    const width = (((box.inputs as Json).shape as Json).box as Json).width as Json;
    await call(run, 'set_value', { value: width.id as string, expression: '80 mm' });
    expect(await volume()).toBeCloseTo(before, 3);
    const listed = await call<{ parts: { features: { id: string; frozen?: boolean; status: string }[] }[] }>(
      run,
      'list_features',
      { part: base },
    );
    expect(listed.parts[0]?.features.find((f) => f.id === added.feature)).toMatchObject({
      frozen: true,
      status: 'blocked',
    });

    const live = await call<{ frozen: boolean }>(run, 'feature_freeze', { feature: added.feature, frozen: false });
    expect(live.frozen).toBe(false);
    expect(await volume()).toBeCloseTo(80 * 40 * 10 + 20 * 20 * 5, 3);
    expect((await refusal(run, 'feature_freeze', { feature: 'feat_nope' })).code).toBe('NOT_FOUND');
  });
});

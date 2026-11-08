/**
 * Writes version-2 documents as the app does, headless: the app's services
 * over an evaluation service in this thread on the real kernel and solver,
 * edited through the CAD tool executor and the app's command helpers. Used
 * to generate the regression fixtures.
 */
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display, Key } from '@tweakcad/worker/src/v2/service/types';
import { bootApp, type AppServiceClient, type AppServices } from '../app/services';
import { newDocument } from '../app/document';
import { MemoryWorkingCopy } from '../app/storage/workingCopy';
import { createAiContext } from '../ai/context';
import { storeTransactions } from '../ai/document';
import { executeTool, type ToolRun } from '../ai/executor';

export interface Kernel {
  k: OcctKernel;
  gcs: GcsWrapper;
  service: EvaluationService;
}

/** The kernel, and the solver loaded from planegcs's wasm file at `solverWasm`. */
export async function loadKernel(solverWasm: string): Promise<Kernel> {
  const k = await OcctKernel.init();
  const gcs = await make_gcs_wrapper(solverWasm);
  return { k, gcs, service: new EvaluationService(k, gcs) };
}

function clientOf(service: EvaluationService): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(service.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(service.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(service.exportFile(format, scope, options)),
    exportFreeCad: () => Promise.resolve(service.exportFreeCad()),
    properties: (key) => Promise.resolve(service.properties(key)),
    measure: (kind, targets) => Promise.resolve(service.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(service.resolve(record, scope)),
    bodiesBefore: (scope, records, options) => Promise.resolve(service.bodiesBefore(scope, records, options)),
    externalCurves: (key, mode, frame) => Promise.resolve(service.externalCurves(key, mode, frame)),
    neighbours: (key) => Promise.resolve(service.neighbours(key)),
  };
}

/** The date every fixture document is written on, so a regenerated file differs only where the model does. */
const WRITTEN = new Date('2026-11-06T00:00:00Z');

export interface Session {
  s: AppServices;
  run: ToolRun;
  /** Runs a tool; a refusal throws with its message. */
  call<T = Json>(name: string, input?: Json): Promise<T>;
  /** The display after the newest rebuild. */
  display(): Promise<Display>;
  /** The root part's id. */
  part: string;
}

/** A session on a new document named `name`, or on `open` as it stands. */
export async function session(kernel: Kernel, name: string, seed: number, open?: Json): Promise<Session> {
  const ids = seededIds(seed);
  const doc = open ?? newDocument({ ids, name, now: WRITTEN });
  const { services: s } = await bootApp({
    client: clientOf(kernel.service),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids,
    name: () => name,
    boot: { doc, localId: null, storage: { kind: 'unsaved' }, session: { kind: 'unsaved' } },
  });
  const ctx = createAiContext({ services: s, solver: () => Promise.resolve(kernel.gcs) });
  const run: ToolRun = { ctx, transactions: storeTransactions(ctx) };
  const call = async <T = Json>(tool: string, input: Json = {}): Promise<T> => {
    const r = await executeTool(tool, input, run);
    if (!r.ok) throw new Error(`${tool} ${JSON.stringify(input)}: ${r.error.code}: ${r.error.message}`);
    return r.value as T;
  };
  const display = async (): Promise<Display> => {
    await s.whenShown();
    const shown = s.display.getState().display;
    if (!shown) throw new Error('nothing is shown');
    return shown;
  };
  const part = (((doc.root as Json).part as Json | undefined)?.id ?? ((doc.parts as Json[])[0] as Json).id) as string;
  if (!open) s.editor.dispatch({ type: 'renamePart', part, name });
  return { s, run, call, display, part };
}

/** A circular edge of a placed definition: its key, by the circle's centre and radius. */
export async function circleEdge(
  s: AppServices,
  display: Display,
  definition: number,
  centre: readonly number[],
  radius: number,
): Promise<Key> {
  const def = display.definitions[definition];
  if (!def) throw new Error(`no definition ${definition}`);
  for (const body of def.bodies) {
    const edges = body.mesh.edges;
    for (let i = 2; i < edges.length; i += 3) {
      const key = edges[i] as Key;
      const m = (await s.client.properties(key))?.measures as Json | undefined;
      if (m?.curve !== 'circle') continue;
      const c = m.center as number[];
      if (!c) continue;
      const r = (m.length as number) / (2 * Math.PI);
      if (Math.abs(r - radius) < 1e-6 && c.every((v, j) => Math.abs(v - (centre[j] as number)) < 1e-6)) return key;
    }
  }
  throw new Error(`no circle of radius ${radius} at ${JSON.stringify(centre)}`);
}

/** A planar face of a placed definition: its key, by its outward normal and a point of its plane. */
export async function planeFace(
  s: AppServices,
  display: Display,
  definition: number,
  normal: readonly number[],
  point: readonly number[],
): Promise<Key> {
  const def = display.definitions[definition];
  if (!def) throw new Error(`no definition ${definition}`);
  for (const body of def.bodies) {
    const faces = body.mesh.faces;
    for (let i = 2; i < faces.length; i += 3) {
      const key = faces[i] as Key;
      const m = (await s.client.properties(key))?.measures as Json | undefined;
      const n = m?.normal as number[] | undefined;
      const c = m?.centroid as number[] | undefined;
      if (!n || !c || n.some((v, j) => Math.abs(v - (normal[j] as number)) > 1e-9)) continue;
      if (Math.abs(c.reduce((sum, v, j) => sum + (v - (point[j] as number)) * (normal[j] as number), 0)) < 1e-6)
        return key;
    }
  }
  throw new Error(`no face facing ${JSON.stringify(normal)} through ${JSON.stringify(point)}`);
}

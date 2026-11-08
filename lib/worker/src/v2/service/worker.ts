/**
 * The version-2 worker entry: one evaluation service on its own kernel and
 * sketch solver, exposed with Comlink. Meshes and files come back as
 * transferred typed arrays; everything else is structured-cloned data.
 */
import * as Comlink from 'comlink';
import { OcctKernel } from 'occt-wasm';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import planegcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { EntityRecord } from '@tweakcad/format';
import type { Json } from '../context';
import { EvaluationService } from './service';
import { buffers } from './transfer';
import { applyPatch, type PatchOp } from './docPatch';
import type { ImportFormat } from './importShape';
import type { SurfaceSpec } from './onSurfaces';
import type {
  BeforeScope,
  ContextRequest,
  Display,
  EvaluateServiceOptions,
  ExportFormat,
  ExportOptions,
  FrameDisplay,
  Key,
  MeasureKind,
  PickOptions,
  PickTarget,
  Progress,
  ResolveScope,
} from './types';

let loading: Promise<EvaluationService> | null = null;
/** The document the client last sent to evaluate, by the id it gave it, for the next to be sent as a change from it. */
let kept: { id: number; doc: Json } | null = null;
/** Where progress of a running job goes: the port the client gave at `connect`. */
let progressPort: MessagePort | null = null;

/** Posts a job's progress on the client's port, tagged with the job, so the client can drop a superseded job's. */
function reporter(job: number | undefined): ((p: Progress) => void) | undefined {
  const port = progressPort;
  if (!port || job === undefined) return undefined;
  return (p) => port.postMessage({ job, ...p });
}

/** The service, its kernel and solver loaded once per worker; a failed load is tried again on the next call. */
function service(): Promise<EvaluationService> {
  loading ??= (async () => {
    const [kernel, solver] = await Promise.all([OcctKernel.init(), make_gcs_wrapper(planegcsWasmUrl)]);
    return new EvaluationService(kernel, solver);
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

const api = {
  /** Loads the kernel and solver; later calls return at once. */
  async init(): Promise<{ loadTimeMs: number }> {
    const t0 = performance.now();
    await service();
    return { loadTimeMs: Math.round(performance.now() - t0) };
  },

  /** Takes the port progress of jobs is posted on. */
  connect(port: MessagePort): void {
    progressPort = port;
  },

  /**
   * Evaluates `doc`; with a `job`, its progress is posted on the connected
   * port, tagged with it. With an `id`, the document is kept under it, for
   * the next to come as a change from it (`evaluateChange`).
   */
  async evaluate(doc: Json, options?: EvaluateServiceOptions, job?: number, id?: number): Promise<Display> {
    kept = id === undefined ? null : { id, doc };
    const display = (await service()).evaluate(doc, options, reporter(job));
    return Comlink.transfer(display, buffers(display));
  },

  /**
   * Evaluates the document kept under `base` with `patch` applied, kept in
   * turn under `id`; null when the document kept is not `base`, and the
   * client sends the whole document instead.
   */
  async evaluateChange(
    base: number,
    patch: PatchOp[],
    id: number,
    options?: EvaluateServiceOptions,
    job?: number,
  ): Promise<Display | null> {
    if (!kept || kept.id !== base) return null;
    const doc = applyPatch(kept.doc, patch) as Json;
    kept = { id, doc };
    const display = (await service()).evaluate(doc, options, reporter(job));
    return Comlink.transfer(display, buffers(display));
  },

  async pick(target: PickTarget, options?: PickOptions) {
    return (await service()).pick(target, options);
  },

  async resolve(record: EntityRecord, scope: ResolveScope) {
    return (await service()).resolve(record, scope);
  },

  async bodiesBefore(scope: BeforeScope, records?: EntityRecord[], options?: { picks?: boolean }) {
    return (await service()).bodiesBefore(scope, records, options);
  },

  async outlinesBefore(scope: BeforeScope, records: EntityRecord[]) {
    const outlines = (await service()).outlinesBefore(scope, records);
    return Comlink.transfer(outlines, buffers(outlines));
  },

  async measure(kind: MeasureKind, targets: (Key | PickTarget)[]) {
    return (await service()).measure(kind, targets);
  },

  async properties(key: Key) {
    return (await service()).properties(key);
  },

  async bodyMeasures(key: Key) {
    return (await service()).bodyMeasures(key);
  },

  async externalCurves(key: Key, mode: 'project' | 'intersect', frame: FrameDisplay) {
    return (await service()).externalCurves(key, mode, frame);
  },

  async entities(keys: Key[]) {
    return (await service()).entities(keys);
  },

  async neighbours(key: Key) {
    return (await service()).neighbours(key);
  },

  async updateContexts(doc: Json, requests: ContextRequest[], options?: { passes?: number; capturedAt?: string }) {
    return (await service()).updateContexts(doc, requests, options);
  },

  async freeze(doc: Json, feature: string) {
    return (await service()).freeze(doc, feature);
  },

  async exportFile(format: ExportFormat, scope: ResolveScope, options?: ExportOptions): Promise<Uint8Array> {
    const bytes = (await service()).exportFile(format, scope, options);
    return Comlink.transfer(bytes, buffers(bytes));
  },

  async importFile(bytes: Uint8Array, format: ImportFormat, feature: string, name: string) {
    return (await service()).importFile(bytes, format, feature, name);
  },

  async bodyRecords(part: string, before: string | undefined) {
    return (await service()).bodyRecords(part, before);
  },

  async exportFreeCad() {
    return (await service()).exportFreeCad();
  },

  async shapeMeasures(brep: string) {
    return (await service()).shapeMeasures(brep);
  },

  async stepMeasures(part: string, feature: string) {
    return (await service()).stepMeasures(part, feature);
  },

  async locate(
    part: string,
    before: string | undefined,
    brep: string,
    kind: 'edge' | 'face',
    indices: number[] | 'all',
    ofFaces?: number[],
  ) {
    return (await service()).locate(part, before, brep, kind, indices, ofFaces);
  },
  async locateOnSurfaces(part: string, before: string | undefined, pairs: [SurfaceSpec, SurfaceSpec][]) {
    return (await service()).locateOnSurfaces(part, before, pairs);
  },
  async bodiesMadeBy(part: string, before: string | undefined, features: string[]) {
    return (await service()).bodiesMadeBy(part, before, features);
  },
  async locateFacesOnSurfaces(part: string, before: string | undefined, surfaces: SurfaceSpec[]) {
    return (await service()).locateFacesOnSurfaces(part, before, surfaces);
  },
  async vetSketch(inputs: Record<string, unknown>) {
    return (await service()).vetSketch(inputs);
  },
  async vetSketches(doc: Json, features: string[]) {
    return (await service()).vetSketches(doc, features);
  },

  /** Releases the kept evaluation and its kernel shapes. */
  async release(): Promise<void> {
    (await service()).release();
  },
};

export type ServiceWorkerApi = typeof api;

Comlink.expose(api);

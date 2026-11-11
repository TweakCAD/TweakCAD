/**
 * The app's side of the version-2 worker service: a typed client over one
 * dedicated worker. Calls are answered in the order they are made; each
 * `evaluate` replaces the kept evaluation, so keys from an earlier display
 * stop meaning anything once a later one has been asked for.
 */
import * as Comlink from 'comlink';
import type { EntityRecord } from '@tweakcad/format';
import type { ServiceWorkerApi } from './worker';
import type { FcstdExport } from '../fcstd/export';
import type { ImportFormat, ImportedShape, ImportProgress } from './importShape';
import type { SurfaceSpec } from './onSurfaces';
import { diffDocs } from './docPatch';
import type {
  BeforeScope,
  BodiesBefore,
  ContextRequest,
  ContextsUpdate,
  FrozenResult,
  Display,
  EntityInfo,
  EvaluateServiceOptions,
  ExportFormat,
  ExportOptions,
  FrameDisplay,
  Key,
  MeasureKind,
  Measured,
  BodyMeasures,
  BodyMesh,
  PickOptions,
  PickOutline,
  PickTarget,
  Picked,
  PickedEntity,
  Progress,
  Resolved,
  ResolveScope,
  ShapeMeasures,
} from './types';

export type * from './types';
export type { ImportFormat, ImportedShape, ImportProgress } from './importShape';
export { edgeAt, faceAt, matrixOf } from './picking';

/**
 * Passes on the progress the worker posts, tagged with its job, for the
 * newest job started only: what a superseded job still reports is dropped.
 */
export class ProgressRelay {
  private jobs = 0;
  private readonly listeners = new Set<(p: Progress) => void>();

  /** A new job, which from now on is the only one heard. */
  start(): number {
    return ++this.jobs;
  }

  receive(message: Progress & { job: number }): void {
    const { job, ...progress } = message;
    if (job !== this.jobs) return;
    for (const listener of this.listeners) listener(progress as Progress);
  }

  /** Returns the unsubscribe. */
  listen(listener: (p: Progress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }
}

type Geometry = Pick<BodyMesh, 'positions' | 'normals' | 'indices' | 'segments' | 'points'>;

/** Displays whose geometries the store keeps: enough for a preview and the committed display to take turns. */
const KEPT_DISPLAYS = 3;

/**
 * The geometries of the bodies of the last few displays the worker sent, by
 * id (`BodyDisplay.geometry`): a body whose geometry the client holds comes
 * as kept, with its pick tables only, and gets its geometry back here.
 */
export class MeshStore {
  private readonly geometries = new Map<number, Geometry>();
  private readonly recent: Set<number>[] = [];

  /** The geometries held, for the worker (`EvaluateServiceOptions.held`). */
  held(): number[] {
    return [...this.geometries.keys()];
  }

  /** `display` with every kept body's geometry in place, its new geometries kept for the next; null when it keeps one not held. */
  fill(display: Display): Display | null {
    const used = new Set<number>();
    for (const def of display.definitions) {
      for (const body of def.bodies) {
        const id = body.geometry;
        if (id === undefined || body.unmeshed) continue;
        used.add(id);
        if (body.kept) {
          const geometry = this.geometries.get(id);
          if (!geometry) return null;
          body.mesh = { ...body.mesh, ...geometry };
          delete body.kept;
        } else {
          const { positions, normals, indices, segments, points } = body.mesh;
          this.geometries.set(id, { positions, normals, indices, segments, points });
        }
      }
    }
    this.recent.push(used);
    if (this.recent.length > KEPT_DISPLAYS) this.recent.shift();
    for (const id of this.geometries.keys()) if (!this.recent.some((r) => r.has(id))) this.geometries.delete(id);
    return display;
  }
}

/** How a call ends when the worker it went to is restarted (`ServiceClient.restart`). */
export class WorkerRestarted extends Error {
  constructor() {
    super('The worker was restarted');
  }
}

export class ServiceClient {
  // Held in private fields, out of reach of anything that walks the client's
  // properties: a released Comlink proxy throws on every property read.
  #worker!: Worker;
  /** The worker's API as Comlink gives it. */
  #remote!: Comlink.Remote<ServiceWorkerApi>;
  /** The same API, each call ending in `WorkerRestarted` when the worker is restarted before it answers. */
  #api!: Comlink.Remote<ServiceWorkerApi>;
  private stop: (e: Error) => void = () => undefined;
  private readonly progress = new ProgressRelay();
  private meshes = new MeshStore();
  private port!: MessagePort;
  /** The document last sent to evaluate and the id the worker keeps it under, so the next goes as a change from it. */
  private sent: { doc: unknown; id: number } | null = null;
  private sends = 0;

  /** A client over the workers `spawn` makes, each running `worker.ts`: one now, another at each restart. */
  constructor(private readonly spawnWorker: () => Worker) {
    this.connect();
  }

  private connect(): void {
    this.#worker = this.spawnWorker();
    const remote = Comlink.wrap<ServiceWorkerApi>(this.#worker);
    this.#remote = remote;
    const stopped = new Promise<never>((_, reject) => {
      this.stop = reject;
    });
    // A restart with no call waiting is heard by no one.
    stopped.catch(() => undefined);
    this.#api = new Proxy(remote, {
      get: (target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        const method = Reflect.get(target, name) as (...args: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => Promise.race([method(...args), stopped]);
      },
    });
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (e: MessageEvent<Progress & { job: number }>) => this.progress.receive(e.data);
    this.#api.connect(Comlink.transfer(channel.port2, [channel.port2])).catch(() => undefined);
  }

  /**
   * Stops the worker, whatever it is doing, and starts a fresh one: the only
   * way to end a kernel call. Calls waiting end in `WorkerRestarted`. The new
   * worker keeps no document and numbers its geometries afresh, so the next
   * evaluate sends the whole document and every geometry. Its kernel loads
   * with the first call.
   */
  restart(): void {
    this.stop(new WorkerRestarted());
    this.port.close();
    this.#remote[Comlink.releaseProxy]();
    this.#worker.terminate();
    this.sent = null;
    this.meshes = new MeshStore();
    this.connect();
  }

  /** Hears the progress of the newest job (an evaluate); a superseded job's progress is dropped. Returns the unsubscribe. */
  onProgress(listener: (p: Progress) => void): () => void {
    return this.progress.listen(listener);
  }

  /** Starts a worker of its own. */
  static spawn(): ServiceClient {
    return new ServiceClient(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
  }

  init(): Promise<{ loadTimeMs: number }> {
    return this.#api.init();
  }

  /**
   * Evaluates `doc` (see `EvaluateServiceOptions`). Bodies whose geometry
   * this client holds come back with it filled in from the store. The next
   * document is sent as its difference from `doc`, found by identity first,
   * so `doc` must not change afterwards: pass a copy of one that will.
   */
  async evaluate(doc: unknown, options?: EvaluateServiceOptions): Promise<Display> {
    const display = this.meshes.fill(await this.send(doc, { ...options, held: this.meshes.held() }));
    if (display) return display;
    // A geometry the worker took to be held is not: evaluate again, holding none, which sends every geometry.
    const evaluate = { ...options, held: [] };
    delete evaluate.restyle;
    return this.meshes.fill(await this.send(doc, evaluate)) as Display;
  }

  /** Evaluates `doc` in the worker, sent as its change from the document sent before when the worker still keeps that one. */
  private async send(doc: unknown, options: EvaluateServiceOptions): Promise<Display> {
    const before = this.sent;
    const id = ++this.sends;
    this.sent = { doc, id };
    if (before) {
      const changed = await this.#api.evaluateChange(
        before.id,
        diffDocs(before.doc, doc),
        id,
        options,
        this.progress.start(),
      );
      if (changed) return changed;
    }
    return this.#api.evaluate(doc as Record<string, unknown>, options, this.progress.start(), id);
  }

  pick(target: PickTarget, options?: PickOptions): Promise<Picked | null> {
    return this.#api.pick(target, options);
  }

  resolve(
    record: EntityRecord,
    scope: ResolveScope,
  ): Promise<Resolved & { instances?: { index: number; key: Key }[] }> {
    return this.#api.resolve(record, scope);
  }

  /** The bodies of a part just before a feature, and where `records` land there; see `EvaluationService.bodiesBefore`. */
  bodiesBefore(scope: BeforeScope, records?: EntityRecord[], options?: { picks?: boolean }): Promise<BodiesBefore> {
    return this.#api.bodiesBefore(scope, records, options);
  }

  /** Where stored references lie in a part just before a feature, drawn; see `EvaluationService.outlinesBefore`. */
  outlinesBefore(scope: BeforeScope, records: EntityRecord[]): Promise<(PickOutline | null)[]> {
    return this.#api.outlinesBefore(scope, records);
  }

  measure(kind: MeasureKind, targets: (Key | PickTarget)[]): Promise<Measured> {
    return this.#api.measure(kind, targets);
  }

  properties(key: Key): ReturnType<ServiceWorkerApi['properties']> {
    return this.#api.properties(key);
  }

  bodyMeasures(key: Key): Promise<BodyMeasures | null> {
    return this.#api.bodyMeasures(key);
  }

  externalCurves(
    key: Key,
    mode: 'project' | 'intersect',
    frame: FrameDisplay,
  ): ReturnType<ServiceWorkerApi['externalCurves']> {
    return this.#api.externalCurves(key, mode, frame);
  }

  entities(keys: Key[]): Promise<EntityInfo[]> {
    return this.#api.entities(keys);
  }

  /** The faces an edge or vertex lies on. */
  neighbours(key: Key): Promise<Key[]> {
    return this.#api.neighbours(key);
  }

  /** Re-captures contexts of `doc` (12.4) apart from the kept evaluation; see `EvaluationService.updateContexts`. */
  updateContexts(
    doc: unknown,
    requests: ContextRequest[],
    options?: { passes?: number; capturedAt?: string },
  ): Promise<ContextsUpdate> {
    return this.#api.updateContexts(doc as Record<string, unknown>, requests, options);
  }

  /** A feature of `doc` frozen (7.2) apart from the kept evaluation; see `EvaluationService.freeze`. */
  freeze(doc: unknown, feature: string): Promise<FrozenResult> {
    return this.#api.freeze(doc as Record<string, unknown>, feature);
  }

  exportFile(format: ExportFormat, scope: ResolveScope, options?: ExportOptions): Promise<Uint8Array> {
    return this.#api.exportFile(format, scope, options);
  }

  /** Reads a file into the stored shape of the `core.import` feature `feature`; `onProgress` hears each stage as it starts. */
  importFile(
    bytes: Uint8Array,
    format: ImportFormat,
    feature: string,
    name: string,
    onProgress?: (p: ImportProgress) => void,
  ): Promise<ImportedShape> {
    return this.#api.importFile(bytes, format, feature, name, onProgress && Comlink.proxy(onProgress));
  }

  /** The references of a part's live bodies just before a feature. */
  bodyRecords(part: string, before: string | undefined): Promise<PickedEntity[]> {
    return this.#api.bodyRecords(part, before);
  }

  /** The evaluated document as a FreeCAD file (see `EvaluationService.exportFreeCad`). */
  exportFreeCad(): Promise<FcstdExport> {
    return this.#api.exportFreeCad();
  }

  /** The volume and box of a shape in BREP text. */
  shapeMeasures(brep: string): Promise<ShapeMeasures | null> {
    return this.#api.shapeMeasures(brep);
  }

  /** The volume and box of a part just after one of its features. */
  stepMeasures(part: string, feature: string): Promise<ShapeMeasures | null> {
    return this.#api.stepMeasures(part, feature);
  }

  /** The kept evaluation's entities that match sub-shapes of another program's shape (see `EvaluationService.locate`). */
  locate(
    part: string,
    before: string | undefined,
    brep: string,
    kind: 'edge' | 'face',
    indices: number[] | 'all',
    ofFaces?: number[],
  ): Promise<(PickedEntity | null)[]> {
    return this.#api.locate(part, before, brep, kind, indices, ofFaces);
  }

  /** The kept evaluation's edges lying on both surfaces of each pair (see `EvaluationService.locateOnSurfaces`). */
  locateOnSurfaces(
    part: string,
    before: string | undefined,
    pairs: [SurfaceSpec, SurfaceSpec][],
  ): Promise<PickedEntity[][]> {
    return this.#api.locateOnSurfaces(part, before, pairs);
  }

  /** The kept evaluation's bodies that any of these features made (see `EvaluationService.bodiesMadeBy`). */
  bodiesMadeBy(part: string, before: string | undefined, features: string[]): Promise<PickedEntity[]> {
    return this.#api.bodiesMadeBy(part, before, features);
  }

  /** The kept evaluation's faces on each surface (see `EvaluationService.locateFacesOnSurfaces`). */
  locateFacesOnSurfaces(
    part: string,
    before: string | undefined,
    surfaces: SurfaceSpec[],
  ): Promise<{ face: PickedEntity; body: PickedEntity }[][]> {
    return this.#api.locateFacesOnSurfaces(part, before, surfaces);
  }

  /** The constraints of a sketch's inputs that the solver cannot hold still (see `EvaluationService.vetSketch`). */
  vetSketch(inputs: unknown): Promise<string[]> {
    return this.#api.vetSketch(inputs as Record<string, unknown>);
  }

  /** The same for sketches of `doc`, read against its values alone; null where a build is needed (see `EvaluationService.vetSketches`). */
  vetSketches(doc: unknown, features: string[]): Promise<(string[] | null)[]> {
    return this.#api.vetSketches(doc as Record<string, unknown>, features);
  }

  release(): Promise<void> {
    return this.#api.release();
  }

  /** Stops the worker and frees its kernel. */
  terminate(): void {
    this.progress.clear();
    this.port.close();
    this.#remote[Comlink.releaseProxy]();
    this.#worker.terminate();
  }
}

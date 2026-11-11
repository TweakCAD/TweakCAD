/**
 * Keeps a display of the newest document. On every document change it asks
 * the worker service to evaluate the document; one evaluate is in flight at
 * a time, and the document changed most recently wins: changes that arrive
 * while one is in flight collapse into a single next evaluate.
 *
 * A result is published only when no newer document is waiting. Each
 * evaluate replaces the worker's kept evaluation, so a display whose
 * successor has already been asked for names keys the worker no longer
 * holds.
 *
 * A feature panel may show a preview: a candidate document that is not the
 * editor's. While one is set it is evaluated in place of the editor's
 * document; document changes then only update what is shown once the
 * preview is cleared.
 *
 * A panel on a feature also names the state it works in: the part just
 * before that feature. While it is named, the viewport shows the part as it
 * stands there: without a preview, the editor's document rolled back to
 * just before the feature; with one, the preview rolled back to just after
 * it, so the features after it do not show. Each published display is
 * followed by that state's bodies, read from the evaluation the worker
 * keeps (no evaluation of its own), which the browser lists. A preview is
 * asked for as one (`EvaluateServiceOptions.preview`): the worker builds
 * each part only up to its rollback, and keeps the committed evaluation to
 * resume from when the preview is cleared.
 *
 * Work that evaluates documents of its own on the same worker (finishing an
 * import) runs through `exclusive`, so it never interleaves with the
 * scheduler's evaluates and the shown document is evaluated again after it.
 *
 * A document that differs from the one the worker keeps only in what is
 * shown (`displayOnly`: a body hidden, shown, coloured or named) is asked
 * for as a restyle of that display: the worker evaluates nothing and meshes
 * only a body shown for the first time.
 *
 * While busy, the status line shows what the worker reports it is doing
 * (`statusOf`), or what work run through `exclusive` reports (`report`).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Doc, Json } from '@tweakcad/editor';
import type {
  BeforeScope,
  BodiesBefore,
  Display,
  EvaluateServiceOptions,
  ListedBody,
  Progress,
} from '@tweakcad/worker/src/v2/service/types';
import { statusOf, type BuildStatus } from './status';
import { displayOnly } from './displayOnly';

/** The bodies of a part just before a feature, from the evaluation of the display with `generation`. */
export interface BeforeListing extends BeforeScope {
  generation: number;
  bodies: ListedBody[];
}

export interface DisplayState {
  /** The newest published display, or null before the first. */
  display: Display | null;
  /** The document revision the display shows (for a preview, the revision it was made from). */
  revision: number;
  /** True while an evaluate is in flight or waiting. */
  evaluating: boolean;
  /** While evaluating: what the worker (or an import holding it) reports it is doing; null before it says. */
  status: BuildStatus | null;
  /** While evaluating: when the app became busy (`Date.now()`), for the time spent; null otherwise. */
  busySince: number | null;
  /** Why the newest evaluate failed; the display stays the one before. */
  error: string | null;
  /** True when the display shows a document other than the editor's: a preview, or the editor's rolled back to the state a panel works in. */
  preview: boolean;
  /** True when the display shows a panel's preview document, the feature as its form stands. */
  candidate: boolean;
  /**
   * The newest display of the editor's document, which a preview does not
   * replace: what the browser lists while a panel previews. Its keys name
   * entities of the worker's kept evaluation only while it is `display`.
   */
  committed: Display | null;
  /** While a panel names the state it works in: that state's bodies, as the newest listing read them; null otherwise. */
  before: BeforeListing | null;
}

export type DisplayStore = StoreApi<DisplayState>;

export function createDisplayStore(): DisplayStore {
  return createStore<DisplayState>(() => ({
    display: null,
    revision: -1,
    evaluating: false,
    status: null,
    busySince: null,
    error: null,
    preview: false,
    candidate: false,
    committed: null,
    before: null,
  }));
}

/** The part of the worker service the scheduler uses. */
export interface Evaluator {
  evaluate(doc: unknown, options?: EvaluateServiceOptions): Promise<Display>;
  /** The bodies of a part just before a feature, in the kept evaluation; absent where the service cannot list them. */
  bodiesBefore?(scope: BeforeScope): Promise<BodiesBefore>;
  /** Hears the progress of the evaluation running; returns the unsubscribe. Absent where the service reports none. */
  onProgress?(listener: (p: Progress) => void): () => void;
}

/** The status line changes at most this often. */
const STATUS_INTERVAL_MS = 100;

/** Where documents come from: the editor's store. */
export interface DocumentSource {
  readonly document: Doc;
  readonly revision: number;
  onRebuild(listener: (document: Doc, revision: number) => void): () => void;
}

interface Request {
  document: Doc;
  revision: number;
  /** Whether it shows other than the editor's newest document: a preview, or a rollback. */
  preview: boolean;
  /** Whether it is a panel's preview document. */
  candidate?: true;
}

/**
 * `doc` with `part` rolled back to `rollback` (7.1), or `doc` itself when
 * the part already stands there or the document has no such part.
 */
function withRollback(doc: Doc, part: string, rollback: Json): Doc {
  const parts = Array.isArray(doc.parts) ? (doc.parts as Json[]) : [];
  const i = parts.findIndex((p) => p.id === part);
  const row = parts[i];
  if (!row || JSON.stringify(row.rollback) === JSON.stringify(rollback)) return doc;
  const next = parts.slice();
  next[i] = { ...row, rollback };
  return { ...doc, parts: next } as Doc;
}

/** The index of the top-level row of a part's timeline that is `feature` or holds it among its children; -1 when none does. */
function rowOf(doc: Doc, part: string, feature: string): { timeline: Json[]; index: number } {
  const row = (Array.isArray(doc.parts) ? (doc.parts as Json[]) : []).find((p) => p.id === part);
  const timeline = Array.isArray(row?.timeline) ? (row.timeline as Json[]) : [];
  const holds = (f: Json): boolean =>
    f.id === feature || (Array.isArray(f.children) && (f.children as Json[]).some(holds));
  return { timeline, index: timeline.findIndex(holds) };
}

/**
 * The part as it stands just before `scope.feature`: `doc` rolled back to
 * that feature. `doc` itself when the part does not hold the feature (a
 * new one, which goes in at the part's rollback) or already stands there.
 */
export function rolledBefore(doc: Doc, scope: BeforeScope): Doc {
  const { timeline, index } = rowOf(doc, scope.part, scope.feature);
  if (index < 0) return doc;
  return withRollback(doc, scope.part, { before: { id: (timeline[index] as Json).id } });
}

/**
 * The part as it stands just after `scope.feature`: `doc` rolled back to
 * the feature after it, or to the end of the timeline. `doc` itself when
 * the part does not hold the feature or already stands there.
 */
export function rolledThrough(doc: Doc, scope: BeforeScope): Doc {
  const { timeline, index } = rowOf(doc, scope.part, scope.feature);
  if (index < 0) return doc;
  const next = timeline[index + 1];
  return withRollback(doc, scope.part, next ? { before: { id: next.id } } : { end: {} });
}

export class RebuildScheduler {
  private pending: Request | null = null;
  /** The editor's newest document. */
  private base: { document: Doc; revision: number } | null = null;
  private previewDoc: Doc | null = null;
  private beforeScope: BeforeScope | null = null;
  /** The document asked for last. */
  private requested: Doc | null = null;
  /** The document the worker's kept evaluation is of, and the generation of its display; null when unknown. */
  private kept: { document: Doc; generation: number } | null = null;
  /** Counts listings asked for; only the newest one is published. */
  private listings = 0;
  /** Listings in flight. */
  private listing = 0;
  private running = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private idleWaiters: (() => void)[] = [];
  private readonly offProgress: (() => void) | undefined;
  /** A status held back until the interval since the last one is over. */
  private heldStatus: BuildStatus | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private statusAt = 0;

  constructor(
    private readonly evaluator: Evaluator,
    readonly store: DisplayStore = createDisplayStore(),
    private readonly options: EvaluateServiceOptions = {},
  ) {
    this.offProgress = evaluator.onProgress?.((p) => this.report(statusOf(p)));
  }

  /**
   * Shows `status` on the status line while the scheduler is busy: the
   * worker's progress, or what work run through `exclusive` (an import)
   * says it is doing. It changes at most every 100 ms, to the newest
   * reported: a build of a thousand features reports a thousand times.
   */
  report(status: BuildStatus): void {
    if (this.disposed || !this.store.getState().evaluating) return;
    const now = Date.now();
    if (now - this.statusAt >= STATUS_INTERVAL_MS) {
      this.showStatus(status);
      return;
    }
    this.heldStatus = status;
    this.statusTimer ??= setTimeout(
      () => {
        this.statusTimer = null;
        const held = this.heldStatus;
        this.heldStatus = null;
        if (held && this.store.getState().evaluating) this.showStatus(held);
      },
      STATUS_INTERVAL_MS - (now - this.statusAt),
    );
  }

  private showStatus(status: BuildStatus): void {
    this.heldStatus = null;
    this.statusAt = Date.now();
    this.store.setState({ status });
  }

  /** Marks the scheduler busy, from now unless it already is. */
  private startBusy(): void {
    if (this.store.getState().evaluating) return;
    // The first report of a build shows at once.
    this.statusAt = 0;
    this.store.setState({ evaluating: true, status: null, busySince: Date.now() });
  }

  /** Follows `source`, starting with its current document. */
  attach(source: DocumentSource): () => void {
    this.unsubscribe?.();
    const off = source.onRebuild((document, revision) => this.request(document, revision));
    this.unsubscribe = off;
    this.request(source.document, source.revision);
    return () => {
      off();
      if (this.unsubscribe === off) this.unsubscribe = null;
    };
  }

  /**
   * Asks for `document` to be shown; a later request before it starts
   * replaces it. Held back while a preview is set; while a panel names the
   * state it works in, shown rolled back to just before its feature.
   */
  request(document: Doc, revision: number): void {
    if (this.disposed) return;
    this.base = { document, revision };
    if (this.previewDoc === null) this.show();
  }

  /**
   * Shows `document` in place of the editor's, until null clears it and the
   * editor's newest document is shown again. While a panel names the state
   * it works in, the preview shows rolled back to just after its feature,
   * and the editor's document to just before it.
   */
  setPreview(document: Doc | null): void {
    if (this.disposed || document === this.previewDoc) return;
    this.previewDoc = document;
    this.show();
  }

  /** True while a preview document is set. */
  get previewing(): boolean {
    return this.previewDoc !== null;
  }

  /** The preview document set, or null. */
  get previewDocument(): Doc | null {
    return this.previewDoc;
  }

  /**
   * Names the state a panel works in, the part just before `scope.feature`,
   * whose bodies are then listed after each display; null stops that.
   */
  setBefore(scope: BeforeScope | null): void {
    if (this.disposed) return;
    const same =
      scope && this.beforeScope && scope.part === this.beforeScope.part && scope.feature === this.beforeScope.feature;
    if (same || (!scope && !this.beforeScope)) return;
    this.beforeScope = scope;
    this.listings++;
    if (this.store.getState().before) this.store.setState({ before: null });
    // What the viewport shows changes with the state named, unless that rolls nothing back (a new feature).
    const next = this.shown();
    if (next && next.document !== this.requested) this.enqueue(next);
    else if (scope && !this.running) void this.list();
  }

  /** True while an evaluate, or a listing of the state a panel works in, is in flight or waiting. */
  get busy(): boolean {
    return this.running || this.pending !== null || this.listing > 0;
  }

  /** Resolves once nothing is in flight or waiting, after the newest display is published. */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Runs `task`, which evaluates documents of its own on the same worker,
   * with the worker to itself: it starts once nothing is in flight, document
   * changes made meanwhile wait, and afterwards the shown document (the
   * newest, or the preview) is evaluated again, since the worker then keeps
   * the task's evaluation. The scheduler is busy until that display is
   * published, so `whenIdle` callers never use the display's keys against
   * the task's evaluation.
   */
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    while (this.busy) await this.whenIdle();
    this.running = true;
    this.startBusy();
    try {
      return await task();
    } finally {
      this.running = false;
      this.kept = null;
      if (!this.disposed && !this.pending) this.pending = this.shown();
      if (this.pending && !this.disposed) void this.drain();
      else this.settle();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.offProgress?.();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.settle();
  }

  /**
   * The document to show: the preview, or the editor's newest; rolled back
   * to the state a panel names, when it names one. Null before the first.
   */
  private shown(): Request | null {
    const scope = this.beforeScope;
    if (this.previewDoc)
      return {
        document: scope ? rolledThrough(this.previewDoc, scope) : this.previewDoc,
        revision: this.base?.revision ?? -1,
        preview: true,
        candidate: true,
      };
    if (!this.base) return null;
    const document = scope ? rolledBefore(this.base.document, scope) : this.base.document;
    return { document, revision: this.base.revision, preview: document !== this.base.document };
  }

  private show(): void {
    const next = this.shown();
    if (next) this.enqueue(next);
  }

  private enqueue(request: Request): void {
    this.requested = request.document;
    this.pending = request;
    this.startBusy();
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.pending && !this.disposed) {
      const { document, revision, preview, candidate } = this.pending;
      this.pending = null;
      try {
        // A change that only shows the kept document otherwise evaluates nothing in the worker.
        const kept = this.kept;
        const restyled =
          kept && displayOnly(kept.document, document) ? { ...this.options, restyle: kept.generation } : this.options;
        const options = candidate ? { ...restyled, preview: true } : restyled;
        this.kept = null;
        this.evaluatingNow = true;
        let display: Display;
        try {
          display = await this.evaluator.evaluate(document, options);
        } finally {
          this.evaluatingNow = false;
        }
        this.kept = { document, generation: display.generation };
        if (this.disposed || this.pending) continue;
        const shown = { display, revision, error: null, preview, candidate: candidate === true };
        this.store.setState(preview ? shown : { ...shown, committed: display });
      } catch (e) {
        if (this.disposed || this.pending) continue;
        this.store.setState({ error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.running = false;
    if (this.beforeScope && !this.disposed) void this.list();
    this.settle();
  }

  /** Lists the bodies of the named state in the newest evaluation, and publishes them unless a newer listing or evaluate was asked for. */
  private async list(): Promise<void> {
    const scope = this.beforeScope;
    if (!scope || !this.evaluator.bodiesBefore || !this.store.getState().display) return;
    const mine = ++this.listings;
    this.listing++;
    try {
      const listed = await this.evaluator.bodiesBefore(scope);
      if (mine === this.listings && !this.disposed && !this.busyEvaluating)
        this.store.setState({ before: { ...scope, generation: listed.generation, bodies: listed.bodies } });
    } catch {
      // A part or feature the evaluation does not hold lists nothing; the browser keeps the committed model.
    } finally {
      this.listing--;
      this.settle();
    }
  }

  /**
   * An evaluate of the scheduler's own is in the worker now (not work run
   * through `exclusive`): what a restart of the worker would stop.
   */
  evaluatingNow = false;

  private get busyEvaluating(): boolean {
    return this.running || this.pending !== null;
  }

  private settle(): void {
    if (this.busy) return;
    if (this.store.getState().evaluating) this.store.setState({ evaluating: false, status: null, busySince: null });
    this.heldStatus = null;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

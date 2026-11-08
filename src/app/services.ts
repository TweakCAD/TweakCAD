/**
 * Everything the app runs on, made once at boot: the editor holding the
 * document, the worker service and the rebuild scheduler over it, the
 * display, selection and app stores, the working copy and the file session.
 */
import { Editor, randomIds, type IdGenerator } from '@tweakcad/editor';
import type { EntityRecord } from '@tweakcad/format';
import type { FcstdExport } from '@tweakcad/worker/src/v2/fcstd/export';
import type {
  BeforeScope,
  BodiesBefore,
  ContextRequest,
  ContextsUpdate,
  ExportFormat,
  FrozenResult,
  ExportOptions,
  ExternalCandidates,
  FrameDisplay,
  Key,
  BodyMeasures,
  MeasureKind,
  Measured,
  PickOutline,
  PickTarget,
  ResolveScope,
  Resolved,
} from '@tweakcad/worker/src/v2/service/types';
import { nameDocumentInUrl, newLocalId, rememberLocalIdInUrl } from '../storage/context.ts';
import { UNTITLED } from '../storage/projectName.ts';
import { createAppStore, type AppStore } from './appState';
import { clearConsole } from './console';
import { createDisplayStore, RebuildScheduler, type DisplayStore, type Evaluator } from './display/scheduler';
import { inContextPick } from './assembly/contexts';
import { shownOf } from './assembly/focus';
import type { PickClient, PickResult } from './picking';
import {
  clearSelection,
  createSelectionStore,
  followGeneration,
  type SelectionItem,
  type SelectionStore,
} from './selection';
import { Autosave } from './storage/autosave';
import { CloudConflictError, type CloudProjects } from './storage/cloud';
import * as disk from './storage/disk';
import { followPreview } from './storage/preview';
import { bootDocument, DocumentSession, type BootResult, type DiskApi } from './storage/session';
import type { WorkingCopyStore } from './storage/workingCopy';

/** The worker service as the app uses it (`ServiceClient`, or a fake in tests). */
export interface AppServiceClient extends Evaluator, PickClient {
  init(): Promise<{ loadTimeMs: number }>;
  exportFile(format: ExportFormat, scope: ResolveScope, options?: ExportOptions): Promise<Uint8Array>;
  exportFreeCad(): Promise<FcstdExport>;
  /** A model entity kind and measures (9.7), or null for anything else. */
  properties(key: Key): Promise<{ kind: string; measures: Measures } | null>;
  /** A shown body's volume, surface area, centre of mass and bounding box; absent where the client cannot read them. */
  bodyMeasures?(key: Key): Promise<BodyMeasures | null>;
  /** A measure between picked keys (6.3), in base units. */
  measure(kind: MeasureKind, targets: (Key | PickTarget)[]): Promise<Measured>;
  /** The keys a stored record lands on in the shown evaluation (9.6). */
  resolve(record: EntityRecord, scope: ResolveScope): Promise<Resolved>;
  /** The bodies of a part just before a feature in the kept evaluation, and where `records` land there; absent where the client cannot list them. */
  bodiesBefore?(scope: BeforeScope, records?: EntityRecord[], options?: { picks?: boolean }): Promise<BodiesBefore>;
  /** Where stored records lie in a part just before a feature, drawn; absent where the client cannot draw them. */
  outlinesBefore?(scope: BeforeScope, records: EntityRecord[]): Promise<(PickOutline | null)[]>;
  /** The curves an external sketch row would take from a model entity, in a sketch's frame (8.1). */
  externalCurves(key: Key, mode: 'project' | 'intersect', frame: FrameDisplay): Promise<ExternalCandidates>;
  /** The faces an edge or vertex of the shown evaluation lies on. */
  neighbours?(key: Key): Promise<Key[]>;
  /** Re-captures contexts of a document (12.4) apart from the shown evaluation. */
  updateContexts?(
    doc: unknown,
    requests: ContextRequest[],
    options?: { passes?: number; capturedAt?: string },
  ): Promise<ContextsUpdate>;
  /** A feature of a document frozen (7.2) apart from the shown evaluation. */
  freeze?(doc: unknown, feature: string): Promise<FrozenResult>;
}

/** The measures of a model entity (9.7) the app reads, in its part's frame. */
export interface Measures {
  surface?: string;
  curve?: string;
  centroid?: readonly [number, number, number];
  normal?: readonly [number, number, number];
  axis?: readonly [number, number, number];
  center?: readonly [number, number, number];
  point?: readonly [number, number, number];
  bbox?: readonly [readonly [number, number, number], readonly [number, number, number]];
}

export interface AppServices {
  editor: Editor;
  client: AppServiceClient;
  scheduler: RebuildScheduler;
  display: DisplayStore;
  selection: SelectionStore;
  app: AppStore;
  autosave: Autosave;
  session: DocumentSession;
  /**
   * What a command needs to reference `item` (see `pickReference`), once the
   * newest display is shown; null when the item's display is no longer the
   * one shown.
   */
  pick(item: SelectionItem, options?: { before?: string }): Promise<PickResult | null>;
  /** Resolves once the newest document is shown: a change made while waiting is waited for too. */
  whenShown(): Promise<void>;
  /** The shown part or assembly as a file; empty when it shows nothing. */
  exportShown(format: ExportFormat): Promise<Uint8Array>;
  /** The document as a FreeCAD file, once evaluation has settled. */
  exportFreeCad(): Promise<FcstdExport>;
  /** Resolves once the kernel and solver are loaded in the worker, or rejects with why not. */
  ready: Promise<{ loadTimeMs: number }>;
  dispose(): void;
}

export interface BootAppOptions {
  client: AppServiceClient;
  workingCopy: WorkingCopyStore;
  /** The working-copy record the address names. */
  localId: string | null;
  reset?: boolean;
  ids?: IdGenerator;
  name?: () => string;
  disk?: DiskApi;
  autosaveMs?: number;
  /** What boot opens, when the caller resolved it (`resolveBoot`); otherwise read from the working copy. */
  boot?: BootResult;
  /** Cloud projects, when the site is there. */
  cloud?: CloudProjects | null;
}

export interface BootedApp {
  services: AppServices;
  /** Something to tell the user about what boot opened. */
  notice?: { title?: string; message: string; reopen?: boolean };
}

export async function bootApp(o: BootAppOptions): Promise<BootedApp> {
  const ids = o.ids ?? randomIds();
  const name = o.name ?? (() => UNTITLED);
  const ready = o.client.init();
  const boot =
    o.boot ??
    (await bootDocument({ workingCopy: o.workingCopy, localId: o.localId, reset: o.reset ?? false, ids, name }));
  const cloud = o.cloud ?? null;
  const editor = new Editor(boot.doc, { ids });
  const display = createDisplayStore();
  const scheduler = new RebuildScheduler(o.client, display);
  const selection = createSelectionStore();
  const app = createAppStore();
  const cleanups: (() => void)[] = [];
  cleanups.push(scheduler.attach(editor.store));
  cleanups.push(followGeneration(selection, display));

  const autosave = new Autosave(
    editor,
    o.workingCopy,
    boot.localId,
    boot.storage,
    {
      mintId: newLocalId,
      onMinted: rememberLocalIdInUrl,
      cloud,
      isConflict: (e) => e instanceof CloudConflictError,
      ...(o.autosaveMs !== undefined ? { debounceMs: o.autosaveMs } : {}),
    },
    boot.session.kind === 'cloud' ? boot.session.projectId : null,
  );
  cleanups.push(autosave.attach());

  const session = new DocumentSession({
    editor,
    disk: o.disk ?? disk,
    autosave,
    ids,
    newName: name,
    storage: boot.session,
    cloud,
    onRebound: () => {
      // Another document: nothing selected, back to modelling, an empty console (its warnings were the last document's), and the address names no record until autosave makes one.
      clearSelection(selection);
      clearConsole();
      app.setState({ mode: { kind: 'model' }, panel: null });
      nameDocumentInUrl({ kind: 'local-fresh' });
    },
    onStorage: (storage, localId) => {
      if (storage.kind === 'cloud' && localId)
        nameDocumentInUrl({ kind: 'cloud', cloudProjectId: storage.projectId, localId });
      else nameDocumentInUrl(localId ? { kind: 'local-stored', localId } : { kind: 'local-fresh' });
    },
  });
  // A revision's preview is read-only: no sketch, editing panel or dialog stays open over it.
  cleanups.push(followPreview({ session, app, selection }));

  /** Waits until the newest document is shown; a change made while waiting starts another evaluate, which is waited for too. */
  const settled = async () => {
    do await scheduler.whenIdle();
    while (scheduler.busy);
  };

  const services: AppServices = {
    editor,
    client: o.client,
    scheduler,
    display,
    selection,
    app,
    autosave,
    session,
    ready,
    whenShown: settled,
    async pick(item, options) {
      const generation = display.getState().display?.generation;
      await settled();
      if ('key' in item && display.getState().display?.generation !== generation) return null;
      // While a part is edited in an assembly's context, a pick on another instance goes through the part's context.
      return inContextPick(services, item, options);
    },
    async exportShown(format) {
      await settled();
      const root = shownOf(editor.document, app.getState().focus);
      if (!root || !display.getState().display) return new Uint8Array();
      const scope: ResolveScope = 'part' in root ? { part: root.part } : { assembly: root.assembly };
      const docName = (editor.document.metadata as { name?: unknown }).name;
      return o.client.exportFile(format, scope, { name: typeof docName === 'string' ? docName : 'model' });
    },
    async exportFreeCad() {
      await settled();
      return o.client.exportFreeCad();
    },
    dispose() {
      for (const c of cleanups) c();
      scheduler.dispose();
    },
  };
  return { services, ...(boot.notice ? { notice: boot.notice } : {}) };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { Shell } from './layout/Shell.tsx';
import { initializeApp } from './appInit.ts';
import { initRebuildScheduler, disposeRebuildScheduler, exportActivePart } from './rebuildScheduler.ts';
import { generateProjectName } from './storage/projectName.ts';
import {
  runAutoExport,
  shouldAutoExport,
  type AutoExportStatus,
} from './storage/autoExport.ts';
import { setSketchStoreRef } from './hooks/useSketchStore.ts';
import { setDisplayContextStoreRef } from './hooks/useDisplayContext.ts';
import {
  AutosaveScheduler,
  resolveInitialProject,
  probeSaas,
  loadSocialProviders,
  useSaasState,
  newDocument,
  openFromDisk,
  importFcstdAsDocument,
  pickGeometryForImport,
  pickComponentForImport,
  save,
  saveAsToDisk,
  saveAsNewCloudProject,
  openFileFromDisk,
  type BootResolution,
  type ProjectContext,
  type DocumentStorage,
  type FileOpsHandles,
} from './storage/index.ts';
import { consoleLog } from '@tweakcad/core/src/store/consoleStore.ts';
import { SaveStatus } from './components/SaveStatus.tsx';
import { useConfirm } from './components/ConfirmDialog.tsx';
import { CLOUD_DOCUMENT_MAX_BYTES, wouldExceedCloudLimit } from './storage/cloudAdapter.ts';
import { makeImportedData } from '@tweakcad/core/src/document/importedData.ts';
import { sha256Hex } from '@tweakcad/core/src/document/contentHash.ts';
import { referenceId, generateId } from '@tweakcad/core/src/ids.ts';
import { Toast } from './components/Toast.tsx';
import { enqueueToast, useToastStore } from './components/toastStore.ts';
import { nameDocumentInUrl } from './storage/context.ts';
import { SignInModal } from './components/SignInModal.tsx';
import { BootGate, type BootGateKind } from './components/BootGate.tsx';
import { rememberOfflineChoice } from './storage/offlineChoice.ts';
import { SaveAsPicker } from './components/SaveAsPicker.tsx';
import { HistoryPanel } from './components/HistoryPanel.tsx';
import {
  listCloudRevisions, loadCloudRevision, restoreCloudRevision,
  createCloudVersion, loadCloudProject, createCloudProject,
} from './storage/cloudAdapter.ts';
import { useParametersEditor } from './components/ParametersDialog.tsx';
import { useSettingsDialog } from './components/SettingsDialog.tsx';
import { startBridgeClient } from './ai/mcpBridgeClient.ts';
import { refreshSaasState, isSignedIn } from './storage/index.ts';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import type { PartId } from '@tweakcad/core/src/ids.ts';

type StorageRuntime = {
  scheduler: AutosaveScheduler;
  context: ProjectContext;
  storage: DocumentStorage;
  bootWarning?: string;
  /** "We loaded an autosaved doc from a disk file you opened last session." */
  recoveredFilename?: string;
};

/**
 * Root application component.
 *
 * Boot sequence:
 *   1. Synchronously initialize the in-memory app (no I/O).
 *   2. Fire the SaaS probe so cloud-aware features know whether the backend
 *      is reachable.
 *   3. Resolve the initial document from URL / IDB / cloud. A cloud project
 *      that cannot be read falls back to this browser's copy, or to a gate
 *      that says why — never to a blank document bound to the project.
 *   4. Attach the autosave scheduler.
 */
export function App() {
  const appState = useMemo(() => {
    const state = initializeApp();
    setSketchStoreRef(state.sketchStore);
    setDisplayContextStoreRef(state.displayContextStore);
    return state;
  }, []);
  const [storage, setStorage] = useState<StorageRuntime | null>(null);
  const saas = useSaasState();

  useEffect(() => {
    initRebuildScheduler(appState);
    return disposeRebuildScheduler;
  }, [appState]);

  // Boot the local MCP bridge WS client. Reads settings on mount; opens /
  // closes the socket as the user flips Settings → AI → Enable bridge.
  // Returns a stop() unsub the cleanup runs on unmount or HMR.
  useEffect(() => {
    const stop = startBridgeClient({
      documentStore: appState.documentStore,
      commandBus: appState.commandBus,
      viewportStore: appState.viewportStore,
    });
    return stop;
  }, [appState]);

  // --- Revision history ----------------------------------------------------

  const [historyOpen, setHistoryOpen] = useState(false);
  const cloudProjectId = storage?.storage.kind === 'cloud' ? storage.storage.projectId : null;

  /**
   * Mint a revision when the tab goes away.
   *
   * Autosave keeps the newest bytes safe but writes no history, so without
   * this a session that ends by closing the tab — which is how most of them
   * end — leaves nothing to come back to. `visibilitychange` rather than
   * `beforeunload`: the latter is unreliable on mobile and increasingly
   * ignored, while `hidden` fires on tab switch, minimise and close alike.
   *
   * Over-firing is cheap because the server dedupes on the document's etag:
   * switching tabs ten times without editing produces one revision, not ten.
   */
  useEffect(() => {
    if (!cloudProjectId || !storage) return;
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return;
      void storage.scheduler.flushNow()
        .then(() => createCloudVersion(cloudProjectId, 'Session end'))
        .catch(() => { /* leaving anyway; a lost revision is not worth a dialog */ });
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [cloudProjectId, storage]);

  const listRevisions = useCallback(
    (cursor?: string) => {
      if (!cloudProjectId) return Promise.resolve({ items: [], nextCursor: null });
      return listCloudRevisions(cloudProjectId, cursor ? { cursor } : {});
    },
    [cloudProjectId],
  );

  /**
   * Open a revision without committing to it.
   *
   * Loads the old document into the editor but leaves the server's live copy
   * alone, so looking is free. The next autosave would write the previewed
   * content back — which is why previewing marks the session so the user can
   * tell, and why Restore exists as the deliberate path.
   */
  const previewRevision = useCallback(async (revisionId: string) => {
    if (!cloudProjectId) return;
    const doc = await loadCloudRevision(cloudProjectId, revisionId);
    appState.documentStore.replaceDocument(doc);
    consoleLog('info', `Previewing revision ${revisionId}. Restore to keep it.`, 'history');
  }, [cloudProjectId, appState.documentStore]);

  const restoreRevision = useCallback(async (revisionId: string) => {
    if (!cloudProjectId) return;
    const { snapshotVersionId } = await restoreCloudRevision(cloudProjectId, revisionId);
    // Pull the restored document back down rather than assuming what the
    // server wrote: the restore is the server's copy operation, and reading
    // it back is the only way to be sure the editor agrees with it.
    const result = await loadCloudProject(cloudProjectId);
    if (result?.doc) appState.documentStore.replaceDocument(result.doc);
    setHistoryOpen(false);
    consoleLog(
      'success',
      `Restored ${revisionId}. Your previous work is saved as ${snapshotVersionId}.`,
      'history',
    );
  }, [cloudProjectId, appState.documentStore]);

  // ?autoExport=1 flow: once the project resolves to a cloud-backed
  // context, generate STL/STEP/3MF and PUT them as attachments to the
  // current published version. Runs at most once per page load.
  const autoExportFiredRef = useRef(false);
  const [autoExportStatus, setAutoExportStatus] = useState<
    AutoExportStatus[] | null
  >(null);
  // The status panel opens as soon as the cloud context resolves, before
  // the first status arrives.
  const autoExportDue = storage?.context.kind === 'cloud' && shouldAutoExport();
  if (autoExportDue && autoExportStatus === null) setAutoExportStatus([]);
  useEffect(() => {
    if (autoExportFiredRef.current) return;
    if (!storage) return;
    if (storage.context.kind !== 'cloud') return;
    if (!shouldAutoExport()) return;
    autoExportFiredRef.current = true;
    void runAutoExport(
      appState.documentStore,
      storage.context.cloudProjectId,
      (status) => {
        setAutoExportStatus((prev) => [...(prev ?? []), status]);
        console.log('[autoExport]', status);
      },
    );
  }, [storage, appState.documentStore]);

  // Resolve initial document + attach autosave. Runs once on mount.
  /**
   * Set when boot resolved to no document. Clearing it re-runs boot, which
   * is how both answers take effect: "continue offline" writes the tab's
   * choice first, and signing in changes what `decideBoot` sees. Open file
   * clears it by adopting the picked file directly.
   */
  const [bootGate, setBootGate] = useState<BootGateKind | null>(null);
  const [bootGateBusy, setBootGateBusy] = useState(false);
  const [bootGateError, setBootGateError] = useState<string | null>(null);

  /**
   * Make `resolution` this window's document and start autosaving it.
   *
   * Shared by boot and by the gate's Open file, which reaches a document
   * without boot having resolved one.
   */
  const autosaveUnsubRef = useRef<(() => void) | null>(null);
  const adoptDocument = useCallback((resolution: BootResolution) => {
    if (resolution.doc !== appState.documentStore.getState()) {
      appState.documentStore.replaceDocument(resolution.doc);
    }

    const scheduler = new AutosaveScheduler(resolution.context);
    scheduler.setStorage(resolution.storage);
    autosaveUnsubRef.current?.();
    autosaveUnsubRef.current = scheduler.attach(appState.documentStore);

    setStorage({
      scheduler,
      context: resolution.context,
      storage: resolution.storage,
      ...(resolution.warning ? { bootWarning: resolution.warning } : {}),
      ...(resolution.recoveredFromAutosave && resolution.recoveredFilename
        ? { recoveredFilename: resolution.recoveredFilename }
        : {}),
    });
  }, [appState]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Kick off the SaaS probe so the rest of the UI can render cloud
      // features (or hide them) as soon as the result lands.
      //
      // The social-provider list hangs off the probe's RESULT rather than
      // running beside it: it only matters when we're signed out against a
      // live backend, so a standalone build never issues the request. A
      // failure there degrades the modal to email/password instead of
      // becoming a state the rest of the app has to understand.
      void probeSaas().then((state) => {
        if (state.kind === 'available' && !state.signedIn) void loadSocialProviders();
      });

      const defaultDoc = appState.documentStore.getState();
      const resolution = await resolveInitialProject(defaultDoc);
      if (cancelled) return;

      // Boot deliberately opened nothing: signed in with a bare URL,
      // backend-up-and-signed-out, or a named cloud project that could not
      // be read. Show the gate and attach no autosave — there is no
      // document to save, and minting a blank one here is the guess this
      // whole change exists to stop making.
      if (!('doc' in resolution)) {
        setBootGate(resolution.kind);
        setBootGateError(resolution.kind === 'load-failed' ? resolution.message : null);
        return;
      }

      adoptDocument(resolution);
    })();
    return () => {
      cancelled = true;
      autosaveUnsubRef.current?.();
      autosaveUnsubRef.current = null;
    };
  }, [appState, adoptDocument]);

  // Boot opened something other than what the URL asked for (this
  // browser's copy, or nothing from an unreachable backend). Say so where
  // the user is looking.
  useEffect(() => {
    if (storage?.bootWarning) {
      console.warn('[boot]', storage.bootWarning);
      enqueueToast({ tone: 'warning', message: storage.bootWarning, durationMs: 20_000 });
    }
  }, [storage?.bootWarning]);

  // The file-ops layer needs synchronous read access to the current storage
  // and a way to mutate context routing. We use a ref so callbacks captured
  // by handlers see the latest values without re-binding every state change.
  const storageRef = useRef<DocumentStorage>({ kind: 'unsaved' });
  useEffect(() => {
    if (storage) storageRef.current = storage.storage;
  }, [storage]);

  const { confirm, element: confirmDialogElement } = useConfirm();
  const { open: openParametersEditor, element: parametersDialogElement } = useParametersEditor();
  const { open: openSettings, element: settingsDialogElement } = useSettingsDialog();

  const fileHandles: FileOpsHandles | null = useMemo(() => {
    if (!storage) return null;
    return {
      documentStore: appState.documentStore,
      scheduler: storage.scheduler,
      getStorage: () => storageRef.current,
      setStorage: (next) => {
        storageRef.current = next;
        storage.scheduler.setStorage(next);
        setStorage((prev) => (prev ? { ...prev, storage: next } : prev));
      },
      setContext: (next) => {
        setStorage((prev) => (prev ? { ...prev, context: next } : prev));
        storage.scheduler.setContext(next);
        // A reload must come back to the document this window now holds,
        // not to the project or file it started on.
        nameDocumentInUrl(next);
      },
      blankDoc: () => newProjectWithPart(generateProjectName(), 'Part 1'),
      confirm,
    };
  }, [appState, storage, confirm]);

  const [saveAsOpen, setSaveAsOpen] = useState(false);

  const onFileNew = useCallback(() => {
    if (fileHandles) void newDocument(fileHandles);
  }, [fileHandles]);
  const onFileOpen = useCallback(() => {
    if (!fileHandles) return;
    openFromDisk(fileHandles).catch((err: unknown) => {
      reportFileError('Open failed', err);
    });
  }, [fileHandles]);

  /**
   * File → Import → FreeCAD (.fcstd). A .fcstd carries a whole parametric
   * tree, so (unlike STEP/STL/BREP body import) it OPENS as a new document —
   * `importFcstdAsDocument` replaces the active doc, then we surface the
   * importer's diagnostics (unsupported features/geometry, constraints-not-
   * imported notes) in the in-app console so the user knows what was skipped.
   */
  const onImportFcstd = useCallback(async () => {
    if (!fileHandles) return;
    try {
      const outcome = await importFcstdAsDocument(fileHandles);
      if (!outcome) return; // cancelled / declined discard
      consoleLog('success', `Imported "${outcome.fileName}" from FreeCAD`, 'rebuild');
      for (const d of outcome.diagnostics) {
        const level = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warn' : 'info';
        consoleLog(level, `FreeCAD import: ${d.message}`, 'rebuild');
      }
    } catch (err) {
      consoleLog('error', `FreeCAD import failed: ${(err as Error).message}`, 'rebuild');
    }
  }, [fileHandles]);

  /**
   * File → Import. Prompts for a STEP / STL / BREP file, base64-encodes it,
   * and dispatches a `CreateImportedGeometry` command that appends a
   * new feature to the active part's timeline. The rebuilder then
   * picks it up on the next pass and the kernel decomposes the file
   * into per-solid bodies.
   *
   * Errors during pick (cancel, unsupported extension) are silent /
   * thrown — App.tsx doesn't gate on them because the worker / kernel
   * surface already logs failures to the in-app console via the
   * standard rebuild diagnostics path.
   */
  const onFileImport = useCallback(async (format?: 'step' | 'stl' | 'brep') => {
    try {
      const pick = await pickGeometryForImport(format);
      if (!pick) return; // user cancelled
      const project = appState.documentStore.getState();
      const partIds = Object.keys(project.parts);
      if (partIds.length === 0) {
        reportFileError('Import failed', new Error('The document has no part to import into.'));
        return;
      }
      // v1 imports into the first part. Multi-part documents land
      // when the document model grows assembly support; until then
      // there's a single active part by convention.
      const partId = partIds[0] as PartId;

      // Warn before the work, not after. A large import makes a cloud project
      // exceed the storage limit, and the server only says so on the next
      // autosave — by which point the user has imported, positioned and
      // modelled against geometry that was never going to sync.
      if (storage?.storage.kind === 'cloud'
        && wouldExceedCloudLimit(project, pick.dataBase64.length)) {
        const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
        const go = await confirm({
          title: 'Too large to sync to the cloud',
          message:
            `Importing "${pick.fileName}" takes this project past the ${mb(CLOUD_DOCUMENT_MAX_BYTES)} ` +
            `cloud limit, so it will stop syncing. You can still import it and save to disk. ` +
            `Import anyway?`,
          confirmLabel: 'Import anyway',
          cancelLabel: 'Cancel',
          tone: 'danger',
        });
        if (!go) return;
      }

      // Small files stay embedded and the document stays portable; large
      // ones become a `ref` into `project.references`, which is what lets the
      // bytes be stored once and shared across revisions rather than copied
      // into every snapshot. `makeImportedData` owns that threshold.
      const { data, asset } = makeImportedData(pick.dataBase64, {
        name: pick.fileName,
        type: pick.format,
        hash: await sha256Hex(pick.dataBase64),
        referenceId: referenceId(generateId('ref')),
      });
      const result = appState.commandBus.dispatch({
        type: 'CreateImportedGeometry',
        partId,
        inputs: { fileName: pick.fileName, format: pick.format, data },
        ...(asset ? { asset } : {}),
      });
      if (!result.ok) {
        reportFileError('Import failed', new Error(result.error.message));
      }
    } catch (err) {
      reportFileError('Import failed', err);
    }
  }, [appState.documentStore, appState.commandBus, storage, confirm]);

  /**
   * File → Import Component. Prompts for a `.cadcomponent` (or `.cadjson`
   * used as one), computes its content hash, embeds the sub-document
   * into `project.embeddedComponents[hash]` and appends an
   * `component` feature to the active part's timeline. The
   * rebuilder then re-runs the sub-timeline and surfaces the bodies.
   *
   * v1 always lands the instance at the origin — the Transform UX
   * (numeric panel + gizmo + snap picker) is a future enhancement.
   */
  const onComponentImport = useCallback(async () => {
    try {
      const pick = await pickComponentForImport();
      if (!pick) return; // user cancelled
      const project = appState.documentStore.getState();
      const partIds = Object.keys(project.parts);
      if (partIds.length === 0) {
        reportFileError('Component import failed', new Error('The document has no part to import into.'));
        return;
      }
      const partId = partIds[0] as PartId;

      // Strip extension for the display name; falls back to the file
      // base if the source's metadata.name is unset.
      const baseName = pick.fileName.replace(/\.(cadcomponent|cadjson)$/i, '');
      const componentName = pick.source.metadata?.name?.trim() || baseName;

      const result = appState.commandBus.dispatch({
        type: 'CreateComponent',
        partId,
        component: {
          hash: pick.hash,
          name: componentName,
          origin: pick.fileName,
          embeddedAt: new Date().toISOString(),
          source: pick.source,
        },
        inputs: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
          parameterOverrides: {},
          configurationId: null,
          boolean: 'newBody',
        },
      });
      if (!result.ok) {
        reportFileError('Component import failed', new Error(result.error.message));
      }
    } catch (err) {
      reportFileError('Component import failed', err);
    }
  }, [appState.documentStore, appState.commandBus]);


  const onFileSave = useCallback(() => {
    if (fileHandles) void save(fileHandles);
  }, [fileHandles]);
  // Save As opens the destination picker — disk OR cloud — instead of
  // committing straight to disk.
  const onFileSaveAs = useCallback(() => {
    if (fileHandles) setSaveAsOpen(true);
  }, [fileHandles]);

  /**
   * File → Export. Runs the kernel's STL / STEP / BREP / 3MF exporter on the
   * dedicated export worker and triggers a browser download. Filename
   * mirrors the project name plus the canonical extension.
   */
  const onFileExport = useCallback(
    async (format: 'stl' | 'step' | 'brep' | '3mf') => {
      try {
        const ab = await exportActivePart(
          appState.documentStore,
          format,
          appState.displayContextStore.getState().activePartId,
        );
        if (ab.byteLength === 0) {
          console.warn('[App] Export produced empty output; no bodies?');
          return;
        }
        const mime =
          format === 'stl'
            ? 'model/stl'
            : format === 'step'
              ? 'application/step'
              : format === 'brep'
                ? 'model/brep'
                : 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
        const blob = new Blob([ab], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const baseName =
          appState.documentStore.getState().metadata.name?.trim() || 'model';
        const safe = baseName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64);
        a.href = url;
        a.download = `${safe}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Give the browser a tick to start the download before revoking.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error('[App] Export failed:', err);
      }
    },
    [appState.documentStore],
  );

  // Dismissable recovery toast: shown once when the boot loaded an
  // autosaved doc whose previous origin was a disk file we no longer have
  // a handle to. The user can keep the toast around (dismiss the X) or
  // act on it via the CTA.
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const showRecoveryToast =
    !!storage?.recoveredFilename && !recoveryDismissed;

  // Sign-in modal state. Opens from SaveStatus' "Sign in to sync" pill,
  // from the MainAppBar's account chip, and from the Save-to-cloud flow
  // when the user picks "Cloud" but isn't signed in yet.
  const [signInOpen, setSignInOpen] = useState(false);

  const onContinueOffline = useCallback(() => {
    rememberOfflineChoice();
    window.location.reload();
  }, []);

  /**
   * New project, from the empty state. Creates it on the site first, then
   * navigates to it — so the window's document exists in the account from
   * the moment it exists at all, and the URL names it.
   */
  const onNewCloudProject = useCallback(async () => {
    setBootGateBusy(true);
    setBootGateError(null);
    try {
      const created = await createCloudProject(generateProjectName());
      // A full navigation, not a state swap: boot reads the URL, so this
      // is the one code path that makes the new project *this window's*.
      window.location.search = `?project=${encodeURIComponent(created.id)}`;
    } catch (err) {
      // Do not fall back to a local document. The user asked for a project
      // in their account; quietly giving them something else is how work
      // ends up somewhere they never chose.
      setBootGateError(
        err instanceof Error ? err.message : 'Could not create the project.',
      );
      setBootGateBusy(false);
    }
  }, []);
  /**
   * Open file, from the empty state. The file becomes this window's
   * document as it would from File → Open, and no cloud project is created:
   * Save As → Cloud makes the one project, rather than New project making
   * an empty one first.
   */
  const onOpenFileFromGate = useCallback(async () => {
    setBootGateError(null);
    try {
      const result = await openFileFromDisk();
      if (!result) return;
      const context: ProjectContext = { kind: 'local-stored', localId: `disk-${result.filename}` };
      adoptDocument({
        doc: result.doc,
        context,
        storage: { kind: 'disk', handle: result.handle, filename: result.filename, lastSavedAt: Date.now() },
        source: 'local-only',
      });
      nameDocumentInUrl(context);
      setBootGate(null);
    } catch (err) {
      setBootGateError(err instanceof Error ? err.message : 'Could not open the file.');
    }
  }, [adoptDocument]);
  const onRequestSignIn = useCallback(() => setSignInOpen(true), []);
  const onSignOut = useCallback(async () => {
    try {
      // Same-origin in prod (/cad served from the SaaS host), Vite-proxied
      // in dev. Better Auth's sign-out requires Content-Type: application/json
      // AND a body (header alone returns 415; missing body returns 500).
      // The empty object is the minimum that satisfies both checks.
      await fetch('/api/v1/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
    } catch {
      // Ignore — even if the network call fails, refresh below will clear
      // any stale local state.
    }
    await refreshSaasState();
  }, []);

  if (bootGate) {
    return (
      <>
        <BootGate
          kind={bootGate}
          onSignIn={() => setSignInOpen(true)}
          onContinueOffline={onContinueOffline}
          onNewProject={() => void onNewCloudProject()}
          onOpenFile={() => void onOpenFileFromGate()}
          onRetry={() => window.location.reload()}
          projectsUrl="/dashboard"
          busy={bootGateBusy}
          error={bootGateError}
        />
        <SignInModal
          open={signInOpen}
          onClose={() => setSignInOpen(false)}
          onSignedIn={() => {
            // Boot's answer depended on there being no session. Re-run it.
            window.location.reload();
          }}
        />
        <GlobalToast />
      </>
    );
  }

  return (
    <>
      <ErrorBoundary scopeLabel="the editor">
        <Shell
          onFileNew={onFileNew}
          onFileOpen={onFileOpen}
          onFileImport={onFileImport}
          onImportFcstd={onImportFcstd}
          onComponentImport={onComponentImport}
          onFileSave={onFileSave}
          onFileSaveAs={onFileSaveAs}
          onFileExport={onFileExport}
          onOpenHistory={cloudProjectId ? () => setHistoryOpen(true) : undefined}
          saas={saas}
          onRequestSignIn={onRequestSignIn}
          onSignOut={onSignOut}
          onEditParameters={openParametersEditor}
          onOpenSettings={openSettings}
        />
      </ErrorBoundary>
      {historyOpen && cloudProjectId && (
        <HistoryPanel
          list={listRevisions}
          onPreview={previewRevision}
          onRestore={restoreRevision}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {parametersDialogElement}
      {settingsDialogElement}
      {storage && (
        <div style={saveStatusContainer}>
          <SaveStatus
            scheduler={storage.scheduler}
            context={storage.context}
            storage={storage.storage}
            saas={saas}
            onRequestSignIn={onRequestSignIn}
          />
        </div>
      )}
      {showRecoveryToast && storage?.recoveredFilename && (
        <Toast
          id="recovery"
          tone="warning"
          title="Restored from your last session"
          message={`Showing autosaved content for "${storage.recoveredFilename}". The original file is no longer attached. Use Open to re-attach, or Save to write a new file.`}
          action={{
            label: 'Re-open original',
            onClick: () => onFileOpen(),
          }}
          durationMs={20_000}
          onDismiss={() => setRecoveryDismissed(true)}
        />
      )}
      <GlobalToast />
      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        {...(storage
          ? {
              // Social sign-in navigates the tab to the provider. Autosave is
              // debounced 2s with a timer that resets on every change, so an
              // edit made just before clicking would otherwise be lost on
              // unload — flush it synchronously first.
              beforeRedirect: () => storage.scheduler.flushNow(),
            }
          : {})}
        onSignedIn={() => {
          // No-op for now — SaaS state refresh inside the modal triggers
          // the relevant re-renders. Hook point for "save to cloud
          // after sign-in" follow-through.
          void isSignedIn;
        }}
      />
      {storage && (
        <SaveAsPicker
          open={saveAsOpen}
          docName={appState.documentStore.getState().metadata.name}
          saas={saas}
          onClose={() => setSaveAsOpen(false)}
          onPickDisk={() => {
            setSaveAsOpen(false);
            if (fileHandles) void saveAsToDisk(fileHandles);
          }}
          onPickCloud={async (projectName) => {
            if (!fileHandles) return;
            const created = await saveAsNewCloudProject(
              fileHandles,
              projectName,
              createCloudProject,
            );
            if (!created) {
              // saveAsNewCloudProject logged the error; throw so the picker
              // surfaces it inline.
              throw new Error('Could not create the cloud project.');
            }
            setSaveAsOpen(false);
          }}
          onRequestSignIn={() => {
            setSaveAsOpen(false);
            setSignInOpen(true);
          }}
        />
      )}
      {confirmDialogElement}
      {autoExportStatus !== null && (
        <AutoExportStatusPanel statuses={autoExportStatus} />
      )}
    </>
  );
}

/**
 * Render the most recent toast from the global toast store. Any module —
 * stores, command handlers — can call `enqueueToast(...)` to surface a
 * notification; this component handles the rest. Single-toast-at-a-time;
 * latest replaces previous via the incrementing nonce in the payload.
 */
function GlobalToast() {
  const current = useToastStore((s) => s.current);
  const dismiss = useToastStore((s) => s.dismiss);
  if (!current) return null;
  return (
    <Toast
      id={current.nonce}
      tone={current.tone ?? 'info'}
      {...(current.title !== undefined ? { title: current.title } : {})}
      message={current.message}
      durationMs={current.durationMs ?? 6_000}
      onDismiss={dismiss}
    />
  );
}

/**
 * Tiny floating status panel rendered while the auto-export flow runs.
 * Shows per-format progress + final summary so the user knows when it's
 * safe to close the tab.
 */
function AutoExportStatusPanel({ statuses }: { statuses: AutoExportStatus[] }) {
  const done = statuses.some((s) => s.kind === 'done');
  // Aggregate per-format state.
  const byFormat = new Map<
    'stl' | 'step' | '3mf',
    { running: boolean; result: 'ok' | 'failed' | null; bytes: number; error?: string }
  >();
  for (const s of statuses) {
    if (s.kind === 'done') continue;
    const cur = byFormat.get(s.format) ?? { running: false, result: null, bytes: 0 };
    if (s.kind === 'start') cur.running = true;
    if (s.kind === 'uploaded') {
      cur.running = false;
      cur.result = 'ok';
      cur.bytes = s.sizeBytes;
    }
    if (s.kind === 'failed') {
      cur.running = false;
      cur.result = 'failed';
      cur.error = s.message;
    }
    byFormat.set(s.format, cur);
  }
  const formats: ('stl' | 'step' | '3mf')[] = ['stl', 'step', '3mf'];

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 90,
        minWidth: 280,
        maxWidth: 360,
        padding: '12px 14px',
        background: '#ffffff',
        border: '1px solid #d8d8d8',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
        fontFamily: 'inherit',
        fontSize: 12,
        color: '#333',
      }}
      role="status"
      aria-live="polite"
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: '#111' }}>
          {done ? 'Downloads generated' : 'Generating downloads...'}
        </strong>
        {done && (
          <a
            href={window.location.pathname + window.location.hash}
            style={{ display: 'inline-flex', color: '#888', textDecoration: 'none' }}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <X size={13} />
          </a>
        )}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {formats.map((f) => {
          const s = byFormat.get(f);
          const label = f.toUpperCase();
          if (!s) return <li key={f} style={{ color: '#aaa' }}>{label}: waiting...</li>;
          if (s.running) return <li key={f}>{label}: exporting...</li>;
          if (s.result === 'ok') {
            return (
              <li key={f} style={{ color: '#15803d', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Check size={12} />
                {label}: uploaded ({formatBytes(s.bytes)})
              </li>
            );
          }
          return (
            <li key={f} style={{ color: '#b91c1c', display: 'flex', alignItems: 'center', gap: 4 }} title={s.error}>
              <X size={12} />
              {label}: failed
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Tell the user a file operation failed, in a toast and in the in-app
 * console. A console.error alone is invisible: the user sees nothing happen
 * and cannot tell a failed import from a slow one.
 */
function reportFileError(title: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[App] ${title}:`, err);
  consoleLog('error', `${title}: ${message}`, 'file');
  enqueueToast({ tone: 'warning', title, message });
}

const saveStatusContainer: React.CSSProperties = {
  position: 'fixed',
  bottom: 8,
  right: 8,
  zIndex: 50,
  borderRadius: 6,
  border: '1px solid #e5e5e5',
  background: 'rgba(255, 255, 255, 0.9)',
  backdropFilter: 'blur(4px)',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

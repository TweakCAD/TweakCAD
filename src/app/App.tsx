/**
 * The app's root: decides what the window opens (a document, or the boot
 * gate when the honest answer is "the one you pick"), boots the services
 * (worker service, working copy, document, cloud projects), then lays out
 * the shell with the file commands, revision history, toasts, dialogs and
 * sign-in around it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudStorageProvider } from '@tweakcad/cloud-providers';
import { loadDocument, randomIds, saveDocument } from '@tweakcad/editor';
import { ServiceClient, type ImportFormat } from '@tweakcad/worker/src/v2/service/client';
import type { ExportFormat } from '@tweakcad/worker/src/v2/service/types';
import { BootGate, type BootGateKind } from '../components/BootGate.tsx';
import { useConfirm } from '../components/ConfirmDialog.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { SignInModal } from '../components/SignInModal.tsx';
import { useSettingsDialog } from '../components/SettingsDialog.tsx';
import { Toast } from '../components/Toast.tsx';
import { enqueueToast, useToastStore } from '../components/toastStore.ts';
import { localIdFromUrl, nameDocumentInUrl, projectIdFromUrl } from '../storage/context.ts';
import { hasChosenOffline, rememberOfflineChoice } from '../storage/offlineChoice.ts';
import { UNTITLED } from '../storage/projectName.ts';
import { isSignedIn, probeSaas, refreshSaasState } from '../storage/saasState.ts';
import { loadSocialProviders } from '../storage/socialProviders.ts';
import { captureThumbnail, registerThumbnailCapture } from '../storage/thumbnailCapture.ts';
import { useSaasState } from '../storage/useSaasState.ts';
import { AssistantPanel, useAiContext, useAssistantModels } from '../ai/assistant';
import { Workspace } from './Workspace';
import { consoleLog } from './console';
import { installDevHandle } from './devHandle';
import { installSessionLog } from './sessionLog';
import { SaveStatusPill } from './SaveStatusPill';
import { F3D_FILE, FREECAD_FILE, pickFile } from './io/files';
import { COMPONENT_FILE, importComponent } from './assembly/importComponent';
import { f3dImportMessage, importF3dFile } from './io/f3d';
import { importFreeCad } from './io/freecad';
import { GEOMETRY_FILES, importGeometry } from './io/geometry';
import { activePart } from './modeling/commands';
import { bootApp, type AppServices } from './services';
import { AutoExportPanel } from './storage/AutoExportPanel';
import { runAutoExport, shouldAutoExport, type AutoExportStatus } from './storage/autoExport';
import { resolveBoot } from './storage/boot';
import { CloudProjects, cloudLimitNotice, fetchUrls } from './storage/cloud';
import { download, openFileFromDisk, safeFileName } from './storage/disk';
import { HistoryPanel } from './storage/HistoryPanel';
import { SaveAsPicker } from './storage/SaveAsPicker';
import {
  asksBeforeReplacing,
  missingFilesNotice,
  PREVIEW_MESSAGE,
  type BootResult,
  type FileOutcome,
} from './storage/session';
import { canvasThumbnail } from './storage/thumbnail';
import { defaultWorkingCopy } from './storage/workingCopy';
import type { Viewport } from './viewport/Viewport';

const EXPORT_TYPES: Record<ExportFormat, string> = {
  stl: 'model/stl',
  step: 'application/step',
  brep: 'model/brep',
  '3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
};

function hasResetHint(): boolean {
  return new URLSearchParams(window.location.search).has('reset');
}

function clearResetHint(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('reset')) return;
  url.searchParams.delete('reset');
  window.history.replaceState(window.history.state, '', url.toString());
}

function reportOutcome(title: string, outcome: FileOutcome, done?: () => string): void {
  if (outcome.ok === false) {
    consoleLog('error', `${title}: ${outcome.message}`, 'file');
    enqueueToast({ tone: 'warning', title, message: outcome.message });
  } else if (outcome.ok === true && done) {
    consoleLog('success', done(), 'file');
  }
}

function reportError(title: string): (e: unknown) => void {
  return (e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[app] ${title}:`, e);
    consoleLog('error', `${title}: ${message}`, 'file');
    enqueueToast({ tone: 'warning', title, message });
  };
}

function storageName(services: AppServices): string {
  const storage = services.session.storage;
  return storage.kind === 'disk' ? storage.filename : storage.kind === 'cloud' ? storage.name : 'the document';
}

function warnMissing(missing: readonly string[]): void {
  if (missing.length > 0) enqueueToast({ tone: 'warning', ...missingFilesNotice(missing), durationMs: 20_000 });
}

type Gate = { kind: BootGateKind; message: string | null };

export function App() {
  const [services, setServices] = useState<AppServices | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const saas = useSaasState();
  const [signInOpen, setSignInOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cloudProject, setCloudProject] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [autoExport, setAutoExport] = useState<AutoExportStatus[] | null>(null);
  const { confirm, element: confirmElement } = useConfirm();
  const { open: openSettings, element: settingsElement } = useSettingsDialog();
  const viewportRef = useRef<Viewport | null>(null);
  const ids = useMemo(() => randomIds(), []);
  const workingCopy = useMemo(() => defaultWorkingCopy(), []);
  const cloud = useMemo(
    () => new CloudProjects(new CloudStorageProvider({ baseUrl: '' }), fetchUrls, captureThumbnail),
    [],
  );
  /** Boots the services on `boot`; set once the worker is spawned. */
  const startRef = useRef<((boot: BootResult) => Promise<void>) | null>(null);
  /** Opens a file in place of the document: what a restored session's "Re-open original" does. */
  const reopenRef = useRef<() => void>(() => undefined);
  /** The worker service, for the importers' calls beyond what the services use. */
  const clientRef = useRef<ServiceClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    let booted: AppServices | null = null;
    const client = ServiceClient.spawn();
    clientRef.current = client;
    const reset = hasResetHint();
    let siteUp = false;
    const start = async (boot: BootResult) => {
      const { services: s, notice } = await bootApp({
        client,
        workingCopy,
        localId: boot.localId,
        boot,
        ids,
        cloud: siteUp ? cloud : null,
      });
      if (cancelled) {
        s.dispose();
        return;
      }
      booted = s;
      s.ready.catch((e: unknown) => {
        enqueueToast({
          tone: 'warning',
          title: 'The geometry kernel could not be loaded',
          message: e instanceof Error ? e.message : String(e),
          durationMs: 20_000,
        });
      });
      if (notice) {
        const { reopen, ...text } = notice;
        enqueueToast({
          tone: 'warning',
          ...text,
          durationMs: 20_000,
          ...(reopen ? { action: { label: 'Re-open original', onClick: () => reopenRef.current() } } : {}),
        });
      }
      setGate(null);
      setServices(s);
    };
    startRef.current = start;
    void (async () => {
      const state = await probeSaas();
      siteUp = state.kind === 'available';
      if (state.kind === 'available' && !state.signedIn) void loadSocialProviders();
      const outcome = await resolveBoot({
        workingCopy,
        localId: reset ? null : localIdFromUrl(),
        projectId: reset ? null : projectIdFromUrl(),
        reset,
        ids,
        name: () => UNTITLED,
        saas: { reachable: siteUp, signedIn: isSignedIn(state) },
        offlineChosen: hasChosenOffline(),
        cloud: siteUp ? cloud : null,
      });
      if (reset) clearResetHint();
      if (cancelled) return;
      // Boot deliberately opened nothing: ask, rather than mint a blank document the window would then be bound to.
      if (outcome.kind !== 'document') {
        setGate({ kind: outcome.kind, message: outcome.kind === 'load-failed' ? outcome.message : null });
        return;
      }
      await start(outcome.boot);
    })().catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      startRef.current = null;
      if (clientRef.current === client) clientRef.current = null;
      booted?.dispose();
      client.terminate();
    };
  }, [ids, workingCopy, cloud]);

  useEffect(() => (services ? installSessionLog(services) : undefined), [services]);

  useEffect(() => {
    if (!services || !import.meta.env.DEV) return;
    return installDevHandle(services, () => viewportRef.current);
  }, [services]);

  // The cloud project the document saves to, for the history button and the end-of-session revision, and the revision previewed.
  useEffect(() => {
    if (!services) return;
    const follow = () => {
      setCloudProject(services.session.cloudProject);
      setPreviewing(services.session.preview?.revisionId ?? null);
    };
    follow();
    return services.session.state.subscribe(follow);
  }, [services]);

  /**
   * A revision when the tab goes away. Autosave keeps the newest bytes but
   * writes no history, and most sessions end by closing the tab. The server
   * keeps one revision per distinct document, so switching tabs often costs
   * nothing.
   */
  useEffect(() => {
    if (!services || !cloudProject) return;
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void services.session.endOfSession().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [services, cloudProject]);

  // `?autoExport=1`: once, when a cloud project is open.
  const autoExportStarted = useRef(false);
  useEffect(() => {
    if (!services || !cloudProject || autoExportStarted.current || !shouldAutoExport()) return;
    autoExportStarted.current = true;
    setAutoExport([]);
    void runAutoExport({
      projectId: cloudProject,
      exportShown: (format) => services.exportShown(format),
      onStatus: (s) => setAutoExport((prev) => [...(prev ?? []), s]),
    });
  }, [services, cloudProject]);

  /** Asks before replacing a document edited since it was opened or made, with changes nowhere else. */
  const mayDiscard = useCallback(async (): Promise<boolean> => {
    if (!services) return false;
    const edited = services.editor.store.undoLabel() !== undefined;
    if (
      !asksBeforeReplacing({
        edited,
        storage: services.session.storage.kind,
        autosave: services.autosave.getStatus().kind,
      })
    )
      return true;
    return confirm({
      title: 'Discard current document?',
      message:
        'Unsaved changes in the current document will be lost. Make sure you saved it first if you want to keep them.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
  }, [services, confirm]);

  const onNew = useCallback(() => {
    if (!services) return;
    void mayDiscard().then((ok) => {
      if (ok) services.session.newDocument();
    });
  }, [services, mayDiscard]);

  const onOpen = useCallback(() => {
    if (!services) return;
    void mayDiscard().then(async (ok) => {
      if (!ok) return;
      try {
        reportOutcome('Open failed', await services.session.open(), () => `Opened ${storageName(services)}`);
      } catch (e) {
        reportError('Open failed')(e);
      }
    });
  }, [services, mayDiscard]);

  useEffect(() => {
    reopenRef.current = onOpen;
  }, [onOpen]);

  const onSave = useCallback(() => {
    if (!services) return;
    services.session
      .save()
      .then((o) => reportOutcome('Save failed', o, () => `Saved ${storageName(services)}`), reportError('Save failed'));
  }, [services]);

  const onSaveAs = useCallback(() => {
    if (!services) return;
    if (services.session.preview) reportOutcome('Save As', { ok: false, message: PREVIEW_MESSAGE });
    else setSaveAsOpen(true);
  }, [services]);

  const onSaveAsDisk = useCallback(() => {
    if (!services) return;
    services.session
      .saveAs()
      .then((o) => reportOutcome('Save failed', o, () => `Saved ${storageName(services)}`), reportError('Save failed'));
  }, [services]);

  const onSaveAsCloud = useCallback(
    async (name: string) => {
      if (!services) return;
      const outcome = await services.session.saveAsCloud(name);
      if (outcome.ok === false) throw new Error(outcome.message);
      consoleLog('success', `Saved to the cloud as ${storageName(services)}`, 'file');
      setSaveAsOpen(false);
    },
    [services],
  );

  const onImport = useCallback(
    (format: ImportFormat = 'step') => {
      const client = clientRef.current;
      if (!services || !client) return;
      // Into the part the window works on now, whatever is opened while the file is chosen and read.
      const part = activePart(services);
      if (!part) {
        const message = 'Files are imported into a part. Open a part, then import again.';
        consoleLog('warn', message, 'file');
        enqueueToast({ tone: 'warning', title: 'Import', message });
        return;
      }
      void (async () => {
        const file = await pickFile(GEOMETRY_FILES[format]);
        if (!file) return;
        // Asked before the work, not after: the site would refuse the file only at the next autosave.
        const tooLarge =
          services.session.storage.kind === 'cloud' ? cloudLimitNotice(file.name, file.bytes.byteLength) : null;
        if (
          tooLarge &&
          !(await confirm({ ...tooLarge, confirmLabel: 'Import anyway', cancelLabel: 'Cancel', tone: 'danger' }))
        )
          return;
        const outcome = await importGeometry(services.editor, client, file, format, part);
        if (!outcome.ok) {
          consoleLog('error', `Import of ${file.name} failed: ${outcome.message}`, 'file');
          enqueueToast({ tone: 'warning', title: 'Import failed', message: outcome.message });
          return;
        }
        consoleLog(
          'success',
          `Imported ${file.name} as ${outcome.name} (${outcome.bodies} ${outcome.bodies === 1 ? 'body' : 'bodies'})`,
          'file',
        );
        if (outcome.skipped > 0) {
          const message = `${outcome.skipped} open ${outcome.skipped === 1 ? 'mesh was' : 'meshes were'} left out: ${outcome.skipped === 1 ? 'it has' : 'they have'} holes or loose triangles, so ${outcome.skipped === 1 ? 'it bounds' : 'they bound'} no solid.`;
          consoleLog('warn', `${file.name}: ${message}`, 'file');
          enqueueToast({ tone: 'warning', title: `Imported ${file.name}`, message });
        }
      })().catch(reportError('Import failed'));
    },
    [services, confirm],
  );

  const onImportComponent = useCallback(() => {
    if (!services) return;
    void (async () => {
      const file = await pickFile(COMPONENT_FILE);
      if (!file) return;
      const outcome = await importComponent(services, file);
      if (!outcome.ok) {
        consoleLog('error', `Import of ${file.name} failed: ${outcome.message}`, 'components');
        enqueueToast({ tone: 'warning', title: 'Component import failed', message: outcome.message });
        return;
      }
      consoleLog('success', `Inserted component: ${outcome.name}`, 'components');
    })().catch(reportError('Component import failed'));
  }, [services]);

  const onImportFcstd = useCallback(() => {
    const client = clientRef.current;
    if (!services || !client) return;
    void mayDiscard()
      .then(async (ok) => {
        if (!ok) return;
        const file = await pickFile(FREECAD_FILE);
        if (!file) return;
        // Finishing evaluates other documents in the worker, so it has the worker to itself until the
        // imported document is open; the scheduler then builds that one, resuming from the finishing build.
        const scheduler = services.scheduler;
        const outcome = await scheduler.exclusive(async () => {
          const out = await importFreeCad(file, client, ids, (label, done, total) =>
            scheduler.report({ label, done, total }),
          );
          if (out.ok)
            reportOutcome(
              'FreeCAD import failed',
              services.session.openText(saveDocument(out.document)),
              () => `Imported ${file.name}`,
            );
          return out;
        });
        if (!outcome.ok) {
          consoleLog('error', `Import of ${file.name} failed: ${outcome.message}`, 'file');
          enqueueToast({ tone: 'warning', title: 'FreeCAD import failed', message: outcome.message });
          return;
        }
        for (const n of outcome.notes)
          consoleLog(n.severity === 'warning' ? 'warn' : 'info', `${file.name}, ${n.object}: ${n.message}`, 'file');
        const left = outcome.notes.filter((n) => n.severity === 'warning').length;
        if (left > 0)
          enqueueToast({
            tone: 'info',
            title: `Imported ${file.name}`,
            message: `${left} ${left === 1 ? 'thing was' : 'things were'} not imported; the console lists them.`,
            durationMs: 10_000,
          });
      })
      .catch(reportError('FreeCAD import failed'));
  }, [services, mayDiscard, ids]);

  const onImportF3d = useCallback(() => {
    const client = clientRef.current;
    if (!services || !client) return;
    void mayDiscard()
      .then(async (ok) => {
        if (!ok) return;
        const file = await pickFile(F3D_FILE);
        if (!file) return;
        // As for a FreeCAD file: the worker is the import's until the imported document is open.
        const scheduler = services.scheduler;
        const outcome = await scheduler.exclusive(async () => {
          const out = await importF3dFile(file, client, ids, (label, done, total) =>
            scheduler.report({ label, done, total }),
          );
          if (out.ok)
            reportOutcome(
              '.f3d import failed',
              services.session.openText(saveDocument(out.document)),
              () => `Imported ${file.name}`,
            );
          return out;
        });
        if (!outcome.ok) {
          consoleLog('error', `Import of ${file.name} failed: ${outcome.message}`, 'file');
          enqueueToast({ tone: 'warning', title: '.f3d import failed', message: outcome.message });
          return;
        }
        for (const n of outcome.notes)
          consoleLog(n.severity === 'warning' ? 'warn' : 'info', `${file.name}, ${n.object}: ${n.message}`, 'file');
        const message = f3dImportMessage(outcome.notes);
        if (message) enqueueToast({ tone: 'info', title: `Imported ${file.name}`, message, durationMs: 10_000 });
      })
      .catch(reportError('.f3d import failed'));
  }, [services, mayDiscard, ids]);

  const onExport = useCallback(
    (format: ExportFormat) => {
      if (!services) return;
      services
        .exportShown(format)
        .then((bytes) => {
          if (bytes.byteLength === 0) {
            enqueueToast({ tone: 'info', title: 'Nothing to export', message: 'The shown part has no bodies.' });
            return;
          }
          const name = String((services.editor.document.metadata as { name?: unknown }).name ?? '');
          const file = safeFileName(name || 'model', format);
          download(file, new Blob([bytes as BlobPart], { type: EXPORT_TYPES[format] }));
          consoleLog('success', `Exported ${file}`, 'file');
        })
        .catch(reportError('Export failed'));
    },
    [services],
  );

  const onExportFreeCad = useCallback(() => {
    if (!services) return;
    services
      .exportFreeCad()
      .then(({ bytes, notes }) => {
        const name = String((services.editor.document.metadata as { name?: unknown }).name ?? '');
        const file = safeFileName(name || 'model', 'FCStd');
        download(file, new Blob([bytes as BlobPart], { type: 'application/x-freecad' }));
        consoleLog('success', `Exported ${file}`, 'file');
        for (const n of notes) consoleLog('info', `${file}, ${n.object}: ${n.message}`, 'file');
        if (notes.length > 0)
          enqueueToast({
            tone: 'info',
            title: `Exported ${file}`,
            message: `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} on what FreeCAD gets as stored solids; the console lists them.`,
            durationMs: 10_000,
          });
      })
      .catch(reportError('FreeCAD export failed'));
  }, [services]);

  const listRevisions = useCallback(
    (cursor?: string) =>
      services ? services.session.listRevisions(cursor) : Promise.resolve({ items: [], nextCursor: null }),
    [services],
  );

  const previewRevision = useCallback(
    async (revisionId: string, label: string) => {
      if (!services) return;
      const { missing } = await services.session.previewRevision(revisionId, label);
      warnMissing(missing);
      consoleLog('info', `Showing ${label} read-only. Restore it to make it the live document.`, 'history');
    },
    [services],
  );

  const restoreRevision = useCallback(
    async (revisionId: string) => {
      if (!services) return;
      const { snapshotVersionId, missing } = await services.session.restoreRevision(revisionId);
      warnMissing(missing);
      setHistoryOpen(false);
      consoleLog('success', `Restored ${revisionId}. Your previous work is kept as ${snapshotVersionId}.`, 'history');
    },
    [services],
  );

  /** Closing the history ends a preview: the live document shows again. */
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    services?.session.closePreview();
  }, [services]);

  const onSignOut = useCallback(async () => {
    try {
      await fetch('/api/v1/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      });
    } catch {
      // The refresh below clears the signed-in state either way.
    }
    await refreshSaasState();
  }, []);

  const onViewport = useCallback((vp: Viewport | null) => {
    viewportRef.current = vp;
  }, []);

  // The assistant's tools (in-app chat and the MCP bridge) and the chat panel, when the site offers a model.
  const currentViewport = useCallback(() => viewportRef.current, []);
  const ai = useAiContext(services, currentViewport);
  const models = useAssistantModels(saas);
  const [chatOpen, setChatOpen] = useState(false);
  const assistant =
    ai && models.length > 0 && saas.kind === 'available'
      ? {
          open: chatOpen,
          onToggle: () => setChatOpen((v) => !v),
          panel: (
            <AssistantPanel
              ctx={ai}
              saas={saas}
              models={models}
              onClose={() => setChatOpen(false)}
              onRequestSignIn={() => setSignInOpen(true)}
            />
          ),
        }
      : undefined;

  // A cloud revision's thumbnail is the view as it is drawn.
  useEffect(
    () =>
      registerThumbnailCapture(() =>
        viewportRef.current ? canvasThumbnail(viewportRef.current.getCanvas()) : Promise.resolve(null),
      ),
    [],
  );

  const freshName = useCallback(() => cloud.freshName(), [cloud]);

  /** New project, from the gate: made in the account first, then opened, so the address names it from the start. */
  const onGateNewProject = useCallback(async () => {
    setGateBusy(true);
    try {
      const created = await cloud.create(await cloud.freshName());
      window.location.search = `?project=${encodeURIComponent(created.id)}`;
    } catch (e) {
      setGate((g) => (g ? { ...g, message: e instanceof Error ? e.message : 'The project could not be created.' } : g));
      setGateBusy(false);
    }
  }, [cloud]);

  /** Open file, from the gate: the file becomes this window's document; no cloud project is made for it. */
  const onGateOpenFile = useCallback(async () => {
    try {
      const file = await openFileFromDisk();
      if (!file) return;
      const loaded = loadDocument(file.text);
      if (!loaded.ok) {
        setGate((g) => (g ? { ...g, message: loaded.message } : g));
        return;
      }
      nameDocumentInUrl({ kind: 'local-fresh' });
      await startRef.current?.({
        doc: loaded.document,
        localId: null,
        storage: { kind: 'disk', filename: file.filename },
        session: { kind: 'disk', handle: file.handle, filename: file.filename },
      });
    } catch (e) {
      setGate((g) => (g ? { ...g, message: e instanceof Error ? e.message : 'The file could not be opened.' } : g));
    }
  }, []);

  if (bootError) return <div style={styles.message}>TweakCAD could not start: {bootError}</div>;

  if (gate) {
    return (
      <>
        <BootGate
          kind={gate.kind}
          onSignIn={() => setSignInOpen(true)}
          onContinueOffline={() => {
            rememberOfflineChoice();
            window.location.reload();
          }}
          onNewProject={() => void onGateNewProject()}
          onOpenFile={() => void onGateOpenFile()}
          onRetry={() => window.location.reload()}
          projectsUrl="/dashboard"
          busy={gateBusy}
          error={gate.message}
        />
        <SignInModal
          open={signInOpen}
          onClose={() => setSignInOpen(false)}
          onSignedIn={() => window.location.reload()}
        />
        <GlobalToast />
      </>
    );
  }

  if (!services) return <div style={styles.message}>Loading…</div>;

  return (
    <>
      <ErrorBoundary scopeLabel="the editor">
        <Workspace
          services={services}
          onNew={onNew}
          onOpen={onOpen}
          onSave={onSave}
          onSaveAs={onSaveAs}
          onExport={onExport}
          onExportFreeCad={onExportFreeCad}
          onImport={onImport}
          onImportFcstd={onImportFcstd}
          onImportF3d={onImportF3d}
          onImportComponent={onImportComponent}
          {...(cloudProject ? { onOpenHistory: () => setHistoryOpen(true) } : {})}
          onRestoreRevision={restoreRevision}
          saas={saas}
          onRequestSignIn={() => setSignInOpen(true)}
          onSignOut={() => void onSignOut()}
          onOpenSettings={openSettings}
          onViewport={onViewport}
          {...(assistant ? { assistant } : {})}
        />
      </ErrorBoundary>
      {historyOpen && cloudProject && (
        <HistoryPanel
          list={listRevisions}
          onPreview={previewRevision}
          previewing={previewing}
          onRestore={restoreRevision}
          onClose={closeHistory}
        />
      )}
      <SaveStatusPill services={services} saas={saas} onRequestSignIn={() => setSignInOpen(true)} />
      <SaveAsPicker
        open={saveAsOpen}
        docName={String((services.editor.document.metadata as { name?: unknown }).name ?? '')}
        saas={saas}
        onClose={() => setSaveAsOpen(false)}
        onPickDisk={() => {
          setSaveAsOpen(false);
          onSaveAsDisk();
        }}
        onPickCloud={onSaveAsCloud}
        onRequestSignIn={() => {
          setSaveAsOpen(false);
          setSignInOpen(true);
        }}
        freshName={freshName}
      />
      {autoExport !== null && <AutoExportPanel statuses={autoExport} onDismiss={() => setAutoExport(null)} />}
      <GlobalToast />
      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        beforeRedirect={() => services.autosave.flushNow()}
        onSignedIn={() => undefined}
      />
      {settingsElement}
      {confirmElement}
    </>
  );
}

/** The newest toast from the toast store. */
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
      {...(current.action ? { action: current.action } : {})}
      durationMs={current.durationMs ?? 6_000}
      onDismiss={dismiss}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  message: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    background: '#f5f5f5',
    color: '#666',
    fontSize: 13,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
};

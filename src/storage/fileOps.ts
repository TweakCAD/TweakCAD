/**
 * High-level file operations.
 *
 * Coordinates DocumentStore + DocumentStorage + AutosaveScheduler + disk and
 * cloud adapters into the user-facing actions: New / Open / Save / Save As.
 *
 * Sticky-storage model: Save always writes back to the doc's current
 * `DocumentStorage`. Save As is the only operation that switches storages.
 *
 * Caller wires this into UI handlers (File menu, Ctrl+S keyboard shortcut).
 * It does NOT own React state — it operates on mutable refs / setters
 * passed in by the host (App.tsx).
 */
import type { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import type { CadProject, Diagnostic } from '@tweakcad/core/src/document/schema.ts';
import { importFcstd } from '@tweakcad/fcstd-import';
import type { AutosaveScheduler } from './autosave.ts';
import type { DocumentStorage } from './documentStorage.ts';
import type { ProjectContext } from './context.ts';
import { suggestFilename } from './documentStorage.ts';
import {
  openFileFromDisk,
  pickFcstdForImport,
  saveFileAs,
  writeToHandle,
  type OpenResult,
} from './diskAdapter.ts';
import { saveCloudProject } from './cloudAdapter.ts';

export type ConfirmFn = (opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}) => Promise<boolean>;

export type FileOpsHandles = {
  documentStore: DocumentStore;
  scheduler: AutosaveScheduler;
  getStorage: () => DocumentStorage;
  setStorage: (s: DocumentStorage) => void;
  /** Update the autosave routing when storage changes (e.g. disk → cloud). */
  setContext: (c: ProjectContext) => void;
  /** A blank default doc — used by New. */
  blankDoc: () => CadProject;
  /** Caller-provided confirm dialog. Use a React modal, not window.confirm(). */
  confirm: ConfirmFn;
};

// --- New -----------------------------------------------------------------

export async function newDocument(h: FileOpsHandles): Promise<void> {
  if (await confirmDiscardUnsavedChanges(h)) {
    h.documentStore.replaceDocument(h.blankDoc());
    h.setStorage({ kind: 'unsaved' });
    h.setContext({ kind: 'local-fresh' });
  }
}

// --- Open ----------------------------------------------------------------

export async function openFromDisk(h: FileOpsHandles): Promise<OpenResult | null> {
  if (!(await confirmDiscardUnsavedChanges(h))) return null;
  const result = await openFileFromDisk();
  if (!result) return null;
  h.documentStore.replaceDocument(result.doc);
  h.setStorage({
    kind: 'disk',
    handle: result.handle,
    filename: result.filename,
    lastSavedAt: Date.now(),
  });
  // Autosave still routes to IDB as crash-recovery; behaves like local-stored.
  h.setContext({ kind: 'local-stored', localId: `disk-${result.filename}` });
  return result;
}

// --- Import FreeCAD (.fcstd) ---------------------------------------------

export type FcstdImportOutcome = {
  fileName: string;
  diagnostics: Diagnostic[];
};

/**
 * Import → FreeCAD (.fcstd). Opens the picked file as a brand-new document,
 * mirroring `openFromDisk`: a `.fcstd` carries a whole parametric tree (one
 * CadPart per FreeCAD Body), so it REPLACES the active document rather than
 * appending into it. The imported project starts `unsaved` — there is no
 * `.cadjson` handle yet, so the next Save prompts for a location.
 *
 * Returns the import diagnostics (unsupported features/geometry,
 * constraints-not-imported notes) for the caller to surface, or null if the
 * user cancels the picker or declines to discard unsaved changes. Throws if
 * the archive can't be unzipped / parsed.
 */
export async function importFcstdAsDocument(h: FileOpsHandles): Promise<FcstdImportOutcome | null> {
  if (!(await confirmDiscardUnsavedChanges(h))) return null;
  const pick = await pickFcstdForImport();
  if (!pick) return null;

  const baseName = pick.fileName.replace(/\.fcstd$/i, '');
  const result = await importFcstd(pick.bytes, baseName ? { name: baseName } : {});
  if (!result.ok) {
    throw new Error(result.error);
  }

  h.documentStore.replaceDocument(result.value.project);
  h.setStorage({ kind: 'unsaved' });
  h.setContext({ kind: 'local-fresh' });
  return { fileName: pick.fileName, diagnostics: result.value.diagnostics };
}

// --- Save ----------------------------------------------------------------

/**
 * Save to the current sticky storage. If unsaved, falls through to
 * saveAsToDisk (the most common "I want to save this somewhere" intent for
 * a brand new doc on standalone).
 */
export async function save(h: FileOpsHandles): Promise<void> {
  const storage = h.getStorage();
  const doc = h.documentStore.getState();

  switch (storage.kind) {
    case 'unsaved':
      await saveAsToDisk(h);
      return;
    case 'disk':
      if (storage.handle) {
        const res = await writeToHandle(storage.handle, doc);
        h.setStorage({
          kind: 'disk',
          handle: res.handle,
          filename: res.filename,
          lastSavedAt: res.savedAt,
        });
      } else {
        // Fallback path (no FSA API) — Save always re-prompts because we
        // can't write back to a known location.
        await saveAsToDisk(h);
      }
      return;
    case 'cloud':
      // Cloud saves go through the autosave scheduler in the existing
      // pipeline (it knows to PUT /document). Trigger an immediate flush.
      await h.scheduler.flushNow();
      return;
  }
}

// --- Save As -------------------------------------------------------------

export async function saveAsToDisk(h: FileOpsHandles): Promise<void> {
  const storage = h.getStorage();
  const doc = h.documentStore.getState();
  const suggested = suggestFilename(storage, doc.metadata.name);

  const res = await saveFileAs(doc, suggested);
  if (!res) return; // user cancelled

  h.setStorage({
    kind: 'disk',
    handle: res.handle,
    filename: res.filename,
    lastSavedAt: res.savedAt,
  });
  h.setContext({ kind: 'local-stored', localId: `disk-${res.filename}` });
}

/**
 * Save the current doc as a NEW cloud project. Used for the
 * "migrate this local doc to my account" flow.
 *
 * `name` is the project name the user picked in the Save-As dialog (may
 * differ from doc.metadata.name). It's used both to create the cloud
 * project AND to update the in-memory doc metadata so the editor reflects
 * the new identity.
 *
 * Returns the new projectId+slug, or null if creation failed.
 */
export async function saveAsNewCloudProject(
  h: FileOpsHandles,
  name: string,
  createProject: (name: string) => Promise<{ id: string; slug: string }>,
): Promise<{ id: string; slug: string } | null> {
  const safeName = name.trim() || 'Untitled';
  try {
    const created = await createProject(safeName);
    // Update the in-memory doc's metadata so subsequent saves and the
    // editor's title bar reflect the new name.
    const doc = h.documentStore.getState();
    const renamedDoc =
      doc.metadata.name === safeName
        ? doc
        : { ...doc, metadata: { ...doc.metadata, name: safeName } };
    if (renamedDoc !== doc) {
      h.documentStore.replaceDocument(renamedDoc);
    }
    await saveCloudProject(created.id, renamedDoc);
    h.setStorage({ kind: 'cloud', projectId: created.id, slug: created.slug });
    h.setContext({
      kind: 'cloud',
      cloudProjectId: created.id,
      localId: `cloud-mirror-${created.id}`,
    });
    return created;
  } catch (err) {
    console.error('[fileOps] saveAsNewCloudProject failed', err);
    return null;
  }
}

// --- Helpers -------------------------------------------------------------

/**
 * Prompt the user before discarding in-memory work. Routes through the
 * caller-provided React confirm modal — no system dialog.
 *
 * Conservative: always asks for now. A future revision can check the
 * scheduler's status — if it's 'saved' (no pending changes) and we're on a
 * disk doc, skip the prompt.
 */
async function confirmDiscardUnsavedChanges(h: FileOpsHandles): Promise<boolean> {
  // Skip the prompt for a clean unsaved doc on first boot — nothing to lose.
  if (
    h.getStorage().kind === 'unsaved' &&
    h.scheduler.getStatus().kind === 'idle'
  ) {
    return true;
  }
  return h.confirm({
    title: 'Discard current document?',
    message:
      'Unsaved changes in the current document will be lost. Make sure you saved it first if you want to keep them.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
    tone: 'danger',
  });
}

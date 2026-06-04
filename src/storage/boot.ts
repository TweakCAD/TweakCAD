/**
 * Boot-time storage resolution.
 *
 * Single-document editor: decides what document is open when the editor
 * boots, and what its `DocumentStorage` is (where Save writes back to).
 *
 * Order of precedence:
 *   1. ?project=ID in URL + SaaS available + signed in → load from cloud
 *   2. ?project=ID in URL + SaaS unavailable → fall back to local mirror if
 *      one exists; otherwise start blank with a warning surfaced to the UI
 *   3. ?project=ID in URL + SaaS available + signed out → still try the
 *      local mirror; the UI will offer a sign-in prompt to resync
 *   4. No URL hint → restore the previously-open doc from IDB (crash
 *      recovery / "pick up where you left off")
 *   5. No URL hint and no IDB record → blank default doc, kind 'unsaved'
 *
 * The previous version redirected to /login on (3); that breaks standalone
 * use, where /login doesn't exist. We never redirect anymore — the editor
 * decides what to show and lets the user act.
 */
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';
import { localStore, inferStorage, type StorageSnapshot } from './localStore.ts';
import { loadCloudProject } from './cloudAdapter.ts';
import { probeSaas, isSignedIn } from './saasState.ts';
import { projectIdFromUrl, type ProjectContext } from './context.ts';
import type { DocumentStorage } from './documentStorage.ts';

export type BootResolution = {
  doc: CadProject;
  context: ProjectContext;
  storage: DocumentStorage;
  source: 'cloud' | 'local-mirror' | 'local-only' | 'default';
  /** Non-fatal warning to surface in the UI (e.g. "SaaS offline, opened local copy"). */
  warning?: string;
  /**
   * True when the boot resolved to a doc autosaved during a previous
   * session whose origin was a disk file. The original file handle is
   * gone (browsers don't preserve permission grants across sessions), so
   * the UI should prompt the user to re-attach via File → Open, or
   * Save As to a new file.
   */
  recoveredFromAutosave?: boolean;
  /** When recoveredFromAutosave, the original filename for the toast. */
  recoveredFilename?: string;
};

export async function resolveInitialProject(
  defaultDoc: CadProject,
): Promise<BootResolution> {
  const cloudProjectId = projectIdFromUrl();

  if (cloudProjectId) {
    return resolveCloudIdBoot(cloudProjectId, defaultDoc);
  }

  // No URL hint — try most recent local IDB record (crash recovery).
  const recent = await localStore.mostRecent();
  if (recent) {
    const snap = inferStorage(recent);
    const storage = snapshotToStorage(snap);
    const recoveredFromAutosave = snap.kind === 'disk';
    return {
      doc: recent.doc,
      context: contextFromStorage(storage, recent.id),
      storage,
      source: 'local-only',
      ...(recoveredFromAutosave
        ? { recoveredFromAutosave: true, recoveredFilename: snap.filename }
        : {}),
    };
  }
  return {
    doc: defaultDoc,
    context: { kind: 'local-fresh' },
    storage: { kind: 'unsaved' },
    source: 'default',
  };
}

/**
 * Build a fresh DocumentStorage from a persisted StorageSnapshot. The
 * snapshot omits the FileSystemFileHandle, so disk-backed docs come back
 * with `handle: null` — the user must re-Open the original file to
 * re-attach for in-place saves.
 */
function snapshotToStorage(snap: StorageSnapshot): DocumentStorage {
  switch (snap.kind) {
    case 'unsaved':
      return { kind: 'unsaved' };
    case 'disk':
      return { kind: 'disk', handle: null, filename: snap.filename, lastSavedAt: snap.lastSavedAt };
    case 'cloud':
      return { kind: 'cloud', projectId: snap.projectId, slug: snap.slug };
  }
}

function contextFromStorage(storage: DocumentStorage, localId: string): ProjectContext {
  if (storage.kind === 'cloud') {
    return {
      kind: 'cloud',
      cloudProjectId: storage.projectId,
      localId: `cloud-mirror-${storage.projectId}`,
    };
  }
  // disk + unsaved both route autosaves to IDB only.
  return { kind: 'local-stored', localId };
}

async function resolveCloudIdBoot(
  cloudProjectId: string,
  defaultDoc: CadProject,
): Promise<BootResolution> {
  const saas = await probeSaas();

  // Case A: SaaS unavailable. ?project=ID is moot in standalone mode —
  // try local mirror; if absent, start blank with a warning.
  if (saas.kind === 'unavailable') {
    const mirror = await localStore.getByCloudProjectId(cloudProjectId);
    if (mirror) {
      return {
        doc: mirror.doc,
        context: { kind: 'local-stored', localId: mirror.id },
        storage: { kind: 'unsaved' }, // can't write back to cloud while SaaS is down
        source: 'local-mirror',
        warning: 'The cloud backend is unreachable. Opened your local copy — saves will go to disk only.',
      };
    }
    return {
      doc: defaultDoc,
      context: { kind: 'local-fresh' },
      storage: { kind: 'unsaved' },
      source: 'default',
      warning: 'The cloud backend is unreachable and no local copy was found for that project.',
    };
  }

  // Case B: SaaS available but signed out. Open the mirror if any; the UI
  // surfaces a "Sign in to sync" prompt.
  if (saas.kind === 'available' && !saas.signedIn) {
    const mirror = await localStore.getByCloudProjectId(cloudProjectId);
    if (mirror) {
      return {
        doc: mirror.doc,
        context: { kind: 'local-stored', localId: mirror.id },
        storage: { kind: 'unsaved' },
        source: 'local-mirror',
        warning: 'Sign in to sync this project with the cloud.',
      };
    }
    return {
      doc: defaultDoc,
      context: { kind: 'local-fresh' },
      storage: { kind: 'unsaved' },
      source: 'default',
      warning: 'Sign in to open this cloud project.',
    };
  }

  // Case C: signed in — try cloud, fall back to mirror on network error.
  if (isSignedIn(saas)) {
    try {
      const result = await loadCloudProject(cloudProjectId);
      const localId = `cloud-mirror-${cloudProjectId}`;
      const projectName = result?.name ?? cloudProjectId;
      const storage: DocumentStorage = {
        kind: 'cloud',
        projectId: cloudProjectId,
        slug: projectName,
      };
      if (result?.doc) {
        return {
          doc: result.doc,
          context: { kind: 'cloud', cloudProjectId, localId },
          storage,
          source: 'cloud',
        };
      }
      // Fresh cloud project with no doc yet — start blank, will save on first edit.
      return {
        doc: {
          ...defaultDoc,
          metadata: { ...defaultDoc.metadata, name: projectName },
        },
        context: { kind: 'cloud', cloudProjectId, localId },
        storage,
        source: 'cloud',
      };
    } catch (err) {
      console.warn('[boot] cloud load failed, falling back to local mirror', err);
      const mirror = await localStore.getByCloudProjectId(cloudProjectId);
      if (mirror) {
        return {
          doc: mirror.doc,
          context: { kind: 'cloud', cloudProjectId, localId: mirror.id },
          storage: { kind: 'cloud', projectId: cloudProjectId, slug: mirror.name },
          source: 'local-mirror',
          warning: 'Cloud load failed; opened your local copy. Will retry on save.',
        };
      }
      const localId = `cloud-mirror-${cloudProjectId}`;
      return {
        doc: defaultDoc,
        context: { kind: 'cloud', cloudProjectId, localId },
        storage: { kind: 'cloud', projectId: cloudProjectId, slug: cloudProjectId },
        source: 'cloud',
        warning: 'Cloud load failed and no local copy was found. Starting blank.',
      };
    }
  }

  // Defensive — `saas.kind === 'unknown'` shouldn't happen because we await
  // probeSaas() above, but handle it gracefully.
  return {
    doc: defaultDoc,
    context: { kind: 'local-fresh' },
    storage: { kind: 'unsaved' },
    source: 'default',
  };
}

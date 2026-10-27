/**
 * Thin wrapper around CloudStorageProvider for save/load of CadProject docs.
 *
 * The SaaS API expects multipart .cadjson uploads and serves .cadjson via
 * signed URLs. This adapter handles the (de)serialization.
 *
 * Cloud saves also capture a thumbnail snapshot of the current viewport
 * (when a viewport is mounted — `captureThumbnail` is a no-op in headless
 * contexts) so /models cards have something to show.
 */
import { CloudStorageProvider } from '@tweakcad/cloud-providers';
import type { CadProject } from '@tweakcad/core/src/document/schema.ts';
import { captureThumbnail } from './thumbnailCapture.ts';
import { loadCadDocumentOrThrow } from '@tweakcad/core/src/document/loader.ts';
export { CloudConflictError } from '@tweakcad/cloud-providers';

let cached: CloudStorageProvider | null = null;

function client(): CloudStorageProvider {
  if (cached) return cached;
  cached = new CloudStorageProvider({ baseUrl: '' }); // same-origin
  return cached;
}

/**
 * The etag of the live cloud document, per project.
 *
 * Seeded by `loadCloudProject` and advanced by every successful autosave, so
 * each write states which version it is replacing. Without it the server
 * cannot tell a normal save from one made against a document another tab
 * already moved, and last-write-wins silently discards the other tab's work.
 *
 * Module-level rather than threaded through `AutosaveScheduler`: the etag is
 * a property of the server's copy, not of any one editing session, and the
 * scheduler has no business knowing about HTTP preconditions.
 */
const liveEtags = new Map<string, string>();

export type CloudLoadResult = {
  name: string;
  doc: CadProject;
  etag: string | null;
};

export async function loadCloudProject(projectId: string): Promise<CloudLoadResult | null> {
  const result = await client().load(projectId);
  if (!result.downloadUrl) {
    // Fresh project — server has no document yet. Caller falls back to a
    // blank doc.
    return { name: result.project.name, doc: null as unknown as CadProject, etag: null };
  }
  const res = await fetch(result.downloadUrl, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Cloud document fetch failed: ${res.status}`);
  // Validated, not cast. This was `(await res.json()) as CadProject` — the
  // least-checked path in the app, and the one that loads documents the user
  // did not author, including anything remixed from the public gallery.
  const loaded = loadCadDocumentOrThrow(await res.json());
  for (const d of loaded.diagnostics) {
    console.warn(`[cloud load] ${d.message}`);
  }
  // Seed the precondition for subsequent saves. Everything loaded here is
  // what the server currently holds, so this etag is what our first write
  // claims to be replacing.
  if (result.etag) liveEtags.set(projectId, result.etag);
  return { name: result.project.name, doc: loaded.project, etag: result.etag };
}


/** Forget a project's etag — after a conflict, so the next save is unconditional. */
export function clearCloudEtag(projectId: string): void {
  liveEtags.delete(projectId);
}

/**
 * Autosave the document. Overwrites the live copy and creates **no** version;
 * see {@link createCloudVersion}.
 *
 * Throws `CloudConflictError` when the project moved under us. The caller
 * decides what that means — the scheduler surfaces it rather than retrying,
 * because retrying is precisely how the other tab's work would be lost.
 */
export async function saveCloudProject(
  projectId: string,
  doc: CadProject,
): Promise<{ etag: string; savedAt: string }> {
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
  const result = await client().save(projectId, blob, {
    ifMatch: liveEtags.get(projectId) ?? null,
  });
  liveEtags.set(projectId, result.etag);
  return result;
}

/**
 * Mint a version from the server's current live document, with a thumbnail.
 *
 * Deliberate save points only — explicit Save, Publish, session end. The
 * thumbnail is captured here and not on autosave: it is a canvas readback,
 * and doing it every two seconds costs frame time for a picture nobody sees
 * until the project is listed.
 */
export async function createCloudVersion(
  projectId: string,
  message?: string,
): Promise<{ versionId: string; createdAt: string }> {
  // Best-effort — a headless context returns null and the version still lands.
  const thumbnail = await captureThumbnail();
  return client().createVersion(projectId, {
    ...(message ? { message } : {}),
    thumbnail,
  });
}

/**
 * Largest document a cloud project may hold — mirrors `MAX_BYTES` on the
 * server's `PUT /projects/{id}/document`.
 *
 * Duplicated rather than fetched because the value is only consulted to warn
 * the user *before* an import, and a warning that needs a round-trip is one
 * that cannot run when the backend is slow or absent. **The server is the
 * enforcement**; this constant only decides when to speak up early. If the two
 * drift, the server wins and the user gets the save-time error this exists to
 * pre-empt — worse, but not wrong.
 *
 * See saas-architecture.md §17 "Storage Tier" for why the line sits here.
 */
export const CLOUD_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Whether adding `addedBytes` to `doc` would put it past the cloud limit.
 *
 * Estimated from the serialized document plus the incoming payload rather
 * than measured, because the point is to answer before the import runs.
 */
export function wouldExceedCloudLimit(doc: CadProject, addedBytes: number): boolean {
  return JSON.stringify(doc).length + addedBytes > CLOUD_DOCUMENT_MAX_BYTES;
}

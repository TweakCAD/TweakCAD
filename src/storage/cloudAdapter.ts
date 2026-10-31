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
  // `downloadUrl` only says a document exists. The bytes come through the app
  // (see `loadDocument`), because the signed URL is cross-origin.
  const { document, etag } = await client().loadDocument(projectId);
  // Validated, not cast: this path also loads documents the user did not
  // author, including anything remixed from the public gallery.
  const loaded = loadCadDocumentOrThrow(document);
  for (const d of loaded.diagnostics) {
    console.warn(`[cloud load] ${d.message}`);
  }
  // Seed the precondition for subsequent saves. Everything loaded here is
  // what the server currently holds, so this etag is what our first write
  // claims to be replacing.
  const liveEtag = etag ?? result.etag;
  if (liveEtag) liveEtags.set(projectId, liveEtag);
  // Pull the imported geometry back in. The document the server holds names
  // its imports but does not carry them; without this the project opens to a
  // body that refuses to build, telling the user to re-link a file they never
  // unlinked.
  const doc = await hydrateReferenceAssets(projectId, loaded.project);
  return { name: result.project.name, doc, etag: liveEtag };
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
  // Imported geometry travels separately and is uploaded first, so the
  // document never refers to bytes the server has not got. Doing it the
  // other way round would leave a window where a reader sees a reference
  // that resolves to nothing.
  const { stripped, assets } = splitReferenceAssets(doc);
  if (assets.length > 0) await uploadReferenceAssets(projectId, assets);
  const blob = new Blob([JSON.stringify(stripped)], { type: 'application/json' });
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

// --- Imported-geometry assets ---------------------------------------------

/**
 * Split a document into what the cloud stores and what travels separately.
 *
 * A `ref` import keeps its bytes in `references[id].bytes` so a document on
 * disk stays one self-contained file. For the cloud that is exactly wrong:
 * the bytes would be re-uploaded on every autosave and copied into every
 * revision. So they are uploaded once, keyed by content hash, and dropped
 * from the document.
 *
 * Returns the stripped document plus the assets to upload — the caller
 * uploads first and saves second, so a document never refers to bytes the
 * server has not got.
 */
export function splitReferenceAssets(doc: CadProject): {
  stripped: CadProject;
  assets: { hash: string; base64: string }[];
} {
  const assets: { hash: string; base64: string }[] = [];
  const references: CadProject['references'] = {};

  for (const [id, asset] of Object.entries(doc.references ?? {})) {
    if (asset.bytes !== undefined) {
      assets.push({ hash: asset.hash, base64: asset.bytes });
    }
    // `bytes` omitted, everything else kept: the entry still describes the
    // file (name, size, hash) so the UI can name it even before the bytes
    // come back. Rebuilt field-by-field rather than destructured, so the
    // omission is a statement rather than an unused binding.
    references[id as keyof typeof references] = {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      sizeBytes: asset.sizeBytes,
      hash: asset.hash,
    };
  }

  return { stripped: { ...doc, references }, assets };
}

/**
 * Hashes this session knows the server already holds, per project.
 *
 * Without it, every autosave re-uploaded every import in full. The bytes are
 * put back into the document by {@link hydrateReferenceAssets} on load, so
 * the next save sees them and offers them again — and the server only
 * discovers it already has them *after* receiving them. A 20 MB import on a
 * two-second debounce meant 20 MB per save, which is the bandwidth cost this
 * whole mechanism exists to remove.
 *
 * Safe to trust because the key IS the content hash: an asset that is there
 * cannot change, and the only thing that removes one is deleting the project
 * it belongs to.
 */
const uploadedAssets = new Map<string, Set<string>>();

function knownAssets(projectId: string): Set<string> {
  let set = uploadedAssets.get(projectId);
  if (!set) { set = new Set(); uploadedAssets.set(projectId, set); }
  return set;
}

/** Upload the assets the server does not already hold. */
async function uploadReferenceAssets(
  projectId: string,
  assets: { hash: string; base64: string }[],
): Promise<void> {
  const known = knownAssets(projectId);
  // Sequential on purpose: the server checks the account's allowance per
  // upload, and parallel uploads could each pass that check and collectively
  // bust it. Rare enough after the skip above that the latency does not
  // matter.
  for (const asset of assets) {
    if (known.has(asset.hash)) continue;
    await client().putReference(projectId, asset.hash, base64ToBytes(asset.base64));
    known.add(asset.hash);
  }
}

/**
 * Fetch the bytes for every reference the document names.
 *
 * Without this a cloud project with a large import opens to a body that
 * refuses to build and a diagnostic telling the user to re-link a file they
 * never unlinked. Failures are left as a missing `bytes` rather than thrown:
 * one unreadable asset should cost one import, not the whole document.
 */
export async function hydrateReferenceAssets(
  projectId: string,
  doc: CadProject,
): Promise<CadProject> {
  const entries = Object.entries(doc.references ?? {});
  if (entries.length === 0) return doc;

  const references = { ...doc.references };
  await Promise.all(entries.map(async ([id, asset]) => {
    if (asset.bytes !== undefined) return;
    try {
      const url = await client().referenceUrl(projectId, asset.hash);
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(String(res.status));
      references[id as keyof typeof references] = {
        ...asset,
        bytes: bytesToBase64(new Uint8Array(await res.arrayBuffer())),
      };
      // Fetching it proves it is there, so the next save can skip it.
      knownAssets(projectId).add(asset.hash);
    } catch {
      console.warn(`[cloud] Could not load imported file "${asset.name}"`);
    }
  }));

  return { ...doc, references };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte array blows
  // the argument limit, which is a crash rather than a slow path.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// --- Revision history -----------------------------------------------------

export type CloudRevision = {
  versionId: string;
  createdAt: string;
  message: string | null;
  sizeBytes: number;
  authorId: string | null;
};

/** One page of a project's revision history, newest first. */
export async function listCloudRevisions(
  projectId: string,
  opts: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<{ items: CloudRevision[]; nextCursor: string | null }> {
  return client().listRevisions(projectId, opts);
}

/** Fetch and parse one revision's document, for a read-only preview. */
export async function loadCloudRevision(
  projectId: string,
  revisionId: string,
): Promise<CadProject> {
  const url = await client().revisionUrl(projectId, revisionId);
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Revision fetch failed: ${res.status}`);
  // Validated like any other document the app opens. A revision written by a
  // newer client can carry a feature this build does not know, and refusing
  // to show it would make the history unusable rather than merely degraded.
  return loadCadDocumentOrThrow(await res.json()).project;
}

/**
 * Restore a revision, and adopt the etag the server hands back.
 *
 * That last part is the whole reason this wrapper exists rather than calling
 * the provider directly. A restore replaces the live document, so the etag
 * this module has cached is immediately stale — and the next autosave would
 * send it as `If-Match` and be rejected. The user would see a conflict the
 * instant after fixing their document, which is the worst possible moment.
 */
export async function restoreCloudRevision(
  projectId: string,
  revisionId: string,
): Promise<{ snapshotVersionId: string }> {
  const result = await client().restoreRevision(projectId, revisionId, {
    ifMatch: liveEtags.get(projectId) ?? null,
  });
  liveEtags.set(projectId, result.etag);
  return { snapshotVersionId: result.snapshotVersionId };
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

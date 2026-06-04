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

let cached: CloudStorageProvider | null = null;

function client(): CloudStorageProvider {
  if (cached) return cached;
  cached = new CloudStorageProvider({ baseUrl: '' }); // same-origin
  return cached;
}

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
  const doc = (await res.json()) as CadProject;
  return { name: result.project.name, doc, etag: result.etag };
}

export async function saveCloudProject(
  projectId: string,
  doc: CadProject,
): Promise<{ versionId: string; etag: string; savedAt: string }> {
  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
  // Capture in parallel with the JSON serialization — they're independent
  // and the snapshot is best-effort (null is fine).
  const thumbnail = await captureThumbnail();
  return client().save(projectId, blob, { thumbnail });
}

/**
 * A document's files (the `assets` table, format spec 13.1) on their way to
 * and from cloud storage.
 *
 * In the editor and on disk every asset carries its bytes inline, so a
 * `.cadjson` file stands alone and the worker can read each stored shape.
 * The cloud keeps each file once, keyed by its content hash, and the document
 * it stores marks those assets `{"external": {}}`: an autosave then sends a
 * few kilobytes instead of every imported file, and every revision points at
 * the same bytes. Opening a cloud document fetches the bytes back in.
 */
import { contentHash } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';

/** One file a document holds inline, to upload before the document that names it. */
export interface AssetUpload {
  hash: string;
  bytes: Uint8Array;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // In chunks: spreading a multi-megabyte array into one call overflows the argument limit.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function assetsOf(doc: Doc): Record<string, Json> {
  const assets = doc.assets;
  return typeof assets === 'object' && assets !== null && !Array.isArray(assets)
    ? (assets as Record<string, Json>)
    : {};
}

function inlineBase64(row: Json): string | null {
  const data = row.data as Json | undefined;
  const inline = data?.inline as Json | undefined;
  return typeof inline?.base64 === 'string' ? inline.base64 : null;
}

/**
 * The document as the cloud stores it: every inline asset marked external,
 * with the bytes to upload first. `doc` is not changed.
 */
export function externalizeAssets(doc: Doc): { doc: Doc; uploads: AssetUpload[] } {
  const uploads: AssetUpload[] = [];
  const assets: Record<string, Json> = {};
  for (const [hash, row] of Object.entries(assetsOf(doc))) {
    const base64 = inlineBase64(row);
    if (base64 === null) {
      assets[hash] = row;
      continue;
    }
    uploads.push({ hash, bytes: base64ToBytes(base64) });
    assets[hash] = { ...row, data: { external: {} } };
  }
  return { doc: { ...doc, assets }, uploads };
}

/**
 * The document with each external asset's bytes put inline, read by
 * `fetchBytes`. A file that cannot be read, or whose bytes do not hash to its
 * key, stays external and is listed in `missing` by name: it costs the
 * features that use it (they pause), not the document.
 */
export async function internalizeAssets(
  doc: Doc,
  fetchBytes: (hash: string) => Promise<Uint8Array>,
): Promise<{ doc: Doc; fetched: string[]; missing: string[] }> {
  const entries = Object.entries(assetsOf(doc));
  const external = entries.filter(
    ([, row]) =>
      inlineBase64(row) === null && typeof row.data === 'object' && row.data !== null && 'external' in row.data,
  );
  if (external.length === 0) return { doc, fetched: [], missing: [] };
  const assets: Record<string, Json> = Object.fromEntries(entries);
  const fetched: string[] = [];
  const missing: string[] = [];
  await Promise.all(
    external.map(async ([hash, row]) => {
      try {
        const bytes = await fetchBytes(hash);
        if (bytes.length !== row.size || contentHash(bytes) !== hash) throw new Error('the bytes do not match');
        assets[hash] = { ...row, data: { inline: { base64: bytesToBase64(bytes) } } };
        fetched.push(hash);
      } catch {
        missing.push(typeof row.name === 'string' && row.name ? row.name : hash);
      }
    }),
  );
  return { doc: { ...doc, assets }, fetched, missing };
}

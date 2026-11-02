/**
 * Where the currently-open document lives.
 *
 * The CAD app is a single-document editor: there's exactly one doc in memory,
 * and `DocumentStorage` says where Ctrl+S writes it back to. This is the
 * "sticky storage" model — `Save` always targets the same destination the
 * doc was opened from (or last Save-As'd to). `Save As` is the only operation
 * that switches storages.
 *
 * Three kinds today, designed to grow:
 *   - unsaved: blank "New" doc, no associated storage yet. Save → prompt Save As.
 *   - disk:    .cadjson file on the user's machine. With FileSystemFileHandle
 *              on Chromium/Firefox, Save writes back to the same path silently.
 *              On Safari (no FSA API), `handle` is null and Save triggers a
 *              download with the stored filename.
 *   - cloud:   a SaaS project. Save calls PUT /api/v1/projects/:id/document.
 *
 * Future kinds (Google Drive, Dropbox, ...) plug in as additional union
 * variants without touching the file-ops abstraction layer.
 */

export type DocumentStorage =
  | { kind: 'unsaved' }
  | {
      kind: 'disk';
      /** FileSystemFileHandle when available; null on browsers without FSA API. */
      handle: FileSystemFileHandle | null;
      filename: string;
      /** ms timestamp of the last successful write-back. Used by crash recovery
       *  to compare against IDB's autosave buffer. */
      lastSavedAt: number | null;
    }
  | {
      kind: 'cloud';
      projectId: string;
      slug: string;
    };

/** Display label for the storage indicator (e.g. "📄 bracket.cadjson"). */
export function storageLabel(s: DocumentStorage): string {
  switch (s.kind) {
    case 'unsaved':
      return 'Unsaved';
    case 'disk':
      return s.filename;
    case 'cloud':
      return s.slug;
  }
}

/** Icon hint for the storage indicator. */
export function storageIcon(s: DocumentStorage): 'page' | 'cloud' | 'pencil' {
  switch (s.kind) {
    case 'unsaved':
      return 'pencil';
    case 'disk':
      return 'page';
    case 'cloud':
      return 'cloud';
  }
}

/** Default filename when going from cloud/unsaved → disk via Save As. */
export function suggestFilename(s: DocumentStorage, docName: string): string {
  if (s.kind === 'disk') return s.filename;
  const safe = docName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'document'}.cadjson`;
}

/**
 * Auto-export flow.
 *
 * Triggered when the editor opens with `?autoExport=1` on a cloud-backed
 * project. Closes the loop between the CAD app's kernel (which knows how
 * to produce STL / STEP / 3MF) and the SaaS layer's published-version
 * attachment storage.
 *
 * Sequence:
 *   1. Resolve the project's current published version via
 *      GET /api/v1/projects/:id/current-version
 *   2. Run the three exports through the existing rebuildScheduler
 *      worker pool (re-builds the part, tessellates, writes the file)
 *   3. PUT each export to
 *      /api/v1/projects/:id/versions/:label/attachments/:format
 *
 * Best-effort: failures in any one format are surfaced via a status
 * callback but don't abort the others. Errors are non-fatal — the user
 * gets feedback through the supplied `onStatus` callback and can
 * re-trigger the action by re-loading the page.
 */
import type { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { exportActivePart } from '../rebuildScheduler.ts';

export type AutoExportFormat = 'stl' | 'step' | '3mf';
export type AutoExportStatus =
  | { kind: 'start'; format: AutoExportFormat }
  | { kind: 'uploaded'; format: AutoExportFormat; sizeBytes: number }
  | { kind: 'failed'; format: AutoExportFormat; message: string }
  | { kind: 'done' };

const MIME: Record<AutoExportFormat, string> = {
  stl: 'model/stl',
  step: 'application/step',
  '3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
};

/** Read `?autoExport=1` from the current URL. */
export function shouldAutoExport(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('autoExport') === '1';
}

/**
 * Run the export+upload sequence. The caller (App.tsx) decides when
 * (typically once the first rebuild completes so the kernel has bodies).
 */
export async function runAutoExport(
  documentStore: DocumentStore,
  cloudProjectId: string,
  onStatus: (s: AutoExportStatus) => void,
): Promise<void> {
  // Look up the current version label.
  const verRes = await fetch(
    `/api/v1/projects/${encodeURIComponent(cloudProjectId)}/current-version`,
    { credentials: 'include' },
  );
  if (!verRes.ok) {
    onStatus({
      kind: 'failed',
      format: 'stl',
      message:
        verRes.status === 404
          ? 'Publish the project before generating downloads.'
          : `Could not resolve current version (HTTP ${verRes.status}).`,
    });
    onStatus({ kind: 'done' });
    return;
  }
  const ver = (await verRes.json()) as { versionLabel: string };
  const label = ver.versionLabel;

  const formats: AutoExportFormat[] = ['stl', 'step', '3mf'];
  for (const format of formats) {
    onStatus({ kind: 'start', format });
    try {
      const ab = await exportActivePart(documentStore, format);
      if (ab.byteLength === 0) {
        onStatus({
          kind: 'failed',
          format,
          message: 'No bodies to export — model is empty?',
        });
        continue;
      }
      // The attachment endpoint takes raw bytes with the right
      // Content-Type — not multipart.
      const res = await fetch(
        `/api/v1/projects/${encodeURIComponent(cloudProjectId)}/versions/${encodeURIComponent(label)}/attachments/${encodeURIComponent(format)}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': MIME[format] },
          body: ab,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        onStatus({
          kind: 'failed',
          format,
          message: `Upload failed (HTTP ${res.status}): ${text.slice(0, 80)}`,
        });
      } else {
        onStatus({ kind: 'uploaded', format, sizeBytes: ab.byteLength });
      }
    } catch (err) {
      onStatus({
        kind: 'failed',
        format,
        message: (err as Error).message,
      });
    }
  }
  onStatus({ kind: 'done' });
}

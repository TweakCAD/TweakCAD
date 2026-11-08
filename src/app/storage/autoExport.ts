/**
 * `?autoExport=1`: once a cloud project opens, export the shown model as
 * STL, STEP and 3MF and attach each file to the project's current published
 * version. The site's publish flow opens the editor this way so a published
 * model offers downloads without the author exporting by hand.
 */
import type { ExportFormat } from '@tweakcad/worker/src/v2/service/types';

export type AutoExportFormat = Extract<ExportFormat, 'stl' | 'step' | '3mf'>;

export const AUTO_EXPORT_FORMATS: readonly AutoExportFormat[] = ['stl', 'step', '3mf'];

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

export function shouldAutoExport(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): boolean {
  return new URLSearchParams(search).get('autoExport') === '1';
}

export interface AutoExportOptions {
  projectId: string;
  /** The shown model as a file; empty when it shows nothing. */
  exportShown: (format: AutoExportFormat) => Promise<Uint8Array>;
  onStatus: (s: AutoExportStatus) => void;
  fetch?: typeof fetch;
}

/** Exports each format and uploads it; reports progress through `onStatus`, ending with `done`. */
export async function runAutoExport(o: AutoExportOptions): Promise<void> {
  const request = o.fetch ?? fetch.bind(globalThis);
  const project = encodeURIComponent(o.projectId);
  const version = await request(`/api/v1/projects/${project}/current-version`, { credentials: 'include' });
  if (!version.ok) {
    o.onStatus({
      kind: 'failed',
      format: 'stl',
      message:
        version.status === 404
          ? 'Publish the project before generating downloads.'
          : `The current version could not be read (HTTP ${version.status}).`,
    });
    o.onStatus({ kind: 'done' });
    return;
  }
  const { versionLabel } = (await version.json()) as { versionLabel: string };
  for (const format of AUTO_EXPORT_FORMATS) {
    o.onStatus({ kind: 'start', format });
    try {
      const bytes = await o.exportShown(format);
      if (bytes.byteLength === 0) {
        o.onStatus({ kind: 'failed', format, message: 'The model has no bodies to export.' });
        continue;
      }
      const res = await request(
        `/api/v1/projects/${project}/versions/${encodeURIComponent(versionLabel)}/attachments/${format}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': MIME[format] },
          body: bytes as BlobPart,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        o.onStatus({ kind: 'failed', format, message: `Upload failed (HTTP ${res.status}): ${text.slice(0, 80)}` });
      } else {
        o.onStatus({ kind: 'uploaded', format, sizeBytes: bytes.byteLength });
      }
    } catch (err) {
      o.onStatus({ kind: 'failed', format, message: err instanceof Error ? err.message : String(err) });
    }
  }
  o.onStatus({ kind: 'done' });
}

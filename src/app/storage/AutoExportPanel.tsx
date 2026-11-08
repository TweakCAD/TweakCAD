/** The floating progress panel of `?autoExport=1`: each format's export and upload, then a summary. */
import { Check, X } from 'lucide-react';
import { AUTO_EXPORT_FORMATS, type AutoExportFormat, type AutoExportStatus } from './autoExport';

export function AutoExportPanel({ statuses, onDismiss }: { statuses: AutoExportStatus[]; onDismiss: () => void }) {
  const done = statuses.some((s) => s.kind === 'done');
  const byFormat = new Map<
    AutoExportFormat,
    { running: boolean; result: 'ok' | 'failed' | null; bytes: number; error?: string }
  >();
  for (const s of statuses) {
    if (s.kind === 'done') continue;
    const cur = byFormat.get(s.format) ?? { running: false, result: null, bytes: 0 };
    if (s.kind === 'start') cur.running = true;
    if (s.kind === 'uploaded') {
      cur.running = false;
      cur.result = 'ok';
      cur.bytes = s.sizeBytes;
    }
    if (s.kind === 'failed') {
      cur.running = false;
      cur.result = 'failed';
      cur.error = s.message;
    }
    byFormat.set(s.format, cur);
  }
  const formats = AUTO_EXPORT_FORMATS;

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 90,
        minWidth: 280,
        maxWidth: 360,
        padding: '12px 14px',
        background: '#ffffff',
        border: '1px solid #d8d8d8',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
        fontFamily: 'inherit',
        fontSize: 12,
        color: '#333',
      }}
      role="status"
      aria-live="polite"
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: '#111' }}>
          {done ? 'Downloads generated' : 'Generating downloads...'}
        </strong>
        {done && (
          <button
            type="button"
            onClick={onDismiss}
            style={{
              display: 'inline-flex',
              padding: 0,
              border: 'none',
              background: 'none',
              color: '#888',
              cursor: 'pointer',
            }}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {formats.map((f) => {
          const s = byFormat.get(f);
          const label = f.toUpperCase();
          if (!s)
            return (
              <li key={f} style={{ color: '#aaa' }}>
                {label}: waiting...
              </li>
            );
          if (s.running) return <li key={f}>{label}: exporting...</li>;
          if (s.result === 'ok') {
            return (
              <li key={f} style={{ color: '#15803d', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Check size={12} />
                {label}: uploaded ({formatBytes(s.bytes)})
              </li>
            );
          }
          return (
            <li key={f} style={{ color: '#b91c1c', display: 'flex', alignItems: 'center', gap: 4 }} title={s.error}>
              <X size={12} />
              {label}: failed
            </li>
          );
        })}
      </ul>
    </div>
  );
}

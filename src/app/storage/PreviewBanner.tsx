/**
 * The strip shown while a revision is previewed: which revision, that it is
 * read-only, and the two ways out. Restore makes it the live document;
 * Close shows the live document again.
 */
import { useState } from 'react';
import { Eye } from 'lucide-react';

interface PreviewBannerProps {
  /** The revision, as the history names it. */
  label: string;
  /** Makes the revision the live document; absent where it cannot be restored. */
  onRestore?: (() => Promise<void>) | undefined;
  onClose: () => void;
}

export function PreviewBanner({ label, onRestore, onClose }: PreviewBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = () => {
    if (!onRestore) return;
    setBusy(true);
    setError(null);
    onRestore()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div style={styles.bar} role="status" aria-label="Revision preview">
      <Eye size={14} color="#92400e" style={{ flexShrink: 0 }} />
      <span style={styles.text}>
        Preview of <b>{label}</b> — read-only
      </span>
      {error && <span style={styles.error}>{error}</span>}
      <div style={{ flex: 1 }} />
      {onRestore && (
        <button
          type="button"
          style={{ ...styles.primary, opacity: busy ? 0.6 : 1 }}
          disabled={busy}
          onClick={restore}
          title="Make this revision the live document"
        >
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      )}
      <button
        type="button"
        style={styles.secondary}
        disabled={busy}
        onClick={onClose}
        title="Show the live document again"
      >
        Close
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    background: '#fef3c7',
    borderBottom: '1px solid #f59e0b',
    color: '#78350f',
    fontSize: 12,
  },
  text: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  error: { color: '#b91c1c', marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  primary: {
    height: 26,
    padding: '0 14px',
    border: 'none',
    borderRadius: 5,
    background: '#3b82f6',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondary: {
    height: 26,
    padding: '0 12px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    background: '#fff',
    color: '#555',
    fontSize: 12,
    cursor: 'pointer',
  },
};

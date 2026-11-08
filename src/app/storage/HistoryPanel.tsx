/**
 * HistoryPanel — the project's revisions, and the way back to one.
 *
 * Grouped under collapsible date headers rather than paginated flat. Nothing
 * prunes revisions, so a long-lived project accumulates hundreds; a flat list
 * of "14:32, 14:28, 14:19…" is technically complete and useless to read.
 * Dates are how people actually remember when they broke something.
 *
 * Two steps, not one: select a revision to preview it read-only, then
 * restore. Restore is what people reach for when something has gone wrong,
 * and committing to it from a list of timestamps is a guess. Closing the
 * panel ends the preview.
 */

import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Eye } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader.tsx';
import type { CloudRevision } from './cloud';

interface HistoryPanelProps {
  /** Loads a page of history. */
  list: (cursor?: string) => Promise<{ items: CloudRevision[]; nextCursor: string | null }>;
  /** Opens a revision read-only in the editor, named by `label`. */
  onPreview: (revisionId: string, label: string) => Promise<void>;
  /** The revision previewed now, if any. */
  previewing?: string | null | undefined;
  /** Makes a revision live. Resolves once the document has been replaced. */
  onRestore: (revisionId: string) => Promise<void>;
  onClose: () => void;
}

/** Local calendar day, so "today" means the user's today. */
export function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** How a revision is named outside the list: its day and time, and its message when it has one. */
export function revisionLabel(rev: CloudRevision): string {
  const when = `${dayKey(rev.createdAt)} ${timeOf(rev.createdAt)}`;
  return rev.message ? `${rev.message} (${when})` : when;
}

export function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Revisions under date headers, newest day first.
 *
 * Relies on the server's newest-first ordering rather than sorting again:
 * two orderings of the same list are two things to keep agreeing, and the
 * cursor pagination already depends on that order being stable.
 */
export function groupByDay(items: CloudRevision[]): { day: string; revisions: CloudRevision[] }[] {
  const groups: { day: string; revisions: CloudRevision[] }[] = [];
  for (const item of items) {
    const day = dayKey(item.createdAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.revisions.push(item);
    else groups.push({ day, revisions: [item] });
  }
  return groups;
}

export function HistoryPanel({ list, onPreview, previewing, onRestore, onClose }: HistoryPanelProps) {
  const [items, setItems] = useState<CloudRevision[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void list()
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message || 'Could not load history');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [list]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy]);

  const loadMore = useCallback(() => {
    if (!cursor) return;
    setLoading(true);
    void list(cursor)
      .then((page) => {
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message || 'Could not load more');
        setLoading(false);
      });
  }, [cursor, list]);

  const act = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message || 'That did not work');
    } finally {
      setBusy(false);
    }
  }, []);

  const groups = groupByDay(items);

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader
          title="History"
          icon={<RotateCcw size={14} color="#0d9488" />}
          onClose={onClose}
          closeTitle="Close (Esc)"
        />

        <div style={styles.list}>
          {loading && items.length === 0 && <div style={styles.hint}>Loading…</div>}
          {!loading && items.length === 0 && !error && (
            <div style={styles.hint}>No history yet. Saving the project keeps a restorable copy.</div>
          )}

          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.day);
            return (
              <section key={group.day}>
                <button
                  type="button"
                  style={styles.dayHeader}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.day)) next.delete(group.day);
                      else next.add(group.day);
                      return next;
                    })
                  }
                >
                  <span>{isCollapsed ? '▸' : '▾'}</span>
                  <span style={styles.dayLabel}>{group.day}</span>
                  <span style={styles.dayCount}>{group.revisions.length}</span>
                </button>
                {!isCollapsed &&
                  group.revisions.map((rev) => (
                    <button
                      key={rev.versionId}
                      type="button"
                      style={{
                        ...styles.revision,
                        background: selected === rev.versionId ? '#e3effb' : 'transparent',
                      }}
                      onClick={() => setSelected(rev.versionId)}
                    >
                      <span style={styles.revTime}>{timeOf(rev.createdAt)}</span>
                      <span style={styles.revMessage} title={rev.message ?? ''}>
                        {rev.message || <em style={styles.unnamed}>unnamed</em>}
                      </span>
                      {previewing === rev.versionId && (
                        <Eye
                          size={11}
                          color="#92400e"
                          aria-label="Previewed"
                          style={{ flexShrink: 0, alignSelf: 'center' }}
                        />
                      )}
                      <span style={styles.revSize}>{sizeOf(rev.sizeBytes)}</span>
                    </button>
                  ))}
              </section>
            );
          })}

          {cursor && (
            <button type="button" style={styles.more} onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Older…'}
            </button>
          )}
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.actions}>
          <button
            type="button"
            style={{ ...styles.secondaryBtn, opacity: selected && !busy ? 1 : 0.5 }}
            disabled={!selected || busy}
            onClick={() => {
              const rev = items.find((r) => r.versionId === selected);
              if (rev) void act(() => onPreview(rev.versionId, revisionLabel(rev)));
            }}
            title="Open this revision read-only"
          >
            <Eye size={12} /> Preview
          </button>
          <button
            type="button"
            style={{ ...styles.primaryBtn, opacity: selected && !busy ? 1 : 0.5 }}
            disabled={!selected || busy}
            onClick={() => selected && void act(() => onRestore(selected))}
            title="Make this revision the live document"
          >
            {busy ? 'Working…' : 'Restore'}
          </button>
        </div>
        <div style={styles.footnote}>Restoring keeps your current work as a new entry, so you can come back.</div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', top: 12, right: 12, zIndex: 50, pointerEvents: 'auto' },
  panel: {
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    width: 320,
    overflow: 'hidden',
  },
  list: { maxHeight: 320, overflowY: 'auto', padding: '4px 0' },
  hint: { fontSize: 12, color: '#999', fontStyle: 'italic', padding: '8px 12px' },
  dayHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '6px 12px',
    border: 'none',
    background: '#fafafa',
    borderTop: '1px solid #f0f0f0',
    borderBottom: '1px solid #f0f0f0',
    cursor: 'pointer',
    fontSize: 11,
    color: '#666',
    textAlign: 'left',
  },
  dayLabel: { flex: 1, fontWeight: 600 },
  dayCount: { color: '#aaa' },
  revision: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    width: '100%',
    padding: '5px 12px 5px 24px',
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    textAlign: 'left',
  },
  revTime: { fontFamily: 'monospace', color: '#555', flexShrink: 0 },
  revMessage: {
    flex: 1,
    color: '#333',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  unnamed: { color: '#bbb' },
  revSize: { color: '#aaa', fontSize: 10, flexShrink: 0 },
  more: {
    width: '100%',
    padding: '6px 12px',
    border: 'none',
    background: 'transparent',
    color: '#1a6fd1',
    fontSize: 11,
    cursor: 'pointer',
  },
  error: { fontSize: 11, color: '#dc2626', padding: '4px 12px' },
  actions: {
    display: 'flex',
    gap: 8,
    padding: '8px 12px 4px',
    justifyContent: 'flex-end',
    borderTop: '1px solid #e8e8e8',
  },
  secondaryBtn: {
    height: 28,
    padding: '0 12px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    background: '#f5f5f5',
    color: '#555',
    fontSize: 12,
    cursor: 'pointer',
  },
  primaryBtn: {
    height: 28,
    padding: '0 16px',
    border: 'none',
    borderRadius: 5,
    background: '#3b82f6',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  footnote: { fontSize: 10, color: '#999', padding: '0 12px 10px', textAlign: 'right' },
};

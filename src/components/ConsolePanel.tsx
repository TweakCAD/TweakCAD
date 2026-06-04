/**
 * ConsolePanel - Bottom collapsible console.
 *
 * Features:
 *   - Collapsible via header click
 *   - Log levels: info, warn, error, success
 *   - Timestamped entries
 *   - Clear button
 *   - Auto-scroll to bottom on new messages
 */

import { useRef, useEffect } from 'react';
import {
  ChevronUp,
  ChevronDown,
  Trash2,
  Terminal,
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  Info,
} from 'lucide-react';
import type { LogLevel, ConsoleEntry } from '@tweakcad/core/src/store/consoleStore.ts';

// ---- Helpers ----

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const levelConfig: Record<LogLevel, { color: string; bg: string; icon: React.ReactNode }> = {
  info:    { color: '#666', bg: 'transparent', icon: <Info size={12} /> },
  warn:    { color: '#b45309', bg: '#fffbeb', icon: <AlertTriangle size={12} /> },
  error:   { color: '#dc2626', bg: '#fef2f2', icon: <AlertCircle size={12} /> },
  success: { color: '#16a34a', bg: '#f0fdf4', icon: <CheckCircle size={12} /> },
};

// ---- Types ----

interface ConsolePanelProps {
  entries: ConsoleEntry[];
  collapsed: boolean;
  onToggle: () => void;
  onClear: () => void;
}

// ---- Component ----

export function ConsolePanel({ entries, collapsed, onToggle, onClear }: ConsolePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new entries
  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, collapsed]);

  const errorCount = entries.filter(e => e.level === 'error').length;
  const warnCount = entries.filter(e => e.level === 'warn').length;

  return (
    <div style={{
      ...styles.root,
      height: collapsed ? 28 : 160,
    }}>
      {/* Header bar */}
      <button
        style={styles.header}
        onClick={onToggle}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#eaeaea'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0'; }}
      >
        <Terminal size={12} style={{ color: '#888' }} />
        <span style={styles.headerTitle}>Console</span>

        {/* Status badges */}
        {errorCount > 0 && (
          <span style={{ ...styles.statusBadge, color: '#dc2626', background: '#fef2f2' }}>
            {errorCount} error{errorCount > 1 ? 's' : ''}
          </span>
        )}
        {warnCount > 0 && (
          <span style={{ ...styles.statusBadge, color: '#b45309', background: '#fffbeb' }}>
            {warnCount} warning{warnCount > 1 ? 's' : ''}
          </span>
        )}

        <span style={{ flex: 1 }} />

        {!collapsed && (
          <span
            style={styles.clearBtn}
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            title="Clear console"
            role="button"
            tabIndex={0}
            onMouseEnter={e => { (e.currentTarget as HTMLSpanElement).style.color = '#dc2626'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLSpanElement).style.color = '#999'; }}
          >
            <Trash2 size={12} />
          </span>
        )}

        <span style={styles.collapseIcon}>
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {/* Log entries */}
      {!collapsed && (
        <div ref={scrollRef} style={styles.logArea}>
          {entries.length === 0 && (
            <div style={styles.emptyText}>No console output</div>
          )}

          {entries.map(entry => {
            const cfg = levelConfig[entry.level];
            return (
              <div
                key={entry.id}
                style={{
                  ...styles.logEntry,
                  background: cfg.bg,
                }}
              >
                <span style={{ ...styles.logIcon, color: cfg.color }}>{cfg.icon}</span>
                <span style={styles.logTime}>{formatTime(entry.timestamp)}</span>
                {entry.source && <span style={styles.logSource}>[{entry.source}]</span>}
                <span style={{ ...styles.logMessage, color: cfg.color }}>{entry.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    background: '#fafafa',
    borderTop: '1px solid #d8d8d8',
    transition: 'height 0.15s ease',
    overflow: 'hidden',
    flexShrink: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    padding: '0 10px',
    border: 'none',
    background: '#f0f0f0',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    color: '#666',
    textAlign: 'left',
    width: '100%',
    flexShrink: 0,
    transition: 'background 0.1s',
  },
  headerTitle: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 10,
    color: '#888',
  },
  statusBadge: {
    fontSize: 9,
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: 8,
  },
  clearBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    color: '#999',
    cursor: 'pointer',
    borderRadius: 3,
    transition: 'color 0.1s',
  },
  collapseIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    color: '#aaa',
  },
  logArea: {
    flex: 1,
    overflow: 'auto',
    padding: '2px 0',
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    fontSize: 11,
  },
  logEntry: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    padding: '2px 10px',
    minHeight: 20,
    lineHeight: '18px',
  },
  logIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    marginTop: 3,
  },
  logTime: {
    fontSize: 10,
    color: '#bbb',
    flexShrink: 0,
    marginTop: 1,
  },
  logSource: {
    fontSize: 10,
    color: '#999',
    flexShrink: 0,
    marginTop: 1,
  },
  logMessage: {
    flex: 1,
    wordBreak: 'break-word',
  },
  emptyText: {
    padding: '12px',
    color: '#ccc',
    fontStyle: 'italic',
    textAlign: 'center',
    fontSize: 11,
  },
};

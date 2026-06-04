/**
 * Save status indicator — bottom-right corner pill showing storage origin
 * and current autosave state.
 *
 * Uses inline styles to match the CAD app aesthetic (the rest of the app
 * is CSS-in-JS; no Tailwind here).
 */
import { useEffect, useState } from 'react';
import type {
  AutosaveScheduler,
  SaveStatus as Status,
  ProjectContext,
  DocumentStorage,
  SaasState,
} from '../storage/index.ts';
import { storageLabel } from '../storage/index.ts';

export function SaveStatus({
  scheduler,
  // `context` is retained for symmetry with the autosave scheduler's
  // routing decisions; the indicator itself reads everything from `storage`.
  // Keep the prop so callers don't drift.
  context: _context,
  storage,
  saas,
  onRequestSignIn,
}: {
  scheduler: AutosaveScheduler;
  context: ProjectContext;
  storage: DocumentStorage;
  saas: SaasState;
  /** Open the inline sign-in modal. When omitted, fall back to a /login link. */
  onRequestSignIn?: () => void;
}) {
  const [status, setStatus] = useState<Status>(scheduler.getStatus());
  useEffect(() => scheduler.onStatus(setStatus), [scheduler]);

  const dotBg = dotColor(status, storage);
  const stateText = describe(status, storage);
  const label = storageLabel(storage);
  const pulsing = status.kind === 'saving';

  const showSignIn =
    saas.kind === 'available' && !saas.signedIn && storage.kind !== 'cloud';

  return (
    <div style={styles.row}>
      <span style={styles.group}>
        <span
          style={{
            ...styles.dot,
            background: dotBg,
            ...(pulsing ? { animation: 'cad-save-pulse 1.2s ease-in-out infinite' } : {}),
          }}
        />
        <Icon storage={storage} />
        <span style={styles.label}>{label}</span>
        <span style={styles.separator}>·</span>
        <span style={styles.state}>{stateText}</span>
      </span>
      {showSignIn &&
        (onRequestSignIn ? (
          <button
            type="button"
            onClick={onRequestSignIn}
            style={{ ...styles.signInLink, cursor: 'pointer' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#f5f5f5';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#ffffff';
            }}
          >
            Sign in to sync
          </button>
        ) : (
          <a
            href="/login?return_to=/cad"
            style={styles.signInLink}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = '#f5f5f5';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = '#ffffff';
            }}
          >
            Sign in to sync
          </a>
        ))}
      {/* Pulse keyframes injected once per mount via a sibling style tag. */}
      <style>{KEYFRAMES}</style>
    </div>
  );
}

function describe(status: Status, storage: DocumentStorage): string {
  switch (status.kind) {
    case 'idle':
      return storage.kind === 'unsaved' ? 'no changes' : 'idle';
    case 'saving':
      return 'saving…';
    case 'saved':
      return 'saved';
    case 'offline':
      return `offline (${status.queued} queued)`;
    case 'error':
      return `error: ${status.message}`;
  }
}

function dotColor(status: Status, storage: DocumentStorage): string {
  if (status.kind === 'saving') return '#f59e0b'; // amber
  if (status.kind === 'offline') return '#f59e0b';
  if (status.kind === 'error') return '#dc2626'; // red
  if (status.kind === 'saved') {
    return storage.kind === 'cloud' ? '#10b981' /* emerald */ : '#0ea5e9' /* sky */;
  }
  // idle
  return storage.kind === 'unsaved' ? '#d4d4d4' : '#a3a3a3';
}

function Icon({ storage }: { storage: DocumentStorage }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: '0 0 16 16',
    fill: 'none' as const,
    stroke: '#666',
    strokeWidth: 1.5,
  };
  if (storage.kind === 'cloud') {
    return (
      <svg {...common}>
        <path d="M4 12.5h7a3.5 3.5 0 0 0 .3-6.99A4.5 4.5 0 0 0 3.05 7.5 3 3 0 0 0 4 12.5z" />
      </svg>
    );
  }
  if (storage.kind === 'disk') {
    return (
      <svg {...common}>
        <path d="M3 1.5h6l4 4V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5z" />
        <path d="M9 1.5V5h4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M11 2l3 3-8.5 8.5L2 14l.5-3.5L11 2z" />
    </svg>
  );
}

const KEYFRAMES = `@keyframes cad-save-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}`;

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '4px 10px',
    fontSize: 11,
    color: '#666',
  },
  group: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  label: {
    fontWeight: 500,
    color: '#333',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  separator: {
    color: '#bbb',
  },
  state: {
    color: '#777',
  },
  signInLink: {
    padding: '2px 8px',
    fontSize: 11,
    color: '#333',
    background: '#ffffff',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    textDecoration: 'none',
    transition: 'background 0.12s',
    fontFamily: 'inherit',
    lineHeight: 1.5,
  },
};

/**
 * The bottom-right pill: where the document saves to, the state of its last
 * write, and, signed out against a live site, a way to sign in.
 */
import { useEffect, useState } from 'react';
import type { SaasState } from '../storage/saasState.ts';
import { useDocument, useSlice } from './hooks';
import type { AppServices } from './services';
import type { AutosaveStatus } from './storage/autosave';
import type { DocumentStorage } from './storage/session';

export function SaveStatusPill({
  services,
  saas,
  onRequestSignIn,
}: {
  services: AppServices;
  saas: SaasState;
  onRequestSignIn: () => void;
}) {
  const storage = useSlice(services.session.state, (s) => s.storage);
  // A cloud project is named by its document; a rename here is sent to the site with the next save.
  const docName = (useDocument(services.editor).metadata as { name?: unknown }).name;
  const [status, setStatus] = useState<AutosaveStatus>(services.autosave.getStatus());
  useEffect(() => services.autosave.onStatus(setStatus), [services.autosave]);
  const showSignIn = saas.kind === 'available' && !saas.signedIn && storage.kind !== 'cloud';
  return (
    <div style={styles.container}>
      <div style={styles.row}>
        <span style={styles.group}>
          <span
            style={{
              ...styles.dot,
              background: dotColor(status, storage),
              ...(status.kind === 'saving' ? { animation: 'cad-save-pulse 1.2s ease-in-out infinite' } : {}),
            }}
          />
          <Icon storage={storage} />
          <span style={styles.label}>
            {storage.kind === 'cloud' && typeof docName === 'string' && docName ? docName : label(storage)}
          </span>
          <span style={styles.separator}>·</span>
          <span style={styles.state}>{describe(status, storage)}</span>
        </span>
        {showSignIn && (
          <button
            type="button"
            onClick={onRequestSignIn}
            style={styles.signIn}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f5f5')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#ffffff')}
          >
            Sign in to sync
          </button>
        )}
        <style>{KEYFRAMES}</style>
      </div>
    </div>
  );
}

function label(storage: DocumentStorage): string {
  switch (storage.kind) {
    case 'disk':
      return storage.filename;
    case 'cloud':
      return storage.name;
    default:
      return 'Unsaved';
  }
}

export function describe(status: AutosaveStatus, storage: DocumentStorage): string {
  switch (status.kind) {
    case 'idle':
      // Nothing edited since the document was opened: a cloud project is as the site has it.
      return storage.kind === 'cloud' ? 'saved' : 'no changes';
    case 'saving':
      return 'saving...';
    case 'saved':
      return storage.kind === 'cloud' ? 'saved' : 'saved in this browser';
    case 'offline':
      return `offline (${status.queued} queued)`;
    case 'conflict':
      // The work is safe in the working copy; what is needed is a decision, not a retry.
      return 'changed elsewhere, reload before saving';
    case 'error':
      return `error: ${status.message}`;
  }
}

function dotColor(status: AutosaveStatus, storage: DocumentStorage): string {
  if (status.kind === 'saving' || status.kind === 'offline') return '#f59e0b';
  if (status.kind === 'error' || status.kind === 'conflict') return '#dc2626';
  if (status.kind === 'saved') return storage.kind === 'cloud' ? '#10b981' : '#0ea5e9';
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
  container: {
    position: 'fixed',
    bottom: 8,
    right: 8,
    zIndex: 50,
    borderRadius: 6,
    border: '1px solid #e5e5e5',
    background: 'rgba(255, 255, 255, 0.9)',
    backdropFilter: 'blur(4px)',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '4px 10px', fontSize: 11, color: '#666' },
  group: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  label: {
    fontWeight: 500,
    color: '#333',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  separator: { color: '#bbb' },
  state: { color: '#777' },
  signIn: {
    padding: '2px 8px',
    fontSize: 11,
    color: '#333',
    background: '#ffffff',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    cursor: 'pointer',
    transition: 'background 0.12s',
    fontFamily: 'inherit',
    lineHeight: 1.5,
  },
};

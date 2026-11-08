/**
 * Save-As destination picker.
 *
 * Two destinations today; designed to grow:
 *   - Local file (.cadjson on disk) — always available
 *   - Cloud (new project in user's account) — only when SaaS is reachable
 *     and the user is signed in
 *
 * The cloud row uses progressive disclosure: clicking it expands an inline
 * "Project name" input rather than chaining into a second modal. Less UI
 * jank, fewer state transitions.
 *
 * Inline styles to match the rest of the app.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SaasState } from '../../storage/saasState.ts';
import { generateProjectName, UNTITLED } from '../../storage/projectName.ts';

export type SaveAsPickerProps = {
  open: boolean;
  /** Currently-open document name; pre-fills the cloud project name input. */
  docName: string;
  saas: SaasState;
  onClose: () => void;
  /** User picked "Local file" — close + run the disk save-as flow. */
  onPickDisk: () => void;
  /** User submitted a cloud project name — caller creates project + uploads. */
  onPickCloud: (projectName: string) => Promise<void> | void;
  /** Open the sign-in modal when SaaS available but signed out. */
  onRequestSignIn: () => void;
  /** A generated name none of the account's projects has, offered for a document not named yet. */
  freshName?: () => Promise<string>;
};

export function SaveAsPicker({
  open,
  docName,
  saas,
  onClose,
  onPickDisk,
  onPickCloud,
  onRequestSignIn,
  freshName,
}: SaveAsPickerProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [expanded, setExpanded] = useState<'cloud' | null>(null);
  const [projectName, setProjectName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      setExpanded(null);
      // A document not named yet goes to the cloud under a generated name, which the field offers:
      // one none of the account's projects has once the list is read, unless the field was edited.
      const named = docName && docName !== UNTITLED;
      const offered = named ? docName : generateProjectName();
      setProjectName(offered);
      if (!named && freshName) {
        void freshName().then(
          (fresh) => setProjectName((current) => (current === offered ? fresh : current)),
          () => {},
        );
      }
      setSubmitting(false);
      setError(null);
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open, docName, freshName]);

  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === e.currentTarget) onClose();
  }
  function onDialogCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onClose();
  }

  async function onCloudSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onPickCloud(projectName.trim() || 'Untitled');
    } catch (err) {
      setError((err as Error).message || 'Failed to save to cloud.');
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  }

  const cloudState =
    saas.kind === 'unavailable' || saas.kind === 'unknown' ? 'hidden' : saas.signedIn ? 'ready' : 'signin';

  return (
    <dialog ref={ref} onClick={onDialogClick} onCancel={onDialogCancel} style={styles.dialog}>
      <div style={styles.body}>
        <div>
          <h2 style={styles.title}>Save a copy as...</h2>
          <p style={styles.subtitle}>Choose where to save the current document.</p>
        </div>

        {/* Local file row */}
        <button
          type="button"
          onClick={() => {
            onClose();
            onPickDisk();
          }}
          style={styles.row}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#f7f7f7';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#ffffff';
          }}
        >
          <DiskIcon />
          <span style={styles.rowText}>
            <span style={styles.rowTitle}>Local file</span>
            <span style={styles.rowDesc}>Save a .cadjson to your computer.</span>
          </span>
        </button>

        {/* Cloud row — three states */}
        {cloudState !== 'hidden' && (
          <div style={styles.cloudGroup}>
            <button
              type="button"
              onClick={() => {
                if (cloudState === 'signin') {
                  onClose();
                  onRequestSignIn();
                  return;
                }
                setExpanded((prev) => (prev === 'cloud' ? null : 'cloud'));
              }}
              style={{
                ...styles.row,
                ...(expanded === 'cloud' ? { background: '#f0f6ff' } : {}),
              }}
              onMouseEnter={(e) => {
                if (expanded !== 'cloud') {
                  (e.currentTarget as HTMLButtonElement).style.background = '#f7f7f7';
                }
              }}
              onMouseLeave={(e) => {
                if (expanded !== 'cloud') {
                  (e.currentTarget as HTMLButtonElement).style.background = '#ffffff';
                }
              }}
            >
              <CloudIcon />
              <span style={styles.rowText}>
                <span style={styles.rowTitle}>Cloud (new project)</span>
                <span style={styles.rowDesc}>
                  {cloudState === 'ready'
                    ? 'Create a project in your account and start syncing.'
                    : 'Sign in to save to your account.'}
                </span>
              </span>
            </button>

            {expanded === 'cloud' && cloudState === 'ready' && (
              <form onSubmit={onCloudSubmit} style={styles.cloudForm}>
                <label style={styles.field}>
                  <span style={styles.fieldLabel}>Project name</span>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    required
                    autoFocus
                    maxLength={200}
                    style={styles.input}
                  />
                </label>
                {error && <div style={styles.error}>{error}</div>}
                <div style={styles.cloudActions}>
                  <button type="button" onClick={() => setExpanded(null)} style={styles.cancelBtn}>
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    style={{
                      ...styles.confirmBtn,
                      opacity: submitting ? 0.5 : 1,
                      cursor: submitting ? 'wait' : 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      if (!submitting) (e.currentTarget as HTMLButtonElement).style.background = '#1557a0';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = '#1a6fd1';
                    }}
                  >
                    {submitting ? 'Creating...' : 'Create & save'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        <div style={styles.footer}>
          <button type="button" onClick={onClose} style={styles.cancelBtn}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}

function DiskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#1a6fd1" strokeWidth="1.5">
      <path d="M3 1.5h6l4 4V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5z" />
      <path d="M9 1.5V5h4" />
    </svg>
  );
}
function CloudIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#10b981" strokeWidth="1.5">
      <path d="M4 12.5h7a3.5 3.5 0 0 0 .3-6.99A4.5 4.5 0 0 0 3.05 7.5 3 3 0 0 0 4 12.5z" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  dialog: {
    inset: 0,
    margin: 'auto',
    width: 'min(92vw, 420px)',
    padding: 0,
    border: 'none',
    borderRadius: 10,
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.2)',
    background: '#ffffff',
    color: '#333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  body: {
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: '#222',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 12,
    color: '#666',
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    width: '100%',
    padding: '10px 12px',
    background: '#ffffff',
    border: '1px solid #e0e0e0',
    borderRadius: 6,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'background 0.12s',
  },
  rowText: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  rowTitle: {
    fontSize: 13,
    fontWeight: 500,
    color: '#222',
  },
  rowDesc: {
    fontSize: 11,
    color: '#777',
    lineHeight: 1.4,
  },
  cloudGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  cloudForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '10px 12px',
    background: '#fafafa',
    border: '1px solid #e5e5e5',
    borderRadius: 6,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: '#555',
  },
  input: {
    width: '100%',
    height: 30,
    padding: '0 10px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    fontSize: 13,
    color: '#333',
    outline: 'none',
    background: '#ffffff',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  error: {
    fontSize: 12,
    color: '#dc2626',
    background: '#fee2e2',
    padding: '5px 8px',
    borderRadius: 4,
    border: '1px solid #fecaca',
  },
  cloudActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 6,
  },
  cancelBtn: {
    padding: '6px 12px',
    fontSize: 12,
    background: '#f5f5f5',
    color: '#333',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  confirmBtn: {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 500,
    background: '#1a6fd1',
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.12s',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    paddingTop: 4,
    borderTop: '1px solid #eee',
  },
};

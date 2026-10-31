/**
 * What a window shows when boot deliberately opened nothing.
 *
 * Two cases, both from `decideBoot`:
 *
 *   **gate** — the backend is up and nobody is signed in. Ask before
 *   opening anything, because at this moment there is no document to lose:
 *   a social sign-in redirects away and back, and the cheapest time for
 *   that round trip is before any work exists.
 *
 *   **choose** — signed in, with no document named in the URL. Offer New,
 *   Open (a cloud project) and Open file rather than guessing. Guessing is
 *   what produced three windows editing one cloud project. Open file exists
 *   so bringing a local file in does not first mint an empty cloud project.
 *
 *   **load-failed** — the URL names a cloud project and it could not be
 *   read. Say so, with the reason. Opening a blank document in its place
 *   would look like the project lost its content, and its first autosave
 *   would make that true.
 *
 * Deliberately not a blank canvas in either case. A blank document invites
 * "I reloaded and lost my work", because a reload would mint a second one
 * rather than return to the first.
 */

import { useState } from 'react';
import { CloudOff, FileUp, FolderOpen, LogIn, Plus, RotateCw } from 'lucide-react';

export type BootGateKind = 'gate' | 'choose' | 'load-failed';

interface BootGateProps {
  kind: BootGateKind;
  /** Open the sign-in modal. */
  onSignIn: () => void;
  /** Remember the choice for this tab and open a local document. */
  onContinueOffline: () => void;
  /** Create a cloud project and open it. */
  onNewProject: () => void;
  /** Open a local .cadjson in this window without creating a project. */
  onOpenFile: () => void;
  /** Try the named project again. */
  onRetry: () => void;
  /** Where the project list lives. The editor does not reimplement it. */
  projectsUrl: string;
  /** Set while a project is being created, so the button can't be re-fired. */
  busy?: boolean;
  /** Surfaced when creating a project or loading one failed. */
  error?: string | null;
}

export function BootGate({
  kind,
  onSignIn,
  onContinueOffline,
  onNewProject,
  onOpenFile,
  onRetry,
  projectsUrl,
  busy = false,
  error = null,
}: BootGateProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const card = (
    <div style={styles.card}>
      {kind === 'load-failed' ? (
        <>
          <h1 style={styles.title}>This project didn't open</h1>
          {error && <p style={styles.body}>{error}</p>}
          <div style={styles.actions}>
            <Action
              icon={<RotateCw size={15} />}
              label="Try again"
              primary
              onClick={onRetry}
              hovered={hovered === 'retry'}
              onHover={(h) => setHovered(h ? 'retry' : null)}
            />
            <Action
              icon={<FolderOpen size={15} />}
              label="Your projects"
              href={projectsUrl}
              hovered={hovered === 'open'}
              onHover={(h) => setHovered(h ? 'open' : null)}
            />
          </div>
        </>
      ) : kind === 'gate' ? (
        <>
          <h1 style={styles.title}>Sign in to save your work</h1>
          <p style={styles.body}>
            Signing in keeps your projects in your account, on any machine.
            You can also work offline — everything stays in this browser.
          </p>
          <div style={styles.actions}>
            <Action
              icon={<LogIn size={15} />}
              label="Sign in"
              primary
              onClick={onSignIn}
              hovered={hovered === 'signin'}
              onHover={(h) => setHovered(h ? 'signin' : null)}
            />
            <Action
              icon={<CloudOff size={15} />}
              label="Continue offline"
              onClick={onContinueOffline}
              hovered={hovered === 'offline'}
              onHover={(h) => setHovered(h ? 'offline' : null)}
            />
          </div>
          <p style={styles.footnote}>
            Working offline stores documents in this browser only. Clearing
            site data removes them.
          </p>
        </>
      ) : (
        <>
          <h1 style={styles.title}>Open a project</h1>
          <p style={styles.body}>
            Pick up where you left off, or start something new. Projects live
            in your account, so this window always knows which one it has.
          </p>
          <div style={styles.actions}>
            <Action
              icon={<Plus size={15} />}
              label={busy ? 'Creating…' : 'New project'}
              primary
              disabled={busy}
              onClick={onNewProject}
              hovered={hovered === 'new'}
              onHover={(h) => setHovered(h ? 'new' : null)}
            />
            <Action
              icon={<FolderOpen size={15} />}
              label="Open…"
              href={projectsUrl}
              hovered={hovered === 'open'}
              onHover={(h) => setHovered(h ? 'open' : null)}
            />
            <Action
              icon={<FileUp size={15} />}
              label="Open file…"
              disabled={busy}
              onClick={onOpenFile}
              hovered={hovered === 'file'}
              onHover={(h) => setHovered(h ? 'file' : null)}
            />
          </div>
          {error && <p style={styles.error}>{error}</p>}
        </>
      )}
    </div>
  );

  return <div style={styles.backdrop}>{card}</div>;
}

function Action({
  icon,
  label,
  onClick,
  href,
  primary = false,
  disabled = false,
  hovered,
  onHover,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
  disabled?: boolean;
  hovered: boolean;
  onHover: (h: boolean) => void;
}) {
  const style: React.CSSProperties = {
    ...styles.action,
    ...(primary ? styles.actionPrimary : {}),
    ...(hovered && !disabled
      ? primary
        ? { background: '#1557a8' }
        : { background: '#f2f2f2' }
      : {}),
    ...(disabled ? { opacity: 0.6, cursor: 'default' } : {}),
  };

  if (href) {
    return (
      <a
        href={href}
        style={style}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
      >
        {icon}
        {label}
      </a>
    );
  }
  return (
    <button
      type="button"
      style={style}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      {icon}
      {label}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#fbfbfb',
    zIndex: 40,
  },
  card: {
    width: 'min(440px, calc(100vw - 48px))',
    background: '#fff',
    border: '1px solid #e2e2e2',
    borderRadius: 8,
    padding: '28px 28px 22px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  title: { margin: '0 0 8px', fontSize: 17, fontWeight: 600, color: '#222' },
  body: { margin: '0 0 20px', fontSize: 13, lineHeight: 1.55, color: '#666' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    flex: 1,
    whiteSpace: 'nowrap',
    padding: '9px 14px',
    fontSize: 13,
    fontWeight: 500,
    color: '#333',
    background: '#fff',
    border: '1px solid #d6d6d6',
    borderRadius: 5,
    cursor: 'pointer',
    textDecoration: 'none',
    fontFamily: 'inherit',
  },
  actionPrimary: { background: '#1a6fd1', borderColor: '#1a6fd1', color: '#fff' },
  footnote: { margin: '16px 0 0', fontSize: 11.5, lineHeight: 1.5, color: '#999' },
  error: { margin: '14px 0 0', fontSize: 12.5, color: '#c0392b' },
};

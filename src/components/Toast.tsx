/**
 * Simple top-of-viewport toast for non-blocking notifications.
 *
 * One toast at a time — caller passes the message and optional action;
 * the toast auto-dismisses after `durationMs` (default 8s) or on the X click.
 *
 * Uses inline styles to match the rest of the app.
 */
import { useEffect, useState } from 'react';

export type ToastTone = 'info' | 'warning' | 'success';

export type ToastProps = {
  /** Stable key — change it to force a re-show after dismiss. */
  id: string | number;
  title?: string;
  message: string;
  tone?: ToastTone;
  /** Optional CTA button rendered next to the dismiss X. */
  action?: { label: string; onClick: () => void };
  durationMs?: number;
  onDismiss?: () => void;
};

export function Toast({
  id,
  title,
  message,
  tone = 'info',
  action,
  durationMs = 8_000,
  onDismiss,
}: ToastProps) {
  const [visible, setVisible] = useState(true);

  // Reset visibility when id changes (new toast).
  useEffect(() => {
    setVisible(true);
  }, [id]);

  // Auto-dismiss timer.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, durationMs);
    return () => clearTimeout(t);
  }, [id, visible, durationMs, onDismiss]);

  if (!visible) return null;

  const palette = TONES[tone];

  return (
    <div style={{ ...styles.shell, borderLeft: `3px solid ${palette.accent}` }}>
      <div style={styles.body}>
        {title && <div style={{ ...styles.title, color: palette.titleColor }}>{title}</div>}
        <div style={styles.message}>{message}</div>
      </div>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.onClick();
            setVisible(false);
            onDismiss?.();
          }}
          style={styles.actionBtn}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#fafafa';
          }}
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setVisible(false);
          onDismiss?.();
        }}
        style={styles.dismiss}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = '#333';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = '#888';
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4l8 8M12 4L4 12" />
        </svg>
      </button>
    </div>
  );
}

const TONES: Record<ToastTone, { accent: string; titleColor: string }> = {
  info: { accent: '#1a6fd1', titleColor: '#1a6fd1' },
  warning: { accent: '#f59e0b', titleColor: '#b45309' },
  success: { accent: '#10b981', titleColor: '#065f46' },
};

const styles: Record<string, React.CSSProperties> = {
  shell: {
    position: 'fixed',
    top: 56, // sit under the MainAppBar
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 60,
    minWidth: 320,
    maxWidth: 520,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    background: '#ffffff',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
    border: '1px solid #e5e5e5',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 2,
  },
  message: {
    fontSize: 12,
    lineHeight: 1.4,
    color: '#444',
  },
  actionBtn: {
    flexShrink: 0,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 500,
    color: '#333',
    background: '#fafafa',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.12s',
  },
  dismiss: {
    flexShrink: 0,
    width: 24,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 4,
    color: '#888',
    cursor: 'pointer',
    padding: 0,
    transition: 'color 0.12s',
  },
};

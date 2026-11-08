/**
 * PanelHeader — the shared compact header for every tool panel/dialog.
 *
 * Matches the Sketch Palette's header (≈28px tall, 11px uppercase label,
 * light-grey bar) so all overlays read consistently instead of each dialog
 * inventing its own tall header. Title + optional left icon + optional close
 * (X) button.
 */

import { X } from 'lucide-react';

interface PanelHeaderProps {
  title: string;
  /** Optional small leading glyph/icon (e.g. a colored mark). */
  icon?: React.ReactNode;
  /** When provided, renders a close (X) button on the right. */
  onClose?: (() => void) | undefined;
  /** Tooltip for the close button. */
  closeTitle?: string;
}

export function PanelHeader({ title, icon, onClose, closeTitle = 'Close (Esc)' }: PanelHeaderProps) {
  return (
    <div style={styles.header}>
      {icon && <span style={styles.icon}>{icon}</span>}
      <span style={styles.title}>{title}</span>
      {onClose && (
        <button
          type="button"
          style={styles.closeBtn}
          onClick={onClose}
          title={closeTitle}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#e6e6e6';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '0 6px 0 12px',
    // Fixed height (+ overflow) so an oversized icon glyph can't inflate the
    // bar — every panel header is exactly the Sketch Palette's height.
    height: 28,
    overflow: 'hidden',
    boxSizing: 'border-box',
    borderBottom: '1px solid #ececec',
    background: '#f5f5f5',
  },
  icon: {
    fontSize: 13,
    lineHeight: 1,
    color: '#3b82f6',
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: '#555',
  },
  closeBtn: {
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 4,
    color: '#888',
    cursor: 'pointer',
    padding: 0,
    transition: 'background 0.1s',
  },
};

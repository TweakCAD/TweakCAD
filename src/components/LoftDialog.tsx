/**
 * LoftDialog - Inline panel overlay on the viewport for the loft operation.
 *
 * Multi-profile picker: profiles are click-selected across visible sketches
 * (parent renders one SketchViewer in picker mode per visible sketch). The
 * dialog itself just shows the ordered list and the boolean toggles.
 */

import { useEffect, useCallback, useState } from 'react';
import { X } from 'lucide-react';
// Reuse the existing Pattern icon as a placeholder until a proper Loft glyph
// lands in cadIcons.tsx — same pattern as Revolve reused the existing icon.
import { PatternIcon } from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

// ---- Types ----

export type LoftOperation = 'newBody' | 'join' | 'cut';

/** Per-row info shown in the picked-profiles list. */
export interface LoftDialogProfileEntry {
  /** Stable key for React + remove-by-key. */
  key: string;
  /** "Sketch 1: rect_base" — human-readable. */
  label: string;
}

export interface LoftDialogResult {
  operation: LoftOperation;
  ruled: boolean;
  closed: boolean;
}

interface LoftDialogProps {
  /** Ordered profiles in click order; rendered as a removable list. */
  profiles: LoftDialogProfileEntry[];
  /** Remove a profile by its key (raised from a row's X button). */
  onRemoveProfile: (key: string) => void;
  /** Initial values when editing an existing loft (currently unused; for parity with ExtrudeDialog). */
  initialValues?: { operation?: LoftOperation; ruled?: boolean; closed?: boolean } | undefined;
  onConfirm: (result: LoftDialogResult) => void;
  onCancel: () => void;
}

const MIN_PROFILES = 2;

// ---- Component ----

export function LoftDialog({
  profiles,
  onRemoveProfile,
  initialValues,
  onConfirm,
  onCancel,
}: LoftDialogProps) {
  const [operation, setOperation] = useState<LoftOperation>(initialValues?.operation ?? 'newBody');
  const [ruled, setRuled] = useState<boolean>(initialValues?.ruled ?? false);
  const [closed, setClosed] = useState<boolean>(initialValues?.closed ?? false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const handleConfirm = useCallback(() => {
    if (profiles.length < MIN_PROFILES) return;
    onConfirm({ operation, ruled, closed });
  }, [profiles.length, operation, ruled, closed, onConfirm]);

  const canConfirm = profiles.length >= MIN_PROFILES;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Loft" icon={<PatternIcon size={14} color="#eab308" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>
            Profiles {canConfirm ? `(${profiles.length})` : `(need ${MIN_PROFILES - profiles.length} more)`}
          </div>
          <div style={styles.profileList}>
            {profiles.length === 0 && (
              <div style={styles.emptyHint}>Click profiles in the viewport in order…</div>
            )}
            {profiles.map((p, idx) => (
              <div key={p.key} style={styles.profileRow}>
                <span style={styles.profileIndex}>{idx + 1}</span>
                <span style={styles.profileLabel}>{p.label}</span>
                <button
                  type="button"
                  style={styles.profileRemove}
                  onClick={() => onRemoveProfile(p.key)}
                  title="Remove from loft"
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#dc2626'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#888'; }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div style={styles.row}>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={ruled}
              onChange={e => setRuled(e.target.checked)}
            />
            <span style={styles.checkboxLabel}>Ruled (straight segments)</span>
          </label>
        </div>

        <div style={styles.row}>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={closed}
              onChange={e => setClosed(e.target.checked)}
            />
            <span style={styles.checkboxLabel}>Closed loop</span>
          </label>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Op</span>
          <div style={styles.toggleGroup}>
            <ToggleButton active={operation === 'newBody'} onClick={() => setOperation('newBody')} label="New" />
            <ToggleButton active={operation === 'join'} onClick={() => setOperation('join')} label="Join" />
            <ToggleButton active={operation === 'cut'} onClick={() => setOperation('cut')} label="Cut" />
          </div>
        </div>

        <div style={styles.actions}>
          <button
            style={styles.cancelBtn}
            onClick={onCancel}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#eee'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f5f5f5'; }}
          >
            Cancel
          </button>
          <button
            style={{
              ...styles.okBtn,
              opacity: canConfirm ? 1 : 0.5,
              cursor: canConfirm ? 'pointer' : 'not-allowed',
            }}
            onClick={handleConfirm}
            disabled={!canConfirm}
            onMouseEnter={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#a16207';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#eab308';
            }}
            title={canConfirm ? 'Build loft' : `Pick at least ${MIN_PROFILES} profiles to enable`}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Sub-components ----

function ToggleButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      style={{
        ...styles.toggleBtn,
        background: active ? '#fefce8' : '#f7f7f7',
        color: active ? '#a16207' : '#666',
        borderColor: active ? '#facc15' : '#e0e0e0',
        fontWeight: active ? 600 : 400,
      }}
      onClick={onClick}
      title={label}
      onMouseEnter={e => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = '#ebebeb';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = active ? '#fefce8' : '#f7f7f7';
      }}
    >
      {label}
    </button>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 50,
    pointerEvents: 'auto',
  },
  panel: {
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    width: 300,
    padding: 0,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderBottom: '1px solid #e8e8e8',
    background: '#fafafa',
  },
  headerTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: '#333',
  },
  closeBtn: {
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
    transition: 'background 0.1s',
  },
  section: {
    padding: '10px 12px',
    borderBottom: '1px solid #f0f0f0',
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  profileList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: 140,
    overflowY: 'auto',
  },
  emptyHint: {
    fontSize: 11,
    color: '#aaa',
    fontStyle: 'italic',
    padding: '4px 0',
  },
  profileRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 6px',
    background: '#fafafa',
    border: '1px solid #eee',
    borderRadius: 4,
  },
  profileIndex: {
    width: 16,
    height: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#fefce8',
    color: '#a16207',
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 700,
    flexShrink: 0,
  },
  profileLabel: {
    flex: 1,
    fontSize: 12,
    color: '#333',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  profileRemove: {
    width: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: '#888',
    cursor: 'pointer',
    borderRadius: 3,
    padding: 0,
    transition: 'color 0.1s',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
    gap: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    flexShrink: 0,
    minWidth: 56,
  },
  checkboxRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    fontSize: 12,
    color: '#333',
    width: '100%',
  },
  checkboxLabel: {
    fontSize: 12,
    color: '#333',
  },
  toggleGroup: {
    display: 'flex',
    gap: 2,
    flex: 1,
    justifyContent: 'flex-end',
  },
  toggleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 26,
    padding: '0 10px',
    border: '1px solid #e0e0e0',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 400,
    color: '#666',
    background: '#f7f7f7',
    transition: 'background 0.1s, color 0.1s',
    whiteSpace: 'nowrap',
  },
  actions: {
    display: 'flex',
    gap: 8,
    padding: '8px 12px 12px',
    justifyContent: 'flex-end',
    borderTop: '1px solid #e8e8e8',
  },
  cancelBtn: {
    height: 30,
    padding: '0 14px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    background: '#f5f5f5',
    color: '#555',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    transition: 'background 0.1s',
  },
  okBtn: {
    height: 30,
    padding: '0 20px',
    border: 'none',
    borderRadius: 5,
    background: '#eab308',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

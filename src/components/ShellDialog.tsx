/**
 * ShellDialog — inline panel overlay for the Shell operation.
 *
 * Interaction model:
 *  - Faces are click-selected from the viewport (Shell.tsx flips
 *    pickMode to 'face' while this dialog is open). The first face
 *    pick also pins the source body (Shell operates on one body at a
 *    time; subsequent face picks must lie on that same body or are
 *    rejected at the Shell.tsx subscription layer).
 *  - The dialog itself shows the ordered face list with per-row
 *    remove buttons and a single thickness input.
 *
 * Slate-blue accent (#64748b) matches the ShellIcon's MODIFY-group
 * color in the toolbar.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { ShellIcon } from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

export interface ShellDialogFaceEntry {
  /** Stable key (JSON of FaceRef) for React + remove-by-key. */
  key: string;
  /** "Body 1: face f_3" — human-readable. */
  label: string;
}

export interface ShellDialogResult {
  /** Wall thickness in mm (positive). Builder negates for inward shell. */
  thickness: number;
}

interface ShellDialogProps {
  /** Ordered faces in click order. Empty = waiting for picks. */
  faces: ShellDialogFaceEntry[];
  /** Remove a face by key (X button on row). */
  onRemoveFace: (key: string) => void;
  /** Initial values when editing an existing shell. */
  initialValues?: { thickness?: number } | undefined;
  onConfirm: (result: ShellDialogResult) => void;
  onCancel: () => void;
}

export function ShellDialog({
  faces,
  onRemoveFace,
  initialValues,
  onConfirm,
  onCancel,
}: ShellDialogProps) {
  const [thickness, setThickness] = useState(String(initialValues?.thickness ?? 2));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const validate = useCallback((val: string): number | null => {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) return null;
    return num;
  }, []);

  const handleConfirm = useCallback(() => {
    if (faces.length === 0) {
      setError('Pick at least one face to remove');
      return;
    }
    const num = validate(thickness);
    if (num === null) {
      setError('Thickness must be positive');
      return;
    }
    onConfirm({ thickness: num });
  }, [faces.length, thickness, onConfirm, validate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
  }, [handleConfirm]);

  const canConfirm = faces.length > 0 && validate(thickness) !== null;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Shell" icon={<ShellIcon size={14} color="#64748b" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>
            Faces to Remove {faces.length > 0 ? `(${faces.length})` : '(click faces in viewport)'}
          </div>
          <div style={styles.faceList}>
            {faces.length === 0 && (
              <div style={styles.emptyHint}>Click body faces in the viewport...</div>
            )}
            {faces.map((f, idx) => (
              <div key={f.key} style={styles.faceRow}>
                <span style={styles.faceIndex}>{idx + 1}</span>
                <span style={styles.faceLabel}>{f.label}</span>
                <button
                  type="button"
                  style={styles.faceRemove}
                  onClick={() => onRemoveFace(f.key)}
                  title="Remove from shell"
                  onMouseEnter={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#dc2626'; }}
                  onMouseLeave={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#888'; }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Thickness</span>
          <div style={styles.inputGroup}>
            <input
              ref={inputRef}
              type="text"
              value={thickness}
              onChange={e => { setThickness(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              style={{
                ...styles.input,
                borderColor: error ? '#dc2626' : '#d0d0d0',
              }}
              placeholder="2"
            />
            <span style={styles.unit}>mm</span>
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}

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
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#475569';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#64748b';
            }}
            title={canConfirm ? 'Apply shell' : 'Pick at least one face and set a positive thickness'}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', top: 12, right: 12, zIndex: 50, pointerEvents: 'auto' },
  panel: {
    background: '#fff', border: '1px solid #d0d0d0', borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)', width: 300, padding: 0, overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px', borderBottom: '1px solid #e8e8e8', background: '#fafafa',
  },
  headerTitle: { flex: 1, fontSize: 13, fontWeight: 600, color: '#333' },
  closeBtn: {
    width: 24, height: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', borderRadius: 4,
    color: '#888', cursor: 'pointer', padding: 0,
    transition: 'background 0.1s',
  },
  section: { padding: '10px 12px', borderBottom: '1px solid #f0f0f0' },
  sectionLabel: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6,
  },
  faceList: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' },
  emptyHint: { fontSize: 11, color: '#aaa', fontStyle: 'italic', padding: '4px 0' },
  faceRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 6px',
    background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 4,
  },
  faceIndex: {
    width: 16, height: 16,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: '#cbd5e1', color: '#334155', borderRadius: 4,
    fontSize: 10, fontWeight: 700, flexShrink: 0,
  },
  faceLabel: {
    flex: 1, fontSize: 12, color: '#333',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  faceRemove: {
    width: 18, height: 18,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: '#888',
    cursor: 'pointer', borderRadius: 3, padding: 0, transition: 'color 0.1s',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', gap: 8 },
  label: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3,
    flexShrink: 0, minWidth: 64,
  },
  inputGroup: { display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' },
  input: {
    width: 80, height: 28,
    padding: '0 8px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 13, fontFamily: 'monospace', color: '#333',
    outline: 'none', textAlign: 'right',
    transition: 'border-color 0.15s',
  },
  unit: { fontSize: 11, color: '#999', fontWeight: 500 },
  error: { fontSize: 11, color: '#dc2626', padding: '0 12px 4px' },
  actions: {
    display: 'flex', gap: 8,
    padding: '8px 12px 12px',
    justifyContent: 'flex-end', borderTop: '1px solid #e8e8e8',
  },
  cancelBtn: {
    height: 30, padding: '0 14px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    background: '#f5f5f5', color: '#555',
    cursor: 'pointer', fontSize: 12, fontWeight: 500,
    transition: 'background 0.1s',
  },
  okBtn: {
    height: 30, padding: '0 20px',
    border: 'none', borderRadius: 5,
    background: '#64748b', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

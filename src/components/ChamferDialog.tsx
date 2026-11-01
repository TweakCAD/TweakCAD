/**
 * ChamferDialog — inline panel overlay for the chamfer operation.
 *
 * Identical interaction model to {@link FilletDialog}: edges are
 * click-selected from the viewport (Shell flips pickMode to 'edgeOrFace'
 * while this dialog is open), a face click adds all of its boundary
 * edges, and "Tangent chain" extends an edge pick along tangent
 * neighbours. The dialog itself shows the ordered edge list + per-row
 * remove + a setback-distance input. Phase A
 * ships symmetric chamfers — the same setback on both adjacent faces.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { ChamferIcon } from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

export interface ChamferDialogEdgeEntry {
  /** Stable key for React + remove-by-key. */
  key: string;
  /** "Body 1: edge e_3" — human-readable. */
  label: string;
}

export interface ChamferDialogResult {
  /** Numeric setback distance in mm. Caller stringifies into the schema's Expression. */
  distance: number;
}

interface ChamferDialogProps {
  /** Ordered edges in click order. Empty array = waiting on user pick. */
  edges: ChamferDialogEdgeEntry[];
  /** Remove an edge by key (X button on a row). */
  onRemoveEdge: (key: string) => void;
  /** Whether an edge pick also adds its tangent-continuous neighbours. */
  tangentChain: boolean;
  onTangentChainChange: (on: boolean) => void;
  /** Initial values when editing an existing chamfer (currently unused; for parity). */
  initialValues?: { distance?: number } | undefined;
  onConfirm: (result: ChamferDialogResult) => void;
  onCancel: () => void;
}

export function ChamferDialog({
  edges,
  onRemoveEdge,
  tangentChain,
  onTangentChainChange,
  initialValues,
  onConfirm,
  onCancel,
}: ChamferDialogProps) {
  const [distance, setDistance] = useState(String(initialValues?.distance ?? 1));
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
    if (edges.length === 0) {
      setError('Pick at least one edge');
      return;
    }
    const num = validate(distance);
    if (num === null) {
      setError('Distance must be positive');
      return;
    }
    onConfirm({ distance: num });
  }, [edges.length, distance, onConfirm, validate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
  }, [handleConfirm]);

  const canConfirm = edges.length > 0 && validate(distance) !== null;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Chamfer" icon={<ChamferIcon size={14} color="#06b6d4" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>
            Edges {edges.length > 0 ? `(${edges.length})` : '(click edges or faces in viewport)'}
          </div>
          <div style={styles.edgeList}>
            {edges.length === 0 && (
              <div style={styles.emptyHint}>Click edges, or a face for all its edges...</div>
            )}
            {edges.map((e, idx) => (
              <div key={e.key} style={styles.edgeRow}>
                <span style={styles.edgeIndex}>{idx + 1}</span>
                <span style={styles.edgeLabel}>{e.label}</span>
                <button
                  type="button"
                  style={styles.edgeRemove}
                  onClick={() => onRemoveEdge(e.key)}
                  title="Remove from chamfer"
                  onMouseEnter={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#dc2626'; }}
                  onMouseLeave={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#888'; }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={tangentChain}
              onChange={e => onTangentChainChange(e.target.checked)}
            />
            <span>Tangent chain</span>
          </label>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Distance</span>
          <div style={styles.inputGroup}>
            <input
              ref={inputRef}
              type="text"
              value={distance}
              onChange={e => { setDistance(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              style={{
                ...styles.input,
                borderColor: error ? '#dc2626' : '#d0d0d0',
              }}
              placeholder="1"
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
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#0891b2';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#06b6d4';
            }}
            title={canConfirm ? 'Apply chamfer' : 'Pick at least one edge and set a positive distance'}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

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
  edgeList: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' },
  emptyHint: { fontSize: 11, color: '#aaa', fontStyle: 'italic', padding: '4px 0' },
  edgeRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 6px',
    background: '#fafafa', border: '1px solid #eee', borderRadius: 4,
  },
  edgeIndex: {
    width: 16, height: 16,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: '#cffafe', color: '#0e7490', borderRadius: 4,
    fontSize: 10, fontWeight: 700, flexShrink: 0,
  },
  edgeLabel: { flex: 1, fontSize: 12, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  checkboxRow: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    marginTop: 8, cursor: 'pointer', fontSize: 12, color: '#333',
  },
  edgeRemove: {
    width: 18, height: 18,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: '#888',
    cursor: 'pointer', borderRadius: 3, padding: 0,
    transition: 'color 0.1s',
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
    justifyContent: 'flex-end',
    borderTop: '1px solid #e8e8e8',
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
    background: '#06b6d4', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

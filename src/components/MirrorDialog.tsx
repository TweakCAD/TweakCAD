/**
 * MirrorDialog — inline panel overlay for the Mirror Body operation.
 *
 * Two pickers stacked vertically:
 *   1. Source body: filled in by the Shell when the user clicks any
 *      body in the viewport (pickMode = 'body' while this dialog is
 *      open). Single-body v1; a follow-up can grow to multi-select
 *      without a schema change.
 *   2. Mirror plane: a small XY / XZ / YZ chooser. Construction planes
 *      land later — the schema already accepts `PlaneRef.constructionPlane`,
 *      so it's purely a UI scope decision.
 *
 * Operation toggle (newBody / join) sits at the bottom — `join` is the
 * default because the most common workflow is "model one half, mirror
 * to the whole part".
 */

import { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { MirrorIcon } from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

export interface MirrorDialogPickedBody {
  /** Stable bodyId — matches the BodyRef.bodyId the command will write. */
  bodyId: string;
  /** "Body 1" — human-readable label for the row. */
  label: string;
}

export type MirrorDialogPlane = 'XY' | 'XZ' | 'YZ';
export type MirrorDialogOperation = 'newBody' | 'join';

export interface MirrorDialogResult {
  plane: MirrorDialogPlane;
  operation: MirrorDialogOperation;
}

interface MirrorDialogProps {
  /** Source body the operation will mirror. Null = waiting for pick. */
  pickedBody: MirrorDialogPickedBody | null;
  /** Clear the body pick (X button on the body row). */
  onClearBody: () => void;
  /** Initial values when re-editing an existing mirror. */
  initialValues?: Partial<MirrorDialogResult> | undefined;
  onConfirm: (result: MirrorDialogResult) => void;
  onCancel: () => void;
}

export function MirrorDialog({
  pickedBody,
  onClearBody,
  initialValues,
  onConfirm,
  onCancel,
}: MirrorDialogProps) {
  // `join` matches the common one-half → symmetric-whole workflow.
  const [plane, setPlane] = useState<MirrorDialogPlane>(initialValues?.plane ?? 'XY');
  const [operation, setOperation] = useState<MirrorDialogOperation>(
    initialValues?.operation ?? 'join',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const handleConfirm = useCallback(() => {
    if (!pickedBody) {
      setError('Pick a body to mirror');
      return;
    }
    onConfirm({ plane, operation });
  }, [pickedBody, plane, operation, onConfirm]);

  const canConfirm = pickedBody !== null;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Mirror Body" icon={<MirrorIcon size={14} color="#a855f7" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Source Body</div>
          {pickedBody ? (
            <div style={styles.bodyRow}>
              <span style={styles.bodyDot} />
              <span style={styles.bodyLabel}>{pickedBody.label}</span>
              <button
                type="button"
                style={styles.bodyRemove}
                onClick={onClearBody}
                title="Clear body"
                onMouseEnter={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#dc2626'; }}
                onMouseLeave={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#888'; }}
              >
                <X size={11} />
              </button>
            </div>
          ) : (
            <div style={styles.emptyHint}>Click a body in the viewport...</div>
          )}
        </div>

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Mirror Plane</div>
          <div style={styles.planeRow}>
            {(['XY', 'XZ', 'YZ'] as MirrorDialogPlane[]).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPlane(p)}
                style={{
                  ...styles.planeBtn,
                  background: plane === p ? '#a855f7' : '#f5f5f5',
                  color: plane === p ? '#fff' : '#555',
                  borderColor: plane === p ? '#a855f7' : '#d0d0d0',
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Operation</div>
          <div style={styles.planeRow}>
            <button
              type="button"
              onClick={() => setOperation('join')}
              style={{
                ...styles.opBtn,
                background: operation === 'join' ? '#a855f7' : '#f5f5f5',
                color: operation === 'join' ? '#fff' : '#555',
                borderColor: operation === 'join' ? '#a855f7' : '#d0d0d0',
              }}
              title="Fuse mirror back with source (single symmetric body)"
            >
              Join
            </button>
            <button
              type="button"
              onClick={() => setOperation('newBody')}
              style={{
                ...styles.opBtn,
                background: operation === 'newBody' ? '#a855f7' : '#f5f5f5',
                color: operation === 'newBody' ? '#fff' : '#555',
                borderColor: operation === 'newBody' ? '#a855f7' : '#d0d0d0',
              }}
              title="Keep mirror as a separate body"
            >
              New Body
            </button>
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
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#9333ea';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#a855f7';
            }}
            title={canConfirm ? 'Apply mirror' : 'Pick a body first'}
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
  emptyHint: { fontSize: 11, color: '#aaa', fontStyle: 'italic', padding: '4px 0' },
  bodyRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 8px',
    background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 4,
  },
  bodyDot: {
    width: 8, height: 8, borderRadius: '50%', background: '#a855f7',
  },
  bodyLabel: {
    flex: 1, fontSize: 12, color: '#333',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  bodyRemove: {
    width: 18, height: 18,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: '#888',
    cursor: 'pointer', borderRadius: 3, padding: 0, transition: 'color 0.1s',
  },
  planeRow: { display: 'flex', gap: 6 },
  planeBtn: {
    flex: 1, height: 28, padding: '0 12px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    transition: 'background 0.1s, color 0.1s, border-color 0.1s',
  },
  opBtn: {
    flex: 1, height: 28, padding: '0 12px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    transition: 'background 0.1s, color 0.1s, border-color 0.1s',
  },
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
    background: '#a855f7', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

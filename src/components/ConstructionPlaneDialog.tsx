/**
 * ConstructionPlaneDialog — inline panel overlay for the "create plane"
 * (datum plane) operations.
 *
 * The dialog's `kind` is fixed by the caller — there's no in-dialog
 * type toggle. The two CONSTRUCT ribbon entries each open the dialog
 * pre-configured for one kind:
 *
 *   - **Offset Plane** (`kind: 'offsetFromPlane'`) — user clicks a
 *     plane in the viewport (default XY/XZ/YZ or an existing construction
 *     plane), then types an offset. Mirrors the SketchPlanePicker UX so
 *     plane picking feels the same everywhere.
 *
 *   - **Plane from Face** (`kind: 'offsetFromFace'`) — user clicks a
 *     face on a body, then types an offset along the face's outward
 *     normal. Same picker the Fillet edge flow uses, set to face mode.
 *
 * Both flows surface the picked base in a remove-X row + the offset
 * input. Visual + interaction style matches {@link FilletDialog}.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import type { FaceRef, PlaneRef } from '@tweakcad/core/src/document/schema.ts';
import { PanelHeader } from './PanelHeader.tsx';

export type ConstructionPlaneKind = 'offsetFromPlane' | 'offsetFromFace';

/** A picked plane shown in `offsetFromPlane` mode. */
export interface ConstructionPlanePickedPlane {
  /** Display label e.g. "XY", "Plane 1". */
  label: string;
  /** PlaneRef to round-trip into the dispatched command. */
  planeRef: PlaneRef;
}

/** A picked face shown in `offsetFromFace` mode. */
export interface ConstructionPlanePickedFace {
  /** Display label e.g. "Face 4a2b3c on Body 1". */
  label: string;
  /** Stable FaceRef to round-trip into the dispatched command. */
  faceRef: FaceRef;
}

export type ConstructionPlaneDialogResult =
  | {
      kind: 'offsetFromPlane';
      planeRef: PlaneRef;
      offset: number;
    }
  | {
      kind: 'offsetFromFace';
      faceRef: FaceRef;
      offset: number;
    };

interface ConstructionPlaneDialogProps {
  /** Fixed at open-time by the caller — drives which picker UX is shown. */
  kind: ConstructionPlaneKind;
  /** Plane the user has clicked in `offsetFromPlane` mode. */
  pickedPlane: ConstructionPlanePickedPlane | null;
  /** Face the user has clicked in `offsetFromFace` mode. */
  pickedFace: ConstructionPlanePickedFace | null;
  /** Notify the parent that the user removed the picked base. */
  onClearPickedPlane: () => void;
  onClearPickedFace: () => void;
  /**
   * Controlled offset value (mm). The parent owns it so the on-canvas drag
   * handle and this field share one source of truth — dragging the gizmo
   * updates `offsetValue`, which flows back here; typing here calls
   * `onOffsetChange`. The parent previews the plane live and commits on OK.
   */
  offsetValue: number;
  onOffsetChange: (value: number) => void;
  /** True when editing an existing plane (changes the title/label only). */
  editing?: boolean;
  onConfirm: (result: ConstructionPlaneDialogResult) => void;
  onCancel: () => void;
}

export function ConstructionPlaneDialog({
  kind,
  pickedPlane,
  pickedFace,
  onClearPickedPlane,
  onClearPickedFace,
  offsetValue,
  onOffsetChange,
  editing,
  onConfirm,
  onCancel,
}: ConstructionPlaneDialogProps) {
  // Local text buffer so partial input ("-", "") is allowed while typing.
  // Kept in sync with the controlled `offsetValue` (e.g. when the gizmo
  // drives it) unless the field already shows that number.
  const [offset, setOffset] = useState(String(offsetValue));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Sync the field when the controlled value changes externally (gizmo
    // drag), but don't clobber an in-progress edit that already parses to it.
    if (parseFloat(offset) !== offsetValue) {
      setOffset(String(Math.round(offsetValue * 100) / 100));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offsetValue]);

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
    // Offset 0 is allowed (the plane coincides with the base) — useful
    // for renaming-style reference geometry. NaN is the only reject.
    if (Number.isNaN(num)) return null;
    return num;
  }, []);

  const handleConfirm = useCallback(() => {
    const num = validate(offset);
    if (num === null) {
      setError('Offset must be a number (0 is allowed)');
      return;
    }
    if (kind === 'offsetFromPlane') {
      if (!pickedPlane) {
        setError('Click a plane in the viewport first');
        return;
      }
      onConfirm({ kind: 'offsetFromPlane', planeRef: pickedPlane.planeRef, offset: num });
    } else {
      if (!pickedFace) {
        setError('Click a face in the viewport first');
        return;
      }
      onConfirm({ kind: 'offsetFromFace', faceRef: pickedFace.faceRef, offset: num });
    }
  }, [kind, pickedPlane, pickedFace, offset, onConfirm, validate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
  }, [handleConfirm]);

  const hasPick = kind === 'offsetFromPlane' ? pickedPlane !== null : pickedFace !== null;
  const canConfirm = validate(offset) !== null && hasPick;

  const title = editing
    ? 'Edit Plane'
    : kind === 'offsetFromPlane' ? 'Offset Plane' : 'Plane from Face';
  const baseSectionLabel = kind === 'offsetFromPlane'
    ? (pickedPlane ? 'Base plane (1)' : 'Base plane (click a plane in the viewport)')
    : (pickedFace ? 'Face (1)' : 'Face (click a face in the viewport)');
  const emptyHint = kind === 'offsetFromPlane'
    ? 'Click a default plane (XY/XZ/YZ) or an existing construction plane…'
    : 'Click a planar face on a body…';

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title={title} icon={<span style={styles.headerIcon}>▱</span>} onClose={onCancel} closeTitle="Cancel (Esc)" />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>{baseSectionLabel}</div>
          {kind === 'offsetFromPlane' ? (
            pickedPlane ? (
              <div style={styles.edgeRow}>
                <span style={styles.edgeIndex}>1</span>
                <span style={styles.edgeLabel}>{pickedPlane.label}</span>
                <button
                  type="button"
                  style={styles.edgeRemove}
                  onClick={() => { onClearPickedPlane(); setError(null); }}
                  title="Remove plane"
                  onMouseEnter={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#dc2626'; }}
                  onMouseLeave={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#888'; }}
                >
                  <X size={11} />
                </button>
              </div>
            ) : (
              <div style={styles.emptyHint}>{emptyHint}</div>
            )
          ) : (
            pickedFace ? (
              <div style={styles.edgeRow}>
                <span style={styles.edgeIndex}>1</span>
                <span style={styles.edgeLabel}>{pickedFace.label}</span>
                <button
                  type="button"
                  style={styles.edgeRemove}
                  onClick={() => { onClearPickedFace(); setError(null); }}
                  title="Remove face"
                  onMouseEnter={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#dc2626'; }}
                  onMouseLeave={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#888'; }}
                >
                  <X size={11} />
                </button>
              </div>
            ) : (
              <div style={styles.emptyHint}>{emptyHint}</div>
            )
          )}
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Offset</span>
          <div style={styles.inputGroup}>
            <input
              ref={inputRef}
              type="text"
              value={offset}
              onChange={e => {
                const v = e.target.value;
                setOffset(v);
                setError(null);
                // Push valid numbers up so the gizmo + live preview follow.
                const n = parseFloat(v);
                if (!Number.isNaN(n)) onOffsetChange(n);
              }}
              onKeyDown={handleKeyDown}
              style={{
                ...styles.input,
                borderColor: error ? '#dc2626' : '#d0d0d0',
              }}
              placeholder="10"
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
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#2563eb';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#3b82f6';
            }}
            title={canConfirm ? 'Create plane' : 'Pick a base and set a numeric offset'}
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
  headerIcon: {
    fontSize: 16,
    color: '#3b82f6',
    fontWeight: 700,
    width: 16,
    textAlign: 'center',
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
  edgeRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 6px',
    background: '#fafafa', border: '1px solid #eee', borderRadius: 4,
  },
  edgeIndex: {
    width: 16, height: 16,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: '#dbeafe', color: '#1e40af', borderRadius: 4,
    fontSize: 10, fontWeight: 700, flexShrink: 0,
  },
  edgeLabel: { flex: 1, fontSize: 12, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
    flexShrink: 0, minWidth: 56,
  },
  inputGroup: { display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' },
  input: {
    width: 90, height: 28,
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
    background: '#3b82f6', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

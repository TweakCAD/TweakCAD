/**
 * HoleDialog — inline panel overlay for the Hole feature.
 *
 * Workflow (single hole on face):
 *   1. User clicks the Hole ribbon button → Shell opens the dialog and
 *      switches the viewport into face-pick mode.
 *   2. User clicks a planar face on a body → Shell captures a stable
 *      FaceRef and passes it as `pickedFace`.
 *   3. User picks Hole kind (Simple / Counterbore / Countersink), sets
 *      diameter, extent mode (Blind / Through-All), and any kind-specific
 *      params (cbore diameter+depth, csink diameter+angle).
 *   4. OK → onConfirm({ faceRef, diameter, extent, kind, ... }).
 *
 * The dialog preserves cbore + csink values when the user toggles the
 * kind dropdown, so switching back and forth doesn't lose input. Visual
 * + interaction style matches {@link ConstructionPlaneDialog} and
 * {@link FilletDialog}.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import type { FaceRef } from '@tweakcad/core/src/document/schema.ts';
import { PanelHeader } from './PanelHeader.tsx';

export type HoleKind = 'simple' | 'counterbore' | 'countersink';

export type HoleExtentMode = 'blind' | 'throughAll';

/** A picked face shown in the picked-face row. */
export interface HoleDialogPickedFace {
  /** Display label e.g. "Face 4a2b3c on Body 1". */
  label: string;
  /** Stable FaceRef to round-trip into the dispatched command. */
  faceRef: FaceRef;
}

export interface HoleDialogResult {
  faceRef: FaceRef;
  kind: HoleKind;
  diameter: number;
  extent: HoleExtentMode;
  /** Drill depth in mm. Only meaningful when extent === 'blind'. */
  depth: number;
  /** Counterbore params — only meaningful when kind === 'counterbore'. */
  counterboreDiameter?: number;
  counterboreDepth?: number;
  /** Countersink params — only meaningful when kind === 'countersink'. */
  countersinkDiameter?: number;
  /** Countersink full included angle in degrees. */
  countersinkAngle?: number;
}

interface HoleDialogProps {
  /** Face the user has clicked. Null while the user is still picking. */
  pickedFace: HoleDialogPickedFace | null;
  /** Notify parent that the user removed the picked face. */
  onClearPickedFace: () => void;
  initialValues?: Partial<HoleDialogResult> | undefined;
  onConfirm: (result: HoleDialogResult) => void;
  onCancel: () => void;
}

export function HoleDialog({
  pickedFace,
  onClearPickedFace,
  initialValues,
  onConfirm,
  onCancel,
}: HoleDialogProps) {
  const [kind, setKind] = useState<HoleKind>(initialValues?.kind ?? 'simple');
  const [diameter, setDiameter] = useState(String(initialValues?.diameter ?? 5));
  const [extent, setExtent] = useState<HoleExtentMode>(initialValues?.extent ?? 'blind');
  const [depth, setDepth] = useState(String(initialValues?.depth ?? 10));

  // Counterbore + countersink defaults match common machinist values:
  //  - cbore for an M5 socket-head cap screw: 10 mm ⌀ × 5.5 mm deep.
  //  - csink for an M5 90° flathead: 10 mm rim ⌀ × 90° included.
  const [cboreDiameter, setCboreDiameter] = useState(
    String(initialValues?.counterboreDiameter ?? 10),
  );
  const [cboreDepth, setCboreDepth] = useState(
    String(initialValues?.counterboreDepth ?? 5),
  );
  const [csinkDiameter, setCsinkDiameter] = useState(
    String(initialValues?.countersinkDiameter ?? 10),
  );
  const [csinkAngle, setCsinkAngle] = useState(
    String(initialValues?.countersinkAngle ?? 90),
  );

  const [error, setError] = useState<string | null>(null);
  const diameterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    diameterInputRef.current?.focus();
    diameterInputRef.current?.select();
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const parsePositive = useCallback((val: string): number | null => {
    const n = parseFloat(val);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }, []);

  const handleConfirm = useCallback(() => {
    if (!pickedFace) {
      setError('Click a face in the viewport first');
      return;
    }
    const diaNum = parsePositive(diameter);
    if (diaNum === null) {
      setError('Diameter must be a positive number');
      return;
    }
    const depthNum = extent === 'blind' ? parsePositive(depth) : 0;
    if (extent === 'blind' && depthNum === null) {
      setError('Depth must be a positive number');
      return;
    }

    const result: HoleDialogResult = {
      faceRef: pickedFace.faceRef,
      kind,
      diameter: diaNum,
      extent,
      // `depth` is ignored by the builder when extent === 'throughAll';
      // we still pass the user's last entered value so re-opening the
      // dialog preserves it.
      depth: extent === 'blind' ? depthNum! : parsePositive(depth) ?? 10,
    };

    if (kind === 'counterbore') {
      const cdia = parsePositive(cboreDiameter);
      const cdep = parsePositive(cboreDepth);
      if (cdia === null) { setError('Counterbore diameter must be a positive number'); return; }
      if (cdep === null) { setError('Counterbore depth must be a positive number'); return; }
      if (cdia <= diaNum) {
        setError('Counterbore diameter must exceed hole diameter');
        return;
      }
      result.counterboreDiameter = cdia;
      result.counterboreDepth = cdep;
    }
    if (kind === 'countersink') {
      const sdia = parsePositive(csinkDiameter);
      const sang = parsePositive(csinkAngle);
      if (sdia === null) { setError('Countersink diameter must be a positive number'); return; }
      if (sang === null || sang >= 180) {
        setError('Countersink angle must be in (0, 180) degrees');
        return;
      }
      if (sdia <= diaNum) {
        setError('Countersink diameter must exceed hole diameter');
        return;
      }
      result.countersinkDiameter = sdia;
      result.countersinkAngle = sang;
    }

    onConfirm(result);
  }, [
    pickedFace, kind, diameter, extent, depth,
    cboreDiameter, cboreDepth, csinkDiameter, csinkAngle,
    parsePositive, onConfirm,
  ]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
  }, [handleConfirm]);

  const canConfirm = pickedFace !== null && parsePositive(diameter) !== null;

  const faceSectionLabel = pickedFace ? 'Face (1)' : 'Face (click a face in the viewport)';

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Hole" icon={<span style={styles.headerIcon}>◯</span>} onClose={onCancel} closeTitle="Cancel (Esc)" />

        {/* Face row — same look as Fillet's edge rows and CP's face row. */}
        <div style={styles.section}>
          <div style={styles.sectionLabel}>{faceSectionLabel}</div>
          {pickedFace ? (
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
            <div style={styles.emptyHint}>Click a planar face on a body…</div>
          )}
        </div>

        {/* Hole kind (Simple / Counterbore / Countersink). */}
        <div style={styles.row}>
          <span style={styles.label}>Type</span>
          <select
            value={kind}
            onChange={e => { setKind(e.target.value as HoleKind); setError(null); }}
            style={styles.select}
          >
            <option value="simple">Simple</option>
            <option value="counterbore">Counterbore</option>
            <option value="countersink">Countersink</option>
          </select>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Diameter</span>
          <div style={styles.inputGroup}>
            <input
              ref={diameterInputRef}
              type="text"
              value={diameter}
              onChange={e => { setDiameter(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              style={styles.input}
              placeholder="5"
            />
            <span style={styles.unit}>mm</span>
          </div>
        </div>

        {/* Extent mode + depth (depth disabled when through-all). */}
        <div style={styles.row}>
          <span style={styles.label}>Extent</span>
          <select
            value={extent}
            onChange={e => { setExtent(e.target.value as HoleExtentMode); setError(null); }}
            style={styles.select}
          >
            <option value="blind">Blind</option>
            <option value="throughAll">Through All</option>
          </select>
        </div>

        {extent === 'blind' && (
          <div style={styles.row}>
            <span style={styles.label}>Depth</span>
            <div style={styles.inputGroup}>
              <input
                type="text"
                value={depth}
                onChange={e => { setDepth(e.target.value); setError(null); }}
                onKeyDown={handleKeyDown}
                style={styles.input}
                placeholder="10"
              />
              <span style={styles.unit}>mm</span>
            </div>
          </div>
        )}

        {/* Counterbore-specific fields */}
        {kind === 'counterbore' && (
          <>
            <div style={styles.divider} />
            <div style={styles.row}>
              <span style={styles.label}>⌴ ⌀</span>
              <div style={styles.inputGroup}>
                <input
                  type="text"
                  value={cboreDiameter}
                  onChange={e => { setCboreDiameter(e.target.value); setError(null); }}
                  onKeyDown={handleKeyDown}
                  style={styles.input}
                  placeholder="10"
                />
                <span style={styles.unit}>mm</span>
              </div>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>⌴ Depth</span>
              <div style={styles.inputGroup}>
                <input
                  type="text"
                  value={cboreDepth}
                  onChange={e => { setCboreDepth(e.target.value); setError(null); }}
                  onKeyDown={handleKeyDown}
                  style={styles.input}
                  placeholder="5"
                />
                <span style={styles.unit}>mm</span>
              </div>
            </div>
          </>
        )}

        {/* Countersink-specific fields */}
        {kind === 'countersink' && (
          <>
            <div style={styles.divider} />
            <div style={styles.row}>
              <span style={styles.label}>⌵ ⌀</span>
              <div style={styles.inputGroup}>
                <input
                  type="text"
                  value={csinkDiameter}
                  onChange={e => { setCsinkDiameter(e.target.value); setError(null); }}
                  onKeyDown={handleKeyDown}
                  style={styles.input}
                  placeholder="10"
                />
                <span style={styles.unit}>mm</span>
              </div>
            </div>
            <div style={styles.row}>
              <span style={styles.label}>⌵ Angle</span>
              <div style={styles.inputGroup}>
                <input
                  type="text"
                  value={csinkAngle}
                  onChange={e => { setCsinkAngle(e.target.value); setError(null); }}
                  onKeyDown={handleKeyDown}
                  style={styles.input}
                  placeholder="90"
                />
                <span style={styles.unit}>°</span>
              </div>
            </div>
          </>
        )}

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
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#ea580c';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#f97316';
            }}
            title={canConfirm ? 'Create hole' : 'Pick a face and set a diameter'}
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
    color: '#f97316',
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
    background: '#fed7aa', color: '#9a3412', borderRadius: 4,
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
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', gap: 8 },
  label: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3,
    flexShrink: 0, minWidth: 64,
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
  select: {
    width: 120, height: 28,
    padding: '0 6px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, color: '#333',
    background: '#fff',
    outline: 'none',
    fontFamily: 'inherit',
  },
  unit: { fontSize: 11, color: '#999', fontWeight: 500 },
  divider: { height: 1, background: '#f0f0f0', margin: '4px 12px' },
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
    background: '#f97316', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

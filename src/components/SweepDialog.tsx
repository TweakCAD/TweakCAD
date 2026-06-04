/**
 * SweepDialog — inline panel overlay for the Sweep operation.
 *
 * V1 interaction model: two dropdowns (Profile + Path), each listing
 * all sketches in the project. The first detected closed region of
 * each sketch becomes the profile / path. This is intentionally a
 * lighter UX than Loft's in-viewport profile picker — Sweep v1 is
 * closed-region-only and doesn't need per-region picking. When v2
 * adds open-wire paths, this dialog can grow an in-viewport picker
 * mirroring Loft's pattern.
 *
 * Trade-off: a sketch with multiple regions only contributes its
 * first region. Users who need a specific region can put it in its
 * own sketch — same workaround the early Loft + Extrude builds used
 * before in-viewport pickers landed.
 *
 * Yellow-amber accent (#eab308) reuses the PatternIcon palette since
 * no Sweep-specific icon exists yet (mirrors how Loft reuses the
 * PatternIcon too — noted in cadIcons.tsx).
 */

import { useState, useEffect, useCallback } from 'react';
import { PatternIcon } from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

export interface SweepDialogSketchOption {
  /** FeatureId of the sketch. */
  sketchId: string;
  /** Display name from FeatureNode.name. */
  label: string;
}

export interface SweepDialogResult {
  profileSketchId: string;
  pathSketchId: string;
}

interface SweepDialogProps {
  /** All sketches in the project the user could pick from. */
  availableSketches: SweepDialogSketchOption[];
  /** Initial values when re-editing an existing sweep. */
  initialValues?: Partial<SweepDialogResult> | undefined;
  onConfirm: (result: SweepDialogResult) => void;
  onCancel: () => void;
}

export function SweepDialog({
  availableSketches,
  initialValues,
  onConfirm,
  onCancel,
}: SweepDialogProps) {
  const [profileSketchId, setProfileSketchId] = useState<string>(
    initialValues?.profileSketchId ?? '',
  );
  const [pathSketchId, setPathSketchId] = useState<string>(
    initialValues?.pathSketchId ?? '',
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
    if (!profileSketchId) { setError('Pick a profile sketch'); return; }
    if (!pathSketchId) { setError('Pick a path sketch'); return; }
    if (profileSketchId === pathSketchId) {
      setError('Profile and path must be different sketches');
      return;
    }
    onConfirm({ profileSketchId, pathSketchId });
  }, [profileSketchId, pathSketchId, onConfirm]);

  const canConfirm =
    profileSketchId !== '' &&
    pathSketchId !== '' &&
    profileSketchId !== pathSketchId;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Sweep" icon={<PatternIcon size={14} color="#eab308" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Profile (Closed Sketch)</div>
          <select
            value={profileSketchId}
            onChange={e => { setProfileSketchId(e.target.value); setError(null); }}
            style={styles.select}
          >
            <option value="">— Select sketch —</option>
            {availableSketches.map(s => (
              <option key={s.sketchId} value={s.sketchId}>{s.label}</option>
            ))}
          </select>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Path (Closed Sketch)</div>
          <select
            value={pathSketchId}
            onChange={e => { setPathSketchId(e.target.value); setError(null); }}
            style={styles.select}
          >
            <option value="">— Select sketch —</option>
            {availableSketches.map(s => (
              <option key={s.sketchId} value={s.sketchId}>{s.label}</option>
            ))}
          </select>
        </div>

        <div style={styles.hint}>
          V1 supports closed paths only (e.g., circle profile + circle
          path = torus). Open-wire paths are a v2 follow-up.
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
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#ca8a04';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#eab308';
            }}
            title={canConfirm ? 'Apply sweep' : 'Pick two different sketches for profile and path'}
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
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)', width: 320, padding: 0, overflow: 'hidden',
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
  select: {
    width: '100%', height: 30, padding: '0 8px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 13, color: '#333', background: '#fff',
    outline: 'none', cursor: 'pointer',
  },
  hint: {
    fontSize: 11, color: '#888', fontStyle: 'italic',
    padding: '8px 12px',
    background: '#fffbeb', borderTop: '1px solid #fde68a',
  },
  error: { fontSize: 11, color: '#dc2626', padding: '6px 12px' },
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
    background: '#eab308', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

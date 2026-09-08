/**
 * MovePanel — the Move/Rotate tool panel for body placement.
 *
 * Numeric X/Y/Z fields are two-way synced with the on-canvas gizmo: dragging
 * the gizmo updates the numbers (read from the stored transform), and editing
 * a number writes the absolute transform back (committed on blur/Enter). Move
 * shows position in mm; Rotate shows Euler XYZ in degrees.
 */

import { useState } from 'react';
import * as THREE from 'three';
import { Move } from 'lucide-react';
import { PanelHeader } from './PanelHeader.tsx';

export interface MoveTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
}

interface MovePanelProps {
  scope: 'body' | 'all';
  mode: 'translate' | 'rotate';
  /** The target's current stored transform (drives the numeric fields). */
  transform: MoveTransform;
  onModeChange: (mode: 'translate' | 'rotate') => void;
  /** Write the new absolute transform (caller dispatches the command). */
  onTransformChange: (t: MoveTransform) => void;
  onCancel: () => void;
  onDone: () => void;
}

const AXES = ['X', 'Y', 'Z'] as const;
const round = (n: number, p = 1000) => Math.round(n * p) / p;

/** Display values: position (mm) for translate; Euler XYZ degrees for rotate. */
function displayValues(t: MoveTransform, mode: 'translate' | 'rotate'): [number, number, number] {
  if (mode === 'translate') return [round(t.position[0]), round(t.position[1]), round(t.position[2])];
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...t.rotation), 'XYZ');
  const d = (r: number) => round((r * 180) / Math.PI, 100);
  return [d(e.x), d(e.y), d(e.z)];
}

export function MovePanel({ scope, mode, transform, onModeChange, onTransformChange, onCancel, onDone }: MovePanelProps) {
  const display = displayValues(transform, mode);
  const [buf, setBuf] = useState<string[]>(display.map(String));
  const [editing, setEditing] = useState<number | null>(null);

  // Resync each field from the stored transform (e.g. after a gizmo drag),
  // except the field currently being edited.
  //
  // Adjusted during render rather than in an effect. The effect depended on
  // `display[0..2]` element-wise — `display` is rebuilt every render, so
  // depending on the array itself would resync on every keystroke and fight
  // the user mid-edit. That's why it carried an `exhaustive-deps`
  // suppression. Collapsing the same values into one comparison key states
  // the intent directly and drops the suppression.
  const syncKey = `${display[0]}|${display[1]}|${display[2]}|${mode}|${editing}`;
  const [lastSyncKey, setLastSyncKey] = useState(syncKey);
  if (syncKey !== lastSyncKey) {
    setLastSyncKey(syncKey);
    setBuf(prev => display.map((v, i) => (i === editing ? (prev[i] ?? String(v)) : String(v))));
  }

  const commitField = (i: number) => {
    const num = parseFloat(buf[i] ?? '');
    if (Number.isNaN(num)) {
      setBuf(prev => { const n = [...prev]; n[i] = String(display[i]); return n; });
      return;
    }
    if (mode === 'translate') {
      const position: [number, number, number] = [...transform.position];
      position[i] = num;
      onTransformChange({ position, rotation: transform.rotation });
    } else {
      const deg: [number, number, number] = [...display];
      deg[i] = num;
      const e = new THREE.Euler(
        (deg[0] * Math.PI) / 180, (deg[1] * Math.PI) / 180, (deg[2] * Math.PI) / 180, 'XYZ',
      );
      const q = new THREE.Quaternion().setFromEuler(e);
      onTransformChange({ position: transform.position, rotation: [q.x, q.y, q.z, q.w] });
    }
  };

  const unit = mode === 'translate' ? 'mm' : '°';

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title={scope === 'all' ? 'Move All' : 'Move Body'} icon={<Move size={14} />} />

        <div style={styles.section}>
          <div style={styles.seg}>
            <button type="button" style={segBtn(mode === 'translate')} onClick={() => onModeChange('translate')}>Move</button>
            <button type="button" style={segBtn(mode === 'rotate')} onClick={() => onModeChange('rotate')}>Rotate</button>
          </div>
        </div>

        <div style={styles.section}>
          {AXES.map((ax, i) => (
            <div key={ax} style={styles.fieldRow}>
              <span style={{ ...styles.axisLabel, color: AXIS_COLORS[i] }}>{ax}</span>
              <input
                style={styles.input}
                type="text"
                value={buf[i] ?? ''}
                onChange={e => setBuf(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                onFocus={() => setEditing(i)}
                onBlur={() => { setEditing(null); commitField(i); }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitField(i); (e.target as HTMLInputElement).blur(); } }}
              />
              <span style={styles.unit}>{unit}</span>
            </div>
          ))}
        </div>

        <div style={styles.hint}>Drag the handles or type values. Cancel reverts; Done keeps.</div>

        <div style={styles.actions}>
          <button type="button" style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button type="button" style={styles.doneBtn} onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  );
}

const AXIS_COLORS = ['#d4453f', '#2e9e3f', '#3168d6'];

function segBtn(active: boolean): React.CSSProperties {
  return {
    flex: 1, height: 26, border: '1px solid #d0d0d0', borderRadius: 5, fontSize: 12,
    cursor: 'pointer', transition: 'background 0.1s',
    background: active ? '#3b82f6' : '#f5f5f5', color: active ? '#fff' : '#555',
    fontWeight: active ? 700 : 500,
  };
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', top: 12, right: 12, zIndex: 50, pointerEvents: 'auto' },
  panel: {
    background: '#fff', border: '1px solid #d0d0d0', borderRadius: 8,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)', width: 220, overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  section: { padding: '8px 12px', borderBottom: '1px solid #f0f0f0' },
  seg: { display: 'flex', gap: 4 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
  axisLabel: { width: 14, fontSize: 12, fontWeight: 700, textAlign: 'center', flexShrink: 0 },
  input: {
    flex: 1, height: 26, padding: '0 8px', border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, fontFamily: 'monospace', color: '#333', outline: 'none', textAlign: 'right',
    minWidth: 0,
  },
  unit: { fontSize: 11, color: '#999', width: 18, flexShrink: 0 },
  hint: { fontSize: 11, color: '#aaa', fontStyle: 'italic', padding: '8px 12px' },
  actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '0 12px 12px' },
  cancelBtn: {
    height: 28, padding: '0 14px', border: '1px solid #d0d0d0', borderRadius: 5,
    background: '#f5f5f5', color: '#555', fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },
  doneBtn: {
    height: 28, padding: '0 18px', border: 'none', borderRadius: 5,
    background: '#3b82f6', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
};

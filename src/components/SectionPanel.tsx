/**
 * SectionPanel — controls for the Section view (Inspect).
 *
 * Section view is a non-destructive cut: it clips the bodies with a plane so
 * you can see inside, with a drag handle in the viewport to slide the cut
 * along its normal. This panel just chooses the cut orientation, flips which
 * side is kept, and ends the mode. The actual clipping + drag handle live in
 * the ViewportController (see setSectionPlane / flipSection).
 */

import { PanelHeader } from './PanelHeader.tsx';

export type SectionOrientation = 'XY' | 'XZ' | 'YZ';

interface SectionPanelProps {
  orientation: SectionOrientation;
  onOrientationChange: (o: SectionOrientation) => void;
  onFlip: () => void;
  onDone: () => void;
}

const ORIENTATIONS: { id: SectionOrientation; label: string }[] = [
  { id: 'XY', label: 'XY' },
  { id: 'XZ', label: 'XZ' },
  { id: 'YZ', label: 'YZ' },
];

export function SectionPanel({ orientation, onOrientationChange, onFlip, onDone }: SectionPanelProps) {
  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Section" icon={<span style={styles.headerIcon}>◧</span>} onClose={onDone} closeTitle="End section (Esc)" />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Plane</div>
          <div style={styles.segmented}>
            {ORIENTATIONS.map(o => {
              const active = o.id === orientation;
              return (
                <button
                  key={o.id}
                  type="button"
                  style={{
                    ...styles.segBtn,
                    background: active ? '#3b82f6' : '#f5f5f5',
                    color: active ? '#fff' : '#555',
                    fontWeight: active ? 700 : 500,
                  }}
                  onClick={() => onOrientationChange(o.id)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={styles.actions}>
          <button
            style={styles.flipBtn}
            onClick={onFlip}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#eee'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f5f5f5'; }}
          >
            Flip side
          </button>
          <button
            style={styles.doneBtn}
            onClick={onDone}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#2563eb'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#3b82f6'; }}
          >
            Done
          </button>
        </div>

        <div style={styles.hint}>Drag the handle in the viewport to move the cut.</div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', top: 12, right: 12, zIndex: 50, pointerEvents: 'auto' },
  panel: {
    background: '#fff', border: '1px solid #d0d0d0', borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)', width: 240, overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
    borderBottom: '1px solid #e8e8e8', background: '#fafafa',
  },
  headerIcon: { fontSize: 15, color: '#059669', fontWeight: 700, width: 16, textAlign: 'center' },
  headerTitle: { flex: 1, fontSize: 13, fontWeight: 600, color: '#333' },
  closeBtn: {
    width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', borderRadius: 4, color: '#888', cursor: 'pointer', padding: 0,
  },
  section: { padding: '10px 12px', borderBottom: '1px solid #f0f0f0' },
  sectionLabel: {
    fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase',
    letterSpacing: 0.3, marginBottom: 6,
  },
  segmented: { display: 'flex', gap: 4 },
  segBtn: {
    flex: 1, height: 30, border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, cursor: 'pointer', transition: 'background 0.1s',
  },
  actions: { display: 'flex', gap: 8, padding: '10px 12px', justifyContent: 'space-between' },
  flipBtn: {
    height: 30, padding: '0 14px', border: '1px solid #d0d0d0', borderRadius: 5,
    background: '#f5f5f5', color: '#555', cursor: 'pointer', fontSize: 12, fontWeight: 500,
  },
  doneBtn: {
    height: 30, padding: '0 20px', border: 'none', borderRadius: 5,
    background: '#3b82f6', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  hint: { fontSize: 11, color: '#aaa', fontStyle: 'italic', padding: '0 12px 12px' },
};

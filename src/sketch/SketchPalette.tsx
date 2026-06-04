/**
 * SketchPalette - Right-side options panel during sketch mode.
 *
 * A sketch palette of display toggles and line type.
 * The actual geometry/constraint tools live in the MainToolbar.
 *
 * Options:
 * - Linetype: Normal / Construction toggle
 * - Look At: Reset view to face the sketch plane
 * - Sketch Grid: Show/hide grid
 * - Snap: Enable/disable grid snapping
 * - Profile: Show/hide detected closed profiles
 * - Points: Show/hide sketch points
 * - Dimensions: Show/hide dimension labels
 * - Constraints: Show/hide constraint icons
 * - Construction Geometries: Show/hide construction lines
 * - Finish Sketch button
 */

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSketchEditorStore } from './SketchEditorStore.ts';

// ---- Props ----

interface SketchPaletteProps {
  onFinishSketch: () => void;
}

// ---- Component ----

export function SketchPalette({ onFinishSketch }: SketchPaletteProps) {
  const [collapsed, setCollapsed] = useState(false);
  const gridSnapEnabled = useSketchEditorStore(s => s.gridSnapEnabled);
  const setGridSnap = useSketchEditorStore(s => s.setGridSnap);
  const points = useSketchEditorStore(s => s.points);
  const geometries = useSketchEditorStore(s => s.geometries);
  const selectedGeoIds = useSketchEditorStore(s => s.selectedGeometryIds);
  const selectedPtIds = useSketchEditorStore(s => s.selectedPointIds);

  // Collapsed view: thin vertical tab pinned to the right edge with the
  // label rotated 90°. Click the tab to expand. Collapses to the SIDE not
  // upward, so the viewport reclaims width without leaving an awkward
  // tall slim strip across the top of the right gutter.
  if (collapsed) {
    return (
      <button
        type="button"
        style={styles.collapsedTab}
        onClick={() => setCollapsed(false)}
      >
        <ChevronLeft size={14} />
        <span style={styles.collapsedLabel}>SKETCH PALETTE</span>
      </button>
    );
  }

  // Display options state (local - controls what's visible in the 3D view)
  // These will be wired to the SketchSceneManager in future iterations

  // Selected entity info for the bottom of the palette
  let selectedInfo: { type: string; props: { label: string; value: string }[] } | null = null;

  if (selectedGeoIds.size === 1) {
    const geoId = [...selectedGeoIds][0]!;
    const geom = geometries.get(geoId);
    if (geom) {
      switch (geom.type) {
        case 'line': {
          const start = points.get(geom.startId);
          const end = points.get(geom.endId);
          if (start && end) {
            const length = Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
            selectedInfo = {
              type: geom.construction ? 'Construction Line' : 'Line',
              props: [
                { label: 'Start', value: `(${start.x.toFixed(1)}, ${start.y.toFixed(1)})` },
                { label: 'End', value: `(${end.x.toFixed(1)}, ${end.y.toFixed(1)})` },
                { label: 'Length', value: `${length.toFixed(2)} mm` },
              ],
            };
          }
          break;
        }
        case 'circle': {
          const center = points.get(geom.centerId);
          if (center) {
            selectedInfo = {
              type: geom.construction ? 'Construction Circle' : 'Circle',
              props: [
                { label: 'Center', value: `(${center.x.toFixed(1)}, ${center.y.toFixed(1)})` },
                { label: 'Radius', value: `${geom.radius.toFixed(2)} mm` },
                { label: 'Diameter', value: `${(geom.radius * 2).toFixed(2)} mm` },
              ],
            };
          }
          break;
        }
        case 'arc': {
          const center = points.get(geom.centerId);
          if (center) {
            selectedInfo = {
              type: 'Arc',
              props: [
                { label: 'Center', value: `(${center.x.toFixed(1)}, ${center.y.toFixed(1)})` },
                { label: 'Radius', value: `${geom.radius.toFixed(2)} mm` },
              ],
            };
          }
          break;
        }
      }
    }
  } else if (selectedPtIds.size === 1) {
    const ptId = [...selectedPtIds][0]!;
    const pt = points.get(ptId);
    if (pt) {
      selectedInfo = {
        type: 'Point',
        props: [
          { label: 'X', value: `${pt.x.toFixed(2)} mm` },
          { label: 'Y', value: `${pt.y.toFixed(2)} mm` },
        ],
      };
    }
  }

  const toggleConstruction = () => {
    if (selectedGeoIds.size !== 1) return;
    const geoId = [...selectedGeoIds][0]!;
    const state = useSketchEditorStore.getState();
    const geom = state.geometries.get(geoId);
    if (geom) {
      state.updateGeometry(geoId, { construction: !geom.construction });
    }
  };

  const isConstruction = selectedGeoIds.size === 1
    ? (() => {
        const geoId = [...selectedGeoIds][0]!;
        const geom = geometries.get(geoId);
        return geom?.construction ?? false;
      })()
    : false;

  return (
    <div style={styles.panel}>
      {/* Header with collapse button (whole header is the toggle target) */}
      <button
        type="button"
        style={{ ...styles.header, ...styles.headerButton }}
        onClick={() => setCollapsed(true)}
      >
        <span>SKETCH PALETTE</span>
        <ChevronRight size={14} />
      </button>

      {/* Options */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>Options</div>

        {/* Linetype */}
        <div style={styles.optionRow}>
          <span style={styles.optionLabel}>Linetype</span>
          <div style={styles.linetypeToggle}>
            <button
              style={{
                ...styles.linetypeBtn,
                ...(selectedGeoIds.size === 1 && !isConstruction ? styles.linetypeBtnActive : {}),
              }}
              onClick={() => { if (isConstruction) toggleConstruction(); }}
              title="Normal"
              disabled={selectedGeoIds.size !== 1}
            >
              <svg width="16" height="2" viewBox="0 0 16 2"><line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeWidth="2"/></svg>
            </button>
            <button
              style={{
                ...styles.linetypeBtn,
                ...(selectedGeoIds.size === 1 && isConstruction ? styles.linetypeBtnActive : {}),
              }}
              onClick={() => { if (!isConstruction) toggleConstruction(); }}
              title="Construction"
              disabled={selectedGeoIds.size !== 1}
            >
              <svg width="16" height="2" viewBox="0 0 16 2"><line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeWidth="2" strokeDasharray="3,2"/></svg>
            </button>
          </div>
        </div>

        {/* Checkboxes */}
        <OptionCheckbox label="Sketch Grid" checked={true} onChange={() => {}} />
        <OptionCheckbox label="Snap" checked={gridSnapEnabled} onChange={setGridSnap} />
        <OptionCheckbox label="Profile" checked={true} onChange={() => {}} />
        <OptionCheckbox label="Points" checked={true} onChange={() => {}} />
        <OptionCheckbox label="Dimensions" checked={true} onChange={() => {}} />
        <OptionCheckbox label="Constraints" checked={true} onChange={() => {}} />
        <OptionCheckbox label="Construction Geometries" checked={true} onChange={() => {}} />
      </div>

      {/* Selected entity properties */}
      {selectedInfo && (
        <div style={styles.section}>
          <div style={styles.sectionHeader}>{selectedInfo.type}</div>
          {selectedInfo.props.map((p) => (
            <div key={p.label} style={styles.propRow}>
              <span style={styles.propLabel}>{p.label}</span>
              <span style={styles.propValue}>{p.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Sketch info */}
      <div style={styles.section}>
        <div style={styles.propRow}>
          <span style={styles.propLabel}>Entities</span>
          <span style={styles.propValue}>{geometries.size}</span>
        </div>
        <div style={styles.propRow}>
          <span style={styles.propLabel}>Points</span>
          <span style={styles.propValue}>{points.size}</span>
        </div>
      </div>

      {/* Finish Sketch */}
      <div style={styles.finishSection}>
        <button style={styles.finishBtn} onClick={onFinishSketch}>
          Finish Sketch
        </button>
      </div>
    </div>
  );
}

// ---- OptionCheckbox ----

function OptionCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div style={styles.optionRow}>
      <span style={styles.optionLabel}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={styles.checkbox}
      />
    </div>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    // Flush against the right viewport edge below the ViewCube overlay.
    // Only the inside (left) corners are rounded so the panel looks
    // attached rather than floating.
    top: 140,
    right: 0,
    width: 220,
    maxHeight: 'calc(100% - 148px)',
    background: '#ffffff',
    borderLeft: '1px solid #d0d0d0',
    borderTop: '1px solid #d0d0d0',
    borderBottom: '1px solid #d0d0d0',
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
    fontSize: 12,
    color: '#333',
    zIndex: 10,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '6px 8px 6px 12px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.5,
    color: '#555',
    borderBottom: '1px solid #ececec',
    background: '#f5f5f5',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    minHeight: 28,
    boxSizing: 'border-box' as const,
  },
  headerButton: {
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'inherit',
  },
  section: {
    padding: '8px 12px',
    borderBottom: '1px solid #e8e8e8',
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: 600,
    color: '#333',
    marginBottom: 6,
  },
  optionRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '3px 0',
  },
  optionLabel: {
    color: '#444',
    fontSize: 12,
  },
  checkbox: {
    margin: 0,
    cursor: 'pointer',
    width: 14,
    height: 14,
  },
  linetypeToggle: {
    display: 'flex',
    gap: 2,
  },
  linetypeBtn: {
    width: 28,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #ccc',
    borderRadius: 3,
    background: '#fff',
    color: '#666',
    cursor: 'pointer',
    padding: 0,
  },
  linetypeBtnActive: {
    background: '#3b82f6',
    color: '#fff',
    borderColor: '#2563eb',
  },
  propRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '2px 0',
  },
  propLabel: {
    color: '#777',
    fontSize: 11,
  },
  propValue: {
    color: '#333',
    fontWeight: 500,
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
  },
  finishSection: {
    padding: '10px 12px',
    marginTop: 'auto',
  },
  finishBtn: {
    width: '100%',
    padding: '7px 12px',
    fontSize: 12,
    fontWeight: 600,
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    background: '#fff',
    color: '#333',
    cursor: 'pointer',
    textAlign: 'center',
  },
  // Collapsed tab — vertical strip flush against the right edge. ~26px
  // wide so it takes minimal viewport real estate but stays clickable.
  // Label rotated CCW so it reads bottom-up like a side tab. Only the
  // inside (left) corners are rounded so it looks attached, not floating.
  collapsedTab: {
    position: 'absolute',
    top: 140,
    right: 0,
    width: 26,
    minHeight: 140,
    background: '#f5f5f5',
    borderLeft: '1px solid #d0d0d0',
    borderTop: '1px solid #d0d0d0',
    borderBottom: '1px solid #d0d0d0',
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
    zIndex: 10,
    cursor: 'pointer',
    padding: '8px 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    color: '#555',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  collapsedLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.5,
    writingMode: 'vertical-rl' as const,
    transform: 'rotate(180deg)',
    userSelect: 'none' as const,
  },
};

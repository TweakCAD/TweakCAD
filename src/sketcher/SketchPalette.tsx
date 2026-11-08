/**
 * The sketch palette: the panel at the right of the viewport while a sketch
 * is edited, with the sketch tools, constraints and dimensions, the line
 * type and display options, what is selected and the constraints on it, and
 * Finish Sketch. It reads and drives one `SketchSession`.
 */
import { useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  ArcToolIcon,
  CircleToolIcon,
  CoincidentConstraintIcon,
  DimensionToolIcon,
  DistanceXToolIcon,
  DistanceYToolIcon,
  EqualConstraintIcon,
  FixConstraintIcon,
  HorizontalConstraintIcon,
  LineToolIcon,
  MidpointConstraintIcon,
  ParallelConstraintIcon,
  PerpendicularConstraintIcon,
  PointOnCircleConstraintIcon,
  PointOnLineConstraintIcon,
  PointToolIcon,
  RectToolIcon,
  SelectHandIcon,
  HVConstraintIcon,
  CollinearConstraintIcon,
  ConcentricConstraintIcon,
  SymmetryConstraintIcon,
  TangentConstraintIcon,
  VerticalConstraintIcon,
} from '../icons/cadIcons';
import { CONSTRAINT_KINDS, CONSTRAINT_LABELS, type ConstraintKind } from './constraints';
import type { SketchOptions, SketchSession, SketchSessionState, SketchTool } from './session';

type Icon = (props: { size?: number; color?: string }) => ReactElement;

const TOOLS: { id: SketchTool; label: string; icon: Icon; key?: string }[] = [
  { id: 'select', label: 'Select', icon: SelectHandIcon },
  { id: 'line', label: 'Line', icon: LineToolIcon, key: 'L' },
  { id: 'rectangle', label: 'Rectangle', icon: RectToolIcon, key: 'R' },
  { id: 'circle', label: 'Circle', icon: CircleToolIcon, key: 'C' },
  { id: 'arc', label: '3-Point Arc', icon: ArcToolIcon, key: 'A' },
  { id: 'point', label: 'Point', icon: PointToolIcon, key: 'P' },
];

const DIMENSION_TOOLS: { id: SketchTool; label: string; icon: Icon; key?: string }[] = [
  { id: 'dimension', label: 'Dimension', icon: DimensionToolIcon, key: 'D' },
  { id: 'dimensionX', label: 'Horizontal Dimension', icon: DistanceXToolIcon },
  { id: 'dimensionY', label: 'Vertical Dimension', icon: DistanceYToolIcon },
];

const CONSTRAINT_ICONS: Record<ConstraintKind, Icon> = {
  coincident: CoincidentConstraintIcon,
  pointOnLine: PointOnLineConstraintIcon,
  pointOnCircle: PointOnCircleConstraintIcon,
  horizontal: HorizontalConstraintIcon,
  vertical: VerticalConstraintIcon,
  parallel: ParallelConstraintIcon,
  perpendicular: PerpendicularConstraintIcon,
  equal: EqualConstraintIcon,
  tangent: TangentConstraintIcon,
  midpoint: MidpointConstraintIcon,
  fix: FixConstraintIcon,
  hv: HVConstraintIcon,
  collinear: CollinearConstraintIcon,
  concentric: ConcentricConstraintIcon,
  symmetric: SymmetryConstraintIcon,
};

/** Names of the constraint kinds a selected row can carry (8.2). */
const KIND_NAMES: Record<string, string> = {
  ...CONSTRAINT_LABELS,
  fixed: 'Fix',
  block: 'Block',
  pointOnCurve: 'Point on curve',
  concentric: 'Concentric',
  collinear: 'Collinear',
  symmetric: 'Symmetric',
  distance: 'Distance',
  distanceX: 'Horizontal distance',
  distanceY: 'Vertical distance',
  length: 'Length',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
  point: 'Point',
  region: 'Profile',
};

const OPTIONS: { key: keyof SketchOptions; label: string }[] = [
  { key: 'grid', label: 'Sketch Grid' },
  { key: 'gridSnap', label: 'Snap' },
  { key: 'profile', label: 'Profile' },
  { key: 'points', label: 'Points' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'constraints', label: 'Constraints' },
  { key: 'construction', label: 'Construction Geometries' },
];

export interface SketchPaletteProps {
  session: SketchSession;
  onFinish: () => void;
}

export function SketchPalette({ session, onFinish }: SketchPaletteProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <button type="button" style={styles.collapsedTab} onClick={() => setCollapsed(false)}>
        <ChevronLeft size={14} />
        <span style={styles.collapsedLabel}>SKETCH PALETTE</span>
      </button>
    );
  }

  const selectedCurves = state.selected.filter((s) => isCurve(s.kind));
  const construction = selectedCurves.length > 0 ? selectedCurves.every((s) => s.construction) : state.construction;
  const setLinetype = (on: boolean) => {
    if (selectedCurves.length > 0)
      session.setConstruction(
        selectedCurves.map((s) => s.id),
        on,
      );
    else session.setConstructionMode(on);
  };

  return (
    <div style={styles.panel} data-testid="sketch-palette">
      <button type="button" style={{ ...styles.header, ...styles.headerButton }} onClick={() => setCollapsed(true)}>
        <span>SKETCH PALETTE</span>
        <ChevronRight size={14} />
      </button>

      <div style={styles.scroll}>
        <Section title="Create">
          <ToolGrid tools={TOOLS} state={state} session={session} />
        </Section>

        <Section title="Constrain">
          <div style={styles.grid}>
            {CONSTRAINT_KINDS.map((kind) => {
              const Icon = CONSTRAINT_ICONS[kind];
              const active = state.tool === 'constrain' && state.constraint === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  title={CONSTRAINT_LABELS[kind]}
                  aria-label={CONSTRAINT_LABELS[kind]}
                  aria-pressed={active}
                  style={{ ...styles.toolBtn, ...(active ? styles.toolBtnActive : {}) }}
                  onClick={() => session.constrain(kind)}
                >
                  <Icon size={18} {...(active ? { color: '#ffffff' } : {})} />
                </button>
              );
            })}
          </div>
        </Section>

        <Section title="Dimension">
          <ToolGrid tools={DIMENSION_TOOLS} state={state} session={session} />
        </Section>

        <Section title="Options">
          <div style={styles.optionRow}>
            <span style={styles.optionLabel}>Linetype</span>
            <div style={styles.linetypeToggle}>
              <button
                type="button"
                title="Normal"
                aria-label="Normal"
                style={{ ...styles.linetypeBtn, ...(!construction ? styles.linetypeBtnActive : {}) }}
                onClick={() => setLinetype(false)}
              >
                <svg width="16" height="2" viewBox="0 0 16 2">
                  <line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeWidth="2" />
                </svg>
              </button>
              <button
                type="button"
                title="Construction"
                aria-label="Construction"
                style={{ ...styles.linetypeBtn, ...(construction ? styles.linetypeBtnActive : {}) }}
                onClick={() => setLinetype(true)}
              >
                <svg width="16" height="2" viewBox="0 0 16 2">
                  <line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeWidth="2" strokeDasharray="3,2" />
                </svg>
              </button>
            </div>
          </div>
          {OPTIONS.map((o) => (
            <label key={o.key} style={styles.optionRow}>
              <span style={styles.optionLabel}>{o.label}</span>
              <input
                type="checkbox"
                checked={state.options[o.key]}
                onChange={(e) => session.setOptions({ [o.key]: e.target.checked })}
                style={styles.checkbox}
              />
            </label>
          ))}
        </Section>

        {state.message && (
          <div style={styles.section}>
            <div style={styles.message} role="status">
              {state.message}
            </div>
          </div>
        )}

        {state.selected.length > 0 && (
          <Section
            title={
              state.details?.title ??
              (state.selected.length === 1
                ? (KIND_NAMES[state.selected[0]?.kind ?? ''] ?? 'Selection')
                : `${state.selected.length} selected`)
            }
          >
            {state.details?.props.map((p) => (
              <InfoRow key={p.label} label={p.label} value={p.value} />
            ))}
            {uniqueConstraints(state).map((c) => (
              <div key={c.id} style={styles.propRow}>
                <span style={styles.propLabel}>{KIND_NAMES[c.kind] ?? c.kind}</span>
                <button
                  type="button"
                  title="Delete constraint"
                  aria-label="Delete constraint"
                  style={styles.removeBtn}
                  onClick={() => session.removeConstraints([c.id])}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </Section>
        )}

        <div style={styles.section}>
          <InfoRow label="Curves" value={String(state.counts.curves)} />
          <InfoRow label="Points" value={String(state.counts.points)} />
          <InfoRow label="Constraints" value={String(state.counts.constraints)} />
          {state.dof !== null && (
            <InfoRow label="Degrees of freedom" value={state.dof === 0 ? 'Fully defined' : String(state.dof)} />
          )}
        </div>
      </div>

      <div style={styles.finishSection}>
        <button type="button" style={styles.finishBtn} onClick={onFinish}>
          Finish Sketch
        </button>
      </div>
    </div>
  );
}

const CURVE_KINDS = new Set([
  'line',
  'circle',
  'arc',
  'ellipse',
  'ellipticalArc',
  'spline',
  'bezier',
  'nurbs',
  'conic',
  'external',
]);
const isCurve = (kind: string) => CURVE_KINDS.has(kind);

function uniqueConstraints(state: SketchSessionState): { id: string; kind: string }[] {
  const seen = new Map<string, { id: string; kind: string }>();
  for (const s of state.selected) for (const c of s.constraints) seen.set(c.id, c);
  return [...seen.values()];
}

function ToolGrid({
  tools,
  state,
  session,
}: {
  tools: typeof TOOLS;
  state: SketchSessionState;
  session: SketchSession;
}) {
  return (
    <div style={styles.grid}>
      {tools.map((t) => {
        const active = state.tool === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            title={t.key ? `${t.label} (${t.key})` : t.label}
            aria-label={t.label}
            aria-pressed={active}
            style={{ ...styles.toolBtn, ...(active ? styles.toolBtnActive : {}) }}
            onClick={() => session.setTool(t.id)}
          >
            <Icon size={18} color={active ? '#ffffff' : '#444444'} />
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>{title}</div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.propRow}>
      <span style={styles.propLabel}>{label}</span>
      <span style={styles.propValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    position: 'absolute',
    top: 140,
    right: 0,
    width: 220,
    // Above the viewport toolbar in the bottom-right corner.
    maxHeight: 'calc(100% - 200px)',
    background: '#ffffff',
    borderLeft: '1px solid #d0d0d0',
    borderTop: '1px solid #d0d0d0',
    borderBottom: '1px solid #d0d0d0',
    borderTopLeftRadius: 6,
    borderBottomLeftRadius: 6,
    boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
    fontSize: 12,
    color: '#333',
    zIndex: 10,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  scroll: { overflowY: 'auto', minHeight: 0 },
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
    boxSizing: 'border-box',
  },
  headerButton: { border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' },
  section: { padding: '8px 12px', borderBottom: '1px solid #e8e8e8' },
  sectionHeader: { fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 6 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(6, 28px)', gap: 3 },
  toolBtn: {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#ccc',
    borderRadius: 3,
    background: '#fff',
    color: '#444',
    cursor: 'pointer',
    padding: 0,
  },
  toolBtnActive: { background: '#3b82f6', color: '#fff', borderColor: '#2563eb' },
  optionRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' },
  optionLabel: { color: '#444', fontSize: 12 },
  checkbox: { margin: 0, cursor: 'pointer', width: 14, height: 14 },
  linetypeToggle: { display: 'flex', gap: 2 },
  linetypeBtn: {
    width: 28,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#ccc',
    borderRadius: 3,
    background: '#fff',
    color: '#666',
    cursor: 'pointer',
    padding: 0,
  },
  linetypeBtnActive: { background: '#3b82f6', color: '#fff', borderColor: '#2563eb' },
  message: {
    fontSize: 11,
    color: '#92400e',
    background: '#fffbeb',
    border: '1px solid #fcd34d',
    borderRadius: 3,
    padding: '4px 6px',
  },
  propRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' },
  propLabel: { color: '#777', fontSize: 11 },
  propValue: { color: '#333', fontWeight: 500, fontSize: 11, fontFamily: 'ui-monospace, monospace' },
  removeBtn: {
    border: 'none',
    background: 'transparent',
    color: '#999',
    cursor: 'pointer',
    padding: 2,
    display: 'inline-flex',
  },
  finishSection: { padding: '10px 12px', marginTop: 'auto', borderTop: '1px solid #e8e8e8' },
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
    writingMode: 'vertical-rl',
    transform: 'rotate(180deg)',
    userSelect: 'none',
  },
};

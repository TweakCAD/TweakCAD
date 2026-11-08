/**
 * The sketch browser: every curve, text and constraint of the sketch being
 * edited, in a panel flush with the viewport's upper-left corner,
 * collapsible, starting collapsed. Its header carries a
 * lock, closed when the sketch is fully defined and open while degrees of
 * freedom are left, collapsed or not. A row's click selects it (Shift adds),
 * its hover highlights it (a constraint's, the geometry it holds), and its
 * buttons toggle construction or delete it. A constraint row names what it
 * holds. Overlapping geometry is told apart here.
 */
import { useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, Lock, LockOpen, X } from 'lucide-react';
import {
  ArcToolIcon,
  CircleToolIcon,
  CoincidentConstraintIcon,
  CollinearConstraintIcon,
  ConcentricConstraintIcon,
  DimensionToolIcon,
  EllipseToolIcon,
  EqualConstraintIcon,
  FixConstraintIcon,
  HorizontalConstraintIcon,
  LineToolIcon,
  MidpointConstraintIcon,
  OffsetToolIcon,
  ParallelConstraintIcon,
  PerpendicularConstraintIcon,
  PointToolIcon,
  ProjectToolIcon,
  SplineToolIcon,
  SymmetryConstraintIcon,
  TangentConstraintIcon,
  TextToolIcon,
  VerticalConstraintIcon,
} from '../icons/cadIcons';
import type { BrowsedRow, SketchSession } from './session';

type Icon = (props: { size?: number; color?: string }) => ReactElement;

const ICONS: Record<string, Icon> = {
  line: LineToolIcon,
  circle: CircleToolIcon,
  arc: ArcToolIcon,
  ellipse: EllipseToolIcon,
  ellipticalArc: EllipseToolIcon,
  spline: SplineToolIcon,
  bezier: SplineToolIcon,
  conic: SplineToolIcon,
  nurbs: SplineToolIcon,
  point: PointToolIcon,
  external: ProjectToolIcon,
  text: TextToolIcon,
  horizontal: HorizontalConstraintIcon,
  vertical: VerticalConstraintIcon,
  parallel: ParallelConstraintIcon,
  perpendicular: PerpendicularConstraintIcon,
  collinear: CollinearConstraintIcon,
  equal: EqualConstraintIcon,
  tangent: TangentConstraintIcon,
  concentric: ConcentricConstraintIcon,
  coradial: ConcentricConstraintIcon,
  midpoint: MidpointConstraintIcon,
  symmetric: SymmetryConstraintIcon,
  pointOnCurve: CoincidentConstraintIcon,
  fixed: FixConstraintIcon,
  block: FixConstraintIcon,
  offset: OffsetToolIcon,
};

export interface SketchBrowserProps {
  session: SketchSession;
  /** Whether it opens collapsed; true unless given. */
  startCollapsed?: boolean;
}

export function SketchBrowser({ session, startCollapsed = true }: SketchBrowserProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  // Starts collapsed so it does not crowd the viewport until it is asked for.
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const [open, setOpen] = useState({ geometry: true, constraints: true });
  if (!state.open) return null;
  const dof = state.dof;
  const stateLabel =
    dof === null ? 'Does not solve' : dof === 0 ? 'Fully constrained' : `Under-constrained · ${dof} DOF`;
  const lock =
    dof === 0 ? (
      <Lock size={12} color="#1a6fd1" strokeWidth={2} aria-label={stateLabel} />
    ) : dof !== null ? (
      <LockOpen size={12} color="#9ca3af" strokeWidth={2} aria-label={stateLabel} />
    ) : null;
  const header = (
    <button
      type="button"
      style={{ ...styles.header, ...styles.headerButton }}
      title={stateLabel}
      onClick={() => setCollapsed(!collapsed)}
    >
      <span>SKETCH BROWSER</span>
      <span style={styles.headerEnd}>
        {lock}
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </span>
    </button>
  );
  if (collapsed) return <div style={{ ...styles.panel, height: 'auto' }}>{header}</div>;
  const rows = session.browse();
  const status =
    state.dof === null
      ? 'Does not solve'
      : state.dof === 0
        ? 'Fully defined'
        : `${state.dof} degree${state.dof === 1 ? '' : 's'} of freedom`;
  const tone = state.dof === null ? styles.statusBad : state.dof === 0 ? styles.statusDone : styles.statusOpen;
  return (
    <div style={styles.panel} data-testid="sketch-browser" onPointerLeave={() => session.highlight(null)}>
      {header}
      <div style={{ ...styles.status, ...tone }}>{status}</div>
      <div style={styles.body}>
        <Section
          title="Geometry"
          count={rows.geometry.length}
          open={open.geometry}
          onToggle={() => setOpen({ ...open, geometry: !open.geometry })}
        >
          {rows.geometry.length === 0 ? (
            <div style={styles.empty}>No geometry yet.</div>
          ) : (
            rows.geometry.map((r) => (
              <Row
                key={r.id}
                row={r}
                selected={state.selection.includes(r.id)}
                session={session}
                {...(r.kind !== 'text'
                  ? { onConstruction: () => session.setConstruction([r.id], !r.construction) }
                  : {})}
              />
            ))
          )}
        </Section>
        <Section
          title="Constraints"
          count={rows.constraints.length}
          open={open.constraints}
          onToggle={() => setOpen({ ...open, constraints: !open.constraints })}
        >
          {rows.constraints.length === 0 ? (
            <div style={styles.empty}>No constraints yet.</div>
          ) : (
            rows.constraints.map((r) => (
              <Row key={r.id} row={r} selected={state.selection.includes(r.id)} session={session} />
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.section}>
      <button type="button" style={styles.sectionHeader} onClick={onToggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span style={styles.sectionTitle}>{title}</span>
        <span style={styles.sectionCount}>{count}</span>
      </button>
      {open && <div style={styles.sectionBody}>{children}</div>}
    </div>
  );
}

function Row({
  row,
  selected,
  session,
  onConstruction,
}: {
  row: BrowsedRow;
  selected: boolean;
  session: SketchSession;
  onConstruction?: () => void;
}) {
  const Icon = ICONS[row.kind] ?? DimensionToolIcon;
  const remove = () =>
    row.kind === 'text' || !('active' in row) ? session.deleteRows([row.id]) : session.removeConstraints([row.id]);
  return (
    <div
      role="button"
      tabIndex={0}
      style={{
        ...styles.row,
        ...(selected ? styles.rowSelected : {}),
        ...(row.active === false ? styles.rowInactive : {}),
      }}
      onMouseEnter={() => session.highlight(row.id)}
      onClick={(e) => session.select([row.id], e.shiftKey)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') session.select([row.id]);
      }}
    >
      <span style={styles.rowIcon}>
        <Icon size={14} color={row.construction ? '#964B00' : '#555'} />
      </span>
      <span style={styles.rowLabel}>
        {row.label}
        {row.sub && <span style={styles.rowSub}> · {row.sub}</span>}
      </span>
      {onConstruction && (
        <button
          type="button"
          title={row.construction ? 'Make normal' : 'Make construction'}
          aria-label={row.construction ? 'Make normal' : 'Make construction'}
          style={{ ...styles.rowButton, color: row.construction ? '#964B00' : '#9ca3af' }}
          onClick={(e) => {
            e.stopPropagation();
            onConstruction();
          }}
        >
          <svg width="12" height="2" viewBox="0 0 12 2">
            <line x1="0" y1="1" x2="12" y2="1" stroke="currentColor" strokeWidth="2" strokeDasharray="3,2" />
          </svg>
        </button>
      )}
      <button
        type="button"
        title="Delete"
        aria-label={`Delete ${row.label}`}
        style={styles.rowButton}
        onClick={(e) => {
          e.stopPropagation();
          remove();
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 240,
    maxHeight: '100%',
    background: '#ffffff',
    borderRight: '1px solid #d0d0d0',
    borderBottom: '1px solid #d0d0d0',
    borderBottomRightRadius: 6,
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
    boxSizing: 'border-box',
  },
  headerEnd: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  headerButton: { borderWidth: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' },
  status: { padding: '4px 8px', fontSize: 11, fontWeight: 600, borderBottom: '1px solid #d0d0d0', textAlign: 'center' },
  statusBad: { background: '#fde7e7', color: '#c1262d' },
  statusDone: { background: '#e1efff', color: '#1a6fd1' },
  statusOpen: { background: '#f6f6f6', color: '#666' },
  body: { flex: 1, overflow: 'auto', padding: 4, display: 'flex', flexDirection: 'column', gap: 2 },
  section: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #ececec',
    borderRadius: 4,
    background: '#fafafa',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 6px',
    background: 'transparent',
    borderWidth: 0,
    cursor: 'pointer',
    color: '#555',
    fontFamily: 'inherit',
    textAlign: 'left',
    width: '100%',
  },
  sectionTitle: { fontSize: 11, fontWeight: 600, letterSpacing: 0.3, flex: 1 },
  sectionCount: { fontSize: 10, color: '#888', fontVariantNumeric: 'tabular-nums' },
  sectionBody: { display: 'flex', flexDirection: 'column', padding: '2px 4px 4px 4px', gap: 1 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 4px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 3,
    cursor: 'pointer',
    minHeight: 22,
    fontSize: 11,
    color: '#333',
  },
  rowSelected: { background: '#fffbeb', borderColor: '#f59e0b' },
  rowInactive: { opacity: 0.5 },
  rowIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    flexShrink: 0,
  },
  rowLabel: { flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { color: '#888', fontFamily: 'ui-monospace, monospace', fontSize: 10 },
  rowButton: {
    width: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    background: 'transparent',
    borderRadius: 3,
    color: '#888',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
  },
  empty: { padding: '6px 4px', fontSize: 10, color: '#aaa', fontStyle: 'italic' },
};

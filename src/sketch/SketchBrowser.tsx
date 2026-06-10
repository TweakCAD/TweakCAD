/**
 * SketchBrowser — collapsible panel listing all geometry + constraints in the
 * active sketch.
 *
 * Two sections (each collapsible):
 *   - Geometry: lines, circles, arcs, ellipses, slots, polygons, splines,
 *     standalone points. Click selects in scene; × deletes.
 *   - Constraints: every constraint in the store. Hover surfaces a delete
 *     button. Future work: hover highlights referenced entities.
 *
 * Why floating + collapsible (matching SketchPalette style): when a user has
 * overlapping geometry the browser is the disambiguator — list every line,
 * click the one they meant. Always-available, not buried in a context menu.
 *
 * Lives only during sketchActive; Shell mounts/unmounts based on the same
 * flag used for SketchPalette.
 */

import { useEffect, useMemo, useState } from 'react';
import { consoleLog } from '@tweakcad/core/src/store/consoleStore.ts';
import { dispatchRemoveConstraint, dispatchRemoveSketchEntity } from './sketchDispatch.ts';
import { ChevronDown, ChevronRight, X, AlertTriangle, Lock, LockOpen } from 'lucide-react';
import { useSketchEditorStore } from './SketchEditorStore.ts';
import type {
  HitTarget,
  SketchConstraint,
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from '@tweakcad/core/src/sketch/types.ts';
import { ORIGIN_CONSTRAINT_ID } from '@tweakcad/core/src/sketch/types.ts';
import {
  LineToolIcon,
  CircleToolIcon,
  ArcToolIcon,
  EllipseToolIcon,
  // SlotToolIcon + PolygonToolIcon are not imported here: the editor
  // geometries they iconified are gone; the ribbon tool buttons import
  // these icons directly from the icons module if they still need them.
  SplineToolIcon,
  PointToolIcon,
  HorizontalConstraintIcon,
  VerticalConstraintIcon,
  PerpendicularConstraintIcon,
  ParallelConstraintIcon,
  TangentConstraintIcon,
  EqualConstraintIcon,
  ConcentricConstraintIcon,
  MidpointConstraintIcon,
  CoincidentConstraintIcon,
  FixConstraintIcon,
  DimensionToolIcon,
  PointOnLineConstraintIcon,
  PointOnCircleConstraintIcon,
  SymmetryConstraintIcon,
} from '../icons/cadIcons.tsx';

// ---- Component ----

export function SketchBrowser() {
  // Starts minimized so it doesn't crowd the viewport until the user asks for it.
  const [collapsed, setCollapsed] = useState(true);
  const [geomOpen, setGeomOpen] = useState(true);
  const [conOpen, setConOpen] = useState(true);

  const points = useSketchEditorStore(s => s.points);
  const geometries = useSketchEditorStore(s => s.geometries);
  const constraints = useSketchEditorStore(s => s.constraints);
  const unsatisfied = useSketchEditorStore(s => s.unsatisfiedConstraints);
  const dof = useSketchEditorStore(s => s.dof);
  // Browser × buttons dispatch through the bus (see onDelete handlers
  // below) instead of mutating the editor store directly — without
  // that, deletions only land in the editor; the next bus dispatch
  // triggers hydration which restores the "deleted" entity from the
  // doc.

  // Log under-constrained / unsatisfied state to the dev console so
  // the user has somewhere to read details without crowding the
  // panel. Fires only on state transitions (DOF count change /
  // unsatisfied set change), not on every render.
  useEffect(() => {
    if (unsatisfied.size > 0) {
      consoleLog('warn',
        `Sketch has ${unsatisfied.size} unsatisfied constraint(s) — check the Constraints list for red rows.`,
        'sketch',
      );
      return;
    }
    if (typeof dof === 'number' && dof > 0) {
      // Best-effort hint at what's free. The solver returns a count,
      // not a per-entity DOF breakdown — listing each geometry +
      // whether it has a dimensional constraint is a useful proxy.
      const undimensioned: string[] = [];
      for (const g of geometries.values()) {
        const hasDim = [...constraints.values()].some(c => {
          if (c.type === 'radius' && c.geometryId === g.id) return true;
          if (c.type === 'length' && c.geometryId === g.id) return true;
          return false;
        });
        if (!hasDim && (g.type === 'line' || g.type === 'circle' || g.type === 'arc')) {
          undimensioned.push(`${g.type} ${g.id}`);
        }
      }
      const hint = undimensioned.length > 0
        ? ` Undimensioned: ${undimensioned.join(', ')}.`
        : ' Add dimensions or pin points to the origin.';
      consoleLog('info', `Sketch under-constrained: ${dof} DOF remaining.${hint}`, 'sketch');
    }
  }, [dof, unsatisfied, geometries, constraints]);

  const setGeometryConstruction = useSketchEditorStore(s => s.setGeometryConstruction);
  const setHoveredTarget = useSketchEditorStore(s => s.setHoveredTarget);
  const setHoveredConstraint = useSketchEditorStore(s => s.setHoveredConstraint);
  // Browser is read-only for selection — selection is driven from the viewport.

  // Memoized rows so we don't recompute labels on every render. V9
  // carries `construction` through so the row can render its toggle.
  const geomRows = useMemo(
    () => Array.from(geometries.values()).map(g => ({
      ...describeGeometry(g, points),
      construction: !!g.construction,
    })),
    [geometries, points],
  );
  const conRows = useMemo(
    // Single committed-constraints list. There is no "rolledBack" branch
    // (no editor-store-side `conflictingConstraints` bucket) — rejections
    // never enter editor state, they
    // surface as toasts from `sketchDispatch.dispatchApplyConstraint`.
    //
    // V11.5 · the origin's anchoring `fixed` constraint is hidden — it
    // exists in the store + drives the solver, but users can't delete it
    // (see SketchEditorStore.removeConstraint) so showing it as a row
    // with a useless × button would be noise. The orange origin glyph in
    // the viewport conveys the "this is anchored" affordance.
    () => Array.from(constraints.values())
      .filter(c => c.id !== ORIGIN_CONSTRAINT_ID)
      .map(c => ({
        ...describeConstraint(c, geometries),
        constraint: c,
      })),
    [constraints, geometries],
  );

  // Lock badge in the header bar — closed blue when fully
  // constrained, open grey when under-constrained. Stays visible when
  // the panel is collapsed so the user always knows the sketch state.
  // Mirrors the project-tree row indicator for parity.
  const stateLabel = unsatisfied.size > 0
    ? `${unsatisfied.size} unsatisfied`
    : dof === 0
      ? 'Fully constrained'
      : typeof dof === 'number' && dof > 0
        ? `Under-constrained · ${dof} DOF`
        : null;
  const headerLock = unsatisfied.size > 0
    ? null
    : dof === 0
      ? <Lock size={12} color="#1a6fd1" strokeWidth={2} aria-label="Fully constrained" />
      : typeof dof === 'number' && dof > 0
        ? <LockOpen size={12} color="#9ca3af" strokeWidth={2} aria-label={`Under-constrained · ${dof} DOF`} />
        : null;

  if (collapsed) {
    return (
      <div style={{ ...styles.panel, height: 'auto' }}>
        <button
          type="button"
          style={{ ...styles.header, ...styles.headerButton }}
          onClick={() => setCollapsed(false)}
          {...(stateLabel ? { title: stateLabel } : {})}
        >
          <span>SKETCH BROWSER</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {headerLock}
            <ChevronDown size={14} />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <button
        type="button"
        style={{ ...styles.header, ...styles.headerButton }}
        onClick={() => setCollapsed(true)}
        {...(stateLabel ? { title: stateLabel } : {})}
      >
        <span>SKETCH BROWSER</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {headerLock}
          <ChevronDown size={14} style={{ transform: 'rotate(180deg)' }} />
        </span>
      </button>

      {/* DOF status strip — only renders for the error state. The
          header lock (or its absence) conveys constrained/under-
          constrained; "Solving…" is too transient to flash here.
          Under-constrained details are logged to the dev console
          (see effect below) rather than crowding this panel. */}
      {unsatisfied.size > 0 && (
        <div style={dofStripStyle(dof, true)}>{unsatisfied.size} unsatisfied</div>
      )}

      <div style={styles.body}>
        <Section
          title="Geometry"
          count={geomRows.length}
          open={geomOpen}
          onToggle={() => setGeomOpen(v => !v)}
        >
          {geomRows.length === 0 ? (
            <div style={styles.empty}>No geometry yet.</div>
          ) : (
            geomRows.map(row => (
              <Row
                key={String(row.id)}
                icon={row.icon}
                label={row.label}
                sub={row.sub}
                onHover={(on) => setHoveredTarget(on ? { type: 'geometry', id: row.id } : null)}
                onDelete={() => dispatchRemoveSketchEntity(String(row.id))}
                isConstruction={row.construction}
                onToggleConstruction={() => setGeometryConstruction(row.id, !row.construction)}
              />
            ))
          )}
        </Section>

        <Section
          title="Constraints"
          count={conRows.length}
          open={conOpen}
          onToggle={() => setConOpen(v => !v)}
        >
          {conRows.length === 0 ? (
            <div style={styles.empty}>No constraints yet.</div>
          ) : (
            conRows.map(row => (
              <Row
                key={String(row.id)}
                icon={row.icon}
                label={row.label}
                sub={row.sub}
                warn={unsatisfied.has(row.id)}
                onHover={(on) => setHoveredConstraint(on ? row.constraint : null)}
                onDelete={() => dispatchRemoveConstraint(String(row.id))}
              />
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

// ---- Atoms ----

function Section({
  title, count, open, onToggle, children,
}: {
  title: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode;
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

interface RowProps {
  icon: React.ReactNode;
  label: string;
  sub?: string | undefined;
  onDelete: () => void;
  onHover?: ((on: boolean) => void) | undefined;
  /** When true, the row renders an over-constrained warning badge. */
  warn?: boolean | undefined;
  /**
   * V9 · construction toggle. When `isConstruction` is provided, a small
   * "C" button appears next to delete; clicking calls `onToggleConstruction`
   * with the inverse. Only geometry rows pass these props — constraint
   * rows skip them. Toggle is the only way to flip an existing
   * geometry's construction flag; previously the flag was only set at
   * draw time via the global `constructionMode` toggle.
   */
  isConstruction?: boolean | undefined;
  onToggleConstruction?: (() => void) | undefined;
}

function Row({ icon, label, sub, onDelete, onHover, warn, isConstruction, onToggleConstruction }: RowProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{
        ...styles.row,
        background: warn ? '#fff5f5' : hover ? '#f5f5f5' : 'transparent',
        borderColor: warn ? '#fca5a5' : 'transparent',
        cursor: 'default',
      }}
      onMouseEnter={() => { setHover(true); onHover?.(true); }}
      onMouseLeave={() => { setHover(false); onHover?.(false); }}
      title={warn ? 'Over-constrained — this constraint can\'t be satisfied' : undefined}
    >
      {warn && (
        <span style={styles.warnIcon} title="Over-constrained">
          <AlertTriangle size={11} color="#dc2626" />
        </span>
      )}
      <span style={styles.rowIcon}>{icon}</span>
      <span style={{ ...styles.rowLabel, color: warn ? '#b91c1c' : '#333' }}>
        {label}
        {sub && <span style={styles.rowSub}> · {sub}</span>}
      </span>
      {hover && onToggleConstruction && (
        <button
          type="button"
          style={{ ...styles.deleteBtn, marginRight: 4, color: isConstruction ? '#3b82f6' : '#9ca3af' }}
          onClick={(e) => { e.stopPropagation(); onToggleConstruction(); }}
          title={isConstruction ? 'Convert to real geometry' : 'Convert to construction (dashed, not extrudable)'}
        >
          C
        </button>
      )}
      {hover && (
        <button
          type="button"
          style={styles.deleteBtn}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

// ---- Descriptors ----

interface GeomRow {
  id: SketchGeometryId;
  icon: React.ReactNode;
  label: string;
  sub?: string;
}

function describeGeometry(g: SketchGeometry, points: Map<SketchPointId, SketchPoint>): GeomRow {
  const tag = g.construction ? ' (constr.)' : '';
  switch (g.type) {
    case 'line': {
      const a = points.get(g.startId);
      const b = points.get(g.endId);
      const len = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
      return { id: g.id, icon: <LineToolIcon size={14} color="#3b82f6" />, label: `Line${tag}`, sub: `${len.toFixed(2)} mm` };
    }
    case 'circle':
      return { id: g.id, icon: <CircleToolIcon size={14} color="#3b82f6" />, label: `Circle${tag}`, sub: `R ${g.radius.toFixed(2)}` };
    case 'arc':
      return { id: g.id, icon: <ArcToolIcon size={14} color="#3b82f6" />, label: `Arc${tag}`, sub: `R ${g.radius.toFixed(2)}` };
    case 'ellipse':
      return { id: g.id, icon: <EllipseToolIcon size={14} color="#3b82f6" />, label: `Ellipse${tag}`, sub: `r ${g.minorRadius.toFixed(2)}` };
    // There are no `slot` or `polygon` editor-geometry rows —
    // decomposed slots / polygons show up as line + arc rows now.
    case 'spline':
      return { id: g.id, icon: <SplineToolIcon size={14} color="#3b82f6" />, label: `Spline${tag}`, sub: `${g.pointIds.length} pts` };
    case 'bezier':
      return { id: g.id, icon: <SplineToolIcon size={14} color="#3b82f6" />, label: `Bezier${tag}`, sub: 'cubic' };
    case 'point':
      return { id: g.id, icon: <PointToolIcon size={14} color="#3b82f6" />, label: `Point${tag}` };
  }
}

interface ConRow {
  id: SketchConstraint['id'];
  icon: React.ReactNode;
  label: string;
  sub?: string;
  /** Referenced entity to highlight on row hover (first ref for multi-ref constraints). */
  hoverTarget?: HitTarget;
}

function describeConstraint(
  c: SketchConstraint,
  geometries: Map<SketchGeometryId, SketchGeometry>,
): ConRow {
  const refName = (gid: SketchGeometryId): string => {
    const g = geometries.get(gid);
    return g ? `${g.type}` : '?';
  };
  switch (c.type) {
    case 'horizontal':
      return { id: c.id, icon: <HorizontalConstraintIcon size={14} color="#e54d2e" />, label: 'Horizontal', sub: refName(c.geometryId),
               hoverTarget: { type: 'geometry', id: c.geometryId } };
    case 'vertical':
      return { id: c.id, icon: <VerticalConstraintIcon size={14} color="#e54d2e" />, label: 'Vertical', sub: refName(c.geometryId),
               hoverTarget: { type: 'geometry', id: c.geometryId } };
    case 'perpendicular':
      return { id: c.id, icon: <PerpendicularConstraintIcon size={14} color="#e54d2e" />, label: 'Perpendicular',
               sub: `${refName(c.geometryA)} ↔ ${refName(c.geometryB)}`,
               hoverTarget: { type: 'geometry', id: c.geometryA } };
    case 'parallel':
      return { id: c.id, icon: <ParallelConstraintIcon size={14} color="#e54d2e" />, label: 'Parallel',
               sub: `${refName(c.geometryA)} ↔ ${refName(c.geometryB)}`,
               hoverTarget: { type: 'geometry', id: c.geometryA } };
    case 'coincident':
      return { id: c.id, icon: <CoincidentConstraintIcon size={14} color="#e54d2e" />, label: 'Coincident',
               hoverTarget: { type: 'point', id: c.pointA } };
    case 'fixed':
      return { id: c.id, icon: <FixConstraintIcon size={14} color="#e54d2e" />, label: 'Fixed', sub: `(${c.x.toFixed(1)}, ${c.y.toFixed(1)})`,
               hoverTarget: { type: 'point', id: c.pointId } };
    case 'distance':
      return { id: c.id, icon: <DimensionToolIcon size={14} color="#0ea5e9" />, label: 'Distance', sub: `${c.value.toFixed(2)} mm`,
               hoverTarget: { type: 'point', id: c.pointA } };
    case 'length':
      return { id: c.id, icon: <DimensionToolIcon size={14} color="#0ea5e9" />, label: 'Length', sub: `${c.value.toFixed(2)} mm`,
               hoverTarget: { type: 'geometry', id: c.geometryId } };
    case 'radius':
      return { id: c.id, icon: <DimensionToolIcon size={14} color="#0ea5e9" />, label: 'Radius', sub: `${c.value.toFixed(2)} mm`,
               hoverTarget: { type: 'geometry', id: c.geometryId } };
    case 'angle': {
      const deg = (Math.abs(c.value) * 180 / Math.PI).toFixed(1);
      return { id: c.id, icon: <DimensionToolIcon size={14} color="#0ea5e9" />, label: 'Angle',
               sub: `${refName(c.geometryA)} ↔ ${refName(c.geometryB)}: ${deg}°`,
               hoverTarget: { type: 'geometry', id: c.geometryA } };
    }
    case 'distanceX':
      return { id: c.id, icon: <DimensionToolIcon size={14} color="#0ea5e9" />, label: 'Distance X',
               sub: `${Math.abs(c.value).toFixed(2)} mm`,
               hoverTarget: { type: 'point', id: c.pointA } };
    case 'distanceY':
      return { id: c.id, icon: <DimensionToolIcon size={14} color="#0ea5e9" />, label: 'Distance Y',
               sub: `${Math.abs(c.value).toFixed(2)} mm`,
               hoverTarget: { type: 'point', id: c.pointA } };
    case 'pointOnLine':
      return { id: c.id, icon: <PointOnLineConstraintIcon size={14} color="#e54d2e" />, label: 'Point on line',
               sub: refName(c.geometryId),
               hoverTarget: { type: 'point', id: c.pointId } };
    case 'pointOnCircle':
      return { id: c.id, icon: <PointOnCircleConstraintIcon size={14} color="#e54d2e" />, label: 'Point on circle',
               sub: refName(c.geometryId),
               hoverTarget: { type: 'point', id: c.pointId } };
    case 'symmetric':
      return { id: c.id, icon: <SymmetryConstraintIcon size={14} color="#e54d2e" />, label: 'Symmetric',
               sub: refName(c.geometryId),
               hoverTarget: { type: 'geometry', id: c.geometryId } };
    case 'tangent': {
      // Two flavours: line ↔ circle, or circle ↔ circle. Sub-label calls
      // out which entities the constraint pairs so the user can identify it
      // in the browser when there are several tangents in the sketch.
      const sub = c.lineId !== undefined
        ? `${refName(c.lineId)} ↔ ${refName(c.circleId)}`
        : c.secondCircleId !== undefined
          ? `${refName(c.circleId)} ↔ ${refName(c.secondCircleId)}`
          : refName(c.circleId);
      // Hover-highlight the line first (line-circle case) or the primary
      // circle (circle-circle case).
      const hoverGeom = c.lineId ?? c.circleId;
      return { id: c.id, icon: <TangentConstraintIcon size={14} color="#e54d2e" />, label: 'Tangent', sub,
               hoverTarget: { type: 'geometry', id: hoverGeom } };
    }
    case 'equal':
      return { id: c.id, icon: <EqualConstraintIcon size={14} color="#e54d2e" />, label: 'Equal',
               sub: `${refName(c.geometryA)} ↔ ${refName(c.geometryB)}`,
               hoverTarget: { type: 'geometry', id: c.geometryA } };
    case 'concentric':
      return { id: c.id, icon: <ConcentricConstraintIcon size={14} color="#e54d2e" />, label: 'Concentric',
               sub: `${refName(c.geometryA)} ↔ ${refName(c.geometryB)}`,
               hoverTarget: { type: 'geometry', id: c.geometryA } };
    case 'midpoint':
      return { id: c.id, icon: <MidpointConstraintIcon size={14} color="#e54d2e" />, label: 'Midpoint',
               sub: `point ↔ ${refName(c.geometryId)}`,
               hoverTarget: { type: 'point', id: c.pointId } };
  }
  // Fallback for unknown constraint kinds added in the future.
  return { id: (c as SketchConstraint).id, icon: <EqualConstraintIcon size={14} color="#e54d2e" />, label: (c as { type: string }).type };
}

// ---- Styles ----

/**
 * V7 · DOF strip style. Colour-codes the sketch's solver state:
 *   - Red bg when any constraint is unsatisfied (something is broken)
 *   - Blue bg + light blue text when fully defined (DOF = 0) — the
 *     "blue when locked" convention
 *   - Neutral grey when under-constrained or still solving
 */
function dofStripStyle(dof: number | undefined, hasUnsatisfied: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '4px 12px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.3,
    borderBottom: '1px solid #d0d0d0',
    textAlign: 'center',
  };
  if (hasUnsatisfied) return { ...base, background: '#fde7e7', color: '#c1262d' };
  if (dof === 0) return { ...base, background: '#e1efff', color: '#1a6fd1' };
  return { ...base, background: '#f6f6f6', color: '#666' };
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    // Flush against the upper-left viewport corner — only the inside
    // corners are rounded so the panel looks attached rather than floating.
    top: 0,
    left: 0,
    width: 240,
    maxHeight: '100%',
    background: '#ffffff',
    borderRight: '1px solid #d0d0d0',
    borderBottom: '1px solid #d0d0d0',
    borderTopRightRadius: 0,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
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
  headerButton: {
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  body: {
    flex: 1,
    overflow: 'auto',
    padding: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
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
    border: 'none',
    cursor: 'pointer',
    color: '#555',
    fontFamily: 'inherit',
    textAlign: 'left',
    width: '100%',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.3,
    flex: 1,
  },
  sectionCount: {
    fontSize: 10,
    color: '#888',
    fontVariantNumeric: 'tabular-nums',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    padding: '2px 4px 4px 4px',
    gap: 1,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 4px',
    border: '1px solid transparent',
    borderRadius: 3,
    cursor: 'pointer',
    minHeight: 22,
    transition: 'background 0.08s',
    fontSize: 11,
    color: '#333',
  },
  rowIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    flexShrink: 0,
  },
  warnIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    flexShrink: 0,
    marginRight: 1,
  },
  rowLabel: {
    flex: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  rowSub: {
    color: '#888',
    fontFamily: 'ui-monospace, monospace',
    fontSize: 10,
  },
  deleteBtn: {
    width: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 3,
    color: '#888',
    cursor: 'pointer',
    flexShrink: 0,
  },
  empty: {
    padding: '6px 4px',
    fontSize: 10,
    color: '#aaa',
    fontStyle: 'italic',
  },
};

/**
 * MainToolbar - ribbon.
 *
 * Two-row layout:
 *   Row 1 (title bar): [Logo] [File ops] [Undo/Redo] [Rebuilding] [Settings] [Project name]
 *   Row 2 (ribbon, full width):
 *     - Modeling mode: CREATE | MODIFY | ASSEMBLE | INSPECT
 *     - Sketch mode:   SELECT | CREATE | CONSTRAINTS | MODIFY | FINISH SKETCH
 *
 * Each ribbon button is large (icon stacked above label, ~64px wide). Sections
 * are visually separated by vertical dividers and have a small uppercase header
 * beneath them.
 */

import { Children, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isSaasAvailable } from '../storage/saasState.ts';
import type { SaasState } from '../storage/saasState.ts';
import { useBridgeStatus } from '../hooks/useBridgeStatus.ts';
import {
  Undo2,
  Redo2,
  Save,
  FolderOpen,
  FileDown,
  FilePlus,
  FileInput,
  Settings,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Package,
  Box,
  Wand2,
  ExternalLink,
  History,
} from 'lucide-react';
import {
  SketchIcon,
  ExtrudeIcon,
  HoleIcon,
  PlaneIcon,
  CutIcon,
  FilletIcon,
  ChamferIcon,
  PatternIcon,
  MirrorIcon,
  RevolveIcon,
  ShellIcon,
  FuseIcon,
  SelectHandIcon,
  LineToolIcon,
  RectToolIcon,
  CircleToolIcon,
  ArcToolIcon,
  PolygonToolIcon,
  EllipseToolIcon,
  SlotToolIcon,
  SplineToolIcon,
  PointToolIcon,
  TrimToolIcon,
  ExtendToolIcon,
  OffsetToolIcon,
  SketchFilletToolIcon,
  SketchMirrorToolIcon,
  DimensionToolIcon,
  HorizontalConstraintIcon,
  VerticalConstraintIcon,
  HVConstraintIcon,
  PerpendicularConstraintIcon,
  ParallelConstraintIcon,
  TangentConstraintIcon,
  EqualConstraintIcon,
  ConcentricConstraintIcon,
  MidpointConstraintIcon,
  CoincidentConstraintIcon,
  FixConstraintIcon,
  PointOnLineConstraintIcon,
  PointOnCircleConstraintIcon,
  SymmetryConstraintIcon,
  DistanceXToolIcon,
  DistanceYToolIcon,
  FinishSketchIcon,
  ConstructionGeometryIcon,
  MeasureIcon,
  BoxIcon,
  CylinderIcon,
  SphereIcon,
  ConeIcon,
  TorusIcon,
} from '../icons/cadIcons.tsx';
// Logo as a Vite asset → content-hashed + base-prefixed (`/cad/assets/…` in the
// embedded build, `/assets/…` standalone). Not a root-absolute `/500.png`,
// which would 404 under /cad and couldn't cache-bust.
import logoUrl from '../assets/logo.png';

// ---- Types ----

export type SketchConstraintKind =
  | 'hv'
  | 'horizontal'
  | 'vertical'
  | 'perpendicular'
  | 'parallel'
  | 'tangent'
  | 'equal'
  | 'coincident'
  | 'fix'
  | 'pointOnLine'
  | 'pointOnCircle'
  | 'symmetric'
  | 'concentric'
  | 'midpoint';

/**
 * The toolbar is split into two visually distinct strips so they can be
 * placed independently in the layout:
 *
 *   • `MainAppBar`  — full-width title strip at the very top of the window:
 *                     logo, file operations, undo/redo, project name,
 *                     settings, sidebar-collapse toggle. Lives outside the
 *                     sidebar + viewport row.
 *   • `MainRibbon`  — the mode-specific ribbon (modeling or
 *                     sketch). Lives above the viewport only, so it stays
 *                     aligned with the 3D canvas regardless of the
 *                     ProjectTree sidebar's collapsed/expanded state.
 *
 * Keeping the two strips as separate components avoids a "centerColumn
 * wraps both" coupling and lets the title strip span the full window.
 */

interface AppBarProps {
  projectName: string;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string | undefined;
  redoLabel?: string | undefined;
  onUndo: () => void;
  onRedo: () => void;
  rebuilding: boolean;
  /** True when the project-tree sidebar is currently collapsed. */
  sidebarCollapsed?: boolean | undefined;
  /** Toggle the sidebar collapsed/expanded state. */
  onToggleSidebar?: (() => void) | undefined;
  /** True when the right-side Components panel is open. */
  componentsPanelOpen?: boolean | undefined;
  /** Toggle the Components panel (also bound to Ctrl+I). */
  onToggleComponentsPanel?: (() => void) | undefined;
  /** Start a new blank document. */
  onNew?: (() => void) | undefined;
  /** Open a .cadjson from disk. */
  onOpen?: (() => void) | undefined;
  /**
   * Import a STEP / STL / BREP geometry file into the current document.
   * The optional `format` hint lets the dropdown items narrow the
   * picker to a single format.
   */
  onImport?: ((format?: 'step' | 'stl' | 'brep') => void) | undefined;
  /** Import a FreeCAD `.fcstd` file as a new document (replaces the active doc). */
  onImportFcstd?: (() => void) | undefined;
  /**
   * Import a parametric component (.cadcomponent / .cadjson) and embed
   * it as an `component` feature.
   */
  onImportComponent?: (() => void) | undefined;
  /** Import a DXF drawing as a new 2D sketch on a chosen plane. */
  onImportSketchDxf?: (() => void) | undefined;
  /** Import an SVG drawing as a new 2D sketch on a chosen plane. */
  onImportSketchSvg?: (() => void) | undefined;
  /** Save to the doc's sticky storage (disk path or cloud). */
  onSave?: (() => void) | undefined;
  /** Save a copy to disk under a new name. */
  onSaveAs?: (() => void) | undefined;
  /** Export the current document to a downloadable geometry format. */
  onExport?: ((format: 'stl' | 'step' | 'brep' | '3mf') => void) | undefined;
  /** Optional SaaS state — drives the account chip on the right. */
  saas?: SaasState | undefined;
  /** Open the inline sign-in modal. */
  onRequestSignIn?: (() => void) | undefined;
  /** Sign out + refresh state. */
  onSignOut?: (() => void) | undefined;
  /** Open the app-level Settings dialog (MCP bridge config, etc). */
  onOpenSettings?: (() => void) | undefined;
  /**
   * Rename the project. Called when the user commits an inline edit
   * to `projectName`. If absent, the name is rendered read-only. The
   * Shell wires this to a `RenameProject` command on the command bus —
   * empty / whitespace-only names are rejected at validation time
   * (handler returns INVALID_NAME), so callers don't need to filter.
   */
  onRenameProject?: ((name: string) => void) | undefined;
  /** True when the right-side chat panel is currently open. */
  chatPanelOpen?: boolean | undefined;
  /**
   * Toggle the chat panel. Caller decides whether the panel is
   * actually usable (signed-in / SaaS-available); the toolbar just
   * dispatches the toggle and updates the active state.
   */
  onToggleChatPanel?: (() => void) | undefined;
  /** Opens revision history. Absent when the project has no cloud history. */
  onOpenHistory?: (() => void) | undefined;
}

interface RibbonProps {
  sketchActive?: boolean | undefined;
  /** True while the plane picker is open (between clicking Sketch and choosing a plane) */
  sketchPickingPlane?: boolean | undefined;
  /** Open the sketch plane picker overlay (creates sketch once a plane is chosen) */
  onSketchClick?: (() => void) | undefined;
  /** Cancel the plane picker without creating a sketch */
  onSketchCancelPlanePick?: (() => void) | undefined;
  /** Called when user clicks Finish Sketch (exit sketch mode) */
  onSketchEnd?: (() => void) | undefined;
  /** Current active sketch tool (for highlighting in sketch mode) */
  sketchTool?: string | null | undefined;
  /** Set the sketch tool */
  onSketchToolChange?: ((tool: string | null) => void) | undefined;
  /** Apply a constraint to the current sketch selection */
  onApplyConstraint?: ((constraint: SketchConstraintKind) => void) | undefined;
  /** Whether new sketch geometry will be created as construction (dashed). */
  constructionMode?: boolean | undefined;
  /** Toggle the construction-mode flag in the sketch editor store. */
  onToggleConstructionMode?: (() => void) | undefined;
  /** Called when user clicks Extrude tool in the toolbar */
  onExtrudeClick?: (() => void) | undefined;
  /** Called when user clicks Revolve tool in the toolbar */
  onRevolveClick?: (() => void) | undefined;
  /** Called when user clicks Loft tool in the toolbar */
  onLoftClick?: (() => void) | undefined;
  /** Called when user clicks Sweep tool in the toolbar */
  onSweepClick?: (() => void) | undefined;
  /** Called when user clicks Fillet tool in the toolbar */
  onFilletClick?: (() => void) | undefined;
  /** Called when user clicks Chamfer tool in the toolbar */
  onChamferClick?: (() => void) | undefined;
  /** Called when user clicks Hole tool in the toolbar */
  onHoleClick?: (() => void) | undefined;
  /** Called with the boolean op the clicked ribbon entry stands for. */
  onBooleanClick?: ((op: 'union' | 'subtract' | 'intersect') => void) | undefined;
  /** Toggle the measure readout panel. */
  onMeasureClick?: (() => void) | undefined;
  /** Whether the measure panel is open (highlights the button). */
  measureActive?: boolean | undefined;
  /** Called with the shape the clicked ribbon entry stands for. */
  onPrimitiveClick?: ((kind: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus') => void) | undefined;
  /** Called when user clicks Mirror Body tool in the toolbar */
  onMirrorClick?: (() => void) | undefined;
  /** Called when user clicks Shell tool in the toolbar */
  onShellClick?: (() => void) | undefined;
  /** Called when user clicks Pattern tool in the toolbar */
  onPatternClick?: (() => void) | undefined;
  /** Called when user clicks "Offset Plane" tool. */
  onOffsetPlaneClick?: (() => void) | undefined;
  /** Called when user clicks "Plane from Face" tool. */
  onPlaneFromFaceClick?: (() => void) | undefined;
  /** Called when user toggles the INSPECT "Section" tool. */
  onSectionClick?: (() => void) | undefined;
  /** Whether section view is currently active (highlights the button). */
  sectionActive?: boolean | undefined;
}

type ToolId =
  | 'sketch'
  | 'offsetPlane'
  | 'planeFromFace'
  | 'extrude'
  | 'hole'
  | 'primBox'
  | 'primCylinder'
  | 'primSphere'
  | 'primCone'
  | 'primTorus'
  | 'cut'
  | 'fuse'
  | 'intersect'
  | 'fillet'
  | 'chamfer'
  | 'pattern'
  | 'mirror'
  | 'revolve'
  | 'loft'
  | 'shell'
  | 'sweep';

// Ribbon groups follow a DESIGN workspace layout. CONSTRUCT
// is for reference geometry (planes, axes, points) that doesn't produce
// bodies — kept distinct from CREATE so users don't conflate "datum"
// with "extrude/revolve/loft that adds a body."
type RibbonGroup = 'CREATE' | 'MODIFY' | 'CONSTRUCT' | 'ASSEMBLE' | 'INSPECT';

interface ToolDef {
  id: ToolId;
  label: string;
  icon: (color: string) => React.ReactNode;
  shortcut?: string;
  group: RibbonGroup;
  /** Brand color used to tint the icon */
  color: string;
  /** Visible as a top-level ribbon button. Non-primary tools are dropdown-only. */
  primary?: boolean;
}

interface SketchToolDef {
  id: string;
  label: string;
  shortcut?: string;
  icon: (c: string) => React.ReactNode;
  /** Visible as a top-level ribbon button. Non-primary tools are dropdown-only. */
  primary?: boolean;
}

// ---- Tool Definitions ----

const TOOLS: ToolDef[] = [
  { id: 'sketch',  label: 'Sketch',  icon: (c) => <SketchIcon size={26} color={c} />,  shortcut: 'S', group: 'CREATE', color: '#3b82f6', primary: true },
  { id: 'extrude', label: 'Extrude', icon: (c) => <ExtrudeIcon size={26} color={c} />, shortcut: 'E', group: 'CREATE', color: '#22c55e', primary: true },
  { id: 'revolve', label: 'Revolve', icon: (c) => <RevolveIcon size={26} color={c} />, group: 'CREATE', color: '#ec4899', primary: true },
  // Loft uses PatternIcon as a placeholder until a proper glyph lands; the
  // dialog also uses the same icon so the visual link is consistent.
  { id: 'loft',    label: 'Loft',    icon: (c) => <PatternIcon size={26} color={c} />, group: 'CREATE', color: '#eab308', primary: true },
  // Sweep reuses PatternIcon as a placeholder until a sweep-specific
  // glyph lands (same pattern Loft followed).
  { id: 'sweep',   label: 'Sweep',   icon: (c) => <PatternIcon size={26} color={c} />, group: 'CREATE', color: '#eab308', primary: true },
  { id: 'hole',    label: 'Hole',    icon: (c) => <HoleIcon size={26} color={c} />,    shortcut: 'H', group: 'CREATE', color: '#f97316', primary: true },
  // Primitives — a solid from numbers, no sketch. Box earns a ribbon slot;
  // the other four live in the CREATE dropdown and open the same dialog.
  { id: 'primBox',      label: 'Box',      icon: (c) => <BoxIcon size={26} color={c} />,      group: 'CREATE', color: '#14b8a6', primary: true },
  { id: 'primCylinder', label: 'Cylinder', icon: (c) => <CylinderIcon size={26} color={c} />, group: 'CREATE', color: '#14b8a6' },
  { id: 'primSphere',   label: 'Sphere',   icon: (c) => <SphereIcon size={26} color={c} />,   group: 'CREATE', color: '#14b8a6' },
  { id: 'primCone',     label: 'Cone',     icon: (c) => <ConeIcon size={26} color={c} />,     group: 'CREATE', color: '#14b8a6' },
  { id: 'primTorus',    label: 'Torus',    icon: (c) => <TorusIcon size={26} color={c} />,    group: 'CREATE', color: '#14b8a6' },
  { id: 'fillet',  label: 'Fillet',  icon: (c) => <FilletIcon size={26} color={c} />,  shortcut: 'F', group: 'MODIFY', color: '#06b6d4', primary: true },
  { id: 'chamfer', label: 'Chamfer', icon: (c) => <ChamferIcon size={26} color={c} />, group: 'MODIFY', color: '#06b6d4', primary: true },
  { id: 'shell',   label: 'Shell',   icon: (c) => <ShellIcon size={26} color={c} />,   group: 'MODIFY', color: '#64748b', primary: true },
  { id: 'pattern', label: 'Pattern', icon: (c) => <PatternIcon size={26} color={c} />, group: 'MODIFY', color: '#eab308', primary: true },
  // Boolean ops live in the MODIFY overflow dropdown only
  { id: 'cut',     label: 'Cut',     icon: (c) => <CutIcon size={26} color={c} />,     group: 'MODIFY', color: '#ef4444' },
  { id: 'fuse',    label: 'Combine', icon: (c) => <FuseIcon size={26} color={c} />,    group: 'MODIFY', color: '#8b5cf6' },
  { id: 'intersect', label: 'Intersect', icon: (c) => <FuseIcon size={26} color={c} />, group: 'MODIFY', color: '#8b5cf6' },
  { id: 'mirror',  label: 'Mirror',  icon: (c) => <MirrorIcon size={26} color={c} />,  group: 'MODIFY', color: '#a855f7' },
  // CONSTRUCT — reference geometry (no bodies). Each plane *type* is its
  // own ribbon entry ("Offset Plane", "Plane from Face", etc.) as distinct
  // menu items rather than a single dialog with a kind toggle. Axis /
  // Point / CSys land here as their builders ship.
  { id: 'offsetPlane',   label: 'Offset Plane',   icon: (c) => <PlaneIcon size={26} color={c} />, group: 'CONSTRUCT', color: '#3b82f6', primary: true },
  { id: 'planeFromFace', label: 'Plane from Face', icon: (c) => <PlaneIcon size={26} color={c} />, group: 'CONSTRUCT', color: '#3b82f6', primary: true },
];

const SKETCH_CREATE_TOOLS: SketchToolDef[] = [
  { id: 'line',         label: 'Line',      shortcut: 'L', icon: (c) => <LineToolIcon size={26} color={c} />, primary: true },
  { id: 'rectangle',    label: 'Rectangle', shortcut: 'R', icon: (c) => <RectToolIcon size={26} color={c} />, primary: true },
  { id: 'circle',       label: 'Circle',    shortcut: 'C', icon: (c) => <CircleToolIcon size={26} color={c} />, primary: true },
  { id: 'arc-3point',   label: 'Arc',       shortcut: 'A', icon: (c) => <ArcToolIcon size={26} color={c} />, primary: true },
  { id: 'point',        label: 'Point',                    icon: (c) => <PointToolIcon size={26} color={c} />, primary: true },
  // Overflow — accessible from the CREATE dropdown.
  // Alternate circle constructors.
  { id: 'circle-2point', label: 'Circle 2-pt', icon: (c) => <CircleToolIcon size={26} color={c} /> },
  { id: 'circle-3point', label: 'Circle 3-pt', icon: (c) => <CircleToolIcon size={26} color={c} /> },
  { id: 'arc-center',   label: 'Arc center', icon: (c) => <ArcToolIcon size={26} color={c} /> },
  { id: 'polygon',      label: 'Polygon',    icon: (c) => <PolygonToolIcon size={26} color={c} /> },
  { id: 'slot',         label: 'Slot',       icon: (c) => <SlotToolIcon size={26} color={c} /> },
  { id: 'ellipse',      label: 'Ellipse',    icon: (c) => <EllipseToolIcon size={26} color={c} /> },
  { id: 'spline',       label: 'Spline',     icon: (c) => <SplineToolIcon size={26} color={c} /> },
];

const SKETCH_MODIFY_TOOLS: SketchToolDef[] = [
  { id: 'trim',          label: 'Trim',    shortcut: 'T', icon: (c) => <TrimToolIcon size={26} color={c} />, primary: true },
  { id: 'sketch-fillet', label: 'Fillet',                 icon: (c) => <SketchFilletToolIcon size={26} color={c} />, primary: true },
  { id: 'offset',        label: 'Offset',  shortcut: 'O', icon: (c) => <OffsetToolIcon size={26} color={c} />, primary: true },
  // Overflow — accessible from the MODIFY dropdown
  { id: 'extend',        label: 'Extend',                 icon: (c) => <ExtendToolIcon size={26} color={c} /> },
  { id: 'sketch-mirror', label: 'Mirror',                 icon: (c) => <SketchMirrorToolIcon size={26} color={c} /> },
];

const SKETCH_DIMENSION_TOOLS: SketchToolDef[] = [
  { id: 'dimension', label: 'Dimension', shortcut: 'D', icon: (c) => <DimensionToolIcon size={26} color={c} />, primary: true },
  { id: 'dimension-x', label: 'Dim H', icon: (c) => <DistanceXToolIcon size={26} color={c} />, primary: true },
  { id: 'dimension-y', label: 'Dim V', icon: (c) => <DistanceYToolIcon size={26} color={c} />, primary: true },
];

const SKETCH_CONSTRAINTS: { id: SketchConstraintKind; label: string; icon: (c: string) => React.ReactNode; primary?: boolean }[] = [
  // Combined H/V auto-picks per line based on its dominant axis.
  { id: 'hv',            label: 'H / V',         icon: (c) => <HVConstraintIcon size={26} color={c} />, primary: true },
  { id: 'coincident',    label: 'Coincident',    icon: (c) => <CoincidentConstraintIcon size={26} color={c} />, primary: true },
  { id: 'perpendicular', label: 'Perpendicular', icon: (c) => <PerpendicularConstraintIcon size={26} color={c} />, primary: true },
  { id: 'parallel',      label: 'Parallel',      icon: (c) => <ParallelConstraintIcon size={26} color={c} />, primary: true },
  { id: 'tangent',       label: 'Tangent',       icon: (c) => <TangentConstraintIcon size={26} color={c} />, primary: true },
  { id: 'equal',         label: 'Equal',         icon: (c) => <EqualConstraintIcon size={26} color={c} />, primary: true },
  // Overflow — explicit Horizontal/Vertical, additional constraints, Fix.
  { id: 'horizontal',    label: 'Horizontal',    icon: (c) => <HorizontalConstraintIcon size={26} color={c} /> },
  { id: 'vertical',      label: 'Vertical',      icon: (c) => <VerticalConstraintIcon size={26} color={c} /> },
  { id: 'pointOnLine',   label: 'Point on line', icon: (c) => <PointOnLineConstraintIcon size={26} color={c} /> },
  { id: 'pointOnCircle', label: 'Point on circle', icon: (c) => <PointOnCircleConstraintIcon size={26} color={c} /> },
  { id: 'midpoint',      label: 'Midpoint',      icon: (c) => <MidpointConstraintIcon size={26} color={c} /> },
  { id: 'concentric',    label: 'Concentric',    icon: (c) => <ConcentricConstraintIcon size={26} color={c} /> },
  { id: 'symmetric',     label: 'Symmetric',     icon: (c) => <SymmetryConstraintIcon size={26} color={c} /> },
  { id: 'fix',           label: 'Fix / UnFix',   icon: (c) => <FixConstraintIcon size={26} color={c} /> },
];

// ---- Components ----

/**
 * Full-width title bar: logo, sidebar-collapse toggle, file ops, undo/redo,
 * project name, settings. Rendered at the very top of the window, spanning
 * the whole layout above the sidebar+viewport row.
 */
export function MainAppBar({
  projectName,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  rebuilding,
  sidebarCollapsed,
  onToggleSidebar,
  componentsPanelOpen,
  onToggleComponentsPanel,
  onNew,
  onOpen,
  onImport,
  onImportFcstd,
  onImportComponent,
  onImportSketchDxf,
  onImportSketchSvg,
  onSave,
  onSaveAs,
  onExport,
  saas,
  onRequestSignIn,
  onSignOut,
  onOpenSettings,
  onRenameProject,
  onOpenHistory,
  chatPanelOpen,
  onToggleChatPanel,
}: AppBarProps) {
  return (
    <div style={styles.titleRow}>
      {/* Logo area: width tracks the sidebar so the logo always lives in
          its own column above the ProjectTree. Shrinks with the sidebar
          on collapse. */}
      <div
        style={{
          ...styles.logoArea,
          width: sidebarCollapsed ? 8 : 240,
        }}
      >
        <img src={logoUrl} alt="TweakCAD logo" style={styles.logoImg} draggable={false} />
        {!sidebarCollapsed && (
          <span style={styles.wordmark}>
            <span style={{ color: '#0A2452' }}>Tweak</span>
            <span style={{ color: '#0164D4' }}>CAD</span>
          </span>
        )}
      </div>

      <IconBtn
        icon={sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        label={sidebarCollapsed ? 'Show project tree' : 'Hide project tree'}
        onClick={() => onToggleSidebar?.()}
      />

      {/* The catalog is a SaaS surface — a standalone build has nothing to
          browse, so the button is absent rather than present-and-failing.
          Gated on `available` rather than `signedIn` because the published
          catalog is public; you can browse and insert without an account.
          Importing a .cadcomponent from disk stays available either way (File
          → Import), which is the standalone path. */}
      {isSaasAvailable(saas) && (
        <IconBtn
          icon={<Box size={16} />}
          label="Components (Ctrl+I)"
          onClick={() => onToggleComponentsPanel?.()}
          active={componentsPanelOpen}
        />
      )}

      {/* 20px gap between the collapse toggle and the rest of the app bar. */}
      <div style={styles.afterCollapseGap} />
      <div style={styles.separator} />

      <IconBtn icon={<FilePlus size={16} />}   label="New (Ctrl+Alt+N)" onClick={() => onNew?.()} />
      <IconBtn icon={<FolderOpen size={16} />} label="Open (Ctrl+O)"    onClick={() => onOpen?.()} />
      <ImportButton onImport={onImport} onImportFcstd={onImportFcstd} onImportComponent={onImportComponent} onImportSketchDxf={onImportSketchDxf} onImportSketchSvg={onImportSketchSvg} />
      <IconBtn icon={<Save size={16} />}       label="Save (Ctrl+S)"    onClick={() => onSave?.()} />
      <IconBtn icon={<FileDown size={16} />}   label="Save as (Ctrl+Shift+S)" onClick={() => onSaveAs?.()} />
      {onOpenHistory && (
        <IconBtn icon={<History size={16} />} label="Version history" onClick={onOpenHistory} />
      )}
      <ExportButton onExport={onExport} />

      <div style={styles.separator} />

      <IconBtn icon={<Undo2 size={16} />} label={undoLabel ? `Undo: ${undoLabel}` : 'Nothing to undo'}
               onClick={onUndo} disabled={!canUndo} />
      <IconBtn icon={<Redo2 size={16} />} label={redoLabel ? `Redo: ${redoLabel}` : 'Nothing to redo'}
               onClick={onRedo} disabled={!canRedo} />

      <div style={{ flex: 1 }} />

      {rebuilding && <span style={styles.rebuildBadge}>Rebuilding</span>}
      <ProjectNameField name={projectName} onRename={onRenameProject} />

      <div style={styles.separator} />
      {/* Wand only shows when SaaS is actually reachable — local-only
          deployments don't get the in-app chat panel (they have the MCP
          bridge for that). Same visibility rule as AccountChip below. */}
      {isSaasAvailable(saas) && (
        <IconBtn
          icon={<Wand2 size={16} />}
          label={chatPanelOpen ? 'Close AI assistant' : 'AI assistant'}
          onClick={() => onToggleChatPanel?.()}
          active={chatPanelOpen}
        />
      )}
      <AccountChip
        saas={saas}
        onRequestSignIn={onRequestSignIn}
        onSignOut={onSignOut}
      />
      <BridgeStatusDot onClick={() => onOpenSettings?.()} />
      <IconBtn icon={<Settings size={16} />} label="Settings" onClick={() => onOpenSettings?.()} />
    </div>
  );
}

// ---- ProjectNameField ----

/**
 * Inline-editable project name. Reads as plain text; double-click (or
 * single-click when no rename handler is supplied makes it read-only)
 * swaps in an `<input>` seeded with the current name. Enter or blur
 * commits via `onRename`; Esc cancels and reverts.
 *
 * Empty / whitespace-only entries silently revert — the handler also
 * rejects them with INVALID_NAME so the doc is safe either way, but
 * we don't want to flash a validation error for what's clearly a
 * "never mind" gesture.
 *
 * Width auto-grows with the text via a measuring `<span>` rendered
 * off-screen — keeps the input snug to the name while still leaving
 * a small slack so typing doesn't jump the cursor.
 */
function ProjectNameField({
  name,
  onRename,
}: {
  name: string;
  onRename?: ((next: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  // Keep draft in sync when the underlying name changes externally
  // (e.g. opening a different project while NOT editing). When the
  // user is mid-edit, leave their draft alone.
  //
  // Adjusted during render rather than in an effect, so the toolbar never
  // shows the previous project's name for a frame after switching. Tracks
  // both triggers the effect's dependency array had — the name changing,
  // and leaving edit mode — since the reset is conditional on `editing`
  // and so can't use the plain `useSeededState` helper.
  const [lastNameSync, setLastNameSync] = useState({ name, editing });
  if (name !== lastNameSync.name || editing !== lastNameSync.editing) {
    setLastNameSync({ name, editing });
    if (!editing) setDraft(name);
  }

  // After flipping into edit mode, focus + select the text.
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  // Re-measure on draft change so the input hugs the text.
  useEffect(() => {
    if (!editing) return;
    const m = measureRef.current;
    if (!m) return;
    // 16px slack for the caret + a bit of breathing room.
    setMeasuredWidth(Math.min(360, Math.max(60, m.offsetWidth + 16)));
  }, [draft, editing]);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    onRename?.(next);
  }

  function cancel() {
    setEditing(false);
    setDraft(name);
  }

  if (!editing) {
    const editable = !!onRename;
    return (
      <span
        style={{
          ...styles.projectName,
          cursor: editable ? 'text' : 'default',
        }}
        title={editable ? `${name} (double-click to rename)` : name}
        onDoubleClick={editable ? () => setEditing(true) : undefined}
      >
        {name}
      </span>
    );
  }

  return (
    <>
      {/* Off-screen mirror used to measure the current draft text width. */}
      <span ref={measureRef} style={projectNameStyles.measure} aria-hidden="true">
        {draft || ' '}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        style={{
          ...projectNameStyles.input,
          ...(measuredWidth !== null ? { width: measuredWidth } : {}),
        }}
        aria-label="Project name"
      />
    </>
  );
}

const projectNameStyles: Record<string, React.CSSProperties> = {
  input: {
    fontSize: 12,
    color: '#222',
    background: '#ffffff',
    border: '1px solid #a8cef0',
    borderRadius: 4,
    padding: '2px 6px',
    marginRight: 4,
    fontFamily: 'inherit',
    outline: 'none',
    minWidth: 60,
    maxWidth: 360,
  },
  /**
   * Width mirror — same font metrics as the input/span so offsetWidth
   * matches what the input will need. Absolute + hidden so it never
   * affects layout.
   */
  measure: {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre',
    fontSize: 12,
    fontFamily: 'inherit',
    padding: '2px 6px',
    border: '1px solid transparent',
    pointerEvents: 'none',
    left: -9999,
    top: -9999,
  },
};

// ---- BridgeStatusDot ----

/**
 * Tiny coloured dot in the title bar reflecting MCP bridge WS state.
 * Hidden when the bridge is disabled in settings (no clutter for the
 * 95% of users who never enable it). Hover tooltip carries the URL and
 * — on error — the failure message. Click jumps into Settings → AI so
 * the user can flip the toggle or change host/port without hunting.
 *
 *   • disabled   — not rendered
 *   • connecting — yellow
 *   • connected  — green
 *   • error      — red
 */
function BridgeStatusDot({ onClick }: { onClick: () => void }) {
  const status = useBridgeStatus();
  if (status.state === 'disabled') return null;

  const color =
    status.state === 'connected' ? '#22c55e' :   // green
    status.state === 'connecting' ? '#eab308' :  // yellow
    '#ef4444';                                    // red (error)

  const label =
    status.state === 'connecting' ? `AI bridge: connecting to ${status.url}` :
    status.state === 'connected' ? `AI bridge: connected (${status.url})` :
    `AI bridge: error: ${status.message}`;

  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={bridgeDotStyles.btn}
    >
      <span style={{ ...bridgeDotStyles.dot, background: color }} />
    </button>
  );
}

const bridgeDotStyles: Record<string, React.CSSProperties> = {
  btn: {
    width: 18,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
  },
};

// ---- AccountChip ----

/**
 * Right-side chip: "Sign in" pill when SaaS is available + signed out,
 * a user-initialed avatar with a dropdown when signed in, nothing when
 * SaaS is unavailable.
 */
function AccountChip({
  saas,
  onRequestSignIn,
  onSignOut,
}: {
  saas?: SaasState | undefined;
  onRequestSignIn?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  // Don't render anything until the probe resolves — keeps the UI from
  // flashing a "sign in" chip and then hiding it again on standalone hosts.
  if (!saas || saas.kind === 'unknown') return null;
  if (saas.kind === 'unavailable') return null;

  if (!saas.signedIn) {
    return (
      <button
        type="button"
        onClick={() => onRequestSignIn?.()}
        style={accountStyles.signInBtn}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#1557a0';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#1a6fd1';
        }}
      >
        Sign in
      </button>
    );
  }

  const initials = saas.user.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || saas.user.email[0]?.toUpperCase() || '?';

  return (
    <div ref={wrapperRef} style={accountStyles.wrapper}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={saas.user.name || saas.user.email}
        style={accountStyles.avatar}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#3a3a3a';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#2a2a2a';
        }}
      >
        {initials}
      </button>
      {open && (
        <div role="menu" style={accountStyles.menu}>
          <div style={accountStyles.menuHeader}>
            <div style={accountStyles.menuName}>{saas.user.name}</div>
            <div style={accountStyles.menuEmail}>{saas.user.email}</div>
          </div>
          <div style={accountStyles.menuDivider} />
          <a
            href="/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="My projects (opens in a new tab)"
            style={accountStyles.menuItemExternal}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = '#f5f5f5';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
            }}
          >
            My projects
            <ExternalLink size={11} aria-hidden />
          </a>
          <a
            href="/account"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Account settings (opens in a new tab)"
            style={accountStyles.menuItemExternal}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = '#f5f5f5';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
            }}
          >
            Account settings
            <ExternalLink size={11} aria-hidden />
          </a>
          <div style={accountStyles.menuDivider} />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut?.();
            }}
            style={{ ...accountStyles.menuItem, color: '#dc2626' }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#fee2e2';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const menuItemBase: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '6px 12px',
  fontSize: 12,
  color: '#333',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  textDecoration: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'background 0.1s',
};

const accountStyles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'relative',
  },
  signInBtn: {
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 500,
    background: '#1a6fd1',
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.12s',
  },
  avatar: {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: '#2a2a2a',
    color: '#fff',
    borderRadius: '50%',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.12s',
    fontFamily: 'inherit',
  },
  menu: {
    position: 'absolute',
    top: '110%',
    right: 0,
    minWidth: 200,
    padding: '4px 0',
    background: '#ffffff',
    border: '1px solid #e5e5e5',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
    zIndex: 100,
  },
  menuHeader: {
    padding: '8px 12px',
  },
  menuName: {
    fontSize: 13,
    fontWeight: 600,
    color: '#222',
  },
  menuEmail: {
    fontSize: 11,
    color: '#888',
    marginTop: 1,
  },
  menuDivider: {
    height: 1,
    background: '#eee',
    margin: '4px 0',
  },
  menuItem: menuItemBase,
  // Same row, laid out to seat the trailing "opens in a new tab" marker
  // next to the label instead of on its own line.
  menuItemExternal: {
    ...menuItemBase,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    boxSizing: 'border-box',
  },
};

/**
 * Mode-specific ribbon (modeling vs sketch). Lives above the viewport,
 * NOT above the sidebar — that's why it's a separate component from the
 * full-width app bar. Width tracks the viewport, scrolls horizontally if
 * the user shrinks the window.
 */
export function MainRibbon({
  sketchActive,
  sketchPickingPlane,
  onSketchClick,
  onSketchCancelPlanePick,
  onSketchEnd,
  sketchTool,
  onSketchToolChange,
  onApplyConstraint,
  constructionMode,
  onToggleConstructionMode,
  onExtrudeClick,
  onRevolveClick,
  onLoftClick,
  onSweepClick,
  onFilletClick,
  onChamferClick,
  onHoleClick,
  onBooleanClick,
  onMeasureClick,
  measureActive,
  onPrimitiveClick,
  onMirrorClick,
  onShellClick,
  onPatternClick,
  onOffsetPlaneClick,
  onPlaneFromFaceClick,
  onSectionClick,
  sectionActive,
}: RibbonProps) {
  return (
    <div style={styles.ribbonRow}>
      {sketchActive ? (
        <SketchRibbon
          sketchTool={sketchTool ?? null}
          onSketchToolChange={onSketchToolChange}
          onApplyConstraint={onApplyConstraint}
          onSketchEnd={onSketchEnd}
          constructionMode={constructionMode ?? false}
          onToggleConstructionMode={onToggleConstructionMode}
        />
      ) : (
        <ModelingRibbon
          sketchPickingPlane={sketchPickingPlane ?? false}
          onSketchClick={onSketchClick}
          onSketchCancelPlanePick={onSketchCancelPlanePick}
          onExtrudeClick={onExtrudeClick}
          onRevolveClick={onRevolveClick}
          onLoftClick={onLoftClick}
          onSweepClick={onSweepClick}
          onFilletClick={onFilletClick}
          onChamferClick={onChamferClick}
          onHoleClick={onHoleClick}
          onBooleanClick={onBooleanClick}
          onMeasureClick={onMeasureClick}
          measureActive={measureActive}
          onPrimitiveClick={onPrimitiveClick}
          onMirrorClick={onMirrorClick}
          onShellClick={onShellClick}
          onPatternClick={onPatternClick}
          onOffsetPlaneClick={onOffsetPlaneClick}
          onPlaneFromFaceClick={onPlaneFromFaceClick}
          onSectionClick={onSectionClick}
          sectionActive={sectionActive}
        />
      )}
    </div>
  );
}

// ---- Modeling Ribbon ----

function ModelingRibbon({
  sketchPickingPlane,
  onSketchClick,
  onSketchCancelPlanePick,
  onExtrudeClick,
  onRevolveClick,
  onLoftClick,
  onSweepClick,
  onFilletClick,
  onChamferClick,
  onHoleClick,
  onBooleanClick,
  onMeasureClick,
  measureActive,
  onPrimitiveClick,
  onMirrorClick,
  onShellClick,
  onPatternClick,
  onOffsetPlaneClick,
  onPlaneFromFaceClick,
  onSectionClick,
  sectionActive,
}: {
  sketchPickingPlane: boolean;
  onSketchClick?: (() => void) | undefined;
  onSketchCancelPlanePick?: (() => void) | undefined;
  onExtrudeClick?: (() => void) | undefined;
  onRevolveClick?: (() => void) | undefined;
  onLoftClick?: (() => void) | undefined;
  onSweepClick?: (() => void) | undefined;
  onFilletClick?: (() => void) | undefined;
  onChamferClick?: (() => void) | undefined;
  onHoleClick?: (() => void) | undefined;
  /** Called with the boolean op the clicked ribbon entry stands for. */
  onBooleanClick?: ((op: 'union' | 'subtract' | 'intersect') => void) | undefined;
  /** Toggle the measure readout panel. */
  onMeasureClick?: (() => void) | undefined;
  /** Whether the measure panel is open (highlights the button). */
  measureActive?: boolean | undefined;
  /** Called with the shape the clicked ribbon entry stands for. */
  onPrimitiveClick?: ((kind: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus') => void) | undefined;
  onMirrorClick?: (() => void) | undefined;
  onShellClick?: (() => void) | undefined;
  onPatternClick?: (() => void) | undefined;
  onOffsetPlaneClick?: (() => void) | undefined;
  onPlaneFromFaceClick?: (() => void) | undefined;
  onSectionClick?: (() => void) | undefined;
  sectionActive?: boolean | undefined;
}) {
  const createTools = TOOLS.filter(t => t.group === 'CREATE');
  const modifyTools = TOOLS.filter(t => t.group === 'MODIFY');
  const constructTools = TOOLS.filter(t => t.group === 'CONSTRUCT');
  const createPrimary = createTools.filter(t => t.primary);
  const modifyPrimary = modifyTools.filter(t => t.primary);
  const constructPrimary = constructTools.filter(t => t.primary);

  const handleToolClick = (toolId: ToolId) => {
    if (toolId === 'sketch') {
      if (sketchPickingPlane) {
        onSketchCancelPlanePick?.();
      } else {
        onSketchClick?.();
      }
      return;
    }
    if (toolId === 'extrude') {
      onExtrudeClick?.();
      return;
    }
    if (toolId === 'revolve') {
      onRevolveClick?.();
      return;
    }
    if (toolId === 'loft') {
      onLoftClick?.();
      return;
    }
    if (toolId === 'sweep') {
      onSweepClick?.();
      return;
    }
    if (toolId === 'fillet') {
      onFilletClick?.();
      return;
    }
    if (toolId === 'chamfer') {
      onChamferClick?.();
      return;
    }
    if (toolId === 'hole') {
      onHoleClick?.();
      return;
    }
    if (toolId === 'cut' || toolId === 'fuse' || toolId === 'intersect') {
      onBooleanClick?.(toolId === 'cut' ? 'subtract' : toolId === 'fuse' ? 'union' : 'intersect');
      return;
    }
    if (toolId.startsWith('prim')) {
      const kind = toolId.slice(4).toLowerCase() as 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';
      onPrimitiveClick?.(kind);
      return;
    }
    if (toolId === 'mirror') {
      onMirrorClick?.();
      return;
    }
    if (toolId === 'shell') {
      onShellClick?.();
      return;
    }
    if (toolId === 'pattern') {
      onPatternClick?.();
      return;
    }
    if (toolId === 'offsetPlane') {
      onOffsetPlaneClick?.();
      return;
    }
    if (toolId === 'planeFromFace') {
      onPlaneFromFaceClick?.();
      return;
    }
    // Other tools: no-op for now (stubs)
  };

  const toMenuItem = (tool: ToolDef): MenuItem => ({
    id: tool.id,
    label: tool.label,
    shortcut: tool.shortcut,
    icon: tool.icon(tool.color),
    active: tool.id === 'sketch' && sketchPickingPlane,
    onClick: () => handleToolClick(tool.id),
  });

  return (
    <>
      <RibbonGroupView label="CREATE" menu={createTools.map(toMenuItem)}>
        {createPrimary.map(tool => (
          <RibbonBtn
            key={tool.id}
            icon={tool.icon(tool.color)}
            label={tool.label}
            shortcut={tool.shortcut}
            active={tool.id === 'sketch' && sketchPickingPlane}
            onClick={() => handleToolClick(tool.id)}
          />
        ))}
      </RibbonGroupView>

      <RibbonGroupView label="MODIFY" menu={modifyTools.map(toMenuItem)}>
        {modifyPrimary.map(tool => (
          <RibbonBtn
            key={tool.id}
            icon={tool.icon(tool.color)}
            label={tool.label}
            shortcut={tool.shortcut}
            onClick={() => handleToolClick(tool.id)}
            // All MODIFY tools (Fillet/Chamfer/Mirror/Shell/Pattern) now wired.
            // Every MODIFY tool is wired now; the booleans were the last.
            disabled={false}
          />
        ))}
      </RibbonGroupView>

      {/* CONSTRUCT — reference geometry group. Each plane *type* is its
          own ribbon entry. Axis / Point / CSys land here as their
          builders ship. */}
      <RibbonGroupView label="CONSTRUCT" menu={constructTools.map(toMenuItem)}>
        {constructPrimary.map(tool => (
          <RibbonBtn
            key={tool.id}
            icon={tool.icon(tool.color)}
            label={tool.label}
            shortcut={tool.shortcut}
            onClick={() => handleToolClick(tool.id)}
            disabled={tool.id !== 'offsetPlane' && tool.id !== 'planeFromFace'}
          />
        ))}
      </RibbonGroupView>

      <RibbonGroupView label="ASSEMBLE">
        <RibbonBtn icon={<PatternIcon size={26} color="#aaa" />} label="Joint" disabled onClick={() => {}} />
        <RibbonBtn icon={<MirrorIcon size={26} color="#aaa" />}  label="Rigid" disabled onClick={() => {}} />
      </RibbonGroupView>

      <RibbonGroupView label="INSPECT">
        <RibbonBtn
          icon={<HoleIcon size={26} color={sectionActive ? '#2563eb' : '#059669'} />}
          label="Section"
          active={sectionActive}
          onClick={() => onSectionClick?.()}
        />
        <RibbonBtn
          icon={<MeasureIcon size={26} color={measureActive ? '#2563eb' : '#0d9488'} />}
          label="Measure"
          active={measureActive}
          onClick={() => onMeasureClick?.()}
        />
      </RibbonGroupView>
    </>
  );
}

// ---- Sketch Ribbon ----

function SketchRibbon({
  sketchTool,
  onSketchToolChange,
  onApplyConstraint,
  onSketchEnd,
  constructionMode,
  onToggleConstructionMode,
}: {
  sketchTool: string | null;
  onSketchToolChange?: ((tool: string | null) => void) | undefined;
  onApplyConstraint?: ((constraint: SketchConstraintKind) => void) | undefined;
  onSketchEnd?: (() => void) | undefined;
  constructionMode?: boolean;
  onToggleConstructionMode?: (() => void) | undefined;
}) {
  const sketchToolToMenu = (color: string) => (t: SketchToolDef): MenuItem => ({
    id: t.id,
    label: t.label,
    shortcut: t.shortcut,
    icon: t.icon(color),
    active: sketchTool === t.id,
    onClick: () => onSketchToolChange?.(t.id),
  });

  const createPrimary = SKETCH_CREATE_TOOLS.filter(t => t.primary);
  const modifyPrimary = SKETCH_MODIFY_TOOLS.filter(t => t.primary);

  return (
    <>
      <RibbonGroupView
        label="SELECT"
        menu={[{
          id: 'select',
          label: 'Select (Esc)',
          icon: <SelectHandIcon size={22} color="#555" />,
          active: sketchTool === 'select',
          onClick: () => onSketchToolChange?.('select'),
        }]}
      >
        <RibbonBtn
          icon={<SelectHandIcon size={26} color="#555" />}
          label="Select"
          active={sketchTool === 'select'}
          onClick={() => onSketchToolChange?.('select')}
        />
      </RibbonGroupView>

      <RibbonGroupView label="CREATE" menu={SKETCH_CREATE_TOOLS.map(sketchToolToMenu('#3b82f6'))}>
        {createPrimary.map(t => (
          <RibbonBtn
            key={t.id}
            icon={t.icon('#3b82f6')}
            label={t.label}
            shortcut={t.shortcut}
            active={sketchTool === t.id}
            onClick={() => onSketchToolChange?.(t.id)}
          />
        ))}
        {/* Construction toggle: when active, every new geometry is marked
            construction (dashed, not extrudable). Click toggles it off
            again. */}
        <RibbonBtn
          icon={<ConstructionGeometryIcon size={26} color={constructionMode ? '#964B00' : '#888'} />}
          label="Construction"
          active={!!constructionMode}
          onClick={() => onToggleConstructionMode?.()}
        />
      </RibbonGroupView>

      <RibbonGroupView
        label="CONSTRAINTS"
        menu={SKETCH_CONSTRAINTS.map(c => ({
          id: c.id,
          label: c.label,
          icon: c.icon('#e54d2e'),
          onClick: () => onApplyConstraint?.(c.id),
        }))}
      >
        {SKETCH_CONSTRAINTS.filter(c => c.primary).map(c => (
          <RibbonBtn
            key={c.id}
            icon={c.icon('#e54d2e')}
            label={c.label}
            onClick={() => onApplyConstraint?.(c.id)}
          />
        ))}
      </RibbonGroupView>

      <RibbonGroupView label="DIMENSION" menu={SKETCH_DIMENSION_TOOLS.map(sketchToolToMenu('#0ea5e9'))}>
        {SKETCH_DIMENSION_TOOLS.map(t => (
          <RibbonBtn
            key={t.id}
            icon={t.icon('#0ea5e9')}
            label={t.label}
            shortcut={t.shortcut}
            active={sketchTool === t.id}
            onClick={() => onSketchToolChange?.(t.id)}
          />
        ))}
      </RibbonGroupView>

      <RibbonGroupView label="MODIFY" menu={SKETCH_MODIFY_TOOLS.map(sketchToolToMenu('#8b5cf6'))}>
        {modifyPrimary.map(t => (
          <RibbonBtn
            key={t.id}
            icon={t.icon('#8b5cf6')}
            label={t.label}
            shortcut={t.shortcut}
            active={sketchTool === t.id}
            onClick={() => onSketchToolChange?.(t.id)}
          />
        ))}
      </RibbonGroupView>

      <div style={{ flex: 1 }} />

      <div style={styles.finishWrap}>
        <button
          type="button"
          style={styles.finishBtn}
          onClick={() => onSketchEnd?.()}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#f1fdf5';
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#15803d';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#ffffff';
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#16a34a';
          }}
          title="Finish Sketch (Esc)"
        >
          <FinishSketchIcon size={26} color="#16a34a" />
          <span style={styles.finishLabel}>Finish</span>
        </button>
      </div>
    </>
  );
}

// ---- Atoms ----

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string | undefined;
  icon: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}

/**
 * Renders a flex row of children that progressively hides trailing items
 * when the container is too narrow to fit them all. Hidden items don't
 * vanish from the DOM — they get `display: none`. Width measurement is
 * cached after the first render where all are visible, so subsequent
 * resizes are O(n) without re-flow churn.
 *
 * The collapse is signalled to the parent via `onCollapsedChange` so the
 * group's label/dropdown can show a "more inside" affordance.
 */
function ResponsiveRow({
  children,
  onCollapsedChange,
}: {
  children: React.ReactNode;
  onCollapsedChange?: (collapsed: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const widthsRef = useRef<number[]>([]);
  const items = Children.toArray(children);
  const total = items.length;
  // Start with everything visible so the first paint can measure natural widths.
  const [visible, setVisible] = useState(total);

  // After every render, capture each currently-visible child's natural width.
  // We only update widths for indices that are visible (offsetWidth > 0).
  useLayoutEffect(() => {
    for (let i = 0; i < itemRefs.current.length; i++) {
      const el = itemRefs.current[i];
      if (el && el.offsetWidth > 0) widthsRef.current[i] = el.offsetWidth;
    }
  });

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const recompute = (): void => {
      const widths = widthsRef.current;
      if (widths.length < total) return;
      const avail = c.clientWidth;
      let acc = 0;
      let n = 0;
      for (let i = 0; i < total; i++) {
        const w = widths[i] ?? 0;
        if (acc + w > avail) break;
        acc += w;
        n++;
      }
      // Always show at least 1 button to make the group feel non-empty.
      const next = Math.max(1, n);
      setVisible(prev => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver(recompute);
    ro.observe(c);
    recompute();
    return () => ro.disconnect();
  }, [total]);

  useEffect(() => {
    onCollapsedChange?.(Math.max(0, total - visible));
  }, [visible, total, onCollapsedChange]);

  return (
    <div ref={containerRef} style={styles.ribbonGroupBody}>
      {items.map((child, i) => (
        <div
          // Key on index — children here are flat tool buttons, not keyed lists.
          key={i}
          ref={(el) => { itemRefs.current[i] = el; }}
          style={{ display: i < visible ? 'inline-flex' : 'none', flexShrink: 0 }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}

function RibbonGroupView({
  label,
  children,
  menu,
}: {
  label: string;
  children: React.ReactNode;
  /** When present, the label becomes a clickable dropdown trigger. */
  menu?: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const [collapsedCount, setCollapsedCount] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // If the responsive row had to hide items, we MUST surface a dropdown
  // even when no explicit menu was passed in.
  const effectiveMenu = menu ?? (collapsedCount > 0 ? [] : undefined);
  const hasMenu = !!effectiveMenu;

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ left: rect.left, top: rect.bottom, width: rect.width });
    }
    setOpen(true);
  };

  return (
    <div style={styles.ribbonGroup}>
      <ResponsiveRow onCollapsedChange={setCollapsedCount}>{children}</ResponsiveRow>
      {hasMenu ? (
        <button
          ref={triggerRef}
          type="button"
          style={{
            ...styles.ribbonGroupLabelButton,
            // Hint that items collapsed into the dropdown — a clear brand-blue
            // (with a touch more weight) so the group reads as interactive, not
            // disabled.
            ...(collapsedCount > 0 ? { color: '#3b82f6', fontWeight: 600 } : {}),
          }}
          onClick={toggle}
          title={collapsedCount > 0
            ? `${label} (${collapsedCount} more hidden, click to see all)`
            : `Show all ${label.toLowerCase()} tools`}
        >
          {label} <ChevronDown size={10} style={{ marginLeft: 2, verticalAlign: 'middle' }} />
        </button>
      ) : (
        <div style={styles.ribbonGroupLabel}>{label}</div>
      )}

      {open && anchor && (
        <>
          {/* Click-away backdrop, fixed so it covers everything */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={() => setOpen(false)}
          />
          {/* Dropdown rendered in fixed coords so the ribbon's overflowX:auto
              does NOT clip it. Anchored just under the group label. */}
          <div
            style={{
              ...styles.dropdown,
              position: 'fixed',
              left: anchor.left,
              top: anchor.top + 2,
              minWidth: Math.max(180, anchor.width),
            }}
          >
            {!menu ? (
              // Auto-collapse case (no explicit menu): show the group's real
              // ribbon buttons so the dropdown is always functional — never a
              // dead/"disabled" menu. Clicking any tool closes the popover.
              <div
                style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 4, maxWidth: 232 }}
                onClickCapture={() => setOpen(false)}
              >
                {children}
              </div>
            ) : menu.map(item => (
              <button
                key={item.id}
                type="button"
                disabled={item.disabled}
                style={{
                  ...styles.dropdownItem,
                  background: item.active ? '#e3effb' : 'transparent',
                  color: item.disabled ? '#bbb' : '#333',
                  cursor: item.disabled ? 'not-allowed' : 'pointer',
                }}
                onClick={() => {
                  if (item.disabled) return;
                  item.onClick?.();
                  setOpen(false);
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled && !item.active) {
                    (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0';
                  }
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = item.active ? '#e3effb' : 'transparent';
                }}
              >
                <span style={styles.dropdownIcon}>{item.icon}</span>
                <span style={styles.dropdownLabel}>{item.label}</span>
                {item.shortcut && <span style={styles.dropdownShortcut}>{item.shortcut}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface RibbonBtnProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string | undefined;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  primary?: boolean | undefined;
  onClick: () => void;
}

function RibbonBtn({ icon, label, shortcut, active, disabled, primary, onClick }: RibbonBtnProps) {
  const [hover, setHover] = useState(false);
  const baseBg = primary
    ? (active ? '#16a34a' : '#22c55e')
    : (active ? '#e3effb' : 'transparent');
  const hoverBg = primary
    ? '#16a34a'
    : (active ? '#d4e6f9' : '#ebebeb');
  const bg = disabled
    ? 'transparent'
    : (hover ? hoverBg : baseBg);
  const color = primary ? '#fff' : (active ? '#1a6fd1' : '#444');
  const borderColor = primary
    ? (active ? '#15803d' : '#16a34a')
    : (active ? '#a8cef0' : 'transparent');

  return (
    <button
      style={{
        ...styles.ribbonBtn,
        background: bg,
        color,
        borderColor,
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => !disabled && setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
    >
      <span style={styles.ribbonBtnIcon}>{icon}</span>
      <span style={styles.ribbonBtnLabel}>{label}</span>
    </button>
  );
}

interface IconBtnProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  active?: boolean | undefined;
}

// ---- ExportButton ----

/**
 * Dropdown variant of IconBtn — clicking the FileInput icon opens a
 * small menu listing the importable formats: component (.cadcomponent),
 * STEP / STL / BREP body geometry, a FreeCAD `.fcstd` document, and
 * DXF / SVG sketches. The 3D-body entries call back with a format hint,
 * which the App layer forwards to `pickGeometryForImport(format)` so the
 * native file picker only shows files of that format; the others trigger
 * their own dedicated pick flows.
 *
 * Shares `exportMenuStyles` with `ExportButton` for a consistent
 * dropdown look. Kept structurally identical to ExportButton so the
 * two grow in lockstep (same hover treatment, same keyboard close,
 * same close-on-outside-click).
 */
function ImportButton({
  onImport,
  onImportFcstd,
  onImportComponent,
  onImportSketchDxf,
  onImportSketchSvg,
}: {
  onImport?: ((format?: 'step' | 'stl' | 'brep') => void) | undefined;
  onImportFcstd?: (() => void) | undefined;
  onImportComponent?: (() => void) | undefined;
  onImportSketchDxf?: (() => void) | undefined;
  onImportSketchSvg?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  function pick(format: 'step' | 'stl' | 'brep') {
    if (!onImport) return;
    setOpen(false);
    onImport(format);
  }

  function pickComponent() {
    if (!onImportComponent) return;
    setOpen(false);
    onImportComponent();
  }

  function pickFcstd() {
    if (!onImportFcstd) return;
    setOpen(false);
    onImportFcstd();
  }

  function pickSketchDxf() {
    if (!onImportSketchDxf) return;
    setOpen(false);
    onImportSketchDxf();
  }

  function pickSketchSvg() {
    if (!onImportSketchSvg) return;
    setOpen(false);
    onImportSketchSvg();
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="Import (Component / STEP / STL / BREP / FreeCAD / DXF / SVG)"
        style={{
          ...styles.iconBtn,
          background: hover ? '#ebebeb' : 'transparent',
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <FileInput size={16} />
      </button>
      {open && (
        <div role="menu" style={exportMenuStyles.menu}>
          <ExportMenuItem
            label="Import Component..."
            sub=".cadcomponent / .cadjson · embed as a parametric instance"
            onClick={pickComponent}
          />
          <ExportMenuItem
            label="Import STEP..."
            sub=".step / .stp · precise parametric geometry"
            onClick={() => pick('step')}
          />
          <ExportMenuItem
            label="Import STL..."
            sub=".stl · faceted mesh (3D-printable shells)"
            onClick={() => pick('stl')}
          />
          <ExportMenuItem
            label="Import BREP..."
            sub=".brep / .brp · OpenCASCADE native B-Rep"
            onClick={() => pick('brep')}
          />
          <ExportMenuItem
            label="Import FreeCAD..."
            sub=".fcstd · parametric Sketch/Pad/Pocket tree → opens as a new document"
            onClick={pickFcstd}
          />
          <ExportMenuItem
            label="Import DXF (sketch)..."
            sub=".dxf · 2D curves → new sketch on a chosen plane"
            onClick={pickSketchDxf}
          />
          <ExportMenuItem
            label="Import SVG (sketch, experimental)..."
            sub=".svg · small files only · large/detailed art may be slow or rejected"
            onClick={pickSketchSvg}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Dropdown variant of IconBtn — clicking the package icon opens a small
 * menu with STL / STEP / BREP / 3MF entries. Each calls back with the format,
 * the App layer wires it to rebuildScheduler.exportActivePart + download.
 */
function ExportButton({
  onExport,
}: {
  onExport?: ((format: 'stl' | 'step' | 'brep' | '3mf') => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'stl' | 'step' | 'brep' | '3mf'>(null);
  const [hover, setHover] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  async function pick(format: 'stl' | 'step' | 'brep' | '3mf') {
    if (!onExport || busy) return;
    setBusy(format);
    setOpen(false);
    try {
      await onExport(format);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        title={busy ? `Exporting ${busy.toUpperCase()}...` : 'Export (STL / STEP / BREP / 3MF)'}
        style={{
          ...styles.iconBtn,
          background: hover && busy === null ? '#ebebeb' : 'transparent',
          opacity: busy !== null ? 0.5 : 1,
          cursor: busy !== null ? 'wait' : 'pointer',
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <Package size={16} />
      </button>
      {open && (
        <div role="menu" style={exportMenuStyles.menu}>
          <ExportMenuItem
            label="Export STL..."
            sub=".stl · 3D printing"
            onClick={() => pick('stl')}
          />
          <ExportMenuItem
            label="Export STEP..."
            sub=".step · parametric CAD interchange"
            onClick={() => pick('step')}
          />
          <ExportMenuItem
            label="Export BREP..."
            sub=".brep · OpenCASCADE native B-Rep"
            onClick={() => pick('brep')}
          />
          <ExportMenuItem
            label="Export 3MF..."
            sub=".3mf · modern slicer format"
            onClick={() => pick('3mf')}
          />
        </div>
      )}
    </div>
  );
}

function ExportMenuItem({
  label,
  sub,
  onClick,
}: {
  label: string;
  sub: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...exportMenuStyles.item,
        background: hover ? '#f5f5f5' : 'transparent',
      }}
    >
      <span style={exportMenuStyles.itemLabel}>{label}</span>
      <span style={exportMenuStyles.itemSub}>{sub}</span>
    </button>
  );
}

const exportMenuStyles: Record<string, React.CSSProperties> = {
  menu: {
    position: 'absolute',
    top: '110%',
    left: 0,
    minWidth: 220,
    padding: '4px 0',
    background: '#ffffff',
    border: '1px solid #e5e5e5',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
    zIndex: 200,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    width: '100%',
    padding: '6px 12px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    transition: 'background 0.1s',
  },
  itemLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#222',
  },
  itemSub: {
    fontSize: 10,
    color: '#888',
    marginTop: 1,
  },
};

function IconBtn({ icon, label, onClick, disabled, active }: IconBtnProps) {
  const [hover, setHover] = useState(false);
  const bg = active
    ? (hover ? '#d4e6f9' : '#e3effb')
    : (hover && !disabled ? '#ebebeb' : 'transparent');
  return (
    <button
      style={{
        ...styles.iconBtn,
        background: bg,
        color: active ? '#1a6fd1' : '#555',
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={label}
      onMouseEnter={() => !disabled && setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {icon}
    </button>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    height: 36,
    padding: '0 8px',
    gap: 2,
    borderBottom: '1px solid #ececec',
    background: '#f7f7f7',
    userSelect: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  ribbonRow: {
    display: 'flex',
    alignItems: 'stretch',
    height: 78,
    padding: '4px 6px',
    gap: 0,
    // No horizontal scrollbar — each ribbon group's ResponsiveRow collapses
    // its trailing buttons into the group's dropdown when space is tight.
    overflowX: 'hidden',
    overflowY: 'hidden',
    width: '100%',
    background: '#ffffff',
    borderBottom: '1px solid #d8d8d8',
    userSelect: 'none',
    boxSizing: 'border-box',
  },
  /**
   * Wraps the logo image; tracks the sidebar's width so the logo lives in
   * its own "column" aligned with the ProjectTree. Width is set inline
   * from sidebarCollapsed state; the transition keeps it in lock-step with
   * the sidebar's own width animation (Shell.tsx uses 140ms ease-out).
   */
  logoArea: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: '100%',
    flexShrink: 0,
    overflow: 'hidden',
    transition: 'width 140ms ease-out',
  },
  logoImg: {
    height: 24,
    width: 'auto',
    objectFit: 'contain',
    pointerEvents: 'none',
  },
  /** Two-color one-word wordmark next to the logo; colors sampled from logo.png. */
  wordmark: {
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },
  /** 20px between the sidebar-collapse toggle and the rest of the app bar. */
  afterCollapseGap: {
    width: 20,
    flexShrink: 0,
  },
  separator: {
    width: 1,
    height: 20,
    background: '#d8d8d8',
    margin: '0 4px',
  },
  iconBtn: {
    width: 26,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 4,
    padding: 0,
    transition: 'background 0.1s, color 0.1s',
  },
  ribbonGroup: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    padding: '2px 6px 0 6px',
    borderRight: '1px solid #ececec',
    // Allow groups to shrink so the ResponsiveRow inside each one can detect
    // its container is narrowing and progressively hide trailing buttons.
    // minWidth keeps a 1-button footprint so the group label/dropdown is
    // always reachable even when fully collapsed.
    flexShrink: 1,
    minWidth: 72,
    minHeight: 0,
  },
  ribbonGroupBody: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 1,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  ribbonGroupLabel: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.6,
    color: '#888',
    textAlign: 'center',
    padding: '0 0 1px 0',
    textTransform: 'uppercase',
  },
  ribbonGroupLabelButton: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.6,
    color: '#666',
    textAlign: 'center',
    padding: '0 4px 1px 4px',
    textTransform: 'uppercase',
    border: '1px solid transparent',
    background: 'transparent',
    cursor: 'pointer',
    borderRadius: 3,
    display: 'block',
    width: '100%',
  },
  ribbonBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    width: 60,
    minWidth: 60,
    flexShrink: 0,
    height: 58,
    padding: '4px 2px 2px 2px',
    border: '1px solid transparent',
    borderRadius: 4,
    background: 'transparent',
    transition: 'background 0.1s, border-color 0.1s, color 0.1s',
    gap: 2,
  },
  ribbonBtnIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 30,
  },
  ribbonBtnLabel: {
    fontSize: 10,
    fontWeight: 500,
    lineHeight: 1.1,
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 58,
  },
  dropdown: {
    background: '#ffffff',
    border: '1px solid #d8d8d8',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
    padding: 4,
    zIndex: 200,
    minWidth: 200,
    maxHeight: '70vh',
    overflowY: 'auto',
  },
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    minHeight: 30,
    padding: '4px 10px',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'background 0.1s',
  },
  dropdownIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    flexShrink: 0,
  },
  dropdownLabel: {
    flex: 1,
    fontWeight: 500,
  },
  dropdownShortcut: {
    fontSize: 10,
    color: '#999',
    background: '#f0f0f0',
    padding: '1px 5px',
    borderRadius: 3,
    fontFamily: 'ui-monospace, monospace',
  },
  finishWrap: {
    display: 'flex',
    alignItems: 'center',
    paddingRight: 8,
  },
  finishBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    width: 60,
    height: 60,
    padding: 0,
    border: '1px solid #16a34a',
    borderRadius: 4,
    background: '#ffffff',
    color: '#15803d',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.2,
    fontFamily: 'inherit',
    transition: 'background 0.12s, border-color 0.12s',
  },
  finishLabel: {
    fontSize: 10,
    fontWeight: 600,
    lineHeight: 1,
  },
  rebuildBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#cc7700',
    background: '#fff3e0',
    padding: '2px 8px',
    borderRadius: 10,
    letterSpacing: 0.3,
    marginRight: 8,
  },
  projectName: {
    fontSize: 12,
    color: '#777',
    maxWidth: 240,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    marginRight: 4,
  },
};

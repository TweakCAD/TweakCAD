/**
 * The ribbon's tools, grouped and lettered (E Extrude, H Hole, F Fillet,
 * M Move, J Joint, I Measure; S opens the toolbox): in modelling, the modelling
 * tools; while a sketch is edited, the session's tools, constraints and
 * dimensions. Only what the app can do is offered.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { SquareSplitHorizontal } from 'lucide-react';
import type { RibbonToolGroup } from '../../components/MainToolbar.tsx';
import { toolForShortcutKey } from '../../components/toolShortcuts.ts';
import { useSaasState } from '../../storage/useSaasState.ts';
import {
  ArcToolIcon,
  AxisIcon,
  ConstructionPointIcon,
  FrameIcon,
  LoftIcon,
  SweepIcon,
  ThreadIcon,
  CenterRectToolIcon,
  MeasureIcon,
  PlaneIcon,
  BoxIcon,
  ConeIcon,
  CutIcon,
  CylinderIcon,
  FuseIcon,
  MirrorIcon,
  MoveIcon,
  PatternIcon,
  ShellIcon,
  SphereIcon,
  TorusIcon,
  ChamferIcon,
  CircleToolIcon,
  CoincidentConstraintIcon,
  CollinearConstraintIcon,
  ConcentricConstraintIcon,
  ConstructionGeometryIcon,
  DimensionToolIcon,
  DistanceXToolIcon,
  DistanceYToolIcon,
  EllipseToolIcon,
  EqualConstraintIcon,
  ExtendToolIcon,
  ExtrudeIcon,
  FilletIcon,
  FixConstraintIcon,
  HVConstraintIcon,
  HoleIcon,
  HorizontalConstraintIcon,
  IntersectToolIcon,
  LineToolIcon,
  MidpointConstraintIcon,
  OffsetToolIcon,
  ParallelConstraintIcon,
  PerpendicularConstraintIcon,
  PointToolIcon,
  PolygonToolIcon,
  ProjectToolIcon,
  RectToolIcon,
  RevolveIcon,
  SelectHandIcon,
  SketchFilletToolIcon,
  SketchIcon,
  SketchMirrorToolIcon,
  SlotToolIcon,
  SplineToolIcon,
  SymmetryConstraintIcon,
  TangentArcToolIcon,
  TangentConstraintIcon,
  TextToolIcon,
  TrimToolIcon,
  VerticalConstraintIcon,
  PointOnLineConstraintIcon,
  PointOnCircleConstraintIcon,
} from '../../icons/cadIcons.tsx';
import type { ConstraintKind, SketchSession, SketchSessionState, SketchTool } from '../../sketcher';
import { useSlice } from '../hooks';
import type { AppState } from '../appState';
import type { AppServices } from '../services';
import { startExtrude, startPanel, startProfileFeature, startSketch } from './commands';
import type { SessionStore } from './SketchMode';
import { insertDrawing } from './sketchFiles';
import { ASSEMBLY_TOOLS } from '../assembly/tools';

export interface ModelTool {
  id: string;
  label: string;
  /** The tool's text in the group's menu, when it differs from the button's. */
  menuLabel?: string;
  group: 'CREATE' | 'MODIFY' | 'CONSTRUCT' | 'ASSEMBLE' | 'INSPECT';
  shortcut?: string;
  /** Shown as a button; the others are in the group's menu only. */
  primary?: boolean;
  icon: React.ReactNode;
  /** The panel kind that shows the tool as active. */
  panel?: string;
  /** Whether the tool is offered now; absent, always. */
  available?: () => boolean;
  /** Shows the tool as active by app state other than a panel. */
  active?: (state: AppState) => boolean;
  run: (services: AppServices) => void;
}

const MODEL_TOOLS: readonly ModelTool[] = [
  {
    id: 'sketch',
    label: 'Sketch',
    group: 'CREATE',
    icon: <SketchIcon size={26} color="#3b82f6" />,
    panel: 'sketchPlane',
    run: (s) => void startSketch(s),
  },
  {
    id: 'extrude',
    label: 'Extrude',
    group: 'CREATE',
    shortcut: 'E',
    icon: <ExtrudeIcon size={26} color="#22c55e" />,
    panel: 'extrude',
    run: (s) => startExtrude(s),
  },
  {
    id: 'revolve',
    label: 'Revolve',
    group: 'CREATE',
    icon: <RevolveIcon size={26} color="#ec4899" />,
    panel: 'revolve',
    run: (s) => startProfileFeature(s, 'revolve', 'Revolve'),
  },
  {
    id: 'sweep',
    label: 'Sweep',
    group: 'CREATE',
    icon: <SweepIcon size={26} color="#eab308" />,
    panel: 'sweep',
    run: (s) => startProfileFeature(s, 'sweep', 'Sweep', undefined, undefined, false),
  },
  {
    id: 'loft',
    label: 'Loft',
    group: 'CREATE',
    icon: <LoftIcon size={26} color="#eab308" />,
    panel: 'loft',
    run: (s) => startProfileFeature(s, 'loft', 'Loft', undefined, undefined, false),
  },
  {
    id: 'hole',
    label: 'Hole',
    group: 'CREATE',
    shortcut: 'H',
    icon: <HoleIcon size={26} color="#f97316" />,
    panel: 'hole',
    run: (s) => startPanel(s, 'hole', 'Hole', { needsBody: true }),
  },
  {
    id: 'primBox',
    label: 'Box',
    group: 'CREATE',
    icon: <BoxIcon size={26} color="#14b8a6" />,
    panel: 'primitive.box',
    run: (s) => startPanel(s, 'primitive.box', 'Box'),
  },
  {
    id: 'thread',
    label: 'Thread',
    group: 'CREATE',
    primary: false,
    icon: <ThreadIcon size={26} color="#f97316" />,
    panel: 'thread',
    run: (s) => startPanel(s, 'thread', 'Thread', { needsBody: true }),
  },
  {
    id: 'primCylinder',
    label: 'Cylinder',
    group: 'CREATE',
    primary: false,
    icon: <CylinderIcon size={26} color="#14b8a6" />,
    panel: 'primitive.cylinder',
    run: (s) => startPanel(s, 'primitive.cylinder', 'Cylinder'),
  },
  {
    id: 'primSphere',
    label: 'Sphere',
    group: 'CREATE',
    primary: false,
    icon: <SphereIcon size={26} color="#14b8a6" />,
    panel: 'primitive.sphere',
    run: (s) => startPanel(s, 'primitive.sphere', 'Sphere'),
  },
  {
    id: 'primCone',
    label: 'Cone',
    group: 'CREATE',
    primary: false,
    icon: <ConeIcon size={26} color="#14b8a6" />,
    panel: 'primitive.cone',
    run: (s) => startPanel(s, 'primitive.cone', 'Cone'),
  },
  {
    id: 'primTorus',
    label: 'Torus',
    group: 'CREATE',
    primary: false,
    icon: <TorusIcon size={26} color="#14b8a6" />,
    panel: 'primitive.torus',
    run: (s) => startPanel(s, 'primitive.torus', 'Torus'),
  },
  {
    id: 'pattern',
    label: 'Pattern',
    group: 'CREATE',
    primary: false,
    icon: <PatternIcon size={26} color="#eab308" />,
    panel: 'pattern',
    run: (s) => startPanel(s, 'pattern', 'Pattern', { needsBody: true }),
  },
  {
    id: 'mirror',
    label: 'Mirror',
    group: 'CREATE',
    primary: false,
    icon: <MirrorIcon size={26} color="#a855f7" />,
    panel: 'mirror',
    run: (s) => startPanel(s, 'mirror', 'Mirror', { needsBody: true }),
  },
  {
    id: 'fillet',
    label: 'Fillet',
    group: 'MODIFY',
    shortcut: 'F',
    icon: <FilletIcon size={26} color="#06b6d4" />,
    panel: 'fillet',
    run: (s) => startPanel(s, 'fillet', 'Fillet', { needsBody: true }),
  },
  {
    id: 'chamfer',
    label: 'Chamfer',
    group: 'MODIFY',
    icon: <ChamferIcon size={26} color="#06b6d4" />,
    panel: 'chamfer',
    run: (s) => startPanel(s, 'chamfer', 'Chamfer', { needsBody: true }),
  },
  {
    id: 'shell',
    label: 'Shell',
    group: 'MODIFY',
    icon: <ShellIcon size={26} color="#64748b" />,
    panel: 'shell',
    run: (s) => startPanel(s, 'shell', 'Shell', { needsBody: true }),
  },
  // One Combine, its operation (Join, Cut, Intersect) chosen in its panel.
  {
    id: 'combine',
    label: 'Combine',
    group: 'MODIFY',
    icon: <FuseIcon size={26} color="#8b5cf6" />,
    panel: 'combine',
    run: (s) => startPanel(s, 'combine', 'Combine', { needsBody: true }),
  },
  {
    id: 'move',
    label: 'Move',
    group: 'MODIFY',
    primary: false,
    shortcut: 'M',
    icon: <MoveIcon size={26} color="#0ea5e9" />,
    panel: 'move',
    run: (s) => startPanel(s, 'move', 'Move', { needsBody: true }),
  },
  {
    id: 'parameters',
    label: 'Parameters',
    menuLabel: 'Change Parameters',
    group: 'MODIFY',
    primary: false,
    icon: <DimensionToolIcon size={26} color="#9c27b0" />,
    run: (s) => s.app.setState({ parametersOpen: true }),
  },
  {
    id: 'removeBody',
    label: 'Remove Body',
    group: 'MODIFY',
    primary: false,
    icon: <CutIcon size={26} color="#ef4444" />,
    panel: 'removeBody',
    run: (s) => startPanel(s, 'removeBody', 'Remove Body', { needsBody: true }),
  },
  {
    id: 'offsetPlane',
    label: 'Offset Plane',
    group: 'CONSTRUCT',
    icon: <PlaneIcon size={26} color="#3b82f6" />,
    panel: 'construction.offsetPlane',
    run: (s) => startPanel(s, 'construction.offsetPlane', 'Offset Plane'),
  },
  {
    id: 'planeFromFace',
    label: 'Plane from Face',
    group: 'CONSTRUCT',
    icon: <PlaneIcon size={26} color="#3b82f6" />,
    panel: 'construction.planeFromFace',
    run: (s) => startPanel(s, 'construction.planeFromFace', 'Plane from Face', { needsBody: true }),
  },
  {
    id: 'plane',
    label: 'Plane',
    group: 'CONSTRUCT',
    primary: false,
    icon: <PlaneIcon size={26} color="#3b82f6" />,
    panel: 'construction.plane',
    run: (s) => startPanel(s, 'construction.plane', 'Plane'),
  },
  {
    id: 'midplane',
    label: 'Midplane',
    group: 'CONSTRUCT',
    primary: false,
    icon: <PlaneIcon size={26} color="#3b82f6" />,
    panel: 'construction.midplane',
    run: (s) => startPanel(s, 'construction.midplane', 'Midplane'),
  },
  {
    id: 'axis',
    label: 'Axis',
    group: 'CONSTRUCT',
    primary: false,
    icon: <AxisIcon size={26} color="#3b82f6" />,
    panel: 'construction.axis',
    run: (s) => startPanel(s, 'construction.axis', 'Axis'),
  },
  {
    id: 'axisThroughCylinder',
    label: 'Axis Through Cylinder',
    group: 'CONSTRUCT',
    primary: false,
    icon: <AxisIcon size={26} color="#3b82f6" />,
    panel: 'construction.axisThroughCylinder',
    run: (s) => startPanel(s, 'construction.axisThroughCylinder', 'Axis Through Cylinder', { needsBody: true }),
  },
  {
    id: 'point',
    label: 'Point',
    group: 'CONSTRUCT',
    primary: false,
    icon: <ConstructionPointIcon size={26} color="#3b82f6" />,
    panel: 'construction.point',
    run: (s) => startPanel(s, 'construction.point', 'Point'),
  },
  {
    id: 'pointAtCenter',
    label: 'Point at Center',
    group: 'CONSTRUCT',
    primary: false,
    icon: <ConstructionPointIcon size={26} color="#3b82f6" />,
    panel: 'construction.pointAtCenter',
    run: (s) => startPanel(s, 'construction.pointAtCenter', 'Point at Center', { needsBody: true }),
  },
  {
    id: 'frame',
    label: 'Frame',
    group: 'CONSTRUCT',
    primary: false,
    icon: <FrameIcon size={26} color="#3b82f6" />,
    panel: 'construction.frame',
    run: (s) => startPanel(s, 'construction.frame', 'Frame'),
  },
  {
    id: 'measure',
    label: 'Measure',
    group: 'INSPECT',
    shortcut: 'I',
    icon: <MeasureIcon size={26} color="#0d9488" />,
    panel: 'measure',
    run: (s) => toggleMeasure(s),
  },
  {
    id: 'section',
    label: 'Section',
    group: 'INSPECT',
    icon: <SquareSplitHorizontal size={26} color="#059669" strokeWidth={1.5} />,
    active: (s) => s.section !== null,
    run: (s) => toggleSection(s),
  },
  ...ASSEMBLY_TOOLS,
];

/**
 * The Section tool starts a section view (cut parallel to XZ), leaving a sketch and closing a panel first, or ends it.
 */
export function toggleSection(services: AppServices): void {
  const { app } = services;
  if (app.getState().section) {
    app.setState({ section: null });
    return;
  }
  app.setState({ panel: null, ...(app.getState().mode.kind === 'sketch' ? { mode: { kind: 'model' } } : {}) });
  app.setState({ section: { plane: 'XZ', distance: null, angle: 0, flipped: false } });
}

/** The Measure tool opens its panel, or closes it when open. */
function toggleMeasure(services: AppServices): void {
  if (services.app.getState().panel?.kind === 'measure') services.app.setState({ panel: null });
  else startPanel(services, 'measure', 'Measure');
}

/** The modelling ribbon, and its shortcuts while modelling with no panel open. */
export function useModelingRibbon(services: AppServices): RibbonToolGroup[] {
  const { app } = services;
  const panel = useSlice(app, (s) => s.panel);
  const mode = useSlice(app, (s) => s.mode);
  // Tools active by app state (Section) follow it, and tools offered with a site follow the site.
  useSlice(app, (s) => s.section);
  useSaasState();

  useEffect(() => {
    if (mode.kind !== 'model' || (panel && panel.kind !== 'sketchPlane')) return;
    const keyed = MODEL_TOOLS.flatMap((t) => (t.shortcut ? [{ id: t.id, shortcut: t.shortcut }] : []));
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const id = toolForShortcutKey(e, keyed);
      const tool = MODEL_TOOLS.find((t) => t.id === id);
      if (!tool) return;
      e.preventDefault();
      tool.run(services);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [services, mode.kind, panel]);

  return modelToolGroups()
    .map(({ label, tools }) => ({ label, tools: tools.filter((t) => !t.available || t.available()) }))
    .filter((g) => g.tools.length > 0)
    .map(({ label, tools }) => ({
      label,
      tools: tools.map((t) => ({
        id: t.id,
        label: t.label,
        ...(t.menuLabel !== undefined ? { menuLabel: t.menuLabel } : {}),
        shortcut: t.shortcut,
        icon: t.icon,
        primary: t.primary !== false,
        active: (t.panel !== undefined && panel?.kind === t.panel) || (t.active?.(app.getState()) ?? false),
        onClick: () => t.run(services),
      })),
    }));
}

/** The modelling ribbon's groups in order, each with its tools in list order. */
export const GROUP_ORDER: readonly ModelTool['group'][] = ['CREATE', 'MODIFY', 'CONSTRUCT', 'ASSEMBLE', 'INSPECT'];

export function modelToolGroups(): { label: ModelTool['group']; tools: ModelTool[] }[] {
  return GROUP_ORDER.map((label) => ({ label, tools: MODEL_TOOLS.filter((t) => t.group === label) }));
}

type ToolDef = {
  id: SketchTool;
  label: string;
  shortcut?: string;
  primary?: boolean;
  icon: (c: string) => React.ReactNode;
};

/** The sketch CREATE group: the everyday tools as buttons, the other constructors in its menu. */
const CREATE: ToolDef[] = [
  { id: 'line', label: 'Line', shortcut: 'L', primary: true, icon: (c) => <LineToolIcon size={26} color={c} /> },
  {
    id: 'rectangle',
    label: 'Rectangle',
    shortcut: 'R',
    primary: true,
    icon: (c) => <RectToolIcon size={26} color={c} />,
  },
  { id: 'circle', label: 'Circle', shortcut: 'C', primary: true, icon: (c) => <CircleToolIcon size={26} color={c} /> },
  { id: 'arc', label: 'Arc', shortcut: 'A', primary: true, icon: (c) => <ArcToolIcon size={26} color={c} /> },
  { id: 'point', label: 'Point', primary: true, icon: (c) => <PointToolIcon size={26} color={c} /> },
  { id: 'text', label: 'Text', primary: true, icon: (c) => <TextToolIcon size={26} color={c} /> },
  { id: 'centerRectangle', label: 'Center Rectangle', icon: (c) => <CenterRectToolIcon size={26} color={c} /> },
  { id: 'circle2', label: 'Circle 2-pt', icon: (c) => <CircleToolIcon size={26} color={c} /> },
  { id: 'circle3', label: 'Circle 3-pt', icon: (c) => <CircleToolIcon size={26} color={c} /> },
  { id: 'arcCenter', label: 'Arc center', icon: (c) => <ArcToolIcon size={26} color={c} /> },
  { id: 'tangentArc', label: 'Tangent Arc', icon: (c) => <TangentArcToolIcon size={26} color={c} /> },
  { id: 'polygon', label: 'Inscribed Polygon', icon: (c) => <PolygonToolIcon size={26} color={c} /> },
  { id: 'polygonCircumscribed', label: 'Circumscribed Polygon', icon: (c) => <PolygonToolIcon size={26} color={c} /> },
  { id: 'polygonEdge', label: 'Edge Polygon', icon: (c) => <PolygonToolIcon size={26} color={c} /> },
  { id: 'slot', label: 'Slot', icon: (c) => <SlotToolIcon size={26} color={c} /> },
  { id: 'ellipse', label: 'Ellipse', icon: (c) => <EllipseToolIcon size={26} color={c} /> },
  { id: 'spline', label: 'Spline', icon: (c) => <SplineToolIcon size={26} color={c} /> },
  { id: 'project', label: 'Project', shortcut: 'P', icon: (c) => <ProjectToolIcon size={26} color={c} /> },
  { id: 'intersect', label: 'Intersect', icon: (c) => <IntersectToolIcon size={26} color={c} /> },
];

const MODIFY: ToolDef[] = [
  { id: 'trim', label: 'Trim', shortcut: 'T', primary: true, icon: (c) => <TrimToolIcon size={26} color={c} /> },
  { id: 'fillet', label: 'Fillet', primary: true, icon: (c) => <SketchFilletToolIcon size={26} color={c} /> },
  { id: 'offset', label: 'Offset', shortcut: 'O', primary: true, icon: (c) => <OffsetToolIcon size={26} color={c} /> },
  { id: 'extend', label: 'Extend', icon: (c) => <ExtendToolIcon size={26} color={c} /> },
  { id: 'mirror', label: 'Mirror', icon: (c) => <SketchMirrorToolIcon size={26} color={c} /> },
];

const DIMENSION: ToolDef[] = [
  {
    id: 'dimension',
    label: 'Dimension',
    shortcut: 'D',
    primary: true,
    icon: (c) => <DimensionToolIcon size={26} color={c} />,
  },
  { id: 'dimensionX', label: 'Dim H', primary: true, icon: (c) => <DistanceXToolIcon size={26} color={c} /> },
  { id: 'dimensionY', label: 'Dim V', primary: true, icon: (c) => <DistanceYToolIcon size={26} color={c} /> },
];

/** The CONSTRAINTS group: H / V and the common ones as buttons, the rest in its menu. */
const CONSTRAINTS: { id: ConstraintKind; label: string; primary: boolean; icon: (c: string) => React.ReactNode }[] = [
  { id: 'hv', label: 'H / V', primary: true, icon: (c) => <HVConstraintIcon size={26} color={c} /> },
  {
    id: 'coincident',
    label: 'Coincident',
    primary: true,
    icon: (c) => <CoincidentConstraintIcon size={26} color={c} />,
  },
  {
    id: 'perpendicular',
    label: 'Perpendicular',
    primary: true,
    icon: (c) => <PerpendicularConstraintIcon size={26} color={c} />,
  },
  { id: 'parallel', label: 'Parallel', primary: true, icon: (c) => <ParallelConstraintIcon size={26} color={c} /> },
  { id: 'tangent', label: 'Tangent', primary: true, icon: (c) => <TangentConstraintIcon size={26} color={c} /> },
  { id: 'equal', label: 'Equal', primary: true, icon: (c) => <EqualConstraintIcon size={26} color={c} /> },
  {
    id: 'horizontal',
    label: 'Horizontal',
    primary: false,
    icon: (c) => <HorizontalConstraintIcon size={26} color={c} />,
  },
  { id: 'vertical', label: 'Vertical', primary: false, icon: (c) => <VerticalConstraintIcon size={26} color={c} /> },
  {
    id: 'pointOnLine',
    label: 'Point on line',
    primary: false,
    icon: (c) => <PointOnLineConstraintIcon size={26} color={c} />,
  },
  {
    id: 'pointOnCircle',
    label: 'Point on circle',
    primary: false,
    icon: (c) => <PointOnCircleConstraintIcon size={26} color={c} />,
  },
  { id: 'collinear', label: 'Collinear', primary: false, icon: (c) => <CollinearConstraintIcon size={26} color={c} /> },
  { id: 'midpoint', label: 'Midpoint', primary: false, icon: (c) => <MidpointConstraintIcon size={26} color={c} /> },
  {
    id: 'concentric',
    label: 'Concentric',
    primary: false,
    icon: (c) => <ConcentricConstraintIcon size={26} color={c} />,
  },
  { id: 'symmetric', label: 'Symmetric', primary: false, icon: (c) => <SymmetryConstraintIcon size={26} color={c} /> },
  { id: 'fix', label: 'Fix / UnFix', primary: false, icon: (c) => <FixConstraintIcon size={26} color={c} /> },
];

const noSession = () => () => undefined;
const noState = () => null;

/** The sketch ribbon over the open session; empty until the session is open. */
export function useSketchRibbon(sessions: SessionStore): RibbonToolGroup[] {
  const session = useSlice(sessions, (s) => s.session);
  const state = useSyncExternalStore<SketchSessionState | null>(
    session?.subscribe ?? noSession,
    session?.getState ?? noState,
  );
  if (!session || !state) return [];
  return sketchRibbon(session, state);
}

export function sketchRibbon(session: SketchSession, state: SketchSessionState): RibbonToolGroup[] {
  const tool = (t: ToolDef, color: string) => ({
    id: t.id,
    label: t.label,
    shortcut: t.shortcut,
    icon: t.icon(color),
    primary: t.primary ?? false,
    active: state.tool === t.id,
    onClick: () => session.setTool(t.id),
  });
  return [
    {
      label: 'SELECT',
      menu: true,
      tools: [
        {
          id: 'select',
          label: 'Select',
          menuLabel: 'Select (Esc)',
          icon: <SelectHandIcon size={26} color="#555" />,
          active: state.tool === 'select',
          onClick: () => session.setTool('select'),
        },
      ],
    },
    {
      label: 'CREATE',
      tools: [
        ...CREATE.map((t) => tool(t, '#3b82f6')),
        {
          id: 'construction',
          label: 'Construction',
          shortcut: 'X',
          icon: <ConstructionGeometryIcon size={26} color={state.construction ? '#964B00' : '#888'} />,
          primary: true,
          active: state.construction,
          onClick: () => session.toggleConstruction(),
        },
      ],
    },
    {
      label: 'CONSTRAINTS',
      tools: CONSTRAINTS.map((c) => ({
        id: c.id,
        label: c.label,
        icon: c.icon('#e54d2e'),
        primary: c.primary,
        active: state.tool === 'constrain' && state.constraint === c.id,
        onClick: () => session.constrain(c.id),
      })),
    },
    { label: 'DIMENSION', menu: true, tools: DIMENSION.map((t) => tool(t, '#0ea5e9')) },
    { label: 'MODIFY', tools: MODIFY.map((t) => tool(t, '#8b5cf6')) },
    {
      label: 'INSERT',
      tools: [
        {
          id: 'insertDxf',
          label: 'Insert DXF',
          icon: <SketchIcon size={26} color="#64748b" />,
          primary: true,
          onClick: () => insertDrawing(session, 'dxf'),
        },
        {
          id: 'insertSvg',
          label: 'Insert SVG',
          icon: <SketchIcon size={26} color="#64748b" />,
          primary: false,
          onClick: () => insertDrawing(session, 'svg'),
        },
      ],
    },
  ];
}

/**
 * The browser panel: the document, its parameters and its parts, and for
 * each part its origin (the standard planes, axes and point), sketches,
 * construction, derived components and bodies (an import that made several
 * as one node). The timeline is the bar at the bottom. A feature's pause
 * shows as a build failure does, with the message as its tooltip; one that
 * built but not as authored shows amber, with the warning.
 */
import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  Box,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Crosshair,
  Eye,
  EyeOff,
  FileBox,
  Layers,
  Pause,
  PenLine,
  Pencil,
  Plus,
  Ruler,
  Settings,
  SquareDashed,
  Trash2,
  ArrowUp,
  ArrowDown,
  StepBack,
  StepForward,
  Type,
  Move,
  Ungroup,
  Group,
  Lock,
  LockOpen,
  ArrowDownToLine,
  Puzzle,
  Snowflake,
} from 'lucide-react';
import { BODY_COLOR_SWATCHES } from './attributes';
import { useKeptInWindow } from './menuPlacement';
import { DOCUMENT_NODE, setAllOpen, toggleNode, useTreeOpen } from './treeOpen';
import {
  ExtrudeIcon,
  RevolveIcon,
  FeatureSuppressedIcon,
  FeatureWarningIcon,
  featureTypeColors,
  getFeatureIcon,
} from '../icons/cadIcons.tsx';
import { bodyGroups, componentsOf, rowOf } from './browserActions';
import { featureTypeLabel, type FeatureRow, type PartView } from './features';
import { editableInPanel } from './modeling/panelTypes';
import { freezable } from './modeling/freeze';
import { VIEW_FEATURE_ACTIONS } from './storage/preview';
import type { StandardDatum, StandardPlane } from './selection';

export type FeatureAction =
  | 'editSketch'
  | 'editFeature'
  | 'extrude'
  | 'revolve'
  | 'rename'
  | 'suppress'
  | 'unsuppress'
  | 'freeze'
  | 'unfreeze'
  | 'rollHere'
  | 'rollEnd'
  | 'moveUp'
  | 'moveDown'
  | 'group'
  | 'ungroup'
  | 'exportDxf'
  | 'exportSvg'
  | 'editComponent'
  | 'duplicateComponent'
  | 'delete';

/** What the menu of a group node does; the group's id comes with it. */
export type GroupAction = 'renameGroup' | 'ungroup';

/** What a body's menu, or an import's node, does to its bodies. */
export type BodyAction =
  | { kind: 'visible'; visible: boolean }
  | { kind: 'color'; color: string | null }
  /** A body's own name; empty gives it its numbered name again. */
  | { kind: 'rename'; name: string }
  | { kind: 'move' }
  /** An import placed in one step, all its bodies together: centred on the origin, or resting on the XY plane. */
  | { kind: 'place'; to: 'origin' | 'xy' }
  | { kind: 'remove' };

export interface MenuEntry {
  action: FeatureAction;
  label: string;
  danger?: boolean;
}

/**
 * The context menu of a top-level feature at `index` of a timeline of
 * `count`, rolled back to `rollbackIndex`. `grouping` offers Group when
 * several features are selected, and Ungroup for a feature in a group.
 */
export function featureMenu(
  row: FeatureRow,
  index: number,
  count: number,
  rollbackIndex: number,
  grouping: { canGroup?: boolean; grouped?: boolean } = {},
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (row.type === 'core.sketch') {
    entries.push(
      { action: 'editSketch', label: 'Edit Sketch' },
      { action: 'extrude', label: 'Extrude' },
      { action: 'revolve', label: 'Revolve' },
    );
    entries.push({ action: 'exportDxf', label: 'Export DXF...' }, { action: 'exportSvg', label: 'Export SVG...' });
  }
  if (editableInPanel(row.type) && !row.frozen) entries.push({ action: 'editFeature', label: 'Edit Feature' });
  if (row.component) entries.push({ action: 'editComponent', label: 'Edit Component...' });
  if (row.type === 'core.derive') entries.push({ action: 'duplicateComponent', label: 'Duplicate Component' });
  entries.push({ action: 'rename', label: 'Rename' });
  entries.push(
    row.suppressed ? { action: 'unsuppress', label: 'Unsuppress' } : { action: 'suppress', label: 'Suppress' },
  );
  // A top-level feature that built is frozen as it built; a frozen one is made live again.
  if (index >= 0 && freezable(row.type)) {
    if (row.frozen) entries.push({ action: 'unfreeze', label: 'Unfreeze' });
    else if (row.status === 'success') entries.push({ action: 'freeze', label: 'Freeze' });
  }
  if (index >= 0) {
    if (rollbackIndex !== index + 1) entries.push({ action: 'rollHere', label: 'Roll Back to Here' });
    if (rollbackIndex < count) entries.push({ action: 'rollEnd', label: 'Roll to End' });
    if (index > 0) entries.push({ action: 'moveUp', label: 'Move Earlier' });
    if (index < count - 1) entries.push({ action: 'moveDown', label: 'Move Later' });
    if (grouping.canGroup) entries.push({ action: 'group', label: 'Group Selected' });
    if (grouping.grouped) entries.push({ action: 'ungroup', label: 'Ungroup' });
  }
  entries.push({ action: 'delete', label: 'Delete', danger: true });
  return entries;
}

/**
 * What a body's menu offers for the feature that made it: Edit Feature (or
 * Edit Component and Duplicate Component for a derived component), then
 * Suppress or Unsuppress and Delete Feature. An import has no inputs to
 * edit, and is not suppressed from its bodies, which would leave none to
 * unsuppress it from.
 */
/** The menu entries offered: on a read-only preview only what writes nothing; with the marker fixed, no rollback moves. */
export function allowedEntries(entries: MenuEntry[], o: { readOnly: boolean; markerLocked: boolean }): MenuEntry[] {
  return entries.filter(
    (x) =>
      (!o.readOnly || VIEW_FEATURE_ACTIONS.has(x.action)) &&
      (!o.markerLocked || (x.action !== 'rollHere' && x.action !== 'rollEnd')),
  );
}

export function bodyFeatureMenu(row: FeatureRow): { edit: MenuEntry[]; state: MenuEntry[] } {
  const edit: MenuEntry[] = [];
  if (row.type === 'core.derive') {
    if (row.component) edit.push({ action: 'editComponent', label: 'Edit Component...' });
    edit.push({ action: 'duplicateComponent', label: 'Duplicate Component' });
  } else if (editableInPanel(row.type) && !row.frozen) edit.push({ action: 'editFeature', label: 'Edit Feature' });
  const state: MenuEntry[] = [];
  if (row.type !== 'core.import')
    state.push(
      row.suppressed ? { action: 'unsuppress', label: 'Unsuppress' } : { action: 'suppress', label: 'Suppress' },
    );
  state.push({ action: 'delete', label: 'Delete Feature', danger: true });
  return { edit, state };
}

const MENU_ICONS: Record<FeatureAction, React.ReactNode> = {
  editSketch: <Pencil size={14} />,
  editFeature: <Pencil size={14} />,
  extrude: <ExtrudeIcon size={14} />,
  revolve: <RevolveIcon size={14} />,
  rename: <Type size={14} />,
  suppress: <Pause size={14} />,
  unsuppress: <Pause size={14} />,
  freeze: <Snowflake size={14} />,
  unfreeze: <Snowflake size={14} />,
  rollHere: <StepBack size={14} />,
  rollEnd: <StepForward size={14} />,
  moveUp: <ArrowUp size={14} />,
  moveDown: <ArrowDown size={14} />,
  group: <Group size={14} />,
  ungroup: <Ungroup size={14} />,
  exportDxf: <FileBox size={14} />,
  exportSvg: <FileBox size={14} />,
  editComponent: <Puzzle size={14} />,
  duplicateComponent: <Puzzle size={14} />,
  delete: <Trash2 size={14} />,
};

export interface BrowserBody {
  /** The body's key in the shown display; -1 when the shown display (a preview) does not hold it. */
  key: number;
  /** Its identity, the same in a preview's display and the committed one. */
  id: string;
  name: string;
  feature: string;
  color: string;
  visible: boolean;
}

/** The keys an action on body rows acts on; a row the shown display (a preview) lacks has none. */
const keysOf = (b: BrowserBody): number[] => (b.key >= 0 ? [b.key] : []);

export interface BrowserTreeProps {
  documentName: string;
  parts: (PartView & { bodies: BrowserBody[]; configuration?: { options: string[]; active: string | null } })[];
  /** The document's parameters and the shown part's: each one's value now, its expression, and the configuration row that sets it. */
  parameters: { id: string; name: string; value: string; text: string; configured: string | null }[];
  onEditParameters: () => void;
  onSetConfiguration: (part: string, option: string) => void;
  onToggleFeatureVisible: (feature: string, visible: boolean) => void;
  /** A body menu's or an import node's action on its bodies, by key, with the part they are listed under. */
  onBodyAction: (part: string, keys: readonly number[], action: BodyAction) => void;
  assemblies: { id: string; name: string }[];
  /** The assemblies' own rows (instances, joints, positions), drawn in place of their plain names. */
  assemblyTree?: React.ReactNode;
  /** The part new features go into; another part offers Open. */
  activePart?: string | null;
  onOpenPart?: (part: string) => void;
  /**
   * Makes a part the active one, or with null the whole design: each part's
   * radio, and the document's while `designActive` is given.
   */
  onActivatePart?: (part: string | null) => void;
  /** The document's root is an assembly: whether it shows with no part active (its radio is on). */
  designActive?: boolean;
  /** The header's New Part. */
  onNewPart?: () => void;
  selectedFeatures: ReadonlySet<string>;
  selectedKeys: ReadonlySet<number>;
  selectedStandard: ReadonlySet<StandardPlane>;
  selectedDatums: ReadonlySet<StandardDatum>;
  standardPlanesVisible: boolean;
  onToggleStandardPlanes: () => void;
  onSelectStandard: (name: StandardPlane, additive: boolean) => void;
  onSelectDatum: (name: StandardDatum, additive: boolean) => void;
  onSelectFeature: (feature: string, additive: boolean) => void;
  onSelectBody: (key: number, additive: boolean) => void;
  onFeatureAction: (action: FeatureAction, feature: string) => void;
  onRenameFeature: (feature: string, name: string) => void;
  /** The feature whose name is being edited (set from outside by a menu's Rename). */
  renaming: string | null;
  onRenamingChange: (feature: string | null) => void;
  /**
   * The document is a read-only preview: rows select and their menus offer
   * only what writes nothing (exports); renames, eyes, colours, the
   * configuration choice and the parameters editor are left out.
   */
  readOnly?: boolean;
  /** The rollback marker is fixed (a feature panel is open): the menus leave out Roll Back to Here and Roll to End. */
  markerLocked?: boolean;
}

/** The standard planes in the colours the viewport draws them in, by their normals: XY blue (Z), XZ green (Y), YZ red (X). */
const STANDARD_ROWS: { name: StandardPlane; label: string; color: string }[] = [
  { name: 'xy', label: 'XY Plane', color: '#3b82f6' },
  { name: 'xz', label: 'XZ Plane', color: '#22c55e' },
  { name: 'yz', label: 'YZ Plane', color: '#ef4444' },
];

/** The standard axes (X red, Y green, Z blue, as the viewport draws them when picked) and the origin point. */
const DATUM_ROWS: { name: StandardDatum; label: string; color: string }[] = [
  { name: 'x', label: 'X Axis', color: '#ef4444' },
  { name: 'y', label: 'Y Axis', color: '#22c55e' },
  { name: 'z', label: 'Z Axis', color: '#3b82f6' },
  { name: 'origin', label: 'Origin Point', color: '#888888' },
];

/** A body row's menu: the body, and the row of the feature that made it. */
interface BodyMenu {
  /** The part the body is listed under. */
  part: string;
  body: BrowserBody;
  source: FeatureRow | undefined;
  x: number;
  y: number;
}

export function BrowserTree(props: BrowserTreeProps) {
  const open = useTreeOpen();
  const toggle = toggleNode;
  const [menu, setMenu] = useState<{ feature: string; entries: MenuEntry[]; x: number; y: number } | null>(null);
  const [bodyMenu, setBodyMenu] = useState<BodyMenu | null>(null);
  /** The body whose name is being edited in its row. */
  const [renamingBody, setRenamingBody] = useState<string | null>(null);
  const [importMenu, setImportMenu] = useState<{
    part: string;
    feature: FeatureRow;
    keys: number[];
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useKeptInWindow(menuRef, menu ?? bodyMenu ?? importMenu);

  const anyMenu = menu !== null || bodyMenu !== null || importMenu !== null;
  const closeMenus = () => {
    setMenu(null);
    setBodyMenu(null);
    setImportMenu(null);
  };
  // A press outside the open menu, or Escape, closes it.
  useEffect(() => {
    if (!anyMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenus();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [anyMenu]);

  /** The end of an in-place rename of a sketch or construction row. */
  const renamed = (row: FeatureRow, name: string | null) => {
    props.onRenamingChange(null);
    if (name !== null && name.trim() !== '' && name.trim() !== row.name) props.onRenameFeature(row.id, name.trim());
  };
  const sketchesOf = (rows: FeatureRow[]): FeatureRow[] =>
    rows.flatMap((r) => [...(r.type === 'core.sketch' ? [r] : []), ...sketchesOf(r.children)]);
  const constructionOf = (rows: FeatureRow[]): FeatureRow[] =>
    rows.flatMap((r) => [...(CONSTRUCTION_TYPES.has(r.type) ? [r] : []), ...constructionOf(r.children)]);
  // The entries a body's menu has for the feature that made it.
  const sourceMenu = bodyMenu?.source ? bodyFeatureMenu(bodyMenu.source) : null;
  const readOnly = props.readOnly === true;
  /** A feature row's menu, as far as the document allows; none when it would be empty. */
  const openMenu = (feature: string, entries: MenuEntry[], e: React.MouseEvent) => {
    const allowed = allowedEntries(entries, { readOnly, markerLocked: props.markerLocked === true });
    if (allowed.length > 0) setMenu({ feature, entries: allowed, x: e.clientX, y: e.clientY });
  };
  const sourceAction = (action: FeatureAction) => {
    const feature = bodyMenu?.source?.id;
    closeMenus();
    if (feature) props.onFeatureAction(action, feature);
  };

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <Layers size={12} style={{ color: '#888' }} />
        <span style={styles.headerTitle}>Browser</span>
        <span style={styles.headerActions}>
          <HeaderButton label="Expand all" onClick={() => setAllOpen(true)}>
            <ChevronsUpDown size={12} color="#666" />
          </HeaderButton>
          <HeaderButton label="Collapse all" onClick={() => setAllOpen(false)}>
            <ChevronsDownUp size={12} color="#666" />
          </HeaderButton>
          {props.onNewPart && (
            <HeaderButton label="New part" onClick={props.onNewPart}>
              <Plus size={12} color="#666" />
            </HeaderButton>
          )}
        </span>
      </div>
      <div style={styles.content}>
        <TreeNode
          label={props.documentName}
          icon={<FileBox size={13} color="#888" />}
          expanded={open(DOCUMENT_NODE)}
          onToggle={() => toggle(DOCUMENT_NODE)}
          depth={0}
          bold
          {...(props.onActivatePart && props.designActive !== undefined
            ? {
                radio: {
                  on: props.designActive,
                  onClick: () => props.onActivatePart?.(null),
                  ariaLabel: 'Show the whole design',
                },
              }
            : {})}
        >
          <TreeNode
            label="Parameters"
            icon={<Ruler size={12} color="#9c27b0" />}
            expanded={open('parameters')}
            onToggle={() => toggle('parameters')}
            depth={1}
            count={props.parameters.length}
            {...(readOnly
              ? {}
              : {
                  trailingAction: {
                    icon: <Settings size={11} color="#777" />,
                    onClick: props.onEditParameters,
                    ariaLabel: 'Edit parameters',
                  },
                })}
          >
            {props.parameters.length === 0 && (
              <span style={{ ...styles.emptyText, paddingLeft: 36 }}>No parameters</span>
            )}
            {props.parameters.map((p) => (
              <div
                key={p.id}
                style={{ ...styles.paramRow, paddingLeft: 42 }}
                onDoubleClick={readOnly ? undefined : props.onEditParameters}
                title={
                  p.configured !== null
                    ? `${p.name} = ${p.value} (configuration ${p.configured}; own value ${p.text})`
                    : `${p.name} = ${p.text}`
                }
              >
                <span style={styles.paramName}>{p.name}</span>
                <span style={styles.paramValue}>{p.value}</span>
                {p.configured !== null && (
                  <span style={styles.paramConfigured} aria-label={`Set by configuration ${p.configured}`}>
                    {p.configured}
                  </span>
                )}
              </div>
            ))}
          </TreeNode>
          {props.assemblyTree ??
            props.assemblies.map((a) => (
              <div key={a.id} style={{ ...styles.originItem, paddingLeft: 8 + 14 }}>
                <Layers size={12} color="#6366f1" />
                <span style={{ ...styles.originLabel, fontSize: 12, color: '#444', fontWeight: 600 }}>{a.name}</span>
              </div>
            ))}
          {props.parts.map((part) => {
            const sketches = sketchesOf(part.features);
            const construction = constructionOf(part.features);
            const components = componentsOf(part.features);
            return (
              <TreeNode
                key={part.id}
                label={part.name}
                icon={<Box size={13} color="#ff9800" />}
                expanded={open(part.id)}
                onToggle={() => toggle(part.id)}
                depth={1}
                bold
                {...(props.onOpenPart && props.activePart !== part.id
                  ? {
                      trailingAction: {
                        icon: <ExternalLink size={11} color="#777" />,
                        onClick: () => props.onOpenPart?.(part.id),
                        ariaLabel: `Open ${part.name} on its own`,
                      },
                    }
                  : {})}
                {...(props.onActivatePart
                  ? {
                      radio: {
                        on: props.activePart === part.id,
                        onClick: () => props.onActivatePart?.(part.id),
                        ariaLabel: `Make ${part.name} active`,
                      },
                    }
                  : {})}
              >
                {part.configuration && (
                  <div style={{ ...styles.paramRow, paddingLeft: 8 + 2 * 14 }}>
                    <span style={styles.paramName}>Configuration</span>
                    <select
                      aria-label={`${part.name} configuration`}
                      value={part.configuration.active ?? ''}
                      onChange={(e) => props.onSetConfiguration(part.id, e.target.value)}
                      disabled={readOnly}
                      style={styles.configSelect}
                    >
                      {part.configuration.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <TreeNode
                  label="Origin"
                  icon={<Crosshair size={12} color="#888" />}
                  expanded={open(`${part.id}/origin`)}
                  onToggle={() => toggle(`${part.id}/origin`)}
                  depth={2}
                  trailingAction={{
                    icon: props.standardPlanesVisible ? (
                      <Eye size={11} strokeWidth={1.5} />
                    ) : (
                      <EyeOff size={11} strokeWidth={1.5} />
                    ),
                    onClick: props.onToggleStandardPlanes,
                    ariaLabel: props.standardPlanesVisible ? 'Hide origin planes' : 'Show origin planes',
                  }}
                >
                  {STANDARD_ROWS.map((p) => (
                    <OriginRow
                      key={p.name}
                      label={p.label}
                      color={p.color}
                      plane
                      selected={props.selectedStandard.has(p.name)}
                      onClick={(additive) => props.onSelectStandard(p.name, additive)}
                    />
                  ))}
                  {DATUM_ROWS.map((p) => (
                    <OriginRow
                      key={p.name}
                      label={p.label}
                      color={p.color}
                      selected={props.selectedDatums.has(p.name)}
                      onClick={(additive) => props.onSelectDatum(p.name, additive)}
                    />
                  ))}
                </TreeNode>
                <TreeNode
                  label="Sketches"
                  icon={<PenLine size={12} color="#2196f3" />}
                  expanded={open(`${part.id}/sketches`)}
                  onToggle={() => toggle(`${part.id}/sketches`)}
                  depth={2}
                  count={sketches.length}
                >
                  {sketches.length === 0 && <span style={{ ...styles.emptyText, paddingLeft: 56 }}>No sketches</span>}
                  {sketches.map((row) => (
                    <FeatureRowView
                      key={row.id}
                      row={row}
                      depth={3}
                      pastRollback={false}
                      selected={props.selectedFeatures.has(row.id)}
                      renaming={props.renaming === row.id}
                      onClick={(additive) => props.onSelectFeature(row.id, additive)}
                      onDoubleClick={() => {
                        if (!readOnly) props.onFeatureAction('editSketch', row.id);
                      }}
                      onRename={(name) => renamed(row, name)}
                      {...(readOnly
                        ? {}
                        : {
                            eye: {
                              hidden: row.hidden,
                              onToggle: () => props.onToggleFeatureVisible(row.id, row.hidden),
                            },
                          })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        props.onSelectFeature(row.id, false);
                        const index = part.features.findIndex((f) => f.id === row.id);
                        openMenu(row.id, featureMenu(row, index, part.features.length, part.rollbackIndex), e);
                      }}
                    />
                  ))}
                </TreeNode>
                {construction.length > 0 && (
                  <TreeNode
                    label="Construction"
                    icon={<SquareDashed size={12} color="#3b82f6" />}
                    expanded={open(`${part.id}/construction`)}
                    onToggle={() => toggle(`${part.id}/construction`)}
                    depth={2}
                    count={construction.length}
                  >
                    {construction.map((row) => (
                      <FeatureRowView
                        key={row.id}
                        row={row}
                        depth={3}
                        pastRollback={false}
                        selected={props.selectedFeatures.has(row.id)}
                        renaming={props.renaming === row.id}
                        onClick={(additive) => props.onSelectFeature(row.id, additive)}
                        onDoubleClick={() => {
                          if (!readOnly) props.onFeatureAction('editFeature', row.id);
                        }}
                        onRename={(name) => renamed(row, name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          props.onSelectFeature(row.id, false);
                          const index = part.features.findIndex((f) => f.id === row.id);
                          openMenu(row.id, featureMenu(row, index, part.features.length, part.rollbackIndex), e);
                        }}
                        {...(readOnly
                          ? {}
                          : {
                              eye: {
                                hidden: row.hidden,
                                onToggle: () => props.onToggleFeatureVisible(row.id, row.hidden),
                              },
                            })}
                      />
                    ))}
                  </TreeNode>
                )}
                <TreeNode
                  label="Components"
                  icon={<Puzzle size={12} color="#6366f1" />}
                  expanded={open(`${part.id}/components`)}
                  onToggle={() => toggle(`${part.id}/components`)}
                  depth={2}
                  count={components.length}
                >
                  {components.length === 0 && (
                    <span style={{ ...styles.emptyText, paddingLeft: 56 }}>No components</span>
                  )}
                  {components.map((row) => {
                    const keys = part.bodies.filter((b) => b.feature === row.id).flatMap(keysOf);
                    const hidden =
                      row.hidden || (keys.length > 0 && part.bodies.every((b) => b.feature !== row.id || !b.visible));
                    return (
                      <FeatureRowView
                        key={row.id}
                        row={row}
                        depth={3}
                        pastRollback={false}
                        selected={props.selectedFeatures.has(row.id)}
                        renaming={props.renaming === row.id}
                        onClick={(additive) => props.onSelectFeature(row.id, additive)}
                        onDoubleClick={() => {
                          if (!readOnly) props.onFeatureAction(row.component ? 'editComponent' : 'editFeature', row.id);
                        }}
                        onRename={(name) => renamed(row, name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          props.onSelectFeature(row.id, false);
                          const index = part.features.findIndex((f) => f.id === row.id);
                          openMenu(row.id, featureMenu(row, index, part.features.length, part.rollbackIndex), e);
                        }}
                        // A component's eye shows or hides the bodies it made, as their own eyes do.
                        {...(readOnly
                          ? {}
                          : {
                              eye: {
                                hidden,
                                onToggle: () =>
                                  row.hidden
                                    ? props.onToggleFeatureVisible(row.id, true)
                                    : props.onBodyAction(part.id, keys, { kind: 'visible', visible: hidden }),
                              },
                            })}
                      />
                    );
                  })}
                </TreeNode>
                <TreeNode
                  label="Bodies"
                  icon={<Box size={12} color="#ff9800" />}
                  expanded={open(`${part.id}/bodies`)}
                  onToggle={() => toggle(`${part.id}/bodies`)}
                  depth={2}
                  count={part.bodies.length}
                >
                  {part.bodies.length === 0 && <span style={{ ...styles.emptyText, paddingLeft: 56 }}>No bodies</span>}
                  {bodyGroups(part.features, part.bodies).map((g) => {
                    const bodyRow = (b: BrowserBody, depth: number) => (
                      <BodyRowView
                        key={b.id}
                        body={b}
                        depth={depth}
                        selected={b.key >= 0 && props.selectedKeys.has(b.key)}
                        onClick={(additive) => {
                          if (b.key >= 0) props.onSelectBody(b.key, additive);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (b.key < 0) return;
                          props.onSelectBody(b.key, false);
                          // Everything a body's menu offers writes to the document.
                          if (!readOnly)
                            setBodyMenu({
                              part: part.id,
                              body: b,
                              source: rowOf(part.features, b.feature),
                              x: e.clientX,
                              y: e.clientY,
                            });
                        }}
                        {...(readOnly
                          ? {}
                          : {
                              onToggleVisible: () =>
                                props.onBodyAction(part.id, keysOf(b), { kind: 'visible', visible: !b.visible }),
                            })}
                        renaming={renamingBody === b.id}
                        onStartRename={() => {
                          if (b.key >= 0 && !readOnly) setRenamingBody(b.id);
                        }}
                        onRename={(name) => {
                          setRenamingBody(null);
                          if (name !== null && name.trim() !== b.name)
                            props.onBodyAction(part.id, keysOf(b), { kind: 'rename', name: name.trim() });
                        }}
                      />
                    );
                    if ('body' in g) return bodyRow(g.body, 3);
                    const id = `import:${g.feature.id}`;
                    const keys = g.bodies.flatMap(keysOf);
                    const allHidden = g.bodies.every((b) => !b.visible);
                    const members = g.bodies.map((b) => bodyRow(b, 4));
                    return (
                      <div key={id}>
                        <TreeNode
                          label={g.feature.name}
                          icon={<Box size={12} color="#ff9800" />}
                          expanded={open(id)}
                          onToggle={() => toggle(id)}
                          depth={3}
                          count={keys.length}
                          {...(readOnly
                            ? {}
                            : {
                                trailingAction: {
                                  icon: allHidden ? (
                                    <EyeOff size={11} strokeWidth={1.5} />
                                  ) : (
                                    <Eye size={11} strokeWidth={1.5} />
                                  ),
                                  onClick: () =>
                                    props.onBodyAction(part.id, keys, { kind: 'visible', visible: allHidden }),
                                  ariaLabel: allHidden ? 'Show all bodies' : 'Hide all bodies',
                                },
                              })}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (!readOnly)
                              setImportMenu({ part: part.id, feature: g.feature, keys, x: e.clientX, y: e.clientY });
                          }}
                        >
                          {members}
                        </TreeNode>
                      </div>
                    );
                  })}
                </TreeNode>
              </TreeNode>
            );
          })}
        </TreeNode>
      </div>
      {importMenu && (
        <div ref={menuRef} style={{ ...styles.contextMenu, left: importMenu.x, top: importMenu.y }}>
          <MenuButton
            icon={<Move size={14} />}
            label="Move all"
            onClick={() => {
              closeMenus();
              props.onBodyAction(importMenu.part, importMenu.keys, { kind: 'move' });
            }}
          />
          <MenuButton
            icon={<Crosshair size={14} />}
            label="Move to origin"
            onClick={() => {
              closeMenus();
              props.onBodyAction(importMenu.part, importMenu.keys, { kind: 'place', to: 'origin' });
            }}
          />
          <MenuButton
            icon={<ArrowDownToLine size={14} />}
            label="Drop on XY plane"
            onClick={() => {
              closeMenus();
              props.onBodyAction(importMenu.part, importMenu.keys, { kind: 'place', to: 'xy' });
            }}
          />
          <div style={styles.contextDivider} />
          <MenuButton
            icon={<Trash2 size={14} />}
            label="Delete"
            danger
            onClick={() => {
              closeMenus();
              props.onFeatureAction('delete', importMenu.feature.id);
            }}
          />
        </div>
      )}
      {bodyMenu && (
        <div ref={menuRef} style={{ ...styles.contextMenu, left: bodyMenu.x, top: bodyMenu.y }}>
          <MenuButton
            icon={<Type size={14} />}
            label="Rename"
            onClick={() => {
              setBodyMenu(null);
              setRenamingBody(bodyMenu.body.id);
            }}
          />
          <MenuButton
            icon={bodyMenu.body.visible ? <EyeOff size={14} /> : <Eye size={14} />}
            label={bodyMenu.body.visible ? 'Hide' : 'Show'}
            onClick={() => {
              setBodyMenu(null);
              props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), {
                kind: 'visible',
                visible: !bodyMenu.body.visible,
              });
            }}
          />
          <div style={styles.colorLabel}>Color</div>
          <div style={styles.colorGrid} role="group" aria-label="Body color">
            {BODY_COLOR_SWATCHES.map((c) => (
              <button
                key={c.color}
                type="button"
                title={c.name}
                aria-label={c.name}
                style={{
                  ...styles.swatch,
                  background: c.color,
                  outline: bodyMenu.body.color === c.color ? '2px solid #1a6fd1' : 'none',
                }}
                onClick={() => {
                  setBodyMenu(null);
                  props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), { kind: 'color', color: c.color });
                }}
              />
            ))}
          </div>
          <div style={styles.colorActions}>
            <button
              type="button"
              style={styles.colorTextBtn}
              onClick={() => {
                setBodyMenu(null);
                props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), { kind: 'color', color: null });
              }}
            >
              Default
            </button>
            <label style={styles.colorTextBtn} title="Custom color">
              Custom…
              <CustomColour
                initial={bodyMenu.body.color}
                onPick={(color) => {
                  setBodyMenu(null);
                  props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), { kind: 'color', color });
                }}
              />
            </label>
          </div>
          <div style={styles.contextDivider} />
          {sourceMenu?.edit.map((entry) => (
            <MenuButton
              key={entry.action}
              icon={MENU_ICONS[entry.action]}
              label={entry.label}
              onClick={() => sourceAction(entry.action)}
            />
          ))}
          <MenuButton
            icon={<Move size={14} />}
            label="Move"
            onClick={() => {
              setBodyMenu(null);
              props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), { kind: 'move' });
            }}
          />
          {bodyMenu.source?.type === 'core.import' && (
            <>
              <MenuButton
                icon={<Crosshair size={14} />}
                label="Move to origin"
                onClick={() => {
                  setBodyMenu(null);
                  props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), { kind: 'place', to: 'origin' });
                }}
              />
              <MenuButton
                icon={<ArrowDownToLine size={14} />}
                label="Drop on XY plane"
                onClick={() => {
                  setBodyMenu(null);
                  props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), { kind: 'place', to: 'xy' });
                }}
              />
            </>
          )}
          <div style={styles.contextDivider} />
          {sourceMenu?.state
            .filter((entry) => !entry.danger)
            .map((entry) => (
              <MenuButton
                key={entry.action}
                icon={MENU_ICONS[entry.action]}
                label={entry.label}
                onClick={() => sourceAction(entry.action)}
              />
            ))}
          <MenuButton
            icon={<Trash2 size={14} />}
            label="Remove Body"
            danger
            onClick={() => {
              setBodyMenu(null);
              props.onBodyAction(bodyMenu.part, keysOf(bodyMenu.body), { kind: 'remove' });
            }}
          />
          {sourceMenu?.state
            .filter((entry) => entry.danger)
            .map((entry) => (
              <MenuButton
                key={entry.action}
                icon={MENU_ICONS[entry.action]}
                label={entry.label}
                danger
                onClick={() => sourceAction(entry.action)}
              />
            ))}
        </div>
      )}
      {menu && (
        <ContextMenu
          ref={menuRef}
          x={menu.x}
          y={menu.y}
          entries={menu.entries}
          onAction={(action) => {
            setMenu(null);
            if (action === 'rename') props.onRenamingChange(menu.feature);
            else props.onFeatureAction(action, menu.feature);
          }}
        />
      )}
    </div>
  );
}

/** A small icon button of the browser's header. */
function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      style={styles.headerActionBtn}
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = '#e6e6e6';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

export function TreeNode({
  label,
  icon,
  expanded,
  onToggle,
  depth,
  count,
  bold,
  children,
  trailingAction,
  radio,
  onContextMenu,
}: {
  label: string;
  icon: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  depth: number;
  count?: number;
  bold?: boolean;
  children?: React.ReactNode;
  trailingAction?: { icon: React.ReactNode; onClick: () => void; ariaLabel: string };
  /** A radio left of the trailing action: on for the active part, or the design shown with none. */
  radio?: { on: boolean; onClick: () => void; ariaLabel: string };
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const controls = (trailingAction ? 1 : 0) + (radio ? 1 : 0);
  return (
    <>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          style={{
            ...styles.treeNodeBtn,
            paddingLeft: 8 + depth * 14,
            paddingRight: 8 + controls * 22,
            fontWeight: bold ? 600 : 500,
            fontSize: bold ? 12 : 11,
            color: bold ? '#444' : '#555',
          }}
          onClick={onToggle}
          onContextMenu={onContextMenu}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          <span style={styles.expandIcon}>{expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
          <span style={{ display: 'inline-flex' }}>{icon}</span>
          <span style={styles.treeNodeLabel}>{label}</span>
          {count !== undefined && <span style={styles.badge}>{count}</span>}
        </button>
        {trailingAction && (
          <button
            type="button"
            style={styles.trailingActionBtn}
            onClick={(e) => {
              e.stopPropagation();
              trailingAction.onClick();
            }}
            aria-label={trailingAction.ariaLabel}
            title={trailingAction.ariaLabel}
          >
            {trailingAction.icon}
          </button>
        )}
        {radio && (
          <button
            type="button"
            role="radio"
            aria-checked={radio.on}
            style={{ ...styles.trailingActionBtn, right: trailingAction ? 26 : 4 }}
            onClick={(e) => {
              e.stopPropagation();
              if (!radio.on) radio.onClick();
            }}
            aria-label={radio.ariaLabel}
            title={radio.ariaLabel}
          >
            <span style={{ ...styles.radio, ...(radio.on ? styles.radioOn : {}) }} />
          </button>
        )}
      </div>
      {expanded && children}
    </>
  );
}

function FeatureRowView({
  row,
  depth,
  pastRollback,
  selected,
  renaming,
  onClick,
  onDoubleClick,
  onRename,
  onContextMenu,
  eye,
}: {
  eye?: { hidden: boolean; onToggle: () => void };
  row: FeatureRow;
  depth: number;
  pastRollback: boolean;
  selected: boolean;
  renaming: boolean;
  onClick: (additive: boolean) => void;
  onDoubleClick: () => void;
  onRename: (name: string | null) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const color = featureTypeColors[row.iconKey] ?? '#888';
  const failed = row.status === 'failed';
  const blocked = row.status === 'blocked';
  // Built, but not as authored: amber as a blocked row, with the warning as its tooltip.
  const warned = row.status === 'success' && row.warning !== undefined;
  const border = selected
    ? '2px solid #1a6fd1'
    : failed
      ? '2px solid #dc2626'
      : blocked || warned
        ? '2px solid #d97706'
        : '2px solid transparent';
  const background = selected ? '#e3effb' : failed ? '#fef2f2' : 'transparent';
  const hoverBackground = failed ? '#fee2e2' : '#f4f4f4';
  const type = featureTypeLabel(row.type, row.iconKey);
  const tooltip = failed
    ? `${row.name} (${type}): ${row.message ?? 'did not build'}`
    : blocked
      ? `${row.name} (${type}): ${row.message ?? 'waits on an earlier feature'}`
      : warned
        ? `${row.name} (${type}): ${row.warning}`
        : `${row.name} (${type}). Right-click for options`;
  return (
    <div
      role="button"
      tabIndex={0}
      data-feature-row
      style={{
        ...styles.featureNode,
        paddingLeft: 8 + depth * 14,
        background,
        borderLeft: border,
        opacity: row.suppressed || pastRollback ? 0.45 : 1,
        position: 'relative',
        ...(eye ? { paddingRight: 28 } : {}),
      }}
      onClick={(e) => onClick(e.shiftKey || e.ctrlKey || e.metaKey)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = hoverBackground;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = background;
      }}
      title={tooltip}
    >
      <span style={{ ...styles.featureIconWrap, background: `${color}18`, color }}>
        {getFeatureIcon(row.iconKey, 12)}
      </span>
      {renaming ? (
        <RenameField name={row.name} onDone={onRename} />
      ) : (
        <span style={{ ...styles.featureName, color: failed ? '#b91c1c' : undefined }}>{row.name}</span>
      )}
      {row.suppressed && (
        <span style={styles.statusIcon}>
          <FeatureSuppressedIcon size={10} />
        </span>
      )}
      {row.frozen && (
        <span style={styles.statusIcon} title="Frozen" aria-label="Frozen">
          <Snowflake size={11} strokeWidth={1.5} color="#0ea5e9" />
        </span>
      )}
      {failed && (
        <span style={styles.statusIcon} title={row.message}>
          <FeatureWarningIcon size={12} color="#dc2626" />
        </span>
      )}
      {blocked && (
        <span style={styles.statusIcon} title={row.message}>
          <Pause size={11} strokeWidth={1.5} color="#d97706" />
        </span>
      )}
      {!row.suppressed && !failed && !blocked && row.dof === 0 && (
        <span style={styles.statusIcon} title="Fully constrained" aria-label="Fully constrained">
          <Lock size={11} strokeWidth={1.5} color="#1a6fd1" />
        </span>
      )}
      {!row.suppressed && !failed && !blocked && row.dof !== undefined && row.dof > 0 && (
        <span
          style={styles.statusIcon}
          title={`Under-constrained · ${row.dof} DOF`}
          aria-label={`Under-constrained, ${row.dof} DOF`}
        >
          <LockOpen size={11} strokeWidth={1.5} color="#9ca3af" />
        </span>
      )}
      {eye && (
        <button
          type="button"
          style={styles.trailingActionBtn}
          aria-label={eye.hidden ? `Show ${row.name}` : `Hide ${row.name}`}
          title={eye.hidden ? 'Show' : 'Hide'}
          onClick={(e) => {
            e.stopPropagation();
            eye.onToggle();
          }}
        >
          {eye.hidden ? <EyeOff size={11} strokeWidth={1.5} /> : <Eye size={11} strokeWidth={1.5} />}
        </button>
      )}
    </div>
  );
}

/** A body row: its colour, its name (edited in place on a double-click or Rename), and its eye; dimmed while hidden. */
function BodyRowView({
  body,
  depth,
  selected,
  onClick,
  onContextMenu,
  onToggleVisible,
  renaming,
  onStartRename,
  onRename,
}: {
  body: BrowserBody;
  depth: number;
  selected: boolean;
  onClick: (additive: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Absent for a solid of a shape holding several, which shows and hides as the shape does. */
  onToggleVisible?: () => void;
  renaming: boolean;
  onStartRename: () => void;
  onRename: (name: string | null) => void;
}) {
  const background = selected ? '#e3effb' : 'transparent';
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        style={{
          ...styles.featureNode,
          paddingLeft: 8 + depth * 14,
          paddingRight: 28,
          background,
          borderLeft: selected ? '2px solid #1a6fd1' : '2px solid transparent',
          opacity: body.visible ? 1 : 0.45,
        }}
        onClick={(e) => onClick(e.shiftKey || e.ctrlKey || e.metaKey)}
        onDoubleClick={onStartRename}
        onContextMenu={onContextMenu}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = '#f4f4f4';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = background;
        }}
        title={`${body.name}. Double-click to rename, right-click for options`}
      >
        <span style={{ ...styles.featureIconWrap, background: `${body.color}18`, color: body.color }}>
          <Box size={12} fill={body.color} fillOpacity={0.35} />
        </span>
        {renaming ? (
          <RenameField name={body.name} onDone={onRename} />
        ) : (
          <span style={styles.featureName}>{body.name}</span>
        )}
      </button>
      {onToggleVisible && (
        <button
          type="button"
          style={styles.trailingActionBtn}
          aria-label={body.visible ? `Hide ${body.name}` : `Show ${body.name}`}
          title={body.visible ? 'Hide' : 'Show'}
          onClick={onToggleVisible}
        >
          {body.visible ? <Eye size={11} strokeWidth={1.5} /> : <EyeOff size={11} strokeWidth={1.5} />}
        </button>
      )}
    </div>
  );
}

/** A row of a part's Origin: a standard plane (with its plane mark), axis or the origin point, in its colour. */
function OriginRow({
  label,
  color,
  plane,
  selected,
  onClick,
}: {
  label: string;
  color: string;
  plane?: boolean;
  selected: boolean;
  onClick: (additive: boolean) => void;
}) {
  return (
    <button
      type="button"
      style={{ ...styles.originItem, paddingLeft: 8 + 3 * 14, ...(selected ? styles.selectedRow : {}) }}
      onClick={(e) => onClick(e.shiftKey || e.ctrlKey || e.metaKey)}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = '#f4f4f4';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = selected ? '#e3effb' : 'transparent';
      }}
    >
      <span style={{ ...styles.originDot, background: color }} />
      {plane && (
        <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
          <rect x="1" y="3" width="10" height="6" rx="1" stroke={color} strokeWidth="1" fill={`${color}15`} />
        </svg>
      )}
      <span style={styles.originLabel}>{label}</span>
    </button>
  );
}

/** A name edited in place: Enter or leaving the field gives the name, Escape null. */
export function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      style={styles.renameInput}
      onChange={(e) => setValue(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(value);
        if (e.key === 'Escape') onDone(null);
      }}
    />
  );
}

/**
 * A colour input that reports once, when the picker closes on a colour
 * (its `change` event), not on every step of a drag in the picker.
 */
function CustomColour({ initial, onPick }: { initial: string; onPick: (color: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const changed = () => pick.current(input.value.toLowerCase());
    input.addEventListener('change', changed);
    return () => input.removeEventListener('change', changed);
  }, []);
  return <input ref={ref} type="color" aria-label="Custom color" defaultValue={initial} style={styles.colorInput} />;
}

export function MenuButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      style={{ ...styles.contextItem, color: danger ? '#dc2626' : '#444' }}
      onClick={onClick}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = danger ? '#fef2f2' : '#f4f4f4';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      <span style={styles.contextItemIcon}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/** Feature types whose output the eye shows or hides: sketches and construction geometry. */
const CONSTRUCTION_TYPES: ReadonlySet<string> = new Set([
  'core.constructionPlane',
  'core.constructionAxis',
  'core.constructionPoint',
  'core.constructionFrame',
]);

const ContextMenu = forwardRef<
  HTMLDivElement,
  { x: number; y: number; entries: MenuEntry[]; onAction: (a: FeatureAction) => void }
>(function ContextMenu({ x, y, entries, onAction }, ref) {
  return (
    <div ref={ref} style={{ ...styles.contextMenu, left: x, top: y }}>
      {entries.map((entry) => (
        <div key={entry.action}>
          {entry.danger && <div style={styles.contextDivider} />}
          <button
            type="button"
            style={{ ...styles.contextItem, color: entry.danger ? '#dc2626' : '#444' }}
            onClick={() => onAction(entry.action)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = entry.danger ? '#fef2f2' : '#f4f4f4';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <span style={styles.contextItemIcon}>{MENU_ICONS[entry.action]}</span>
            <span>{entry.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  root: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#fafafa' },
  header: { padding: '8px 12px', borderBottom: '1px solid #d8d8d8', display: 'flex', alignItems: 'center', gap: 6 },
  headerActionBtn: {
    width: 20,
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    borderRadius: 3,
    padding: 0,
  },
  headerActions: { marginLeft: 'auto', display: 'inline-flex', gap: 2 },
  radio: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    border: '1.5px solid #9a9a9a',
    boxSizing: 'border-box',
    background: '#ffffff',
  },
  radioOn: { border: '3px solid #2563eb' },
  headerTitle: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, color: '#888' },
  content: { flex: 1, overflow: 'auto', padding: '2px 0' },
  treeNodeBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    width: '100%',
    height: 26,
    padding: '0 8px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 500,
    color: '#555',
    transition: 'background 0.1s',
    textAlign: 'left',
  },
  treeNodeLabel: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  expandIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    color: '#999',
    flexShrink: 0,
  },
  badge: {
    fontSize: 9,
    fontWeight: 600,
    color: '#999',
    background: '#e8e8e8',
    padding: '1px 5px',
    borderRadius: 8,
    minWidth: 16,
    textAlign: 'center',
  },
  trailingActionBtn: {
    position: 'absolute',
    right: 4,
    top: '50%',
    transform: 'translateY(-50%)',
    width: 20,
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    borderRadius: 3,
    padding: 0,
    color: '#aaa',
  },
  featureNode: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    height: 26,
    padding: '0 8px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 11,
    color: '#555',
    transition: 'background 0.1s',
    textAlign: 'left',
    userSelect: 'none',
  },
  selectedRow: { background: '#e3effb', borderLeft: '2px solid #1a6fd1' },
  featureIconWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    borderRadius: 3,
    flexShrink: 0,
  },
  featureName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  statusIcon: { display: 'inline-flex', alignItems: 'center', flexShrink: 0 },
  originItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    height: 22,
    fontSize: 10,
    color: '#999',
    padding: '0 8px',
    width: '100%',
    border: 'none',
    borderLeft: '2px solid transparent',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
  },
  originDot: { width: 4, height: 4, borderRadius: 2, flexShrink: 0 },
  originLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  emptyText: { display: 'block', padding: '4px 12px', fontSize: 10, color: '#ccc', fontStyle: 'italic' },
  renameInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 11,
    padding: '1px 4px',
    border: '1px solid #a8cef0',
    borderRadius: 3,
    outline: 'none',
  },
  contextMenu: {
    position: 'fixed',
    background: '#fff',
    border: '1px solid #d8d8d8',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
    padding: 4,
    zIndex: 1000,
    minWidth: 160,
  },
  contextItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    height: 30,
    padding: '0 10px',
    border: 'none',
    borderRadius: 5,
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    color: '#444',
    textAlign: 'left',
    transition: 'background 0.1s',
  },
  contextItemIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    color: 'inherit',
  },
  contextDivider: { height: 1, background: '#e8e8e8', margin: '3px 8px' },
  paramRow: { display: 'flex', alignItems: 'center', gap: 6, height: 22, fontSize: 11, color: '#666', paddingRight: 8 },
  paramName: { color: '#555', fontWeight: 500, flexShrink: 0 },
  paramConfigured: {
    flexShrink: 0,
    fontSize: 9,
    color: '#9c27b0',
    background: '#f3e5f5',
    borderRadius: 3,
    padding: '0 3px',
    lineHeight: '13px',
  },
  paramValue: {
    flex: 1,
    color: '#999',
    fontFamily: 'monospace',
    fontSize: 10,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'right',
  },
  configSelect: {
    flex: 1,
    minWidth: 0,
    height: 20,
    fontSize: 11,
    border: '1px solid #ddd',
    borderRadius: 3,
    background: '#fff',
  },
  colorLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    padding: '6px 10px 2px',
  },
  colorGrid: { display: 'grid', gridTemplateColumns: 'repeat(6, 18px)', gap: 5, padding: '4px 10px 6px' },
  colorActions: { display: 'flex', gap: 6, padding: '0 10px 6px' },
  colorTextBtn: {
    position: 'relative',
    flex: 1,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #e0e0e0',
    borderRadius: 4,
    background: '#f7f7f7',
    color: '#444',
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
    overflow: 'hidden',
  },
  colorInput: { position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 3,
    border: '1px solid rgba(0,0,0,0.15)',
    cursor: 'pointer',
    padding: 0,
  },
};

/** The browser's styles, for rows other modules draw in it. */
export const browserStyles = styles;

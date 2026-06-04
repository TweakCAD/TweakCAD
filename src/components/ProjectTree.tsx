/**
 * ProjectTree - browser panel.
 *
 * Hierarchy:
 *   Document Settings
 *   +- Named Views
 *   +- Origin
 *   Component (root)
 *   +- Origin (XY/XZ/YZ planes)
 *   +- Sketches
 *   |    +- Sketch 1
 *   |    +- Sketch 2
 *   +- Bodies
 *   |    +- Body 1 (from Extrude 1)
 *   +- Construction
 *
 * Features:
 *   - Component-scoped Sketches and Bodies
 *   - Right-click context menu (Extrude, Edit Sketch, Delete, Suppress)
 *   - Selection highlighting with blue left border
 *   - Collapsible sections with feature counts
 *   - Origin planes (XY, XZ, YZ) under each component
 */

import { useState, useEffect, useCallback, useRef, forwardRef } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Ruler,
  Pencil,
  PenLine,
  Box,
  Puzzle,
  Trash2,
  EyeOff,
  Eye,
  Crosshair,
  FileBox,
  Layers,
  Lock,
  LockOpen,
  Settings,
  Move,
} from 'lucide-react';
import {
  getFeatureIcon,
  featureTypeColors,
  FeatureSuppressedIcon,
  ExtrudeIcon,
} from '../icons/cadIcons.tsx';

// ---- Types ----

/**
 * Build-status for a feature, derived from the worker's `featureResults`.
 * The tree renders red badges + a tooltip with `errorMessage` on
 * 'failed', and a gray dimmed badge on 'blocked'/'suppressed'. Falls
 * back to 'success' when omitted so legacy callers don't have to plumb
 * status everywhere immediately.
 */
export type FeatureBuildStatus = 'success' | 'failed' | 'blocked' | 'suppressed';

interface TreeFeature {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  visible: boolean;
  /** Build status from the last rebuild. */
  status?: FeatureBuildStatus;
  /** Human-readable error if `status === 'failed'`. */
  errorMessage?: string;
  /**
   * Sketcher remaining degrees of freedom. Only populated for sketch
   * features. 0 = fully defined (Lock badge in the tree row); >0 =
   * under-constrained; `undefined` = not a sketch / solver not ready /
   * sketch has no `_editorState` snapshot yet.
   */
  dof?: number;
}

/** A body produced by the geometry kernel (build artifact, not a document entity) */
export interface TreeBody {
  bodyId: string;
  /** Name label for display (e.g., "Body 1", "Body 2") */
  label: string;
  /** The feature that produced this body */
  sourceFeatureId: string;
  /** Type of the producing feature — drives the body right-click menu
   *  (e.g. `importedGeometry` shows "Move"). */
  sourceFeatureType: string;
  /** Name of the producing feature — label for an import's group node. */
  sourceFeatureName: string;
  /** Whether the body is currently visible in the viewport */
  visible: boolean;
}

interface TreePart {
  id: string;
  name: string;
  timeline: TreeFeature[];
}

export type ContextMenuAction = 'extrude' | 'editSketch' | 'editFeature' | 'editComponent' | 'duplicateComponent' | 'move' | 'moveAll' | 'rename' | 'delete' | 'suppress' | 'enable';

interface ContextMenuEvent {
  featureId: string;
  featureType: string;
  featureEnabled: boolean;
  /** Whether the menu was opened on a body row or a feature/group node —
   *  picks Move (body) vs Move all (feature) for imported geometry. */
  target: 'body' | 'feature';
  x: number;
  y: number;
}

interface ProjectTreeProps {
  parts: TreePart[];
  parameters: Record<string, { name: string; expression: string; unit: string }>;
  /** Actual bodies from the build result (not features) */
  bodies?: TreeBody[] | undefined;
  selectedFeatureId?: string | null;
  selectedBodyId?: string | null;
  onFeatureClick?: (featureId: string) => void;
  onPartClick?: (partId: string) => void;
  onContextAction?: (action: ContextMenuAction, featureId: string) => void;
  onVisibilityToggle?: (featureId: string, visible: boolean) => void;
  /** Called when a body is clicked in the Bodies section. Highlights source feature. */
  onBodyClick?: ((bodyId: string, sourceFeatureId: string) => void) | undefined;
  /** Called when a body's eye icon is toggled */
  onBodyVisibilityToggle?: ((bodyId: string, visible: boolean) => void) | undefined;
  /** Open the Parameters editor dialog. */
  onEditParameters?: (() => void) | undefined;
}

// ---- Helpers ----

const SKETCH_TYPES = new Set(['sketch']);
const CONSTRUCTION_TYPES = new Set(['constructionPlane']);
// Component-flavored timeline entries — surfaced in their own "Components"
// subsection so the user can find them and right-click → Edit Component…
// without scanning the timeline. `componentInstance` is the legacy
// in-worker catalog instance; `importedComponent` is the
// embedded-source variant.
const COMPONENT_TYPES = new Set(['importedComponent', 'componentInstance']);
const BODY_TYPES = new Set([
  'extrude', 'hole', 'linearPattern', 'circularPattern',
  'fillet', 'chamfer', 'mirror',
]);

function categorizeFeatures(features: TreeFeature[]) {
  const sketches: TreeFeature[] = [];
  const construction: TreeFeature[] = [];
  const components: TreeFeature[] = [];
  const bodies: TreeFeature[] = [];

  for (const f of features) {
    if (SKETCH_TYPES.has(f.type)) {
      sketches.push(f);
    } else if (CONSTRUCTION_TYPES.has(f.type)) {
      construction.push(f);
    } else if (COMPONENT_TYPES.has(f.type)) {
      components.push(f);
    } else if (BODY_TYPES.has(f.type)) {
      bodies.push(f);
    } else {
      bodies.push(f);
    }
  }

  return { sketches, construction, components, bodies };
}

/** Group output bodies by their producing feature, preserving first-seen
 *  order — used to nest a multi-solid import under one feature node. */
function groupBodiesByFeature(bodies: TreeBody[]): { featureId: string; type: string; name: string; bodies: TreeBody[] }[] {
  const order: string[] = [];
  const map = new Map<string, { featureId: string; type: string; name: string; bodies: TreeBody[] }>();
  for (const b of bodies) {
    let g = map.get(b.sourceFeatureId);
    if (!g) {
      g = { featureId: b.sourceFeatureId, type: b.sourceFeatureType, name: b.sourceFeatureName, bodies: [] };
      map.set(b.sourceFeatureId, g);
      order.push(b.sourceFeatureId);
    }
    g.bodies.push(b);
  }
  return order.map(id => map.get(id)!);
}

// ---- Component ----

export function ProjectTree({
  parts,
  parameters,
  bodies: treeBodies,
  selectedFeatureId,
  selectedBodyId,
  onFeatureClick,
  onPartClick,
  onContextAction,
  onVisibilityToggle,
  onBodyClick,
  onBodyVisibilityToggle,
  onEditParameters,
}: ProjectTreeProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(
    () => {
      const initial = new Set<string>();
      // Expand all parts/components and their sub-sections by default
      for (const part of parts) {
        initial.add(`part_${part.id}`);
        initial.add(`sketches_${part.id}`);
        initial.add(`construction_${part.id}`);
        initial.add(`components_${part.id}`);
        initial.add(`bodies_${part.id}`);
      }
      initial.add('document_settings');
      initial.add('parameters');
      return initial;
    }
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuEvent | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const isExpanded = (nodeId: string) => expandedNodes.has(nodeId);

  // Close context menu on outside click or escape
  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, feature: TreeFeature) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      featureId: feature.id,
      featureType: feature.type,
      featureEnabled: feature.enabled,
      target: 'feature',
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  const handleContextAction = useCallback((action: ContextMenuAction) => {
    if (contextMenu) {
      onContextAction?.(action, contextMenu.featureId);
      setContextMenu(null);
    }
  }, [contextMenu, onContextAction]);

  const paramEntries = Object.entries(parameters);

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <Layers size={12} style={{ color: '#888' }} />
        <span style={styles.headerTitle}>Browser</span>
      </div>

      <div style={styles.content}>
        {/* Document Settings section */}
        <TreeNode
          nodeId="document_settings"
          label="Document Settings"
          icon={<FileBox size={13} color="#888" />}
          expanded={isExpanded('document_settings')}
          onToggle={() => toggleNode('document_settings')}
          depth={0}
          bold
        >
          {/* Parameters sub-section */}
          <TreeNode
            nodeId="parameters"
            label="Parameters"
            icon={<Ruler size={12} color="#9c27b0" />}
            expanded={isExpanded('parameters')}
            onToggle={() => toggleNode('parameters')}
            depth={1}
            count={paramEntries.length}
            {...(onEditParameters
              ? { trailingAction: { icon: <Settings size={11} color="#777" />, onClick: onEditParameters, ariaLabel: 'Edit parameters' } }
              : {})}
          >
            {paramEntries.length === 0 && (
              <span style={{ ...styles.emptyText, paddingLeft: 36 }}>No parameters</span>
            )}
            {paramEntries.map(([key, param]) => (
              <div key={key} style={{ ...styles.paramRow, paddingLeft: 42 }}>
                <span style={styles.paramName}>{param.name}</span>
                <span style={styles.paramValue}>
                  {param.expression}
                  {param.unit !== 'none' ? ` ${param.unit}` : ''}
                </span>
              </div>
            ))}
          </TreeNode>
        </TreeNode>

        {/* Components (Parts) */}
        {parts.map((part, partIndex) => {
          const { sketches, construction, components } = categorizeFeatures(part.timeline);
          const actualBodies = treeBodies ?? [];
          const isRoot = partIndex === 0;
          const componentLabel = isRoot ? `${part.name} (root)` : part.name;
          const partNodeId = `part_${part.id}`;

          return (
            <div key={part.id}>
              {/* Component node */}
              <TreeNode
                nodeId={partNodeId}
                label={componentLabel}
                icon={<Box size={13} color="#ff9800" />}
                expanded={isExpanded(partNodeId)}
                onToggle={() => {
                  toggleNode(partNodeId);
                  onPartClick?.(part.id);
                }}
                depth={0}
                bold
              >
                {/* Origin planes */}
                <TreeNode
                  nodeId={`origin_${part.id}`}
                  label="Origin"
                  icon={<Crosshair size={12} color="#888" />}
                  expanded={isExpanded(`origin_${part.id}`)}
                  onToggle={() => toggleNode(`origin_${part.id}`)}
                  depth={1}
                >
                  <OriginPlane label="XY Plane" depth={2} color="#f44336" />
                  <OriginPlane label="XZ Plane" depth={2} color="#4caf50" />
                  <OriginPlane label="YZ Plane" depth={2} color="#2196f3" />
                  <OriginItem label="X Axis" depth={2} color="#f44336" />
                  <OriginItem label="Y Axis" depth={2} color="#4caf50" />
                  <OriginItem label="Z Axis" depth={2} color="#2196f3" />
                  <OriginItem label="Origin Point" depth={2} color="#888" />
                </TreeNode>

                {/* Sketches */}
                <TreeNode
                  nodeId={`sketches_${part.id}`}
                  label="Sketches"
                  icon={<PenLine size={12} color="#2196f3" />}
                  expanded={isExpanded(`sketches_${part.id}`)}
                  onToggle={() => toggleNode(`sketches_${part.id}`)}
                  depth={1}
                  count={sketches.length}
                >
                  {sketches.length === 0 && (
                    <span style={{ ...styles.emptyText, paddingLeft: 42 }}>No sketches</span>
                  )}
                  {sketches.map(feature => (
                    <FeatureRow
                      key={feature.id}
                      feature={feature}
                      isSelected={feature.id === selectedFeatureId}
                      onClick={() => onFeatureClick?.(feature.id)}
                      onContextMenu={(e) => handleContextMenu(e, feature)}
                      onVisibilityToggle={onVisibilityToggle}
                      depth={2}
                    />
                  ))}
                </TreeNode>

                {/* Construction — datum planes / axes / points (reference
                    geometry features, no body). Failed builds show a red
                    badge here (e.g. a Plane-from-Face whose face ref went
                    stale). */}
                <TreeNode
                  nodeId={`construction_${part.id}`}
                  label="Construction"
                  icon={<Box size={12} color="#3b82f6" />}
                  expanded={isExpanded(`construction_${part.id}`)}
                  onToggle={() => toggleNode(`construction_${part.id}`)}
                  depth={1}
                  count={construction.length}
                >
                  {construction.length === 0 && (
                    <span style={{ ...styles.emptyText, paddingLeft: 42 }}>No construction geometry</span>
                  )}
                  {construction.map(feature => (
                    <FeatureRow
                      key={feature.id}
                      feature={feature}
                      isSelected={feature.id === selectedFeatureId}
                      onClick={() => onFeatureClick?.(feature.id)}
                      onContextMenu={(e) => handleContextMenu(e, feature)}
                      onVisibilityToggle={onVisibilityToggle}
                      depth={2}
                    />
                  ))}
                </TreeNode>

                {/* Components — imported parametric components placed in
                    this part. Right-click → Edit Component… opens the
                    per-instance properties dialog (overrides + config +
                    boolean). */}
                <TreeNode
                  nodeId={`components_${part.id}`}
                  label="Components"
                  icon={<Puzzle size={12} color="#6366f1" />}
                  expanded={isExpanded(`components_${part.id}`)}
                  onToggle={() => toggleNode(`components_${part.id}`)}
                  depth={1}
                  count={components.length}
                >
                  {components.length === 0 && (
                    <span style={{ ...styles.emptyText, paddingLeft: 42 }}>No components</span>
                  )}
                  {components.map(feature => (
                    <FeatureRow
                      key={feature.id}
                      feature={feature}
                      isSelected={feature.id === selectedFeatureId}
                      onClick={() => onFeatureClick?.(feature.id)}
                      onContextMenu={(e) => handleContextMenu(e, feature)}
                      onVisibilityToggle={onVisibilityToggle}
                      depth={2}
                    />
                  ))}
                </TreeNode>

                {/* Bodies (actual build bodies, not features) */}
                <TreeNode
                  nodeId={`bodies_${part.id}`}
                  label="Bodies"
                  icon={<Box size={12} color="#ff9800" />}
                  expanded={isExpanded(`bodies_${part.id}`)}
                  onToggle={() => toggleNode(`bodies_${part.id}`)}
                  depth={1}
                  count={actualBodies.length}
                >
                  {actualBodies.length === 0 && (
                    <span style={{ ...styles.emptyText, paddingLeft: 42 }}>No bodies</span>
                  )}
                  {(() => {
                    const renderBody = (body: TreeBody, bodyDepth: number) => (
                      <BodyRow
                        key={body.bodyId}
                        body={body}
                        isSelected={body.bodyId === selectedBodyId}
                        onClick={() => onBodyClick?.(body.bodyId, body.sourceFeatureId)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // Select the body so "Move" targets it.
                          onBodyClick?.(body.bodyId, body.sourceFeatureId);
                          setContextMenu({
                            featureId: body.sourceFeatureId,
                            featureType: body.sourceFeatureType,
                            featureEnabled: true,
                            target: 'body',
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        onVisibilityToggle={onBodyVisibilityToggle}
                        depth={bodyDepth}
                      />
                    );
                    return groupBodiesByFeature(actualBodies).map(group => {
                      // A multi-solid import is nested under one feature node
                      // whose right-click menu offers "Move all".
                      if (group.type === 'importedGeometry' && group.bodies.length > 1) {
                        const gid = `bodygroup_${group.featureId}`;
                        // Container eye: hide all bodies if any are visible,
                        // else show all. Drives the same per-body hidden set,
                        // so it's fully recoverable and keeps the nodes.
                        const allHidden = group.bodies.every(b => !b.visible);
                        return (
                          <TreeNode
                            key={gid}
                            nodeId={gid}
                            label={group.name}
                            icon={<Box size={12} color="#ff9800" />}
                            expanded={isExpanded(gid)}
                            onToggle={() => toggleNode(gid)}
                            depth={2}
                            count={group.bodies.length}
                            trailingAction={{
                              icon: allHidden
                                ? <EyeOff size={11} strokeWidth={1.5} />
                                : <Eye size={11} strokeWidth={1.5} />,
                              onClick: () => group.bodies.forEach(b => onBodyVisibilityToggle?.(b.bodyId, allHidden)),
                              ariaLabel: allHidden ? 'Show all bodies' : 'Hide all bodies',
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setContextMenu({
                                featureId: group.featureId,
                                featureType: group.type,
                                featureEnabled: true,
                                target: 'feature',
                                x: e.clientX,
                                y: e.clientY,
                              });
                            }}
                          >
                            {group.bodies.map(b => renderBody(b, 3))}
                          </TreeNode>
                        );
                      }
                      return group.bodies.map(b => renderBody(b, 2));
                    });
                  })()}
                </TreeNode>
              </TreeNode>
            </div>
          );
        })}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          ref={contextMenuRef}
          x={contextMenu.x}
          y={contextMenu.y}
          featureType={contextMenu.featureType}
          featureEnabled={contextMenu.featureEnabled}
          target={contextMenu.target}
          onAction={handleContextAction}
        />
      )}
    </div>
  );
}

// ---- Sub-components ----

interface TreeNodeProps {
  nodeId: string;
  label: string;
  icon: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  depth: number;
  count?: number;
  bold?: boolean;
  children?: React.ReactNode;
  /** Optional small icon button rendered at the right edge of the row. */
  trailingAction?: { icon: React.ReactNode; onClick: () => void; ariaLabel: string };
  /** Right-click handler on the node's own row (e.g. import group → Move all). */
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined;
}

function TreeNode({ label, icon, expanded, onToggle, depth, count, bold, children, trailingAction, onContextMenu }: TreeNodeProps) {
  const paddingLeft = 8 + depth * 14;

  return (
    <>
      <div style={{ position: 'relative' }}>
        <button
          style={{
            ...styles.treeNodeBtn,
            paddingLeft,
            paddingRight: trailingAction ? 28 : 8,
            fontWeight: bold ? 600 : 500,
            fontSize: bold ? 12 : 11,
            color: bold ? '#444' : '#555',
          }}
          onClick={onToggle}
          onContextMenu={onContextMenu}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f0f0f0'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        >
          <span style={styles.expandIcon}>
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          <span style={{ display: 'inline-flex' }}>{icon}</span>
          <span style={styles.treeNodeLabel}>{label}</span>
          {count !== undefined && <span style={styles.badge}>{count}</span>}
        </button>
        {trailingAction && (
          <button
            type="button"
            style={styles.trailingActionBtn}
            onClick={(e) => { e.stopPropagation(); trailingAction.onClick(); }}
            aria-label={trailingAction.ariaLabel}
            title={trailingAction.ariaLabel}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#e6e6e6'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          >
            {trailingAction.icon}
          </button>
        )}
      </div>
      {expanded && children}
    </>
  );
}

interface FeatureRowProps {
  feature: TreeFeature;
  isSelected: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onVisibilityToggle: ((featureId: string, visible: boolean) => void) | undefined;
  depth: number;
}

function FeatureRow({ feature, isSelected, onClick, onContextMenu, onVisibilityToggle, depth }: FeatureRowProps) {
  const typeColor = featureTypeColors[feature.type] ?? '#888';
  const paddingLeft = 8 + depth * 14;

  // Compute build-status visuals. `failed` paints a red left border + red
  // icon + tooltip with the error so the user can diagnose without
  // opening DevTools. `blocked` is grey (depends-on broken upstream).
  const status: FeatureBuildStatus = feature.status ?? 'success';
  const isFailed = status === 'failed';
  const isBlocked = status === 'blocked';
  const baseBorder = isSelected ? '2px solid #1a6fd1'
    : isFailed ? '2px solid #dc2626'
    : isBlocked ? '2px solid #d97706'
    : '2px solid transparent';
  const baseBg = isSelected ? '#e3effb'
    : isFailed ? '#fef2f2'
    : 'transparent';
  const baseHoverBg = isFailed ? '#fee2e2' : '#f4f4f4';
  const tooltip = isFailed
    ? `${feature.name} (${feature.type}) — BUILD FAILED: ${feature.errorMessage ?? 'unknown error'}`
    : isBlocked
      ? `${feature.name} (${feature.type}) — blocked by upstream failure`
      : `${feature.name} (${feature.type}) - Right-click for options`;

  return (
    <button
      style={{
        ...styles.featureNode,
        paddingLeft,
        background: baseBg,
        opacity: feature.enabled ? 1 : 0.45,
        borderLeft: baseBorder,
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={tooltip}
      onMouseEnter={e => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = baseHoverBg;
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = baseBg;
      }}
    >
      <span
        style={{
          ...styles.featureIconWrap,
          background: `${typeColor}18`,
          color: typeColor,
        }}
      >
        {getFeatureIcon(feature.type, 12)}
      </span>
      <span style={{
        ...styles.featureName,
        color: isFailed ? '#b91c1c' : undefined,
      }}>{feature.name}</span>
      <span
        style={styles.visibilityToggle}
        onClick={e => {
          e.stopPropagation();
          onVisibilityToggle?.(feature.id, !feature.visible);
        }}
        title={feature.visible ? 'Hide' : 'Show'}
      >
        {feature.visible ? <Eye size={11} strokeWidth={1.5} /> : <EyeOff size={11} strokeWidth={1.5} />}
      </span>
      {/* Status / state icon. Only rendered when there's something to
          communicate — `success` is the silent default, since a green
          checkmark on every row was noise (the user can already tell
          things built by the absence of red/grey badges).
          For sketches we also surface a Lock when DOF = 0 (V11.5
          continuation) — at-a-glance "this sketch is done" without
          having to enter edit mode. */}
      {(() => {
        if (!feature.enabled) {
          return <span style={styles.statusIcon}><FeatureSuppressedIcon size={10} /></span>;
        }
        if (isFailed) {
          return <span style={styles.statusIcon}>
            <span style={{ color: '#dc2626', fontSize: 14, lineHeight: 1, fontWeight: 700 }} title="Build failed">⚠</span>
          </span>;
        }
        if (isBlocked) {
          return <span style={styles.statusIcon}>
            <span style={{ color: '#d97706', fontSize: 14, lineHeight: 1 }} title="Blocked by upstream">⏸</span>
          </span>;
        }
        if (feature.type === 'sketch' && feature.dof === 0) {
          return <span style={styles.statusIcon} title="Fully constrained">
            <Lock size={11} strokeWidth={1.5} color="#1a6fd1" />
          </span>;
        }
        if (feature.type === 'sketch' && typeof feature.dof === 'number' && feature.dof > 0) {
          return <span style={styles.statusIcon} title={`Under-constrained · ${feature.dof} DOF`}>
            <LockOpen size={11} strokeWidth={1.5} color="#9ca3af" />
          </span>;
        }
        return null;
      })()}
    </button>
  );
}

// ---- BodyRow ----

interface BodyRowProps {
  body: TreeBody;
  isSelected: boolean;
  onClick: () => void;
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined;
  onVisibilityToggle: ((bodyId: string, visible: boolean) => void) | undefined;
  depth: number;
}

function BodyRow({ body, isSelected, onClick, onContextMenu, onVisibilityToggle, depth }: BodyRowProps) {
  const paddingLeft = 8 + depth * 14;

  return (
    <button
      style={{
        ...styles.featureNode,
        paddingLeft,
        background: isSelected ? '#e3effb' : 'transparent',
        borderLeft: isSelected ? '2px solid #1a6fd1' : '2px solid transparent',
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`${body.label} (from feature ${body.sourceFeatureId})`}
      onMouseEnter={e => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = '#f4f4f4';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background =
          isSelected ? '#e3effb' : 'transparent';
      }}
    >
      <span
        style={{
          ...styles.featureIconWrap,
          background: '#ff980018',
          color: '#ff9800',
        }}
      >
        <Box size={12} />
      </span>
      <span style={styles.featureName}>{body.label}</span>
      <span
        style={styles.visibilityToggle}
        onClick={e => {
          e.stopPropagation();
          onVisibilityToggle?.(body.bodyId, !body.visible);
        }}
        title={body.visible ? 'Hide body' : 'Show body'}
      >
        {body.visible ? <Eye size={11} strokeWidth={1.5} /> : <EyeOff size={11} strokeWidth={1.5} />}
      </span>
    </button>
  );
}

function OriginPlane({ label, depth, color }: { label: string; depth: number; color: string }) {
  const paddingLeft = 8 + depth * 14;
  return (
    <div style={{ ...styles.originItem, paddingLeft }}>
      <span style={{ ...styles.originDot, background: color }} />
      <svg width={12} height={12} viewBox="0 0 12 12" style={{ flexShrink: 0 }}>
        <rect x="1" y="3" width="10" height="6" rx="1" stroke={color} strokeWidth="1" fill={`${color}15`} />
      </svg>
      <span style={styles.originLabel}>{label}</span>
    </div>
  );
}

function OriginItem({ label, depth, color }: { label: string; depth: number; color: string }) {
  const paddingLeft = 8 + depth * 14;
  return (
    <div style={{ ...styles.originItem, paddingLeft }}>
      <span style={{ ...styles.originDot, background: color }} />
      <span style={styles.originLabel}>{label}</span>
    </div>
  );
}

// ---- Context Menu ----

interface ContextMenuProps {
  x: number;
  y: number;
  featureType: string;
  featureEnabled: boolean;
  /** 'body' row vs 'feature'/group node — Move vs Move all for imports. */
  target: 'body' | 'feature';
  onAction: (action: ContextMenuAction) => void;
}

const ContextMenu = forwardRef<HTMLDivElement, ContextMenuProps>(
  function ContextMenu({ x, y, featureType, featureEnabled, target, onAction }, ref) {
    const isSketch = featureType === 'sketch';
    const isImportedComponent = featureType === 'importedComponent';
    const isImportedGeometry = featureType === 'importedGeometry';
    const isBody = !isSketch && !isImportedComponent; // extrude, hole, etc.

    const items: Array<{
      action: ContextMenuAction;
      label: string;
      icon: React.ReactNode;
      dividerBefore?: boolean;
      accent?: boolean;
      destructive?: boolean;
    }> = [];

    if (isSketch) {
      items.push({
        action: 'extrude',
        label: 'Extrude',
        icon: <ExtrudeIcon size={14} />,
        accent: true,
      });
      items.push({
        action: 'editSketch',
        label: 'Edit Sketch',
        icon: <Pencil size={14} />,
      });
    }

    if (isImportedComponent) {
      // Imported component: open the per-instance properties editor
      // (overrides + active config + boolean mode).
      items.push({
        action: 'editComponent',
        label: 'Edit Component…',
        icon: <Pencil size={14} />,
        accent: true,
      });
      // Insert another instance of the same component without re-picking
      // the file. Storage stays single-copy (handler is idempotent on
      // hash); the duplicate inherits the source's overrides + config
      // + boolean mode so it's a true "give me another of these" rather
      // than a blank slot.
      items.push({
        action: 'duplicateComponent',
        label: 'Duplicate Component',
        icon: <Puzzle size={14} />,
      });
    }

    if (isBody) {
      // Imported geometry: Move (drag gizmo). On a single body → "Move"
      // (that body); on the import's group node → "Move all" (whole import).
      // "Edit Feature" is a no-op for imports (no parametric inputs).
      if (isImportedGeometry) {
        items.push(target === 'feature'
          ? { action: 'moveAll', label: 'Move all', icon: <Move size={14} />, accent: true }
          : { action: 'move', label: 'Move', icon: <Move size={14} />, accent: true });
      } else {
        items.push({
          action: 'editFeature',
          label: 'Edit Feature',
          icon: <Pencil size={14} />,
          accent: true,
        });
      }
    }

    // Suppress is omitted for imported geometry: an import has no persistent
    // feature row, so a suppressed import (no bodies built) would leave no
    // node to right-click "Enable" — a dead end. Use Delete (undoable) or the
    // per-body Hide eye instead.
    if (!isImportedGeometry) {
      items.push({
        action: featureEnabled ? 'suppress' : 'enable',
        label: featureEnabled ? 'Suppress' : 'Enable',
        icon: featureEnabled ? <EyeOff size={14} /> : <Eye size={14} />,
        dividerBefore: isSketch || isBody || isImportedComponent,
      });
    }

    items.push({
      action: 'delete',
      label: 'Delete',
      icon: <Trash2 size={14} />,
      destructive: true,
    });

    return (
      <div
        ref={ref}
        style={{
          ...styles.contextMenu,
          left: x,
          top: y,
        }}
      >
        {items.map((item) => (
          <div key={item.action}>
            {item.dividerBefore && <div style={styles.contextDivider} />}
            <button
              style={{
                ...styles.contextItem,
                color: item.destructive ? '#dc2626' : item.accent ? '#1a6fd1' : '#444',
                fontWeight: item.accent ? 600 : 500,
              }}
              onClick={() => onAction(item.action)}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  item.destructive ? '#fef2f2' : '#f4f4f4';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              <span style={styles.contextItemIcon}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          </div>
        ))}
      </div>
    );
  }
);

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#fafafa',
  },
  header: {
    padding: '8px 12px',
    borderBottom: '1px solid #d8d8d8',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: '#888',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: '2px 0',
  },
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
  treeNodeLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
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
  },
  featureIconWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    borderRadius: 3,
    flexShrink: 0,
  },
  featureName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  visibilityToggle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 18,
    height: 18,
    borderRadius: 3,
    cursor: 'pointer',
    color: '#aaa',
    marginLeft: 'auto',
  } as React.CSSProperties,
  statusIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  originItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    height: 22,
    fontSize: 10,
    color: '#999',
    padding: '0 8px',
  },
  originDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    flexShrink: 0,
  },
  originLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  emptyText: {
    display: 'block',
    padding: '4px 12px',
    fontSize: 10,
    color: '#ccc',
    fontStyle: 'italic',
  },
  paramRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '2px 12px',
    fontSize: 10,
  },
  paramName: {
    color: '#666',
    fontWeight: 500,
  },
  paramValue: {
    color: '#2266aa',
    fontFamily: 'monospace',
    fontSize: 10,
  },
  // Context Menu
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
  contextDivider: {
    height: 1,
    background: '#e8e8e8',
    margin: '3px 8px',
  },
};

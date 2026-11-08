/**
 * TimelineBar - Bottom timeline showing feature icons in chronological order.
 *
 * Small icon squares connected by lines, with tooltips.
 * No text labels - icons only for compact representation.
 *
 * Features:
 * - Compact icon-only chips with feature-type colors
 * - Connector lines between features
 * - Selection ring
 * - Tooltip on hover with feature name + type
 * - Suppressed features shown dimmed
 * - Playback navigation (step back/forward, to start/end)
 * - Ctrl- or shift-click to select several features
 * - Rename a feature or a group in place
 * - Groups and composites open and close; a group chip has its own menu
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { SkipBack, ChevronLeft, ChevronRight, SkipForward, Play, Folder, FolderOpen } from 'lucide-react';
import { getFeatureIcon, featureTypeColors } from '../icons/cadIcons.tsx';

// ---- Types ----

export interface TimelineFeature {
  id: string;
  name: string;
  type: string;
  /**
   * Which glyph and colour the chip uses. Usually the type; for a
   * `primitive` it is the shape, so a box and a torus don't look alike.
   * Falls back to `type` when absent.
   */
  iconKey?: string;
  enabled: boolean;
  /** Its result is stored as it last built: drawn with a dashed sky-blue ring. */
  frozen?: boolean;
  /**
   * Per-feature build status from the rebuild artifact. Drives the
   * row's visual treatment so the user sees at a glance which feature
   * is failing or being blocked by an upstream — same goal as the
   * red-border treatment in ProjectTree (task #39), now applied to
   * the timeline chips too.
   */
  status?: 'success' | 'suppressed' | 'blocked' | 'failed';
  /** Set when status === 'failed'. Shown in the chip's hover tooltip. */
  errorMessage?: string;
  /**
   * Set when status === 'blocked'. Already resolved upstream-feature-
   * name (+ its own status), e.g. "Sketch 1 (suppressed)" — kept
   * separate from raw blockedBy so the timeline doesn't need access
   * to the global feature-by-id map.
   */
  blockedByLabel?: string;
  /** A composite's own features, shown when the composite is opened. */
  children?: TimelineFeature[];
}

/** A group of features (a part's feature group): collapsed, it shows as one chip. */
export interface TimelineGroup {
  id: string;
  name: string;
  members: string[];
}

interface TimelineBarProps {
  features: TimelineFeature[];
  /** Feature groups; a collapsed group shows as one chip at its first member. */
  groups?: TimelineGroup[] | undefined;
  selectedFeatureId?: string | null;
  /** Every selected feature; takes over from `selectedFeatureId` when given. */
  selectedFeatureIds?: ReadonlySet<string> | undefined;
  rollbackIndex?: number;
  /** A click on a feature; `additive` with ctrl or cmd held (and with shift when there is no range handler). */
  onFeatureClick?: (featureId: string, additive: boolean) => void;
  /**
   * A shift-click: the features from the last one clicked to this one, in
   * timeline order, which replace the selection.
   */
  onFeatureRangeClick?: ((featureIds: string[]) => void) | undefined;
  /** Double-click on a feature: open it for editing. */
  onFeatureDoubleClick?: ((featureId: string) => void) | undefined;
  onRollbackChange?: (index: number) => void;
  /** Right-click context action on a timeline feature */
  onContextAction?: ((action: string, featureId: string) => void) | undefined;
  /**
   * The context menu entries for a feature, replacing the built-in ones.
   * Each entry calls `onContextAction` with its `action`.
   */
  menuFor?: ((feature: TimelineFeature) => TimelineMenuEntry[]) | undefined;
  /** A feature's new name from the menu's Rename (action `rename`). */
  onRename?: ((featureId: string, name: string) => void) | undefined;
  /** A group renamed, or ungrouped, from its chip's menu. */
  onGroupAction?: ((groupId: string, action: 'renameGroup' | 'ungroup', name?: string) => void) | undefined;
  /**
   * The document is a read-only preview: the rollback controls are
   * disabled, groups have no menu, and a chip's menu opens only when
   * `menuFor` gives it entries.
   */
  readOnly?: boolean | undefined;
  /**
   * A feature panel is open: the marker stays where `rollbackIndex` puts it
   * and the step and jump controls are disabled.
   */
  markerLocked?: boolean | undefined;
}

/** One entry of a timeline chip's context menu. */
export interface TimelineMenuEntry {
  action: string;
  label: string;
  danger?: boolean;
}

/** The ring of a frozen feature's chip. */
const FROZEN_COLOR = '#0ea5e9';

/**
 * The features from `anchor` to `to` in timeline `order`, both included,
 * in timeline order; null when either is not in it.
 */
export function featureRange(order: readonly string[], anchor: string, to: string): string[] | null {
  const a = order.indexOf(anchor);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return null;
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// ---- Component ----

export function TimelineBar({
  features,
  selectedFeatureId,
  selectedFeatureIds,
  rollbackIndex,
  onFeatureClick,
  onFeatureRangeClick,
  onFeatureDoubleClick,
  onRollbackChange,
  onContextAction,
  menuFor,
  onRename,
  onGroupAction,
  groups,
  readOnly = false,
  markerLocked = false,
}: TimelineBarProps) {
  const currentIndex = rollbackIndex ?? features.length;
  const isSelected = (id: string) => (selectedFeatureIds ? selectedFeatureIds.has(id) : id === selectedFeatureId);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [openComposites, setOpenComposites] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** The chip a shift-click's range starts at: the last one clicked without shift. */
  const anchorRef = useRef<string | null>(null);
  const [markerLeft, setMarkerLeft] = useState<number | null>(null);
  const groupOf = new Map<string, TimelineGroup>();
  for (const g of groups ?? []) for (const m of g.members) groupOf.set(m, g);
  const firstOf = new Map<string, number>();
  features.forEach((f, i) => {
    const g = groupOf.get(f.id);
    if (g && !firstOf.has(g.id)) firstOf.set(g.id, i);
  });
  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleComposite = (id: string) =>
    setOpenComposites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // The marker sits in the gap before the first chip at or after the rollback: each top-level chip
  // carries the timeline index it starts at, and a collapsed group the index of its first member.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || currentIndex >= features.length) {
      setMarkerLeft(null);
      return;
    }
    const slots = [...track.querySelectorAll<HTMLElement>('[data-slot-index]')];
    const at = slots.find((el) => Number(el.dataset.slotIndex) >= currentIndex);
    setMarkerLeft(at ? at.offsetLeft + (currentIndex > 0 ? 3 : 0) : null);
  }, [currentIndex, features, groups, openGroups, openComposites, renaming, renamingGroup]);
  const [contextMenu, setContextMenu] = useState<{ feature: TimelineFeature; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close the menus on an outside click or Escape
  useEffect(() => {
    if (!contextMenu && !groupMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setGroupMenu(null);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setContextMenu(null);
      setGroupMenu(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', key);
    };
  }, [contextMenu, groupMenu]);

  const handleChipContextMenu = useCallback(
    (e: React.MouseEvent, feature: TimelineFeature) => {
      e.preventDefault();
      setGroupMenu(null);
      if (readOnly && (menuFor?.(feature).length ?? 0) === 0) return;
      setContextMenu({ feature, x: e.clientX, y: e.clientY });
    },
    [readOnly, menuFor],
  );

  const handleGroupContextMenu = useCallback(
    (e: React.MouseEvent, groupId: string) => {
      e.preventDefault();
      setContextMenu(null);
      if (readOnly || !onGroupAction) return;
      setGroupMenu({ groupId, x: e.clientX, y: e.clientY });
    },
    [readOnly, onGroupAction],
  );

  const handleMenuAction = useCallback(
    (action: string) => {
      if (contextMenu) {
        if (action === 'rename' && onRename) setRenaming(contextMenu.feature.id);
        else onContextAction?.(action, contextMenu.feature.id);
      }
      setContextMenu(null);
    },
    [contextMenu, onContextAction, onRename],
  );

  /** One feature's chip, or its name field while it is renamed. */
  const chip = (feature: TimelineFeature, index: number, pastRollback: boolean) => {
    const selected = isSelected(feature.id);
    const iconKey = feature.iconKey ?? feature.type;
    const typeColor = featureTypeColors[iconKey] ?? '#888';
    const status = feature.status ?? 'success';
    if (renaming === feature.id) {
      return (
        <NameField
          name={feature.name}
          onDone={(name) => {
            setRenaming(null);
            if (name !== null && name.trim() !== '' && name.trim() !== feature.name)
              onRename?.(feature.id, name.trim());
          }}
        />
      );
    }

    // Status-driven border + corner dot. failed / blocked override
    // the selection ring color so the user sees the problem first.
    const statusBorderColor = status === 'failed' ? '#dc2626' : status === 'blocked' ? '#f59e0b' : null;

    // Tooltip lines: 1) base "<name> (<type>)", 2) status-specific
    // detail (error message for failed, upstream attribution for
    // blocked), 3) interaction hint.
    const tooltipLines = [`${feature.name} (${feature.type})`];
    if (status === 'failed' && feature.errorMessage) {
      tooltipLines.push(`Failed: ${feature.errorMessage}`);
    } else if (status === 'blocked' && feature.blockedByLabel) {
      tooltipLines.push(`Blocked by ${feature.blockedByLabel}`);
    } else if (status === 'suppressed') {
      tooltipLines.push('Suppressed');
    }
    if (feature.frozen) tooltipLines.push('Frozen');
    tooltipLines.push('Right-click for options');
    const rest = selected ? '#e3effb' : pastRollback ? '#f0f0f0' : `${typeColor}15`;

    return (
      <div style={styles.chipContainer}>
        <button
          data-feature-chip={feature.id}
          data-timeline-index={index}
          style={{
            ...styles.chip,
            borderColor: statusBorderColor ?? (selected ? '#1a6fd1' : feature.frozen ? FROZEN_COLOR : 'transparent'),
            ...(feature.frozen && statusBorderColor === null && !selected ? { borderStyle: 'dashed' } : {}),
            background: rest,
            opacity: !feature.enabled || pastRollback ? 0.4 : 1,
            boxShadow: selected ? '0 0 0 1px #1a6fd1' : 'none',
          }}
          onClick={(e) => {
            const order = features.flatMap((f) => [
              f.id,
              ...(openComposites.has(f.id) ? (f.children ?? []).map((c) => c.id) : []),
            ]);
            const range =
              e.shiftKey && onFeatureRangeClick && anchorRef.current !== null
                ? featureRange(order, anchorRef.current, feature.id)
                : null;
            if (range) {
              onFeatureRangeClick?.(range);
              return;
            }
            anchorRef.current = feature.id;
            onFeatureClick?.(feature.id, e.ctrlKey || e.metaKey || (e.shiftKey && !onFeatureRangeClick));
          }}
          onDoubleClick={() => onFeatureDoubleClick?.(feature.id)}
          onContextMenu={(e) => handleChipContextMenu(e, feature)}
          title={tooltipLines.join('\n')}
          onMouseEnter={(e) => {
            if (!selected) {
              (e.currentTarget as HTMLButtonElement).style.background = `${typeColor}25`;
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)';
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = rest;
            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
          }}
        >
          <span style={{ color: selected ? '#1a6fd1' : typeColor }}>{getFeatureIcon(iconKey, 14)}</span>
        </button>
        {statusBorderColor !== null && (
          <span
            style={{
              ...styles.statusDot,
              background: statusBorderColor,
            }}
          />
        )}
        {feature.children && feature.children.length > 0 && (
          <button
            style={styles.openToggle}
            onClick={() => toggleComposite(feature.id)}
            title={openComposites.has(feature.id) ? 'Close' : `Open (${feature.children.length} features)`}
            aria-label={openComposites.has(feature.id) ? `Close ${feature.name}` : `Open ${feature.name}`}
          >
            {openComposites.has(feature.id) ? <ChevronLeft size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
      </div>
    );
  };

  /** A composite's own features, after its chip while it is open. */
  const childChips = (feature: TimelineFeature, pastRollback: boolean) =>
    feature.children && openComposites.has(feature.id)
      ? feature.children.map((c, i) => (
          <div key={c.id} style={{ ...styles.chipWrapper, borderBottom: '2px dotted #94a3b8' }}>
            <div style={{ ...styles.connector, opacity: pastRollback ? 0.2 : 0.5 }} />
            {chip(c, i, pastRollback)}
          </div>
        ))
      : null;

  /** A group's chip, or its name field while it is renamed. */
  const groupChip = (group: TimelineGroup, open: boolean, failed: boolean, pastRollback: boolean, count: number) =>
    renamingGroup === group.id ? (
      <NameField
        name={group.name}
        onDone={(name) => {
          setRenamingGroup(null);
          if (name !== null && name.trim() !== '' && name.trim() !== group.name)
            onGroupAction?.(group.id, 'renameGroup', name.trim());
        }}
      />
    ) : (
      <div style={styles.chipContainer}>
        <button
          style={{
            ...styles.chip,
            borderColor: !open && failed ? '#dc2626' : 'transparent',
            background: open ? '#64748b25' : '#64748b15',
            opacity: !open && pastRollback ? 0.4 : 1,
          }}
          onClick={() => toggleGroup(group.id)}
          onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
          title={open ? `${group.name}\nClick to close` : `${group.name} (${count} features)\nClick to open`}
        >
          <span style={{ color: '#64748b' }}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
        </button>
      </div>
    );

  const fixed = readOnly || markerLocked;

  const handleBack = () => {
    if (currentIndex > 0 && onRollbackChange) {
      onRollbackChange(currentIndex - 1);
    }
  };

  const handleForward = () => {
    if (currentIndex < features.length && onRollbackChange) {
      onRollbackChange(currentIndex + 1);
    }
  };

  const handleToStart = () => {
    if (onRollbackChange) onRollbackChange(0);
  };

  const handleToEnd = () => {
    if (onRollbackChange) onRollbackChange(features.length);
  };

  return (
    <div style={styles.root}>
      {/* Navigation controls */}
      <div style={styles.navGroup}>
        <NavButton
          icon={<SkipBack size={12} />}
          label="To start"
          onClick={handleToStart}
          disabled={fixed || currentIndex === 0}
        />
        <NavButton
          icon={<ChevronLeft size={13} />}
          label="Step back"
          onClick={handleBack}
          disabled={fixed || currentIndex === 0}
        />
        <NavButton
          icon={<ChevronRight size={13} />}
          label="Step forward"
          onClick={handleForward}
          disabled={fixed || currentIndex >= features.length}
        />
        <NavButton
          icon={<SkipForward size={12} />}
          label="To end"
          onClick={handleToEnd}
          disabled={fixed || currentIndex >= features.length}
        />
      </div>

      {/* Feature icon track */}
      <div ref={trackRef} style={styles.chipTrack}>
        {features.length === 0 && <span style={styles.emptyMessage}>No features</span>}

        {features.map((feature, index) => {
          const group = groupOf.get(feature.id);
          const first = group !== undefined && firstOf.get(group.id) === index;
          const pastRollback = index >= currentIndex;
          if (group && !openGroups.has(group.id)) {
            if (!first) return null;
            const members = features.filter((f) => group.members.includes(f.id));
            return (
              <div key={`group-${group.id}`} data-slot-index={index} style={styles.chipWrapper}>
                {index > 0 && <div style={{ ...styles.connector, opacity: pastRollback ? 0.2 : 0.5 }} />}
                {groupChip(
                  group,
                  false,
                  members.some((f) => f.status === 'failed'),
                  pastRollback,
                  members.length,
                )}
              </div>
            );
          }
          const head =
            group && first ? (
              <div key={`group-${group.id}`} data-slot-index={index} style={styles.chipWrapper}>
                {index > 0 && <div style={{ ...styles.connector, opacity: pastRollback ? 0.2 : 0.5 }} />}
                {groupChip(group, true, false, pastRollback, group.members.length)}
              </div>
            ) : null;
          return (
            <span key={feature.id} style={{ display: 'contents' }}>
              {head}
              <div
                data-slot-index={head ? undefined : index}
                style={{ ...styles.chipWrapper, ...(group ? { borderBottom: '2px solid #94a3b8' } : {}) }}
              >
                {(index > 0 || head) && <div style={{ ...styles.connector, opacity: pastRollback ? 0.2 : 0.5 }} />}
                {chip(feature, index, pastRollback)}
              </div>
              {childChips(feature, pastRollback)}
            </span>
          );
        })}

        {/* Rollback marker */}
        {markerLeft !== null && (
          <div
            style={{
              ...styles.rollbackMarker,
              left: `${markerLeft}px`,
            }}
            title={`Rolled back before feature ${currentIndex + 1}`}
          >
            <Play size={8} style={{ transform: 'rotate(180deg)' }} />
          </div>
        )}
      </div>

      {/* Feature count */}
      <span style={styles.count}>
        {currentIndex}/{features.length}
      </span>

      {/* Context menu (right-click on timeline chip).
          Positioning: the timeline lives at the bottom of the window,
          so a top-anchored menu (top: clientY, growing downward) was
          clipped by the browser viewport bottom edge. Anchor the
          menu's BOTTOM at the click point and let it grow upward
          instead — for a bottom-edge UI this is the only reliable
          choice short of dynamic flip-detection. */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{ ...styles.menu, bottom: window.innerHeight - contextMenu.y, left: contextMenu.x }}
        >
          {menuFor &&
            (() => {
              const feature = contextMenu.feature;
              return feature
                ? menuFor(feature).map((entry) => (
                    <button
                      key={entry.action}
                      style={entry.danger ? { ...menuItemStyle, color: '#e53e3e' } : menuItemStyle}
                      onClick={() => handleMenuAction(entry.action)}
                    >
                      {entry.label}
                    </button>
                  ))
                : null;
            })()}
          {!menuFor && contextMenu.feature.type === 'sketch' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('editSketch')}>
              Edit Sketch
            </button>
          )}
          {!menuFor && contextMenu.feature.type === 'sketch' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('extrude')}>
              Extrude
            </button>
          )}
          {!menuFor && contextMenu.feature.type === 'extrude' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('editFeature')}>
              Edit Feature
            </button>
          )}
          {/* component: per-instance parameter overrides + active config
              + boolean mode. Transform is preserved untouched (a dedicated UX
              for it is not yet wired).
              Duplicate is intentionally NOT here — the timeline is a build-
              order view; duplicating lives in the ProjectTree's Components
              subsection where the inventory mental model fits. */}
          {!menuFor && contextMenu.feature.type === 'component' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('editComponent')}>
              Edit Component...
            </button>
          )}
          {!menuFor &&
            (contextMenu.feature.enabled ? (
              <button style={menuItemStyle} onClick={() => handleMenuAction('suppress')}>
                Suppress
              </button>
            ) : (
              <button style={menuItemStyle} onClick={() => handleMenuAction('enable')}>
                Enable
              </button>
            ))}
          {!menuFor && (
            <button style={{ ...menuItemStyle, color: '#e53e3e' }} onClick={() => handleMenuAction('delete')}>
              Delete
            </button>
          )}
        </div>
      )}
      {groupMenu && (
        <div
          ref={contextMenuRef}
          style={{ ...styles.menu, bottom: window.innerHeight - groupMenu.y, left: groupMenu.x }}
        >
          <button
            style={menuItemStyle}
            onClick={() => {
              setRenamingGroup(groupMenu.groupId);
              setGroupMenu(null);
            }}
          >
            Rename Group
          </button>
          <button
            style={menuItemStyle}
            onClick={() => {
              onGroupAction?.(groupMenu.groupId, 'ungroup');
              setGroupMenu(null);
            }}
          >
            Ungroup
          </button>
        </div>
      )}
    </div>
  );
}

/** A name edited in place of a chip: Enter or leaving the field keeps it, Escape drops it. */
function NameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      aria-label="Name"
      value={value}
      style={styles.nameField}
      onChange={(e) => setValue(e.currentTarget.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value);
        if (e.key === 'Escape') finish(null);
      }}
    />
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '6px 12px',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  fontSize: 12,
  color: '#333',
};

// ---- Sub-components ----

interface NavButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
}

function NavButton({ icon, label, onClick, disabled }: NavButtonProps) {
  return (
    <button
      style={{
        ...styles.navBtn,
        opacity: disabled ? 0.3 : 1,
      }}
      onClick={onClick}
      disabled={disabled}
      title={label}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = '#ebebeb';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {icon}
    </button>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: 36,
    background: '#ffffff',
    borderTop: '1px solid #d8d8d8',
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    gap: 6,
    userSelect: 'none',
  },
  navGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 0,
    background: '#f5f5f5',
    borderRadius: 4,
    padding: 1,
    border: '1px solid #e4e4e4',
    flexShrink: 0,
  },
  navBtn: {
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    borderRadius: 3,
    color: '#555',
    cursor: 'pointer',
    padding: 0,
    transition: 'background 0.12s',
  },
  chipTrack: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    overflow: 'auto',
    gap: 0,
    padding: '0 2px',
    position: 'relative',
  },
  chipWrapper: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  connector: {
    width: 8,
    height: 1,
    background: '#ccc',
  },
  chip: {
    width: 28,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1.5px solid transparent',
    borderRadius: 6,
    background: '#f5f5f5',
    cursor: 'pointer',
    padding: 0,
    transition: 'border-color 0.12s, background 0.12s, transform 0.12s',
  },
  chipContainer: {
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
  },
  // Tiny corner dot for failed (red) / blocked (amber) status. Sits
  // over the chip's top-right so the status is visible at a glance
  // even with the chip dimmed by `enabled === false` or rollback.
  statusDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: '50%',
    border: '1.5px solid #fff',
    pointerEvents: 'none',
    boxShadow: '0 0 0 0.5px rgba(0,0,0,0.1)',
  },
  rollbackMarker: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: 2,
    background: '#cc7700',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#cc7700',
    zIndex: 2,
    borderRadius: 1,
  },
  menu: {
    position: 'fixed',
    background: '#fff',
    border: '1px solid #d8d8d8',
    borderRadius: 6,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    zIndex: 10000,
    minWidth: 140,
    padding: '4px 0',
    fontSize: 12,
  },
  nameField: {
    width: 120,
    height: 24,
    fontSize: 12,
    padding: '0 6px',
    border: '1px solid #1a6fd1',
    borderRadius: 4,
    outline: 'none',
  },
  openToggle: {
    width: 12,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: '#64748b',
    cursor: 'pointer',
    padding: 0,
  },
  emptyMessage: {
    fontSize: 10,
    color: '#ccc',
    fontStyle: 'italic',
  },
  count: {
    fontSize: 10,
    color: '#aaa',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
};

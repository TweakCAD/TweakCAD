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
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  SkipBack,
  ChevronLeft,
  ChevronRight,
  SkipForward,
  Play,
} from 'lucide-react';
import {
  getFeatureIcon,
  featureTypeColors,
} from '../icons/cadIcons.tsx';

// ---- Types ----

interface TimelineFeature {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
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
}

interface TimelineBarProps {
  features: TimelineFeature[];
  selectedFeatureId?: string | null;
  rollbackIndex?: number;
  onFeatureClick?: (featureId: string) => void;
  onRollbackChange?: (index: number) => void;
  /** Right-click context action on a timeline feature */
  onContextAction?: ((action: string, featureId: string) => void) | undefined;
}

// ---- Component ----

export function TimelineBar({
  features,
  selectedFeatureId,
  rollbackIndex,
  onFeatureClick,
  onRollbackChange,
  onContextAction,
}: TimelineBarProps) {
  const currentIndex = rollbackIndex ?? features.length;
  const [contextMenu, setContextMenu] = useState<{ featureId: string; featureType: string; featureEnabled: boolean; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  const handleChipContextMenu = useCallback((e: React.MouseEvent, feature: TimelineFeature) => {
    e.preventDefault();
    setContextMenu({ featureId: feature.id, featureType: feature.type, featureEnabled: feature.enabled, x: e.clientX, y: e.clientY });
  }, []);

  const handleMenuAction = useCallback((action: string) => {
    if (contextMenu && onContextAction) {
      onContextAction(action, contextMenu.featureId);
    }
    setContextMenu(null);
  }, [contextMenu, onContextAction]);

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
          disabled={currentIndex === 0}
        />
        <NavButton
          icon={<ChevronLeft size={13} />}
          label="Step back"
          onClick={handleBack}
          disabled={currentIndex === 0}
        />
        <NavButton
          icon={<ChevronRight size={13} />}
          label="Step forward"
          onClick={handleForward}
          disabled={currentIndex >= features.length}
        />
        <NavButton
          icon={<SkipForward size={12} />}
          label="To end"
          onClick={handleToEnd}
          disabled={currentIndex >= features.length}
        />
      </div>

      {/* Feature icon track */}
      <div style={styles.chipTrack}>
        {features.length === 0 && (
          <span style={styles.emptyMessage}>No features</span>
        )}

        {features.map((feature, index) => {
          const isSelected = feature.id === selectedFeatureId;
          const isPastRollback = index >= currentIndex;
          const typeColor = featureTypeColors[feature.type] ?? '#888';
          const status = feature.status ?? 'success';

          // Status-driven border + corner dot. failed / blocked override
          // the selection ring color so the user sees the problem first.
          // Matches the red-border convention ProjectTree uses (task #39)
          // and adds an orange variant for blocked. Suppressed keeps the
          // existing dimmed-opacity treatment for backward consistency.
          const statusBorderColor =
            status === 'failed' ? '#dc2626'
            : status === 'blocked' ? '#f59e0b'
            : null;

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
          tooltipLines.push('Right-click for options');

          return (
            <div key={feature.id} style={styles.chipWrapper}>
              {/* Connector line */}
              {index > 0 && (
                <div
                  style={{
                    ...styles.connector,
                    opacity: isPastRollback ? 0.2 : 0.5,
                  }}
                />
              )}

              {/* Feature icon chip — wrapped in a relatively-positioned
                  div so the status dot can absolutely-position over its
                  top-right corner without changing chip layout. */}
              <div style={styles.chipContainer}>
                <button
                  style={{
                    ...styles.chip,
                    borderColor: statusBorderColor
                      ?? (isSelected ? '#1a6fd1' : 'transparent'),
                    background: isSelected
                      ? '#e3effb'
                      : isPastRollback
                        ? '#f0f0f0'
                        : `${typeColor}15`,
                    opacity: !feature.enabled || isPastRollback ? 0.4 : 1,
                    boxShadow: isSelected ? '0 0 0 1px #1a6fd1' : 'none',
                  }}
                  onClick={() => onFeatureClick?.(feature.id)}
                  onContextMenu={(e) => handleChipContextMenu(e, feature)}
                  title={tooltipLines.join('\n')}
                  onMouseEnter={e => {
                    if (!isSelected) {
                      (e.currentTarget as HTMLButtonElement).style.background = `${typeColor}25`;
                      (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.1)';
                    }
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      isSelected ? '#e3effb' : isPastRollback ? '#f0f0f0' : `${typeColor}15`;
                    (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
                  }}
                >
                  <span style={{ color: isSelected ? '#1a6fd1' : typeColor }}>
                    {getFeatureIcon(feature.type, 14)}
                  </span>
                </button>
                {statusBorderColor !== null && (
                  <span
                    style={{
                      ...styles.statusDot,
                      background: statusBorderColor,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}

        {/* Rollback marker */}
        {currentIndex < features.length && (
          <div
            style={{
              ...styles.rollbackMarker,
              left: `${currentIndex * 40 + 16}px`,
            }}
            title={`Rollback to feature ${currentIndex}`}
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
          style={{
            position: 'fixed',
            bottom: window.innerHeight - contextMenu.y,
            left: contextMenu.x,
            background: '#fff',
            border: '1px solid #d8d8d8',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 10000,
            minWidth: 140,
            padding: '4px 0',
            fontSize: 12,
          }}
        >
          {contextMenu.featureType === 'sketch' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('editSketch')}>Edit Sketch</button>
          )}
          {contextMenu.featureType === 'sketch' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('extrude')}>Extrude</button>
          )}
          {contextMenu.featureType === 'extrude' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('editFeature')}>Edit Feature</button>
          )}
          {/* importedComponent: per-instance parameter overrides + active config
              + boolean mode. Transform is preserved untouched (a dedicated UX
              for it is not yet wired).
              Duplicate is intentionally NOT here — the timeline is a build-
              order view; duplicating lives in the ProjectTree's Components
              subsection where the inventory mental model fits. */}
          {contextMenu.featureType === 'importedComponent' && (
            <button style={menuItemStyle} onClick={() => handleMenuAction('editComponent')}>Edit Component...</button>
          )}
          {contextMenu.featureEnabled
            ? <button style={menuItemStyle} onClick={() => handleMenuAction('suppress')}>Suppress</button>
            : <button style={menuItemStyle} onClick={() => handleMenuAction('enable')}>Enable</button>
          }
          <button style={{ ...menuItemStyle, color: '#e53e3e' }} onClick={() => handleMenuAction('delete')}>Delete</button>
        </div>
      )}
    </div>
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
      onMouseEnter={e => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = '#ebebeb';
      }}
      onMouseLeave={e => {
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

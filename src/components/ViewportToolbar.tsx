/**
 * ViewportToolbar - Quick-access floating toolbar overlaid on the viewport.
 * Provides minimal controls: Home, Fit to View, Zoom In/Out.
 * Standard views are handled by the ViewCube (the 3D orientation cube).
 */

import type { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';

interface ViewportToolbarProps {
  controller: ViewportController | null;
  /**
   * Override for the Home button. When provided (e.g. while sketch mode is
   * active), it replaces the default `controller.resetView()` so Home can
   * re-snap the camera to the active sketch plane instead of the global
   * iso "home". Outside sketch mode the caller leaves this undefined and
   * the default global reset is used.
   */
  onHome?: (() => void) | undefined;
}

export function ViewportToolbar({ controller, onHome }: ViewportToolbarProps) {
  if (!controller) return null;

  return (
    <div style={styles.container}>
      <div style={styles.group}>
        <ToolbarButton
          label="Home"
          onClick={() => (onHome ? onHome() : controller.resetView())}
        >
          {/* Home icon - house shape */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 1L1 7h2v6h4v-4h2v4h4V7h2L8 1z" fill="currentColor"/>
          </svg>
        </ToolbarButton>
        <ToolbarButton
          label="Fit All"
          onClick={() => controller.fitToView()}
        >
          {/* Fit icon - expand arrows */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <rect x="5" y="5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2"/>
          </svg>
        </ToolbarButton>
        <div style={styles.separator} />
        <ToolbarButton
          label="Zoom In"
          onClick={() => controller.zoomIn()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M5 7h4M7 5v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </ToolbarButton>
        <ToolbarButton
          label="Zoom Out"
          onClick={() => controller.zoomOut()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M5 7h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </ToolbarButton>
      </div>
    </div>
  );
}

// ---- ToolbarButton sub-component ----

interface ToolbarButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function ToolbarButton({ label, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      style={styles.btn}
      onClick={onClick}
      title={label}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = '#e0e0e0';
        (e.currentTarget as HTMLButtonElement).style.color = '#222222';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        (e.currentTarget as HTMLButtonElement).style.color = '#555555';
      }}
    >
      {children}
    </button>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    pointerEvents: 'auto',
    zIndex: 10,
  },
  group: {
    display: 'flex',
    flexDirection: 'row',
    background: 'rgba(255, 255, 255, 0.9)',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(200, 200, 200, 0.7)',
    borderRadius: 6,
    padding: 2,
    gap: 1,
    boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
  },
  separator: {
    width: 1,
    background: 'rgba(200, 200, 200, 0.7)',
    margin: '4px 2px',
  },
  btn: {
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    color: '#555555',
    cursor: 'pointer',
    padding: 0,
    transition: 'background 0.15s, color 0.15s',
  },
};

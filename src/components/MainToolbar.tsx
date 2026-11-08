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

import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  Pencil,
} from 'lucide-react';
import { FinishSketchIcon } from '../icons/cadIcons.tsx';
// Logo as a Vite asset → content-hashed + base-prefixed (`/cad/assets/…` in the
// embedded build, `/assets/…` standalone). Not a root-absolute `/500.png`,
// which would 404 under /cad and couldn't cache-bust.
import logoUrl from '../assets/logo.png';

// ---- Types ----

/**
 * The toolbar is split into two visually distinct strips so they can be
 * placed independently in the layout:
 *
 *   • `MainAppBar`  — full-width title strip at the very top of the window:
 *                     logo, file operations, undo/redo, project name,
 *                     settings, sidebar-collapse toggle. Lives outside the
 *                     sidebar + viewport row.
 *   • `ToolRibbon`  — the ribbon of the current mode's tool groups. Lives
 *                     above the viewport only, so it stays aligned with the
 *                     3D canvas regardless of the sidebar's collapsed or
 *                     expanded state.
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
  /** The red badge while a build runs (`RebuildBadge`), rendering on its own as the build goes; nothing while none does. */
  rebuilding: ReactNode;
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
  /** Import a `.f3d` or `.f3z` file as a new document (replaces the active doc). */
  onImportF3d?: (() => void) | undefined;
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
  /** Export the document as a FreeCAD file. */
  onExportFreeCad?: (() => void) | undefined;
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
   * Toggle the chat panel. Absent when the site offers no AI (it can't
   * be reached, or lists no models for the caller); the wand is then
   * not shown.
   */
  onToggleChatPanel?: (() => void) | undefined;
  /** Opens revision history. Absent when the project has no cloud history. */
  onOpenHistory?: (() => void) | undefined;
}

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
  onImportF3d,
  onImportComponent,
  onImportSketchDxf,
  onImportSketchSvg,
  onSave,
  onSaveAs,
  onExport,
  onExportFreeCad,
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
      {isSaasAvailable(saas) && onToggleComponentsPanel && (
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

      <IconBtn icon={<FilePlus size={16} />} label="New (Ctrl+Alt+N)" onClick={() => onNew?.()} />
      <IconBtn icon={<FolderOpen size={16} />} label="Open (Ctrl+O)" onClick={() => onOpen?.()} />
      {(onImport || onImportFcstd || onImportF3d || onImportComponent || onImportSketchDxf || onImportSketchSvg) && (
        <ImportButton
          onImport={onImport}
          onImportFcstd={onImportFcstd}
          onImportF3d={onImportF3d}
          onImportComponent={onImportComponent}
          onImportSketchDxf={onImportSketchDxf}
          onImportSketchSvg={onImportSketchSvg}
        />
      )}
      <IconBtn icon={<Save size={16} />} label="Save (Ctrl+S)" onClick={() => onSave?.()} />
      <IconBtn icon={<FileDown size={16} />} label="Save as (Ctrl+Shift+S)" onClick={() => onSaveAs?.()} />
      {onOpenHistory && <IconBtn icon={<History size={16} />} label="Version history" onClick={onOpenHistory} />}
      <ExportButton onExport={onExport} onExportFreeCad={onExportFreeCad} />

      <div style={styles.separator} />

      <IconBtn
        icon={<Undo2 size={16} />}
        label={undoLabel ? `Undo: ${undoLabel}` : 'Nothing to undo'}
        onClick={onUndo}
        disabled={!canUndo}
      />
      <IconBtn
        icon={<Redo2 size={16} />}
        label={redoLabel ? `Redo: ${redoLabel}` : 'Nothing to redo'}
        onClick={onRedo}
        disabled={!canRedo}
      />

      <div style={{ flex: 1 }} />

      {rebuilding}
      <ProjectNameField name={projectName} onRename={onRenameProject} />

      <div style={styles.separator} />
      {/* Wand only shows when the site offers AI — local-only use has
          no in-app chat panel (the MCP bridge covers that). */}
      {onToggleChatPanel && (
        <IconBtn
          icon={<Wand2 size={16} />}
          label={chatPanelOpen ? 'Close AI assistant' : 'AI assistant'}
          onClick={onToggleChatPanel}
          active={chatPanelOpen}
        />
      )}
      <AccountChip saas={saas} onRequestSignIn={onRequestSignIn} onSignOut={onSignOut} />
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
function ProjectNameField({ name, onRename }: { name: string; onRename?: ((next: string) => void) | undefined }) {
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
    if (!editable) {
      return (
        <span style={styles.projectName} title={name}>
          {name}
        </span>
      );
    }
    // A bordered field with a pencil, not bare text: the previous version's
    // only affordance was a `title` tooltip saying "double-click to
    // rename", which nobody hovers a label to discover. Single click —
    // double-click was the undiscoverable half.
    return (
      <button
        type="button"
        style={projectNameStyles.readButton}
        title={`Rename "${name}"`}
        aria-label={`Project name: ${name}. Click to rename.`}
        onClick={() => setEditing(true)}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = '#a8cef0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = '#e2e2e2';
        }}
      >
        <span style={projectNameStyles.readLabel}>{name}</span>
        <Pencil size={10} strokeWidth={1.75} color="#999" aria-hidden="true" />
      </button>
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
  /** Read mode. Matches the input's metrics so clicking doesn't shift the row. */
  readButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    maxWidth: 260,
    fontSize: 12,
    color: '#555',
    background: 'transparent',
    border: '1px solid #e2e2e2',
    borderRadius: 4,
    padding: '2px 6px',
    marginRight: 4,
    cursor: 'text',
    font: 'inherit',
    lineHeight: 'inherit',
  },
  readLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
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
    status.state === 'connected'
      ? '#22c55e' // green
      : status.state === 'connecting'
        ? '#eab308' // yellow
        : '#ef4444'; // red (error)

  const label =
    status.state === 'connecting'
      ? `AI bridge: connecting to ${status.url}`
      : status.state === 'connected'
        ? `AI bridge: connected (${status.url})`
        : `AI bridge: error: ${status.message}`;

  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} style={bridgeDotStyles.btn}>
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

  const initials =
    saas.user.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') ||
    saas.user.email[0]?.toUpperCase() ||
    '?';

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

// ---- Tool Ribbon ----

/** One ribbon button of a {@link ToolRibbon}. */
export interface RibbonTool {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string | undefined;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Shown as a button; the others are in the group's menu only. */
  primary?: boolean | undefined;
  /** The tool's text in the group's menu, when it differs from the button's. */
  menuLabel?: string | undefined;
  onClick: () => void;
}

/** A labelled group of a {@link ToolRibbon}. */
export interface RibbonToolGroup {
  label: string;
  tools: RibbonTool[];
  /** Lists every tool in the group's menu even when all are buttons. */
  menu?: boolean | undefined;
}

/** Widths the ribbon lays its groups out by: every tool button is the same size. */
export const RIBBON_METRICS = {
  /** A tool button's width. */
  button: 60,
  /** The gap between two buttons of a group. */
  gap: 1,
  /** A group's padding and divider. */
  chrome: 13,
  /** The narrowest a group's body gets, so its label stays readable. */
  minBody: 72,
} as const;

/** The width a group takes showing `shown` of its buttons. */
export function ribbonGroupWidth(shown: number): number {
  const { button, gap, chrome, minBody } = RIBBON_METRICS;
  return Math.max(minBody, shown * (button + gap) - gap) + chrome;
}

/**
 * How many of its buttons each group shows in `width` pixels. Every group
 * shows all its buttons when they fit; otherwise buttons move into the
 * group menus one at a time, each from the group showing the most (the
 * rightmost of equals), and every group keeps at least one. A function of
 * the width alone, so a ribbon that widens again shows its buttons again.
 */
export function ribbonFit(counts: readonly number[], width: number): number[] {
  const shown = [...counts];
  const total = () => shown.reduce((sum, n) => sum + ribbonGroupWidth(n), 0);
  while (total() > width) {
    let widest = -1;
    for (let i = 0; i < shown.length; i++) {
      const n = shown[i] as number;
      if (n > 1 && (widest < 0 || n >= (shown[widest] as number))) widest = i;
    }
    if (widest < 0) break;
    shown[widest] = (shown[widest] as number) - 1;
  }
  return shown;
}

/**
 * The group menu open after a press or a move over the page while `open`
 * is: a press on another group's label opens that group, a press on the
 * open group's label or anywhere else closes it, and moving onto another
 * group's label switches to it, as a menu bar does.
 */
export function nextOpenGroup(open: string | null, under: string | null, event: 'press' | 'move'): string | null {
  if (event === 'move') return open !== null && under !== null ? under : open;
  return under !== null && under !== open ? under : null;
}

/** A group menu's place on screen, under its label. */
interface MenuAnchor {
  left: number;
  top: number;
  width: number;
}

/** The group label under a screen point, through the backdrop an open menu lays over the page. */
function groupLabelAt(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el instanceof HTMLElement && el.dataset.ribbonGroup !== undefined) return el;
  }
  return null;
}

/**
 * A ribbon built from a list of tool groups, in the same look as the
 * modelling ribbon, with an optional Finish button at the right end.
 * Groups with no tools are left out.
 */
export function ToolRibbon({
  groups,
  onFinish,
  finishLabel = 'Finish',
}: {
  groups: RibbonToolGroup[];
  onFinish?: (() => void) | undefined;
  finishLabel?: string | undefined;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const finishRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [open, setOpen] = useState<{ label: string; anchor: MenuAnchor } | null>(null);
  const [toolbox, setToolbox] = useState<{ x: number; y: number } | null>(null);
  const pointer = useRef({ x: 200, y: 160 });
  const hasFinish = onFinish !== undefined;
  const hasTools = groups.some((g) => g.tools.length > 0);

  // S opens the toolbox at the pointer.
  useEffect(() => {
    if (!hasTools) return;
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    const onKey = (e: KeyboardEvent) => {
      if (!opensToolbox(e)) return;
      e.preventDefault();
      setOpen(null);
      setToolbox({ ...pointer.current });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [hasTools]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = (): void => {
      const style = getComputedStyle(row);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      setWidth(row.clientWidth - padding - (finishRef.current?.offsetWidth ?? 0));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    measure();
    return () => ro.disconnect();
  }, [hasFinish]);

  const shownGroups = groups.filter((g) => g.tools.length > 0);
  const primaryOf = (group: RibbonToolGroup) => group.tools.filter((t) => t.primary !== false);
  const counts = shownGroups.map((g) => primaryOf(g).length);
  const fit = width === null ? counts : ribbonFit(counts, width);

  const openLabel = (label: string | null) => {
    if (label === null) {
      setOpen(null);
      return;
    }
    const trigger = rowRef.current?.querySelector<HTMLElement>(`[data-ribbon-group="${CSS.escape(label)}"]`);
    const rect = trigger?.getBoundingClientRect();
    setOpen(rect ? { label, anchor: { left: rect.left, top: rect.bottom, width: rect.width } } : null);
  };
  const onBackdrop = (e: React.PointerEvent, event: 'press' | 'move') => {
    const under = groupLabelAt(e.clientX, e.clientY)?.dataset.ribbonGroup ?? null;
    const next = nextOpenGroup(open?.label ?? null, under, event);
    if (next !== (open?.label ?? null)) openLabel(next);
  };

  return (
    <div ref={rowRef} style={styles.ribbonRow}>
      {shownGroups.map((group, index) => {
        const primary = primaryOf(group);
        const menu: MenuItem[] | undefined =
          group.menu || primary.length < group.tools.length
            ? group.tools.map((t) => ({
                id: t.id,
                label: t.menuLabel ?? t.label,
                shortcut: t.shortcut,
                icon: t.icon,
                ...(t.disabled !== undefined ? { disabled: t.disabled } : {}),
                ...(t.active !== undefined ? { active: t.active } : {}),
                onClick: t.onClick,
              }))
            : undefined;
        return (
          <RibbonGroupView
            key={group.label}
            label={group.label}
            visible={fit[index] ?? primary.length}
            anchor={open?.label === group.label ? open.anchor : null}
            onToggle={() => openLabel(open?.label === group.label ? null : group.label)}
            onClose={() => setOpen(null)}
            {...(menu ? { menu } : {})}
          >
            {primary.map((t) => (
              <RibbonBtn
                key={t.id}
                icon={t.icon}
                label={t.label}
                shortcut={t.shortcut}
                active={t.active}
                disabled={t.disabled}
                onClick={t.onClick}
              />
            ))}
          </RibbonGroupView>
        );
      })}
      {open && (
        // Covers the page while a menu is open, so a press elsewhere only
        // closes it; a press on another group's label, or a move onto it,
        // opens that group's menu.
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 199 }}
          onPointerDown={(e) => onBackdrop(e, 'press')}
          onPointerMove={(e) => onBackdrop(e, 'move')}
        />
      )}
      {toolbox && <Toolbox groups={groups} at={toolbox} onClose={() => setToolbox(null)} />}
      {onFinish && (
        <>
          <div style={{ flex: 1 }} />
          <div ref={finishRef} style={styles.finishWrap}>
            <button
              type="button"
              style={styles.finishBtn}
              onClick={onFinish}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#f1fdf5';
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#15803d';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#ffffff';
                (e.currentTarget as HTMLButtonElement).style.borderColor = '#16a34a';
              }}
              title={`${finishLabel} (Esc)`}
            >
              <FinishSketchIcon size={26} color="#16a34a" />
              <span style={styles.finishLabel}>{finishLabel}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Toolbox ----

/** A tool the toolbox offers, with the group it is in. */
export interface ToolboxEntry {
  tool: RibbonTool;
  group: string;
}

/**
 * The tools the toolbox lists for a typed `query`: every enabled tool of
 * the ribbon, those whose name starts with the query first, then those
 * with a word starting with it, then those holding it anywhere; all of
 * them, in ribbon order, for an empty query.
 */
export function toolboxMatches(groups: readonly RibbonToolGroup[], query: string): ToolboxEntry[] {
  const all = groups.flatMap((g) => g.tools.filter((t) => !t.disabled).map((tool) => ({ tool, group: g.label })));
  const q = query.trim().toLowerCase();
  if (q === '') return all;
  const rank = (e: ToolboxEntry): number => {
    const names = [e.tool.label, e.tool.menuLabel ?? ''].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) return 0;
    if (names.some((n) => n.split(/[\s/-]+/).some((w) => w.startsWith(q)))) return 1;
    if (names.some((n) => n.includes(q))) return 2;
    return 3;
  };
  return all
    .map((e, i) => ({ e, i, r: rank(e) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e);
}

/** True for the key that opens the toolbox: a bare S. */
export function opensToolbox(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'defaultPrevented'> & {
    target: EventTarget | null;
  },
): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
  if (e.key !== 's' && e.key !== 'S') return false;
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = el?.tagName?.toUpperCase();
  return !(el?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');
}

/**
 * The toolbox: a search box at the pointer listing the ribbon's tools as
 * they are typed. Enter or a click runs the highlighted tool, the arrows
 * move the highlight, and Escape or a click elsewhere closes it.
 */
function Toolbox({
  groups,
  at,
  onClose,
}: {
  groups: readonly RibbonToolGroup[];
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const matches = toolboxMatches(groups, query).slice(0, 12);
  const highlighted = Math.min(index, Math.max(0, matches.length - 1));
  const run = (entry: ToolboxEntry | undefined) => {
    if (!entry) return;
    onClose();
    entry.tool.onClick();
  };
  const width = 260;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 360));
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 299 }} onPointerDown={onClose} />
      <div
        role="dialog"
        aria-label="Toolbox"
        style={{ ...styles.dropdown, position: 'fixed', left, top, width, zIndex: 300 }}
      >
        <input
          autoFocus
          type="text"
          value={query}
          placeholder="Search tools"
          aria-label="Search tools"
          style={styles.toolboxInput}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(matches[highlighted]);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex(Math.min(highlighted + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex(Math.max(highlighted - 1, 0));
            }
          }}
        />
        {matches.length === 0 && <div style={styles.toolboxEmpty}>No tool matches</div>}
        {matches.map((entry, i) => (
          <button
            key={`${entry.group}|${entry.tool.id}`}
            type="button"
            style={{
              ...styles.dropdownItem,
              background: i === highlighted ? '#e3effb' : 'transparent',
              color: '#333',
              cursor: 'pointer',
            }}
            onMouseEnter={() => setIndex(i)}
            onClick={() => run(entry)}
          >
            <span style={styles.dropdownIcon}>{entry.tool.icon}</span>
            <span style={styles.dropdownLabel}>{entry.tool.menuLabel ?? entry.tool.label}</span>
            <span style={styles.toolboxGroup}>{entry.group}</span>
            {entry.tool.shortcut && <span style={styles.dropdownShortcut}>{entry.tool.shortcut}</span>}
          </button>
        ))}
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

function RibbonGroupView({
  label,
  children,
  menu,
  visible,
  anchor,
  onToggle,
  onClose,
}: {
  label: string;
  children: React.ReactNode;
  /** When present, the label becomes a clickable dropdown trigger. */
  menu?: MenuItem[];
  /** How many of the buttons show; the rest are in the group's menu. */
  visible: number;
  /** Where the group's menu shows, or null while it is closed. */
  anchor: MenuAnchor | null;
  onToggle: () => void;
  onClose: () => void;
}) {
  const items = Children.toArray(children);
  const collapsedCount = Math.max(0, items.length - visible);
  // A group with buttons moved out of the row always has a menu, even when
  // no explicit one was passed in.
  const hasMenu = !!menu || collapsedCount > 0;

  return (
    <div style={styles.ribbonGroup}>
      <div style={styles.ribbonGroupBody}>
        {items.map((child, i) => (
          // Keyed by index: the children are flat tool buttons, not a keyed list.
          <div key={i} style={{ display: i < visible ? 'inline-flex' : 'none', flexShrink: 0 }}>
            {child}
          </div>
        ))}
      </div>
      {hasMenu ? (
        <button
          type="button"
          data-ribbon-group={label}
          style={{
            ...styles.ribbonGroupLabelButton,
            // Hint that items collapsed into the dropdown — a clear brand-blue
            // (with a touch more weight) so the group reads as interactive, not
            // disabled.
            ...(collapsedCount > 0 ? { color: '#3b82f6', fontWeight: 600 } : {}),
          }}
          onClick={onToggle}
          title={
            collapsedCount > 0
              ? `${label} (${collapsedCount} more hidden, click to see all)`
              : `Show all ${label.toLowerCase()} tools`
          }
        >
          {label} <ChevronDown size={10} style={{ marginLeft: 2, verticalAlign: 'middle' }} />
        </button>
      ) : (
        <div style={styles.ribbonGroupLabel}>{label}</div>
      )}

      {anchor && (
        // Dropdown rendered in fixed coords so the ribbon's overflow does NOT
        // clip it. Anchored just under the group label, above the backdrop.
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
              onClickCapture={onClose}
            >
              {children}
            </div>
          ) : (
            menu.map((item) => (
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
                  onClose();
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
            ))
          )}
        </div>
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
  const baseBg = primary ? (active ? '#16a34a' : '#22c55e') : active ? '#e3effb' : 'transparent';
  const hoverBg = primary ? '#16a34a' : active ? '#d4e6f9' : '#ebebeb';
  const bg = disabled ? 'transparent' : hover ? hoverBg : baseBg;
  const color = primary ? '#fff' : active ? '#1a6fd1' : '#444';
  const borderColor = primary ? (active ? '#15803d' : '#16a34a') : active ? '#a8cef0' : 'transparent';

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
 * STEP / STL / BREP body geometry, a FreeCAD `.fcstd` document, a `.f3d`
 * document, and
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
  onImportF3d,
  onImportComponent,
  onImportSketchDxf,
  onImportSketchSvg,
}: {
  onImport?: ((format?: 'step' | 'stl' | 'brep') => void) | undefined;
  onImportFcstd?: (() => void) | undefined;
  onImportF3d?: (() => void) | undefined;
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

  function pickF3d() {
    if (!onImportF3d) return;
    setOpen(false);
    onImportF3d();
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
        onClick={() => setOpen((v) => !v)}
        title="Import (Component / STEP / STL / BREP / FreeCAD / .f3d / DXF / SVG)"
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
          {onImportComponent && (
            <ExportMenuItem
              label="Import Component..."
              sub=".cadcomponent / .cadjson · embed as a parametric instance"
              onClick={pickComponent}
            />
          )}
          {onImport && (
            <>
              <ExportMenuItem
                label="Import STEP..."
                sub=".step / .stp · precise solid geometry"
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
            </>
          )}
          {onImportFcstd && (
            <ExportMenuItem
              label="Import FreeCAD..."
              sub=".FCStd · PartDesign Bodies and their features → opens as a new document"
              onClick={pickFcstd}
            />
          )}
          {onImportF3d && (
            <ExportMenuItem
              label="Import .f3d..."
              sub=".f3d / .f3z · sketches and their features → opens as a new document"
              onClick={pickF3d}
            />
          )}
          {onImportSketchDxf && (
            <ExportMenuItem
              label="Import DXF (sketch)..."
              sub=".dxf · 2D curves → new sketch on a chosen plane"
              onClick={pickSketchDxf}
            />
          )}
          {onImportSketchSvg && (
            <ExportMenuItem
              label="Import SVG (sketch, experimental)..."
              sub=".svg · small files only · large/detailed art may be slow or rejected"
              onClick={pickSketchSvg}
            />
          )}
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
  onExportFreeCad,
}: {
  onExport?: ((format: 'stl' | 'step' | 'brep' | '3mf') => void) | undefined;
  onExportFreeCad?: (() => void) | undefined;
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
        title={busy ? `Exporting ${busy.toUpperCase()}...` : 'Export (STL / STEP / BREP / 3MF / FreeCAD)'}
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
          <ExportMenuItem label="Export STL..." sub=".stl · 3D printing" onClick={() => pick('stl')} />
          <ExportMenuItem
            label="Export STEP..."
            sub=".step · parametric CAD interchange"
            onClick={() => pick('step')}
          />
          <ExportMenuItem label="Export BREP..." sub=".brep · OpenCASCADE native B-Rep" onClick={() => pick('brep')} />
          <ExportMenuItem label="Export 3MF..." sub=".3mf · modern slicer format" onClick={() => pick('3mf')} />
          {onExportFreeCad && (
            <ExportMenuItem
              label="Export FreeCAD..."
              sub=".FCStd · parametric feature tree"
              onClick={() => {
                setOpen(false);
                onExportFreeCad();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ExportMenuItem({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
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
  const bg = active ? (hover ? '#d4e6f9' : '#e3effb') : hover && !disabled ? '#ebebeb' : 'transparent';
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

/** The red badge saying what the build in progress is doing. */
export function RebuildBadge({ text }: { text: string }) {
  return (
    <span style={styles.rebuildBadge} title={text}>
      {text}
    </span>
  );
}

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
    // No horizontal scrollbar: `ribbonFit` moves trailing buttons into
    // their group's dropdown when space is tight.
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
    // Sized by the buttons it shows (`ribbonFit`); minWidth keeps the
    // label readable when it shows one.
    flexShrink: 0,
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
  toolboxInput: {
    width: '100%',
    boxSizing: 'border-box',
    height: 28,
    padding: '0 8px',
    marginBottom: 4,
    border: '1px solid #a8cef0',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'inherit',
    outline: 'none',
  },
  toolboxEmpty: {
    fontSize: 12,
    color: '#999',
    padding: '6px 10px',
  },
  toolboxGroup: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.6,
    color: '#999',
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
    fontSize: 11,
    fontWeight: 700,
    color: '#ffffff',
    background: '#d32f2f',
    padding: '2px 8px',
    borderRadius: 10,
    letterSpacing: 0.3,
    marginRight: 8,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 420,
    fontVariantNumeric: 'tabular-nums',
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

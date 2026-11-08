/**
 * App-level Settings dialog.
 *
 * Native `<dialog>` modal (same pattern as ParametersDialog) with a
 * vertical tab nav on the left and a content pane on the right. v1
 * ships ONE tab — AI — covering the local MCP bridge connection. The
 * structure is intentionally tab-friendly: adding Display / Account /
 * Storage tabs is one entry in TAB_DEFS + one render branch.
 *
 * Writes go straight to the localStorage-backed appSettings store via
 * `setAppSettings`. No Apply/Revert button — the MCP bridge settings
 * are observable in-place (toggling the checkbox flips the bridge-
 * client's connection state on the next render) so debounced
 * commit-on-blur feels right; an explicit Apply would add ceremony
 * without payoff. Future tabs with risky settings (e.g. "wipe local
 * storage") can opt into a confirm step.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Sparkles } from 'lucide-react';
import { setAppSettings } from '../storage/appSettings.ts';
import { useAppSettings } from '../hooks/useAppSettings.ts';

type TabId = 'ai';

const TAB_DEFS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'ai', label: 'AI', icon: <Sparkles size={14} /> },
];

// ---- Dialog component ----

type DialogProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsDialog({ open, onClose }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('ai');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Reset to the AI tab when re-opening so the user always lands on the
  // most-likely-needed pane.
  //
  // Adjusted during render rather than in an effect: an effect would paint
  // the stale tab first and then immediately re-render with the right one.
  // This is react.dev's "adjusting state when a prop changes" pattern —
  // React discards the in-progress render and retries with the new state
  // before touching the DOM, so there's no visible intermediate frame.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setActiveTab('ai');
  }

  const onDialogClick = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      // Click on the backdrop (the dialog element itself, not its
      // children) closes the modal — matches the rest of the app.
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const onDialogCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      onClose();
    },
    [onClose],
  );

  return (
    <dialog ref={ref} onClick={onDialogClick} onCancel={onDialogCancel} style={styles.dialog}>
      <div style={styles.body}>
        <div style={styles.header}>
          <h2 style={styles.title}>Settings</h2>
          <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div style={styles.layout}>
          {/* Tab nav */}
          <nav style={styles.tabNav} aria-label="Settings sections">
            {TAB_DEFS.map((tab) => (
              <TabButton
                key={tab.id}
                label={tab.label}
                icon={tab.icon}
                active={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
          </nav>

          {/* Content pane */}
          <div style={styles.pane}>{activeTab === 'ai' && <AiTab />}</div>
        </div>
      </div>
    </dialog>
  );
}

// ---- AI tab ----

function AiTab() {
  const settings = useAppSettings();
  const ai = settings.ai;

  // Port input uses a local draft string so the user can clear / re-type
  // without intermediate values being committed. Valid integers commit
  // immediately on change (no blur dance — commit-on-change is friendlier
  // for settings and avoids React-event-dispatch edge cases we hit when
  // bridging dispatched synthetic events through the SyntheticEvent
  // wrapper).
  const [portDraft, setPortDraft] = useState(String(ai.bridgePort));

  // Re-sync the draft if the store changes from outside (e.g. another
  // tab in the same browser, or a settings reset). Adjusted during render
  // for the same reason as the tab reset above — an effect would show the
  // stale port for one frame.
  const [lastBridgePort, setLastBridgePort] = useState(ai.bridgePort);
  if (ai.bridgePort !== lastBridgePort) {
    setLastBridgePort(ai.bridgePort);
    setPortDraft(String(ai.bridgePort));
  }

  const onPortChange = useCallback((raw: string) => {
    setPortDraft(raw);
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      setAppSettings({ ai: { bridgePort: n } });
    }
    // Invalid (e.g. mid-edit "" or "abc") → draft updates but the store
    // keeps the last valid value. No reset; the user can fix the typo
    // without losing focus.
  }, []);

  return (
    <div style={styles.tabContent}>
      <h3 style={styles.sectionTitle}>Local AI Bridge (MCP)</h3>
      <p style={styles.sectionLead}>
        Connect this CAD app to any <strong>MCP-capable AI assistant</strong> (Claude Desktop, Claude Code, Cursor,
        Codex, VS Code...) via a local bridge process. The assistant can then inspect and modify your project through
        the same commands the human UI uses.
      </p>

      {/* Toggle uses a sibling label (htmlFor) rather than a wrapping
          label so a programmatic click on the input doesn't bubble to
          a containing label and re-fire the label's activation behavior
          (which would toggle the checkbox a second time, undoing the
          first toggle). Clicking the label text still works via the
          for/id association. */}
      <div style={styles.toggleRow}>
        <input
          id="bridge-enabled"
          type="checkbox"
          checked={ai.bridgeEnabled}
          onChange={(e) => setAppSettings({ ai: { bridgeEnabled: e.target.checked } })}
          style={styles.checkbox}
        />
        <label htmlFor="bridge-enabled" style={styles.toggleLabel}>
          Enable AI bridge
        </label>
        <span style={styles.toggleHint}>When enabled, the app probes the WebSocket address below on startup.</span>
      </div>

      <div style={styles.fieldGrid}>
        <label style={styles.fieldLabel} htmlFor="bridge-host">
          Host
        </label>
        <input
          id="bridge-host"
          type="text"
          value={ai.bridgeHost}
          onChange={(e) => setAppSettings({ ai: { bridgeHost: e.target.value } })}
          disabled={!ai.bridgeEnabled}
          style={{ ...styles.input, ...(ai.bridgeEnabled ? {} : styles.inputDisabled) }}
        />

        <label style={styles.fieldLabel} htmlFor="bridge-port">
          Port
        </label>
        <input
          id="bridge-port"
          type="number"
          value={portDraft}
          onChange={(e) => onPortChange(e.target.value)}
          disabled={!ai.bridgeEnabled}
          min={1}
          max={65535}
          style={{ ...styles.input, ...(ai.bridgeEnabled ? {} : styles.inputDisabled) }}
        />
      </div>

      <div style={styles.helpBox}>
        <div style={styles.helpTitle}>Quick start</div>
        <ol style={styles.helpList}>
          <li>
            In a terminal, run:&nbsp;
            <code style={styles.code}>npx @tweakcad/mcp-bridge --port {ai.bridgePort}</code>
          </li>
          <li>Enable the toggle above.</li>
          <li>
            Register the bridge in your assistant's MCP server config (see the bridge's README for client-specific
            snippets: Claude Desktop, Cursor, VS Code, etc.).
          </li>
        </ol>
        <div style={styles.helpFootnote}>
          The bridge holds no state; it relays tool calls between the assistant and this tab. If the tab closes, the
          assistant will see a "no active session" error until you re-open the app.
        </div>
      </div>
    </div>
  );
}

// ---- Imperative hook (matches useParametersEditor pattern) ----

export function useSettingsDialog(): { open: () => void; element: React.ReactElement } {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const onClose = useCallback(() => setIsOpen(false), []);
  const element = <SettingsDialog open={isOpen} onClose={onClose} />;
  return { open, element };
}

// ---- Sub-components ----

function TabButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const bg = active ? '#e3effb' : hover ? '#f0f0f0' : 'transparent';
  const color = active ? '#1a6fd1' : '#444';
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...styles.tabBtn, background: bg, color }}
    >
      <span style={styles.tabBtnIcon}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  dialog: {
    inset: 0,
    margin: 'auto',
    width: 'min(96vw, 720px)',
    maxHeight: '85vh',
    padding: 0,
    border: 'none',
    borderRadius: 10,
    boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
    background: '#ffffff',
    color: '#333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  body: {
    padding: '16px 18px 18px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: '#222',
  },
  closeBtn: {
    width: 26,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    borderRadius: 4,
  },
  layout: {
    display: 'flex',
    gap: 14,
    minHeight: 320,
  },
  tabNav: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 130,
    borderRight: '1px solid #eee',
    paddingRight: 8,
  },
  tabBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    border: '1px solid transparent',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 500,
    textAlign: 'left',
  },
  tabBtnIcon: {
    display: 'inline-flex',
    alignItems: 'center',
  },
  pane: {
    flex: 1,
    minWidth: 0,
    overflow: 'auto',
  },
  tabContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 13,
    fontWeight: 600,
    color: '#222',
  },
  sectionLead: {
    margin: 0,
    fontSize: 12,
    color: '#555',
    lineHeight: 1.5,
  },
  toggleRow: {
    display: 'grid',
    gridTemplateColumns: 'auto auto 1fr',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    background: '#f7f7f7',
    border: '1px solid #e8e8e8',
    borderRadius: 6,
    cursor: 'pointer',
  },
  checkbox: {
    width: 14,
    height: 14,
    cursor: 'pointer',
  },
  toggleLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: '#222',
  },
  toggleHint: {
    fontSize: 11,
    color: '#888',
    justifySelf: 'end',
    textAlign: 'right',
  },
  fieldGrid: {
    display: 'grid',
    gridTemplateColumns: '80px 1fr',
    gap: '8px 12px',
    alignItems: 'center',
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: '#444',
  },
  input: {
    padding: '5px 8px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    borderRadius: 4,
    fontFamily: 'inherit',
    background: '#fff',
    color: '#222',
  },
  inputDisabled: {
    background: '#f5f5f5',
    color: '#999',
    cursor: 'not-allowed',
  },
  helpBox: {
    padding: '10px 12px',
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  helpTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#666',
  },
  helpList: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 12,
    color: '#333',
    lineHeight: 1.6,
  },
  code: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 11,
    background: '#eef0f2',
    padding: '1px 5px',
    borderRadius: 3,
    color: '#1f2937',
  },
  helpFootnote: {
    fontSize: 11,
    color: '#777',
    fontStyle: 'italic',
  },
};

/**
 * The pieces feature panels are made of, in the extrude panel's look: a
 * floating card over the viewport, labelled rows, expression fields with
 * their unit, toggle groups, lists of picked references, check boxes, and Cancel / OK.
 *
 * Every panel is one width (a `wide` one holds a table), and a panel taller
 * than the viewport scrolls under Cancel and OK, which stay in view. Enter
 * anywhere in a panel is OK, except on a button of its own (Cancel, OK, a
 * remove cross) and where a field took it already.
 */
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader.tsx';
import { distinctLabels } from './pickLabels';

/** The width of a feature panel, in CSS pixels; the extrude panel's. */
export const PANEL_WIDTH = 280;
/** The width of a panel that holds a table (a component's parameters). */
export const WIDE_PANEL_WIDTH = 440;

/** Whether Enter pressed on `target` in a panel is the panel's OK: not on a plain button, a text area, or where a handler took it. */
export function enterIsOk(target: EventTarget | null, handled: boolean): boolean {
  if (handled) return false;
  const at = target as Pick<Element, 'closest'> | null;
  if (typeof at?.closest !== 'function') return true;
  if (at.closest('textarea')) return false;
  const button = at.closest('button');
  // A toggle button (one of a group, pressed or not) is a choice, not an action.
  return !button || button.hasAttribute('aria-pressed');
}

export function PanelCard({
  title,
  icon,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div style={styles.overlay}>
      <div
        style={{ ...styles.panel, width: wide ? WIDE_PANEL_WIDTH : PANEL_WIDTH }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || !enterIsOk(e.target, e.defaultPrevented)) return;
          e.preventDefault();
          const ok = e.currentTarget.querySelector<HTMLButtonElement>('button[data-panel-ok]');
          if (ok && !ok.disabled) ok.click();
        }}
      >
        <PanelHeader title={title} icon={icon} onClose={onClose} closeTitle="Cancel (Esc)" />
        {children}
      </div>
    </div>
  );
}

/** A labelled row; `note` is the expression its value comes from, shown under the label. */
export function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: string | null }) {
  return (
    <div style={styles.row}>
      <span style={styles.label}>
        {label}
        <BoundNote text={note} under />
      </span>
      {children}
    </div>
  );
}

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>{label}</div>
      {children}
    </div>
  );
}

/** A text field for an expression, with its unit beside it; Enter confirms. */
export function ExprField({
  label,
  value,
  onChange,
  onEnter,
  unit,
  invalid,
  autoFocus,
  placeholder,
  width = 80,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  onEnter?: () => void;
  unit?: string;
  invalid?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  width?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    ref.current?.select();
  }, [autoFocus]);
  return (
    <Row label={label}>
      <div style={styles.inputGroup}>
        <input
          ref={ref}
          type="text"
          aria-label={label}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) {
              e.preventDefault();
              onEnter();
            }
          }}
          style={{ ...styles.input, width, borderColor: invalid ? '#dc2626' : '#d0d0d0' }}
        />
        {unit !== undefined && <span style={styles.unit}>{unit}</span>}
      </div>
    </Row>
  );
}

/** Three fields under one label, each marked X, Y and Z and sharing the panel's width, with one unit after them; Enter confirms. */
export function XyzRow({
  label,
  values,
  onChange,
  onEnter,
  unit,
  title,
}: {
  label: string;
  values: readonly [string, string, string];
  onChange: (index: number, text: string) => void;
  onEnter?: () => void;
  unit?: string;
  title?: string;
}) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel} title={title}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <span key={axis} style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 10, color: '#999', fontWeight: 600 }}>{axis}</span>
            <input
              type="text"
              aria-label={`${label} ${axis}`}
              value={values[i]}
              onChange={(e) => onChange(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && onEnter) {
                  e.preventDefault();
                  onEnter();
                }
              }}
              style={{ ...styles.input, width: '100%', padding: '0 5px', fontSize: 12 }}
            />
          </span>
        ))}
        {unit !== undefined && <span style={styles.unit}>{unit}</span>}
      </div>
    </div>
  );
}

export interface ToggleOption<T extends string> {
  id: T;
  label: string;
  title?: string;
}

/** A row of buttons of which one is on. */
export function Toggles<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly ToggleOption<T>[];
  onChange: (id: T) => void;
}) {
  return (
    <div style={styles.toggleGroup}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            title={o.title ?? o.label}
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            style={{
              ...styles.toggleBtn,
              background: active ? '#e3effb' : '#f7f7f7',
              color: active ? '#1a6fd1' : '#666',
              borderColor: active ? '#a8cef0' : '#e0e0e0',
              fontWeight: active ? 600 : 400,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The expression a field's value comes from, beside the field or `under` its label: `= thread`. */
export function BoundNote({ text, under = false }: { text: string | null | undefined; under?: boolean }) {
  if (!text) return null;
  return (
    <span style={under ? styles.boundUnder : styles.bound} title={`= ${text}`}>
      = {text}
    </span>
  );
}

/** A labelled toggle group; `bound` is the expression its value comes from. */
export function ToggleRow<T extends string>({
  label,
  value,
  options,
  onChange,
  bound,
}: {
  label: string;
  value: T;
  options: readonly ToggleOption<T>[];
  onChange: (id: T) => void;
  bound?: string | null;
}) {
  return (
    <Row label={label} note={bound ?? null}>
      <Toggles value={value} options={options} onChange={onChange} />
    </Row>
  );
}

/** A dropdown; a value that is not among the options shows as one of its own. `bound` is the expression its value comes from. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  bound,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (id: T) => void;
  bound?: string | null;
}) {
  const listed = options.some((o) => o.id === value)
    ? options
    : [{ id: value, label: value === '' ? '?' : value }, ...options];
  return (
    <Row label={label}>
      <div style={styles.inputGroup}>
        <BoundNote text={bound} />
        <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} style={styles.select}>
          {listed.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </Row>
  );
}

/** A check box; `bound` is the expression its value comes from. */
export function Check({
  label,
  checked,
  onChange,
  bound,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  bound?: string | null;
}) {
  return (
    <label style={styles.checkboxRow}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      <BoundNote text={bound} />
    </label>
  );
}

/**
 * A list of picked references. Clicking the list arms it, so the next
 * viewport clicks add to it; each row has a remove button.
 */
export function PickList({
  label,
  items,
  armed,
  onArm,
  onRemove,
  empty,
  single,
  count,
}: {
  label: string;
  items: readonly { label: string; missing?: boolean }[];
  armed: boolean;
  onArm?: () => void;
  onRemove: (index: number) => void;
  empty: string;
  /** One pick only: shown as a slot rather than a numbered list. */
  single?: boolean;
  /** What the heading counts, where that is more than the number of items. */
  count?: string;
}) {
  const shownLabels = distinctLabels(items.map((item) => item.label));
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>
        {label}
        {!single && items.length > 0 ? ` (${count ?? items.length})` : ''}
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={armed}
        style={{
          ...styles.pickBox,
          borderColor: armed ? '#a8cef0' : '#eee',
          background: armed ? '#f0f7fe' : '#fafafa',
        }}
        onClick={onArm}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && onArm) {
            e.preventDefault();
            onArm();
          }
        }}
      >
        {items.length === 0 && <div style={styles.emptyHint}>{empty}</div>}
        {items.map((item, i) => (
          <div key={`${i}|${item.label}`} style={styles.pickRow}>
            {!single && <span style={styles.pickIndex}>{i + 1}</span>}
            <span style={item.missing ? { ...styles.pickLabel, color: MISSING_COLOR } : styles.pickLabel}>
              {shownLabels[i]}
            </span>
            <button
              type="button"
              style={styles.pickRemove}
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(i);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  return message ? <div style={styles.error}>{message}</div> : null;
}

export function Note({ message }: { message: string | null }) {
  return message ? <div style={styles.note}>{message}</div> : null;
}

/**
 * Cancel and OK. With `blocked` (why the input is not valid yet) OK is
 * disabled and its tooltip says why; otherwise the tooltip is `okTitle`.
 */
export function Actions({
  onCancel,
  onOk,
  okLabel = 'OK',
  blocked = null,
  okTitle,
}: {
  onCancel: () => void;
  onOk: () => void;
  okLabel?: string;
  blocked?: string | null;
  okTitle?: string | undefined;
}) {
  const enabled = blocked === null;
  return (
    <div style={styles.actions}>
      <button
        type="button"
        style={styles.cancelBtn}
        onClick={onCancel}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#eee';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = '#f5f5f5';
        }}
      >
        Cancel
      </button>
      <button
        type="button"
        data-panel-ok=""
        style={{ ...styles.okBtn, opacity: enabled ? 1 : 0.5, cursor: enabled ? 'pointer' : 'not-allowed' }}
        onClick={onOk}
        disabled={!enabled}
        title={enabled ? okTitle : blocked}
        onMouseEnter={(e) => {
          if (enabled) e.currentTarget.style.background = '#1557a0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = '#1a6fd1';
        }}
      >
        {okLabel}
      </button>
    </div>
  );
}

/** The colour of a stored pick that lands on nothing. */
export const MISSING_COLOR = '#dc2626';

export const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 50,
    pointerEvents: 'auto',
    maxHeight: 'calc(100% - 24px)',
    display: 'flex',
  },
  panel: {
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    padding: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', gap: 8 },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    flexShrink: 0,
    minWidth: 56,
  },
  section: { padding: '8px 12px', borderBottom: '1px solid #f0f0f0' },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  inputGroup: { display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' },
  input: {
    height: 28,
    padding: '0 8px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    fontSize: 13,
    fontFamily: 'monospace',
    color: '#333',
    outline: 'none',
    textAlign: 'right',
    transition: 'border-color 0.15s',
    minWidth: 0,
  },
  select: {
    height: 28,
    padding: '0 6px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    fontSize: 12,
    color: '#333',
    background: '#fff',
    width: '100%',
    minWidth: 0,
  },
  unit: { fontSize: 11, color: '#999', fontWeight: 500, minWidth: 18 },
  bound: {
    fontSize: 11,
    color: '#1a6fd1',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 90,
    flexShrink: 0,
  },
  boundUnder: {
    display: 'block',
    fontSize: 10,
    fontWeight: 400,
    color: '#1a6fd1',
    fontFamily: 'monospace',
    textTransform: 'none',
    letterSpacing: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 90,
  },
  error: { fontSize: 11, color: '#dc2626', padding: '0 12px 4px' },
  note: { fontSize: 11, color: '#b45309', padding: '0 12px 4px' },
  toggleGroup: { display: 'flex', gap: 2, flex: 1, justifyContent: 'flex-end', flexWrap: 'wrap' },
  toggleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    height: 26,
    padding: '0 7px',
    border: '1px solid #e0e0e0',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
    transition: 'background 0.1s, color 0.1s',
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: '#555',
    padding: '6px 12px',
    cursor: 'pointer',
  },
  pickBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minHeight: 26,
    maxHeight: 140,
    overflowY: 'auto',
    padding: '3px 6px',
    border: '1px solid #eee',
    borderRadius: 4,
    cursor: 'pointer',
  },
  emptyHint: { fontSize: 11, color: '#aaa', fontStyle: 'italic', padding: '3px 0' },
  pickRow: { display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 },
  pickIndex: { fontSize: 10, color: '#999', minWidth: 14, textAlign: 'right' },
  pickLabel: {
    flex: 1,
    fontSize: 12,
    color: '#333',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pickRemove: {
    width: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: '#888',
    cursor: 'pointer',
    borderRadius: 3,
    padding: 0,
  },
  actions: {
    display: 'flex',
    gap: 8,
    padding: '8px 12px 12px',
    justifyContent: 'flex-end',
    borderTop: '1px solid #e8e8e8',
    position: 'sticky',
    bottom: 0,
    background: '#fff',
    zIndex: 1,
  },
  cancelBtn: {
    height: 30,
    padding: '0 14px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    background: '#f5f5f5',
    color: '#555',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    transition: 'background 0.1s',
  },
  okBtn: {
    height: 30,
    padding: '0 20px',
    border: 'none',
    borderRadius: 5,
    background: '#1a6fd1',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    transition: 'background 0.1s',
  },
};

/**
 * The card at the top of the viewport while a sketch tool takes options or
 * clicks: what the tool asks for next, and its fields (polygon sides, the
 * fillet radius). Offset has a dialog: its direction (one side, two sides,
 * symmetric), its distances, Flip, and OK and Cancel; the curve clicked is
 * previewed with its copies until OK. The text tool has its own panel with a
 * header and close button, its string (focused as it opens), font and height;
 * Escape there closes it back to Select and Enter leaves the field. Editing
 * existing text, the font list shows its own font (by name when the tool does
 * not offer it), and a font picked there is written once it loads. A field
 * takes effect as it is typed, when it reads as a positive number. Keys stop
 * here, so typing never reaches the sketch's shortcuts.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowLeftRight, Type } from 'lucide-react';
import { PanelHeader } from '../components/PanelHeader.tsx';
import { enqueueToast } from '../components/toastStore.ts';
import type { SketchSession, SketchSessionState, ToolSettings } from './session';
import { SKETCH_FONTS, loadSketchFont, type SketchFontId } from './text';

export interface ToolOptionsProps {
  session: SketchSession;
}

/** A field's text as a positive number, or null. */
export function positiveNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^[+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type Field = { key: 'sides' | 'offset' | 'offset2' | 'fillet'; label: string; unit: string; integer?: boolean };

const FIELDS: Partial<Record<string, Field>> = {
  polygon: { key: 'sides', label: 'Sides', unit: '', integer: true },
  polygonCircumscribed: { key: 'sides', label: 'Sides', unit: '', integer: true },
  polygonEdge: { key: 'sides', label: 'Sides', unit: '', integer: true },
  fillet: { key: 'fillet', label: 'Radius', unit: 'mm' },
};

const DIRECTIONS: { id: ToolSettings['offsetDirection']; label: string }[] = [
  { id: 'one', label: 'One side' },
  { id: 'two', label: 'Two sides' },
  { id: 'symmetric', label: 'Symmetric' },
];

export function ToolOptions({ session }: ToolOptionsProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const field = state.tool ? FIELDS[state.tool] : undefined;
  const text = state.tool === 'text';
  if (!state.open || (!state.prompt && !field && !text && state.tool !== 'offset')) return null;
  if (text) return <TextPanel session={session} state={state} />;
  if (state.tool === 'offset') return <OffsetPanel session={session} state={state} />;
  return (
    <div
      style={styles.wrap}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div style={styles.card}>
        {state.prompt && <div style={styles.prompt}>{state.prompt}</div>}
        {state.message && (
          <div style={styles.message} role="alert">
            {state.message}
          </div>
        )}
        {field && <NumberField key={state.tool} session={session} state={state} field={field} />}
      </div>
    </div>
  );
}

function TextPanel({ session, state }: { session: SketchSession; state: SketchSessionState }) {
  const close = () => session.setTool('select');
  return (
    <div
      style={styles.wrap}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        else if (e.key === 'Enter') (e.target as HTMLElement).blur();
      }}
    >
      <div style={styles.panel} data-testid="sketch-text-panel">
        <PanelHeader title="Text" icon={<Type size={13} color="#0164D4" />} onClose={close} />
        <div style={styles.body}>
          {state.prompt && <div style={styles.prompt}>{state.prompt}</div>}
          {state.message && (
            <div style={styles.message} role="alert">
              {state.message}
            </div>
          )}
          <TextFields key={state.text.editing ?? 'new'} session={session} state={state} />
        </div>
      </div>
    </div>
  );
}

function OffsetPanel({ session, state }: { session: SketchSession; state: SketchSessionState }) {
  const close = () => session.setTool('select');
  const direction = state.settings.offsetDirection;
  const picked = state.offsetCurve !== null;
  return (
    <div
      style={styles.wrap}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        else if (e.key === 'Enter') {
          (e.target as HTMLElement).blur();
          if (picked) session.confirmOffset();
        }
      }}
    >
      <div style={styles.panel} data-testid="sketch-offset-panel">
        <PanelHeader title="Offset" icon={<ArrowLeftRight size={13} color="#0164D4" />} onClose={close} />
        <div style={styles.body}>
          {state.prompt && <div style={styles.prompt}>{state.prompt}</div>}
          {state.message && (
            <div style={styles.message} role="alert">
              {state.message}
            </div>
          )}
          <label style={styles.row}>
            <span style={styles.label}>Direction</span>
            <select
              aria-label="Direction"
              style={{ ...styles.input, ...styles.wide }}
              value={direction}
              onChange={(e) =>
                session.setSettings({ offsetDirection: e.target.value as ToolSettings['offsetDirection'] })
              }
            >
              {DIRECTIONS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            session={session}
            state={state}
            field={{ key: 'offset', label: direction === 'two' ? 'Distance 1' : 'Distance', unit: 'mm' }}
          />
          {direction === 'two' && (
            <NumberField session={session} state={state} field={{ key: 'offset2', label: 'Distance 2', unit: 'mm' }} />
          )}
          <div style={styles.buttons}>
            <button
              type="button"
              style={{ ...styles.button, ...(picked ? {} : styles.off) }}
              disabled={!picked}
              onClick={() => session.flipOffset()}
            >
              Flip
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={{ ...styles.button, ...styles.primary, ...(picked ? {} : styles.off) }}
              disabled={!picked}
              onClick={() => session.confirmOffset()}
            >
              OK
            </button>
            <button type="button" style={styles.button} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NumberField({ session, state, field }: { session: SketchSession; state: SketchSessionState; field: Field }) {
  const [value, setValue] = useState(String(state.settings[field.key]));
  const parsed = positiveNumber(value);
  const valid = parsed !== null && (!field.integer || (Number.isInteger(parsed) && parsed >= 3));
  return (
    <label style={styles.row}>
      <span style={styles.label}>{field.label}</span>
      <input
        aria-label={field.label}
        style={{ ...styles.input, borderColor: valid ? '#3b82f6' : '#dc2626' }}
        value={value}
        inputMode="decimal"
        onChange={(e) => {
          setValue(e.target.value);
          const n = positiveNumber(e.target.value);
          if (n !== null && (!field.integer || (Number.isInteger(n) && n >= 3)))
            session.setSettings({ [field.key]: n });
        }}
        onBlur={() => setValue(String(session.getState().settings[field.key]))}
      />
      {field.unit && <span style={styles.unit}>{field.unit}</span>}
    </label>
  );
}

function TextFields({ session, state }: { session: SketchSession; state: SketchSessionState }) {
  const options = state.text;
  const [height, setHeight] = useState(String(options.size));
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Loads the chosen font; a stale load (the font changed again first) is dropped.
  useEffect(() => {
    let cancelled = false;
    session.setTextFont(null);
    loadSketchFont(options.font).then(
      (font) => {
        if (!cancelled) session.setTextFont(font);
      },
      (e: unknown) => {
        if (!cancelled)
          enqueueToast({
            tone: 'warning',
            title: 'Font not loaded',
            message: e instanceof Error ? e.message : String(e),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, options.font]);

  const commit = () => {
    if (options.editing) session.updateText();
  };
  return (
    <>
      <label style={styles.row}>
        <span style={styles.label}>Text</span>
        <input
          ref={input}
          aria-label="Text"
          style={{ ...styles.input, ...styles.wide }}
          value={options.string}
          spellCheck={false}
          onChange={(e) => session.setTextOptions({ string: e.target.value })}
          onBlur={commit}
        />
      </label>
      <label style={styles.row}>
        <span style={styles.label}>Font</span>
        <select
          aria-label="Font"
          style={{ ...styles.input, ...styles.wide }}
          value={options.heldFont === null ? options.font : ''}
          onChange={(e) => {
            if (e.target.value !== '') session.setTextOptions({ font: e.target.value as SketchFontId });
          }}
        >
          {options.heldFont !== null && <option value="">{options.heldFont}</option>}
          {SKETCH_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label style={styles.row}>
        <span style={styles.label}>Height</span>
        <input
          aria-label="Height"
          style={{ ...styles.input, borderColor: positiveNumber(height) !== null ? '#d0d0d0' : '#dc2626' }}
          value={height}
          inputMode="decimal"
          onChange={(e) => {
            setHeight(e.target.value);
            const n = positiveNumber(e.target.value);
            if (n !== null) session.setTextOptions({ size: n });
          }}
          onBlur={commit}
        />
        <span style={styles.unit}>mm</span>
      </label>
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 50,
    pointerEvents: 'auto',
  },
  card: {
    background: '#fff',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 12,
    color: '#333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  panel: {
    background: '#fff',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    width: 280,
    overflow: 'hidden',
    fontSize: 12,
    color: '#333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  body: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' },
  wide: { flex: 1, minWidth: 0, width: 'auto' },
  prompt: { fontSize: 12, color: '#555' },
  message: { fontSize: 11, color: '#b91c1c', maxWidth: 260 },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { width: 52, fontSize: 12, color: '#666' },
  input: {
    width: 70,
    height: 26,
    padding: '0 8px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#d0d0d0',
    borderRadius: 5,
    fontSize: 13,
    color: '#222',
    background: '#fff',
    outline: 'none',
  },
  unit: { fontSize: 12, color: '#888' },
  buttons: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
  button: {
    height: 26,
    padding: '0 12px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#d0d0d0',
    borderRadius: 5,
    background: '#fff',
    color: '#333',
    fontSize: 12,
    cursor: 'pointer',
  },
  primary: { background: '#0164D4', borderColor: '#0164D4', color: '#fff' },
  off: { opacity: 0.45, cursor: 'default' },
};

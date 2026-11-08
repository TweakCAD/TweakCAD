/**
 * The labels of the sketch's dimensions as HTML over the viewport, placed
 * every frame through `project` (part coordinates to pixels in the
 * overlay), so they follow the camera. Clicking a label edits its value's
 * expression; Enter writes it through the session, Escape leaves it. Which
 * label is open is the session's, so a dimension just placed opens by itself.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { fieldText } from './dimensions';
import type { SketchLabel } from './host';
import type { SketchSession } from './session';

/** Where a part-coordinate point shows in the overlay, or null when it is behind the camera. */
export type Projection = (at: [number, number, number]) => { x: number; y: number } | null;

export interface DimensionLabelsProps {
  session: SketchSession;
  project: Projection;
}

export function DimensionLabels({ session, project }: DimensionLabelsProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const labels = state.open ? session.labels() : [];
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const latest = useRef({ labels, project });
  useLayoutEffect(() => {
    latest.current = { labels, project };
  });

  // Follow the camera every frame.
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      for (const label of latest.current.labels) {
        const node = nodes.current.get(label.id);
        if (!node) continue;
        const at = latest.current.project(label.at);
        node.style.display = at ? '' : 'none';
        if (at) node.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div style={styles.overlay}>
      {labels.map((label) => (
        <div
          key={label.id}
          ref={(node) => {
            if (node) nodes.current.set(label.id, node);
            else nodes.current.delete(label.id);
          }}
          style={styles.anchor}
        >
          {state.editing === label.id ? (
            <LabelEditor label={label} session={session} onClose={() => session.clearEditing()} />
          ) : (
            <button
              type="button"
              {...(label.text.startsWith('(') ? { title: 'Driven dimension (reported, not enforced)' } : {})}
              style={{
                ...styles.label,
                ...(label.text.startsWith('(') ? styles.labelDriven : {}),
                ...(state.selection.includes(label.id) ? styles.labelSelected : {}),
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                session.select([label.id]);
                if (!label.text.startsWith('(')) session.editDimension(label.id);
              }}
            >
              {label.text}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function LabelEditor({ label, session, onClose }: { label: SketchLabel; session: SketchSession; onClose: () => void }) {
  const [text, setText] = useState(() => fieldText(label.expression, label.unit));
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const commit = () => {
    const result = session.setDimension(label.id, text);
    if (result.ok) onClose();
    else setError(result.error.message);
  };

  return (
    <div style={styles.inputWrap} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <input
        ref={input}
        type="text"
        value={text}
        spellCheck={false}
        aria-label="Dimension value"
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') onClose();
        }}
        onBlur={onClose}
        style={styles.input}
      />
      <span style={styles.unit}>{label.unit}</span>
      {error && (
        <div style={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  overlay: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6, overflow: 'hidden' },
  anchor: { position: 'absolute', top: 0, left: 0, pointerEvents: 'auto' },
  label: {
    padding: '2px 6px',
    background: 'rgba(255, 255, 255, 0.92)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: '#d1d5db',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
    color: '#1f2937',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    cursor: 'text',
  },
  labelDriven: {
    color: '#9ca3af',
    fontStyle: 'italic',
    background: 'rgba(243, 244, 246, 0.85)',
    borderColor: '#e5e7eb',
    cursor: 'default',
  },
  labelSelected: { borderColor: '#f59e0b', background: '#fffbeb' },
  inputWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    background: '#fff',
    border: '1.5px solid #3b82f6',
    borderRadius: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    padding: '2px 4px',
  },
  input: {
    width: 110,
    padding: '2px 4px',
    border: 'none',
    outline: 'none',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    background: 'transparent',
    color: '#111',
  },
  unit: { fontSize: 10, color: '#6b7280', paddingRight: 4 },
  error: { flexBasis: '100%', fontSize: 10, color: '#b91c1c', padding: '2px 4px', maxWidth: 180, whiteSpace: 'normal' },
};

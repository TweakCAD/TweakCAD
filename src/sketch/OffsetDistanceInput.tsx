/**
 * OffsetDistanceInput — distance field shown while the sketch Offset tool is
 * active, pinned to the top of the viewport.
 *
 * Every valid keystroke updates the tool's distance, so the next edge click
 * uses what is typed without pressing Enter. A value that is not a positive
 * number is flagged and never applied; on blur the field shows the distance
 * the tool will actually use. Key events stop here so digits and Backspace
 * don't reach the sketch editor's shortcuts (Backspace deletes the selection).
 */

import { useRef, useState } from 'react';
import { getOffsetDistance, setOffsetDistance } from './sketchTools.ts';

/** Parse the field's text; null unless it is a finite number above zero. */
export function parseOffsetDistance(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^[+]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function OffsetDistanceInput() {
  const [text, setText] = useState(() => String(getOffsetDistance()));
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = parseOffsetDistance(text) !== null;

  return (
    <div
      style={styles.wrap}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label htmlFor="sketch-offset-distance" style={styles.label}>Offset</label>
      <div style={{ ...styles.field, borderColor: valid ? '#3b82f6' : '#dc2626' }}>
        <input
          id="sketch-offset-distance"
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={text}
          aria-invalid={!valid}
          title={valid ? 'Offset distance' : 'Distance must be greater than zero'}
          onChange={(e) => {
            setText(e.target.value);
            const n = parseOffsetDistance(e.target.value);
            if (n !== null) setOffsetDistance(n);
          }}
          onFocus={(e) => e.target.select()}
          onBlur={() => setText(String(getOffsetDistance()))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') inputRef.current?.blur();
            e.stopPropagation();
          }}
          style={styles.input}
        />
        <span style={styles.unit}>mm</span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 7,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    background: 'rgba(255, 255, 255, 0.95)',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    pointerEvents: 'auto',
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: '#374151',
    userSelect: 'none',
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    background: '#fff',
    border: '1.5px solid #3b82f6',
    borderRadius: 4,
    padding: '2px 4px',
    gap: 4,
  },
  input: {
    width: 56,
    padding: '2px 4px',
    border: 'none',
    outline: 'none',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    background: 'transparent',
    color: '#111',
  },
  unit: {
    fontSize: 10,
    color: '#6b7280',
    paddingRight: 4,
  },
};

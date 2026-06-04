/**
 * RevolveDialog - Inline panel overlay on the viewport for the revolve operation.
 *
 * Mirrors ExtrudeDialog's control-panel approach: appears as a floating
 * card on top of the 3D viewport, with angle input, axis selector, and
 * operation type (New Body / Join / Cut).
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { RevolveIcon } from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

// ---- Types ----

export type RevolveAxis = 'x' | 'y' | 'z';
export type RevolveOperation = 'newBody' | 'join' | 'cut';

export interface RevolveDialogResult {
  /** Sweep angle in degrees (1..360). */
  angle: number;
  /** Axis of revolution. */
  axis: RevolveAxis;
  /** Boolean op against existing bodies. */
  operation: RevolveOperation;
  /** Offset along the profile normal before revolving. */
  startOffset: number;
}

export interface RevolveDialogInitialValues {
  angle?: number;
  axis?: RevolveAxis;
  operation?: RevolveOperation;
  startOffset?: number;
}

interface RevolveDialogProps {
  sketchName: string;
  profileCount?: number | undefined;
  initialValues?: RevolveDialogInitialValues | undefined;
  onConfirm: (result: RevolveDialogResult) => void;
  onCancel: () => void;
}

// ---- Component ----

export function RevolveDialog({
  sketchName,
  profileCount = 1,
  initialValues,
  onConfirm,
  onCancel,
}: RevolveDialogProps) {
  const [angle, setAngle] = useState(String(initialValues?.angle ?? 360));
  const [axis, setAxis] = useState<RevolveAxis>(initialValues?.axis ?? 'z');
  const [operation, setOperation] = useState<RevolveOperation>(initialValues?.operation ?? 'newBody');
  const [startOffset, setStartOffset] = useState(String(initialValues?.startOffset ?? 0));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const validate = useCallback((val: string): number | null => {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0 || num > 360) return null;
    return num;
  }, []);

  const handleConfirm = useCallback(() => {
    const num = validate(angle);
    if (num === null) {
      setError('Enter an angle between 0 and 360°');
      return;
    }
    const parsedOffset = Number(startOffset);
    onConfirm({
      angle: num,
      axis,
      operation,
      startOffset: Number.isFinite(parsedOffset) ? parsedOffset : 0,
    });
  }, [angle, axis, operation, startOffset, onConfirm, validate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  }, [handleConfirm]);

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Revolve" icon={<RevolveIcon size={14} color="#ec4899" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        <div style={styles.row}>
          <span style={styles.label}>Profile</span>
          <span style={styles.sourceValue}>
            {profileCount > 1 ? `${profileCount} profiles from ${sketchName}` : sketchName}
          </span>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Angle</span>
          <div style={styles.inputGroup}>
            <input
              ref={inputRef}
              type="text"
              value={angle}
              onChange={e => { setAngle(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              style={{
                ...styles.input,
                borderColor: error ? '#dc2626' : '#d0d0d0',
              }}
              placeholder="360"
            />
            <span style={styles.unit}>°</span>
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.row}>
          <span style={styles.label}>Axis</span>
          <div style={styles.toggleGroup}>
            <ToggleButton active={axis === 'x'} onClick={() => setAxis('x')} label="X" />
            <ToggleButton active={axis === 'y'} onClick={() => setAxis('y')} label="Y" />
            <ToggleButton active={axis === 'z'} onClick={() => setAxis('z')} label="Z" />
          </div>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Offset</span>
          <div style={styles.inputGroup}>
            <input
              type="text"
              value={startOffset}
              onChange={e => setStartOffset(e.target.value)}
              onKeyDown={handleKeyDown}
              style={styles.input}
              placeholder="0"
            />
            <span style={styles.unit}>mm</span>
          </div>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Op</span>
          <div style={styles.toggleGroup}>
            <ToggleButton active={operation === 'newBody'} onClick={() => setOperation('newBody')} label="New" />
            <ToggleButton active={operation === 'join'} onClick={() => setOperation('join')} label="Join" />
            <ToggleButton active={operation === 'cut'} onClick={() => setOperation('cut')} label="Cut" />
          </div>
        </div>

        <div style={styles.actions}>
          <button
            style={styles.cancelBtn}
            onClick={onCancel}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#eee'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f5f5f5'; }}
          >
            Cancel
          </button>
          <button
            style={styles.okBtn}
            onClick={handleConfirm}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#be185d'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#ec4899'; }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Sub-components ----

function ToggleButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      style={{
        ...styles.toggleBtn,
        background: active ? '#fdf2f8' : '#f7f7f7',
        color: active ? '#be185d' : '#666',
        borderColor: active ? '#f9a8d4' : '#e0e0e0',
        fontWeight: active ? 600 : 400,
      }}
      onClick={onClick}
      title={label}
      onMouseEnter={e => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = '#ebebeb';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = active ? '#fdf2f8' : '#f7f7f7';
      }}
    >
      {label}
    </button>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 50,
    pointerEvents: 'auto',
  },
  panel: {
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    width: 280,
    padding: 0,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderBottom: '1px solid #e8e8e8',
    background: '#fafafa',
  },
  headerTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: '#333',
  },
  closeBtn: {
    width: 24,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 4,
    color: '#888',
    cursor: 'pointer',
    padding: 0,
    transition: 'background 0.1s',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    gap: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    flexShrink: 0,
    minWidth: 56,
  },
  sourceValue: {
    fontSize: 12,
    color: '#ec4899',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  inputGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flex: 1,
    justifyContent: 'flex-end',
  },
  input: {
    width: 80,
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
  },
  unit: {
    fontSize: 11,
    color: '#999',
    fontWeight: 500,
  },
  error: {
    fontSize: 11,
    color: '#dc2626',
    padding: '0 12px 4px',
  },
  toggleGroup: {
    display: 'flex',
    gap: 2,
    flex: 1,
    justifyContent: 'flex-end',
  },
  toggleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 26,
    padding: '0 10px',
    border: '1px solid #e0e0e0',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 400,
    color: '#666',
    background: '#f7f7f7',
    transition: 'background 0.1s, color 0.1s',
    whiteSpace: 'nowrap',
  },
  actions: {
    display: 'flex',
    gap: 8,
    padding: '8px 12px 12px',
    justifyContent: 'flex-end',
    borderTop: '1px solid #e8e8e8',
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
    background: '#ec4899',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    transition: 'background 0.1s',
  },
};

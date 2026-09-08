/**
 * PatternDialog — inline overlay for Linear and Circular body patterns.
 *
 * One dialog with a top tab (Linear / Circular) acting as a
 * "Pattern Type" selector. The two modes share the source body picker
 * and instance-count input; direction/axis + spacing inputs differ:
 *
 *  - Linear:    direction (X/Y/Z) + spacing (mm).
 *  - Circular:  axis (X/Y/Z) + count distributes over a full revolve.
 *               (Partial sweep angle is deferred until the kernel grows
 *               a partial-sweep variant; the builder warns + clamps.)
 *
 * Source body is filled in by the Shell when the user clicks any body
 * in the viewport (pickMode = 'body' while this dialog is open).
 * Single-body v1 mirrors MirrorDialog's body picker exactly.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { PatternIcon } from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

export interface PatternDialogPickedBody {
  bodyId: string;
  label: string;
}

export type PatternKind = 'linear' | 'circular';
export type PatternAxis = 'x' | 'y' | 'z';

export interface PatternDialogResult {
  kind: PatternKind;
  /** Axis for circular, direction for linear. v1 = world X/Y/Z. */
  axis: PatternAxis;
  count: number;
  /** Spacing in mm (linear only — ignored for circular). */
  spacing: number;
}

interface PatternDialogProps {
  pickedBody: PatternDialogPickedBody | null;
  onClearBody: () => void;
  initialValues?: Partial<PatternDialogResult> | undefined;
  onConfirm: (result: PatternDialogResult) => void;
  onCancel: () => void;
}

export function PatternDialog({
  pickedBody,
  onClearBody,
  initialValues,
  onConfirm,
  onCancel,
}: PatternDialogProps) {
  const [kind, setKind] = useState<PatternKind>(initialValues?.kind ?? 'linear');
  const [axis, setAxis] = useState<PatternAxis>(initialValues?.axis ?? 'x');
  const [count, setCount] = useState(String(initialValues?.count ?? 3));
  const [spacing, setSpacing] = useState(String(initialValues?.spacing ?? 20));
  const [error, setError] = useState<string | null>(null);
  const countInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    countInputRef.current?.focus();
    countInputRef.current?.select();
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const validatedCount = (() => {
    const n = parseInt(count, 10);
    if (isNaN(n) || n < 1) return null;
    return n;
  })();
  const validatedSpacing = (() => {
    const n = parseFloat(spacing);
    if (isNaN(n) || n <= 0) return null;
    return n;
  })();

  const handleConfirm = useCallback(() => {
    if (!pickedBody) { setError('Pick a body to pattern'); return; }
    if (validatedCount === null) { setError('Count must be a positive integer'); return; }
    if (kind === 'linear' && validatedSpacing === null) {
      setError('Spacing must be positive'); return;
    }
    onConfirm({
      kind,
      axis,
      count: validatedCount,
      // Spacing is ignored for circular but the result type requires
      // it; pass the validated value (or 0 if validation didn't run
      // for circular).
      spacing: validatedSpacing ?? 0,
    });
  }, [pickedBody, kind, axis, validatedCount, validatedSpacing, onConfirm]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
  }, [handleConfirm]);

  const canConfirm =
    pickedBody !== null &&
    validatedCount !== null &&
    (kind === 'circular' || validatedSpacing !== null);

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader title="Pattern" icon={<PatternIcon size={14} color="#eab308" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        {/* Kind tab strip — Linear / Circular. */}
        <div style={styles.tabStrip}>
          <button
            type="button"
            onClick={() => setKind('linear')}
            style={{
              ...styles.tabBtn,
              ...(kind === 'linear' ? styles.tabBtnActive : {}),
            }}
          >
            Linear
          </button>
          <button
            type="button"
            onClick={() => setKind('circular')}
            style={{
              ...styles.tabBtn,
              ...(kind === 'circular' ? styles.tabBtnActive : {}),
            }}
          >
            Circular
          </button>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Source Body</div>
          {pickedBody ? (
            <div style={styles.bodyRow}>
              <span style={styles.bodyDot} />
              <span style={styles.bodyLabel}>{pickedBody.label}</span>
              <button
                type="button"
                style={styles.bodyRemove}
                onClick={onClearBody}
                title="Clear body"
                onMouseEnter={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#dc2626'; }}
                onMouseLeave={ev => { (ev.currentTarget as HTMLButtonElement).style.color = '#888'; }}
              >
                <X size={11} />
              </button>
            </div>
          ) : (
            <div style={styles.emptyHint}>Click a body in the viewport...</div>
          )}
        </div>

        <div style={styles.section}>
          <div style={styles.sectionLabel}>
            {kind === 'linear' ? 'Direction' : 'Axis'}
          </div>
          <div style={styles.axisRow}>
            {(['x', 'y', 'z'] as PatternAxis[]).map(a => (
              <button
                key={a}
                type="button"
                onClick={() => setAxis(a)}
                style={{
                  ...styles.axisBtn,
                  background: axis === a ? '#eab308' : '#f5f5f5',
                  color: axis === a ? '#fff' : '#555',
                  borderColor: axis === a ? '#eab308' : '#d0d0d0',
                }}
              >
                {a.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Count</span>
          <div style={styles.inputGroup}>
            <input
              ref={countInputRef}
              type="text"
              value={count}
              onChange={e => { setCount(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              style={{
                ...styles.input,
                borderColor: error && validatedCount === null ? '#dc2626' : '#d0d0d0',
              }}
              placeholder="3"
            />
          </div>
        </div>

        {kind === 'linear' && (
          <div style={styles.row}>
            <span style={styles.label}>Spacing</span>
            <div style={styles.inputGroup}>
              <input
                type="text"
                value={spacing}
                onChange={e => { setSpacing(e.target.value); setError(null); }}
                onKeyDown={handleKeyDown}
                style={{
                  ...styles.input,
                  borderColor: error && validatedSpacing === null ? '#dc2626' : '#d0d0d0',
                }}
                placeholder="20"
              />
              <span style={styles.unit}>mm</span>
            </div>
          </div>
        )}

        {error && <div style={styles.error}>{error}</div>}

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
            style={{
              ...styles.okBtn,
              opacity: canConfirm ? 1 : 0.5,
              cursor: canConfirm ? 'pointer' : 'not-allowed',
            }}
            onClick={handleConfirm}
            disabled={!canConfirm}
            onMouseEnter={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#ca8a04';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#eab308';
            }}
            title={canConfirm ? 'Apply pattern' : 'Pick a body, set count > 0, and (linear) spacing > 0'}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', top: 12, right: 12, zIndex: 50, pointerEvents: 'auto' },
  panel: {
    background: '#fff', border: '1px solid #d0d0d0', borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)', width: 300, padding: 0, overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px', borderBottom: '1px solid #e8e8e8', background: '#fafafa',
  },
  headerTitle: { flex: 1, fontSize: 13, fontWeight: 600, color: '#333' },
  closeBtn: {
    width: 24, height: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', borderRadius: 4,
    color: '#888', cursor: 'pointer', padding: 0,
    transition: 'background 0.1s',
  },
  tabStrip: {
    display: 'flex', borderBottom: '1px solid #e8e8e8',
  },
  tabBtn: {
    flex: 1, padding: '8px 12px',
    border: 'none', borderBottom: '2px solid transparent',
    background: 'transparent', color: '#666',
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    transition: 'background 0.1s, color 0.1s, border-color 0.1s',
  },
  tabBtnActive: {
    color: '#eab308', borderBottomColor: '#eab308',
    background: '#fffbeb',
  },
  section: { padding: '10px 12px', borderBottom: '1px solid #f0f0f0' },
  sectionLabel: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6,
  },
  emptyHint: { fontSize: 11, color: '#aaa', fontStyle: 'italic', padding: '4px 0' },
  bodyRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 8px',
    background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4,
  },
  bodyDot: { width: 8, height: 8, borderRadius: '50%', background: '#eab308' },
  bodyLabel: {
    flex: 1, fontSize: 12, color: '#333',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  bodyRemove: {
    width: 18, height: 18,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: '#888',
    cursor: 'pointer', borderRadius: 3, padding: 0, transition: 'color 0.1s',
  },
  axisRow: { display: 'flex', gap: 6 },
  axisBtn: {
    flex: 1, height: 28, padding: '0 12px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    transition: 'background 0.1s, color 0.1s, border-color 0.1s',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', gap: 8 },
  label: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3,
    flexShrink: 0, minWidth: 64,
  },
  inputGroup: { display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' },
  input: {
    width: 80, height: 28,
    padding: '0 8px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 13, fontFamily: 'monospace', color: '#333',
    outline: 'none', textAlign: 'right',
    transition: 'border-color 0.15s',
  },
  unit: { fontSize: 11, color: '#999', fontWeight: 500 },
  error: { fontSize: 11, color: '#dc2626', padding: '0 12px 4px' },
  actions: {
    display: 'flex', gap: 8,
    padding: '8px 12px 12px',
    justifyContent: 'flex-end', borderTop: '1px solid #e8e8e8',
  },
  cancelBtn: {
    height: 30, padding: '0 14px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    background: '#f5f5f5', color: '#555',
    cursor: 'pointer', fontSize: 12, fontWeight: 500,
    transition: 'background 0.1s',
  },
  okBtn: {
    height: 30, padding: '0 20px',
    border: 'none', borderRadius: 5,
    background: '#eab308', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

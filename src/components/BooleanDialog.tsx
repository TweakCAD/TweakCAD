/**
 * BooleanDialog — combine bodies that already exist.
 *
 * Distinct from the `operation` toggle on Extrude and Primitive, which only
 * applies while a shape is being created. This is for two bodies that are
 * both already there: two imports, two primitives, an extrude and a
 * component.
 *
 * The target is singled out rather than being "the first one you picked"
 * because it is the body whose identity survives — references captured
 * against it keep working, and the tools are consumed. That is worth one
 * explicit choice rather than a rule the user has to infer.
 *
 * Visual + interaction style matches {@link PrimitiveDialog}.
 */

import { useState, useEffect, useCallback } from 'react';
import { PanelHeader } from './PanelHeader.tsx';
import { CutIcon, FuseIcon } from '../icons/cadIcons.tsx';

export type BooleanOperation = 'union' | 'subtract' | 'intersect';

/** A body the user can pick. */
export interface BooleanAvailableBody {
  /** Stringified BodyId — the dialog stays string-typed. */
  id: string;
  label: string;
}

export interface BooleanDialogResult {
  operation: BooleanOperation;
  targetBodyId: string;
  toolBodyIds: string[];
}

interface BooleanDialogProps {
  /** Operation the clicked ribbon entry stands for; changeable in-dialog. */
  operation: BooleanOperation;
  availableBodies: BooleanAvailableBody[];
  onConfirm: (result: BooleanDialogResult) => void;
  onCancel: () => void;
}

const LABELS: Record<BooleanOperation, { title: string; verb: string; hint: string }> = {
  union: {
    title: 'Combine',
    verb: 'Combine',
    hint: 'The tools are fused into the target; the result keeps the target.',
  },
  subtract: {
    title: 'Cut',
    verb: 'Cut',
    hint: 'The tools are removed from the target.',
  },
  intersect: {
    title: 'Intersect',
    verb: 'Intersect',
    hint: 'Only the volume shared by the target and the tools is kept.',
  },
};

export function BooleanDialog({
  operation: initialOperation,
  availableBodies,
  onConfirm,
  onCancel,
}: BooleanDialogProps) {
  const [operation, setOperation] = useState<BooleanOperation>(initialOperation);
  const [targetBodyId, setTargetBodyId] = useState(availableBodies[0]?.id ?? '');
  const [toolBodyIds, setToolBodyIds] = useState<string[]>([]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Picking a body as the target drops it from the tools: a body combined
  // with itself is a no-op, and leaving it checked would look deliberate.
  const chooseTarget = useCallback((id: string) => {
    setTargetBodyId(id);
    setToolBodyIds(prev => prev.filter(t => t !== id));
  }, []);

  const toggleTool = useCallback((id: string) => {
    setToolBodyIds(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id]);
  }, []);

  const tools = availableBodies.filter(b => b.id !== targetBodyId);
  const canConfirm = targetBodyId !== '' && toolBodyIds.length > 0;
  const labels = LABELS[operation];

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader
          title={labels.title}
          icon={operation === 'subtract'
            ? <CutIcon size={14} color="#ef4444" />
            : <FuseIcon size={14} color="#8b5cf6" />}
          onClose={onCancel}
          closeTitle="Cancel (Esc)"
        />

        <div style={styles.row}>
          <span style={styles.label}>Op</span>
          <div style={styles.toggleGroup}>
            {(['union', 'subtract', 'intersect'] as const).map(op => (
              <ToggleButton
                key={op}
                active={operation === op}
                onClick={() => setOperation(op)}
                label={LABELS[op].title}
              />
            ))}
          </div>
        </div>
        <div style={styles.hint}>{labels.hint}</div>

        {availableBodies.length < 2 ? (
          <div style={styles.empty}>
            {labels.verb} needs two bodies. Create or import another first.
          </div>
        ) : (
          <>
            <div style={styles.section}>
              <div style={styles.sectionLabel}>Target — kept</div>
              <select
                value={targetBodyId}
                onChange={e => chooseTarget(e.target.value)}
                style={styles.select}
                aria-label="Target body"
              >
                {availableBodies.map(b => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
            </div>

            <div style={styles.section}>
              <div style={styles.sectionLabel}>
                Tools — consumed ({toolBodyIds.length})
              </div>
              <div style={styles.toolList}>
                {tools.map(b => (
                  <label key={b.id} style={styles.toolRow}>
                    <input
                      type="checkbox"
                      checked={toolBodyIds.includes(b.id)}
                      onChange={() => toggleTool(b.id)}
                    />
                    <span style={styles.toolLabel}>{b.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

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
            disabled={!canConfirm}
            onClick={() => onConfirm({ operation, targetBodyId, toolBodyIds })}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleButton({ active, onClick, label }: {
  active: boolean; onClick: () => void; label: string;
}) {
  return (
    <button
      style={{
        ...styles.toggleBtn,
        background: active ? '#e3effb' : '#f7f7f7',
        color: active ? '#1a6fd1' : '#666',
        borderColor: active ? '#a8cef0' : '#e0e0e0',
        fontWeight: active ? 600 : 400,
      }}
      onClick={onClick}
      title={label}
    >
      {label}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', top: 12, right: 12, zIndex: 50, pointerEvents: 'auto' },
  panel: {
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    width: 300,
    overflow: 'hidden',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 12px', gap: 8,
  },
  label: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3, flexShrink: 0, minWidth: 40,
  },
  hint: { fontSize: 11, color: '#888', padding: '0 12px 8px' },
  empty: { fontSize: 12, color: '#999', fontStyle: 'italic', padding: '8px 12px 12px' },
  section: { padding: '10px 12px', borderTop: '1px solid #f0f0f0' },
  sectionLabel: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6,
  },
  select: {
    width: '100%', height: 28, padding: '0 6px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, background: '#fff', color: '#333', outline: 'none', cursor: 'pointer',
  },
  toolList: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' },
  toolRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#333', cursor: 'pointer' },
  toolLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toggleGroup: { display: 'flex', gap: 2, flex: 1, justifyContent: 'flex-end' },
  toggleBtn: {
    height: 26, padding: '0 8px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid #e0e0e0', borderRadius: 5,
    fontSize: 11, cursor: 'pointer', transition: 'background 0.1s',
  },
  actions: {
    display: 'flex', gap: 8, padding: '8px 12px 12px',
    justifyContent: 'flex-end', borderTop: '1px solid #e8e8e8',
  },
  cancelBtn: {
    height: 30, padding: '0 14px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    background: '#f5f5f5', color: '#555',
    cursor: 'pointer', fontSize: 12, fontWeight: 500,
  },
  okBtn: {
    height: 30, padding: '0 20px',
    border: 'none', borderRadius: 5,
    background: '#3b82f6', color: '#fff', fontSize: 12, fontWeight: 600,
  },
};

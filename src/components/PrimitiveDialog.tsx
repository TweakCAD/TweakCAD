/**
 * PrimitiveDialog — create a box, cylinder, sphere, cone or torus from
 * numbers, with no sketch and nothing to pick in the viewport.
 *
 * One dialog for all five rather than five dialogs (the route the CONSTRUCT
 * plane tools took), because the shapes differ only in which dimension fields
 * they show — position and operation are identical, and switching shape to
 * compare is a normal thing to want. The ribbon still offers each shape as its
 * own entry; they open this dialog with that shape selected.
 *
 * Dimensions are plain numbers here. The feature stores `Expression`s, so a
 * primitive can be parameter-driven, but typing expressions belongs in the
 * parameters editor rather than in the create dialog.
 *
 * Visual + interaction style matches {@link ExtrudeDialog}.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PrimitiveKind } from '@tweakcad/core/src/document/schema.ts';
import { PRIMITIVE_KINDS } from '@tweakcad/core/src/document/schema.ts';
import {
  BoxIcon, CylinderIcon, SphereIcon, ConeIcon, TorusIcon, getFeatureIcon,
} from '../icons/cadIcons.tsx';
import { PanelHeader } from './PanelHeader.tsx';

// ---- Types ----

export type PrimitiveOperation = 'newBody' | 'join' | 'cut';

/** A body the user can pick as the target for join / cut. */
export interface PrimitiveAvailableBody {
  /** Stringified BodyId. Kept string-typed so the dialog avoids core's branded ids. */
  id: string;
  /** Display label, e.g. "Body 1 (Extrude 1)". */
  label: string;
}

export interface PrimitiveDialogResult {
  kind: PrimitiveKind;
  /** Dimension values in mm, keyed by the field names the shape uses. */
  dimensions: Record<string, number>;
  position: [number, number, number];
  operation: PrimitiveOperation;
  /** Picked target for join / cut. Undefined means no pick. */
  targetBodyId?: string;
}

export interface PrimitiveDialogInitialValues {
  kind?: PrimitiveKind;
  dimensions?: Record<string, number>;
  position?: [number, number, number];
  operation?: PrimitiveOperation;
  targetBodyId?: string;
}

interface PrimitiveDialogProps {
  /** Shape the ribbon entry opened; the user can still switch in-dialog. */
  kind: PrimitiveKind;
  initialValues?: PrimitiveDialogInitialValues | undefined;
  availableBodies?: PrimitiveAvailableBody[] | undefined;
  /** True when editing an existing primitive (changes the title only). */
  editing?: boolean | undefined;
  onConfirm: (result: PrimitiveDialogResult) => void;
  onCancel: () => void;
}

// ---- Shape metadata ----

interface DimensionField {
  /** Key in `PrimitiveShape` and in the result's `dimensions`. */
  key: string;
  label: string;
  /** Value used when the dialog opens without an initial value. */
  initial: number;
  /** Zero is a legal value — only `cone.topRadius`, which makes a point. */
  allowZero?: boolean;
}

const SHAPE_FIELDS: Record<PrimitiveKind, DimensionField[]> = {
  box: [
    { key: 'width', label: 'Width (X)', initial: 20 },
    { key: 'height', label: 'Height (Y)', initial: 20 },
    { key: 'depth', label: 'Depth (Z)', initial: 20 },
  ],
  cylinder: [
    { key: 'radius', label: 'Radius', initial: 10 },
    { key: 'height', label: 'Height', initial: 20 },
  ],
  sphere: [
    { key: 'radius', label: 'Radius', initial: 10 },
  ],
  cone: [
    { key: 'bottomRadius', label: 'Bottom R', initial: 10 },
    { key: 'topRadius', label: 'Top R', initial: 0, allowZero: true },
    { key: 'height', label: 'Height', initial: 20 },
  ],
  torus: [
    { key: 'majorRadius', label: 'Ring R', initial: 20 },
    { key: 'minorRadius', label: 'Tube R', initial: 5 },
  ],
};

const SHAPE_LABELS: Record<PrimitiveKind, string> = {
  box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', cone: 'Cone', torus: 'Torus',
};

const SHAPE_ICONS: Record<PrimitiveKind, (color: string) => React.ReactNode> = {
  box: c => <BoxIcon size={18} color={c} />,
  cylinder: c => <CylinderIcon size={18} color={c} />,
  sphere: c => <SphereIcon size={18} color={c} />,
  cone: c => <ConeIcon size={18} color={c} />,
  torus: c => <TorusIcon size={18} color={c} />,
};

const AXIS_LABELS = ['X', 'Y', 'Z'] as const;

/** Text buffers for one shape's fields, seeded from initial values. */
function seedDimensions(
  kind: PrimitiveKind,
  initial: Record<string, number> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of SHAPE_FIELDS[kind]) {
    out[field.key] = String(initial?.[field.key] ?? field.initial);
  }
  return out;
}

// ---- Component ----

export function PrimitiveDialog({
  kind: initialKind,
  initialValues,
  availableBodies,
  editing,
  onConfirm,
  onCancel,
}: PrimitiveDialogProps) {
  const [kind, setKind] = useState<PrimitiveKind>(initialValues?.kind ?? initialKind);
  // Text buffers rather than numbers so a half-typed "-" or "" is allowed.
  const [dimensions, setDimensions] = useState<Record<string, string>>(
    () => seedDimensions(initialValues?.kind ?? initialKind, initialValues?.dimensions),
  );
  const [position, setPosition] = useState<[string, string, string]>(() => {
    const p = initialValues?.position ?? [0, 0, 0];
    return [String(p[0]), String(p[1]), String(p[2])];
  });
  const [operation, setOperation] = useState<PrimitiveOperation>(
    initialValues?.operation ?? 'newBody',
  );
  const [targetBodyId, setTargetBodyId] = useState(initialValues?.targetBodyId ?? '');
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const fields = SHAPE_FIELDS[kind];
  const showTargetBodyPicker = operation !== 'newBody' && (availableBodies?.length ?? 0) > 0;

  useEffect(() => {
    firstInputRef.current?.focus();
    firstInputRef.current?.select();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Switching shape re-seeds the fields. Values are not carried across:
  // a sphere's radius is not a box's width, and silently reusing the number
  // would be a guess the user has to notice and undo.
  const switchKind = useCallback((next: PrimitiveKind) => {
    setKind(next);
    setDimensions(seedDimensions(next, next === initialValues?.kind ? initialValues.dimensions : undefined));
    setError(null);
  }, [initialValues]);

  /** Parse every dimension field, or report the first one that fails. */
  const readDimensions = useCallback((): { values: Record<string, number> } | { problem: string } => {
    const values: Record<string, number> = {};
    for (const field of fields) {
      const num = parseFloat(dimensions[field.key] ?? '');
      if (Number.isNaN(num)) return { problem: `${field.label} must be a number` };
      if (num < 0 || (num === 0 && !field.allowZero)) {
        return { problem: `${field.label} must be greater than zero` };
      }
      values[field.key] = num;
    }
    if (kind === 'cone' && values.bottomRadius === 0 && values.topRadius === 0) {
      return { problem: 'A cone needs at least one non-zero radius' };
    }
    if (kind === 'torus' && values.minorRadius! >= values.majorRadius!) {
      return { problem: 'Tube radius must be smaller than ring radius' };
    }
    return { values };
  }, [fields, dimensions, kind]);

  const handleConfirm = useCallback(() => {
    const dims = readDimensions();
    if ('problem' in dims) { setError(dims.problem); return; }
    const coords = position.map(v => parseFloat(v));
    if (coords.some(Number.isNaN)) { setError('Position must be three numbers'); return; }

    onConfirm({
      kind,
      dimensions: dims.values,
      position: [coords[0]!, coords[1]!, coords[2]!],
      operation,
      ...(showTargetBodyPicker && targetBodyId ? { targetBodyId } : {}),
    });
  }, [readDimensions, position, kind, operation, showTargetBodyPicker, targetBodyId, onConfirm]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
  }, [handleConfirm]);

  const canConfirm = !('problem' in readDimensions()) && !position.some(v => Number.isNaN(parseFloat(v)));

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader
          title={editing ? `Edit ${SHAPE_LABELS[kind]}` : SHAPE_LABELS[kind]}
          icon={getFeatureIcon(kind, 14)}
          onClose={onCancel}
          closeTitle="Cancel (Esc)"
        />

        <div style={styles.section}>
          <div style={styles.sectionLabel}>Shape</div>
          <div style={styles.shapeRow}>
            {PRIMITIVE_KINDS.map(k => {
              const active = k === kind;
              return (
                <button
                  key={k}
                  type="button"
                  style={{
                    ...styles.shapeBtn,
                    background: active ? '#e3effb' : '#f7f7f7',
                    borderColor: active ? '#a8cef0' : '#e0e0e0',
                  }}
                  onClick={() => switchKind(k)}
                  title={SHAPE_LABELS[k]}
                  aria-pressed={active}
                >
                  {SHAPE_ICONS[k](active ? '#1a6fd1' : '#666')}
                </button>
              );
            })}
          </div>
        </div>

        {fields.map((field, index) => (
          <div style={styles.row} key={field.key}>
            <span style={styles.label}>{field.label}</span>
            <div style={styles.inputGroup}>
              <input
                {...(index === 0 ? { ref: firstInputRef } : {})}
                type="text"
                value={dimensions[field.key] ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  setDimensions(prev => ({ ...prev, [field.key]: v }));
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                style={{ ...styles.input, borderColor: error ? '#dc2626' : '#d0d0d0' }}
              />
              <span style={styles.unit}>mm</span>
            </div>
          </div>
        ))}

        <div style={styles.row}>
          <span style={styles.label} title="Where the primitive's centre sits">Centre</span>
          <div style={styles.positionGroup}>
            {AXIS_LABELS.map((axis, i) => (
              <div style={styles.axisField} key={axis}>
                <span style={styles.axisLabel}>{axis}</span>
                <input
                  type="text"
                  value={position[i]}
                  onChange={e => {
                    const v = e.target.value;
                    setPosition(prev => {
                      const next: [string, string, string] = [...prev];
                      next[i] = v;
                      return next;
                    });
                    setError(null);
                  }}
                  onKeyDown={handleKeyDown}
                  style={styles.axisInput}
                />
              </div>
            ))}
          </div>
        </div>

        <div style={styles.row}>
          <span style={styles.label}>Op</span>
          <div style={styles.toggleGroup}>
            {(['newBody', 'join', 'cut'] as const).map(op => (
              <ToggleButton
                key={op}
                active={operation === op}
                onClick={() => { setOperation(op); setError(null); }}
                label={op === 'newBody' ? 'New' : op === 'join' ? 'Join' : 'Cut'}
              />
            ))}
          </div>
        </div>

        {showTargetBodyPicker && (
          <div style={styles.row}>
            <span style={styles.label}>Target</span>
            <select
              style={styles.select}
              value={targetBodyId}
              onChange={e => setTargetBodyId(e.target.value)}
            >
              <option value="">Auto</option>
              {availableBodies?.map(b => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
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
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#2563eb';
            }}
            onMouseLeave={e => {
              if (canConfirm) (e.currentTarget as HTMLButtonElement).style.background = '#3b82f6';
            }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
}

function ToggleButton({ active, onClick, label }: ToggleButtonProps) {
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
      onMouseEnter={e => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = '#ebebeb';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = active ? '#e3effb' : '#f7f7f7';
      }}
    >
      {label}
    </button>
  );
}

// ---- Styles ----

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
  section: { padding: '10px 12px', borderBottom: '1px solid #f0f0f0' },
  sectionLabel: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6,
  },
  shapeRow: { display: 'flex', gap: 4 },
  shapeBtn: {
    flex: 1, height: 32,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid #e0e0e0', borderRadius: 5,
    cursor: 'pointer', padding: 0,
    transition: 'background 0.1s, border-color 0.1s',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 12px', gap: 8,
  },
  label: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3,
    flexShrink: 0, minWidth: 68,
  },
  inputGroup: { display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' },
  input: {
    width: 90, height: 28, padding: '0 8px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 13, fontFamily: 'monospace', color: '#333',
    outline: 'none', textAlign: 'right',
    transition: 'border-color 0.15s',
  },
  unit: { fontSize: 11, color: '#999', fontWeight: 500 },
  positionGroup: { display: 'flex', gap: 4, flex: 1, justifyContent: 'flex-end' },
  axisField: { display: 'flex', alignItems: 'center', gap: 3 },
  axisLabel: { fontSize: 10, color: '#999', fontWeight: 600 },
  axisInput: {
    width: 44, height: 28, padding: '0 5px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, fontFamily: 'monospace', color: '#333',
    outline: 'none', textAlign: 'right',
  },
  toggleGroup: { display: 'flex', gap: 2, flex: 1, justifyContent: 'flex-end' },
  toggleBtn: {
    height: 26, padding: '0 10px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid #e0e0e0', borderRadius: 5,
    fontSize: 11, cursor: 'pointer',
    transition: 'background 0.1s',
  },
  select: {
    flex: 1, height: 28, padding: '0 6px',
    border: '1px solid #d0d0d0', borderRadius: 5,
    fontSize: 12, background: '#fff', color: '#333',
    outline: 'none', cursor: 'pointer',
  },
  error: { fontSize: 11, color: '#dc2626', padding: '0 12px 4px' },
  actions: {
    display: 'flex', gap: 8,
    padding: '8px 12px 12px',
    justifyContent: 'flex-end',
    borderTop: '1px solid #e8e8e8',
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
    background: '#3b82f6', color: '#fff',
    fontSize: 12, fontWeight: 600,
    transition: 'background 0.1s, opacity 0.1s',
  },
};

/**
 * ExtrudeDialog - Inline panel overlay on the viewport for extrude operation.
 *
 * Control panel that appears as a floating card on top of the 3D
 * viewport, with distance input, direction toggle,
 * and operation type (New Body / Join / Cut).
 *
 * Handles:
 *   - Distance input with live validation
 *   - Direction: Normal / Reversed / Symmetric
 *   - Operation: New Body / Join / Cut
 *   - OK / Cancel buttons
 *   - Keyboard: Enter to confirm, Escape to cancel
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ExtrudeIcon } from '../icons/cadIcons.tsx';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { PanelHeader } from './PanelHeader.tsx';

// ---- Types ----

// "Symmetric" used to live in `direction` (UX shorthand) but it's
// really an extent — the body is centred about the start plane, regardless
// of which way "normal" points. v0.2 of the dialog separates them so we
// can also offer throughAll / toPlane without overloading direction.
export type ExtrudeDirection = 'normal' | 'reversed';
export type ExtrudeOperation = 'newBody' | 'join' | 'cut';
export type ExtrudeExtentType = 'distance' | 'symmetric' | 'throughAll' | 'toPlane';
export type ExtrudeDefaultPlane = 'XY' | 'XZ' | 'YZ';

/** A body the user can pick as the target for join / cut. */
export interface ExtrudeAvailableBody {
  /** Stringified BodyId. The dialog stays string-typed so it doesn't pull in core's branded ID. */
  id: string;
  /** Display label, e.g. "Body 1 (Extrude 1)". */
  label: string;
}

export interface ExtrudeDialogResult {
  distance: number;
  startOffset: number;
  direction: ExtrudeDirection;
  extentType: ExtrudeExtentType;
  /** Target plane for `extentType: 'toPlane'`. Undefined for other modes. */
  targetPlane?: ExtrudeDefaultPlane;
  operation: ExtrudeOperation;
  /** Picked target body for join / cut. Undefined means no pick. */
  targetBodyId?: string;
}

/** Initial values for pre-populating the dialog when editing an existing extrude */
export interface ExtrudeDialogInitialValues {
  distance?: number;
  startOffset?: number;
  direction?: ExtrudeDirection;
  extentType?: ExtrudeExtentType;
  targetPlane?: ExtrudeDefaultPlane;
  operation?: ExtrudeOperation;
  targetBodyId?: string;
}

interface ExtrudeDialogProps {
  /** Name of the sketch being extruded */
  sketchName: string;
  /** Number of selected profiles that will be extruded */
  profileCount?: number | undefined;
  /** Initial values when editing an existing extrude feature */
  initialValues?: ExtrudeDialogInitialValues | undefined;
  /** Bodies currently in the part — populates the target-body picker. */
  availableBodies?: ExtrudeAvailableBody[] | undefined;
  /** Called when user confirms the extrude */
  onConfirm: (result: ExtrudeDialogResult) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

// ---- Component ----

export function ExtrudeDialog({ sketchName, profileCount = 1, initialValues, availableBodies, onConfirm, onCancel }: ExtrudeDialogProps) {
  const [distance, setDistance] = useState(String(initialValues?.distance ?? 10));
  const [startOffset, setStartOffset] = useState(String(initialValues?.startOffset ?? 0));
  const [direction, setDirection] = useState<ExtrudeDirection>(initialValues?.direction ?? 'normal');
  const [extentType, setExtentType] = useState<ExtrudeExtentType>(initialValues?.extentType ?? 'distance');
  const [targetPlane, setTargetPlane] = useState<ExtrudeDefaultPlane>(initialValues?.targetPlane ?? 'XY');
  const [operation, setOperation] = useState<ExtrudeOperation>(initialValues?.operation ?? 'newBody');
  const [targetBodyId, setTargetBodyId] = useState<string>(initialValues?.targetBodyId ?? '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Distance input only matters for distance / symmetric extents; through-all
  // and to-plane derive their length from geometry, so we skip the >0 check.
  const distanceRelevant = extentType === 'distance' || extentType === 'symmetric';
  // Target-body picker only relevant when the operation isn't newBody.
  const showTargetBodyPicker = operation !== 'newBody' && (availableBodies?.length ?? 0) > 0;

  // Auto-focus the distance input
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Keyboard shortcuts
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
    if (isNaN(num) || num <= 0) return null;
    return num;
  }, []);

  const handleConfirm = useCallback(() => {
    // Distance is only required for distance/symmetric extents.
    let num = 0;
    if (distanceRelevant) {
      const parsed = validate(distance);
      if (parsed === null) {
        setError('Enter a positive number');
        return;
      }
      num = parsed;
    }
    const parsedStartOffset = Number(startOffset);
    // Build with optional fields conditionally — exactOptionalPropertyTypes
    // bans passing `undefined` for `?:` props.
    const payload: ExtrudeDialogResult = {
      distance: num,
      startOffset: Number.isFinite(parsedStartOffset) ? parsedStartOffset : 0,
      direction,
      extentType,
      operation,
    };
    if (extentType === 'toPlane') payload.targetPlane = targetPlane;
    if (showTargetBodyPicker && targetBodyId) payload.targetBodyId = targetBodyId;
    onConfirm(payload);
  }, [distance, startOffset, direction, extentType, targetPlane, operation, targetBodyId, distanceRelevant, showTargetBodyPicker, onConfirm, validate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  }, [handleConfirm]);

  const handleDistanceChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDistance(e.target.value);
    setError(null);
  }, []);

  const handleStartOffsetChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setStartOffset(e.target.value);
    setError(null);
  }, []);

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        {/* Header */}
        <PanelHeader title="Extrude" icon={<ExtrudeIcon size={14} color="#1a6fd1" />} onClose={onCancel} closeTitle="Cancel (Esc)" />

        {/* Source */}
        <div style={styles.row}>
          <span style={styles.label}>Profile</span>
          <span style={styles.sourceValue}>{profileCount > 1 ? `${profileCount} profiles from ${sketchName}` : sketchName}</span>
        </div>

        {/* Extent type — Distance / Symmetric / Through All / To Plane */}
        <div style={styles.row}>
          <span style={styles.label}>Extent</span>
          <div style={styles.toggleGroup}>
            <ToggleButton active={extentType === 'distance'}    onClick={() => setExtentType('distance')}    label="Dist" />
            <ToggleButton active={extentType === 'symmetric'}   onClick={() => setExtentType('symmetric')}   label="Sym" />
            <ToggleButton active={extentType === 'throughAll'}  onClick={() => setExtentType('throughAll')}  label="Thru" />
            <ToggleButton active={extentType === 'toPlane'}     onClick={() => setExtentType('toPlane')}     label="Plane" />
          </div>
        </div>

        {/* Distance input — only for distance/symmetric extents */}
        {distanceRelevant && (
          <div style={styles.row}>
            <span style={styles.label}>Distance</span>
            <div style={styles.inputGroup}>
              <input
                ref={inputRef}
                type="text"
                value={distance}
                onChange={handleDistanceChange}
                onKeyDown={handleKeyDown}
                style={{
                  ...styles.input,
                  borderColor: error ? '#dc2626' : '#d0d0d0',
                }}
                placeholder="10"
              />
              <span style={styles.unit}>mm</span>
            </div>
          </div>
        )}

        {/* Target plane — only for toPlane extent */}
        {extentType === 'toPlane' && (
          <div style={styles.row}>
            <span style={styles.label}>To plane</span>
            <select
              value={targetPlane}
              onChange={e => setTargetPlane(e.target.value as ExtrudeDefaultPlane)}
              style={styles.select}
            >
              <option value="XY">XY</option>
              <option value="XZ">XZ</option>
              <option value="YZ">YZ</option>
            </select>
          </div>
        )}

        {error && <div style={styles.error}>{error}</div>}

        {/* Start offset input */}
        <div style={styles.row}>
          <span style={styles.label}>Offset</span>
          <div style={styles.inputGroup}>
            <input
              type="text"
              value={startOffset}
              onChange={handleStartOffsetChange}
              onKeyDown={handleKeyDown}
              style={styles.input}
              placeholder="0"
            />
            <span style={styles.unit}>mm</span>
          </div>
        </div>

        {/* Direction toggle — symmetric moved to Extent */}
        <div style={styles.row}>
          <span style={styles.label}>Direction</span>
          <div style={styles.toggleGroup}>
            <IconToggle
              active={direction === 'normal'}
              onClick={() => setDirection('normal')}
              icon={<ArrowUp size={14} />}
              tooltip="Normal"
            />
            <IconToggle
              active={direction === 'reversed'}
              onClick={() => setDirection('reversed')}
              icon={<ArrowDown size={14} />}
              tooltip="Reversed"
            />
          </div>
        </div>

        {/* Operation toggle */}
        <div style={styles.row}>
          <span style={styles.label}>Op</span>
          <div style={styles.toggleGroup}>
            <ToggleButton
              active={operation === 'newBody'}
              onClick={() => setOperation('newBody')}
              label="New"
            />
            <ToggleButton
              active={operation === 'join'}
              onClick={() => setOperation('join')}
              label="Join"
            />
            <ToggleButton
              active={operation === 'cut'}
              onClick={() => setOperation('cut')}
              label="Cut"
            />
          </div>
        </div>

        {/* Target body picker — only for join/cut and when bodies exist */}
        {showTargetBodyPicker && (
          <div style={styles.row}>
            <span style={styles.label}>Target</span>
            <select
              value={targetBodyId}
              onChange={e => setTargetBodyId(e.target.value)}
              style={styles.select}
            >
              <option value="">Auto</option>
              {availableBodies!.map(body => (
                <option key={body.id} value={body.id}>{body.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Action buttons */}
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
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1557a0'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#1a6fd1'; }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Sub-components ----

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
}

/** Icon-only toggle button (for direction) */
function IconToggle({ active, onClick, icon, tooltip }: { active: boolean; onClick: () => void; icon: React.ReactNode; tooltip: string }) {
  return (
    <button
      style={{
        ...styles.iconToggle,
        background: active ? '#e3effb' : '#f7f7f7',
        color: active ? '#1a6fd1' : '#888',
        borderColor: active ? '#a8cef0' : '#e0e0e0',
      }}
      onClick={onClick}
      title={tooltip}
      onMouseEnter={e => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = '#ebebeb';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = active ? '#e3effb' : '#f7f7f7';
      }}
    >
      {icon}
    </button>
  );
}

function ToggleButton({ active, onClick, label, icon }: ToggleButtonProps) {
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
      {icon}
      <span>{label}</span>
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
    color: '#2196f3',
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
  select: {
    flex: 1,
    height: 28,
    padding: '0 6px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    fontSize: 12,
    background: '#fff',
    color: '#333',
    outline: 'none',
    cursor: 'pointer',
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
  iconToggle: {
    width: 30,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #e0e0e0',
    borderRadius: 4,
    cursor: 'pointer',
    padding: 0,
    background: '#f7f7f7',
    transition: 'background 0.1s, color 0.1s',
  },
  toggleBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 26,
    padding: '0 8px',
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
    background: '#1a6fd1',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    transition: 'background 0.1s',
  },
};

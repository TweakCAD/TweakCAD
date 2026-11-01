/**
 * DimensionsOverlay — renders persistent dimension labels + the dimension
 * tool's value input on top of the sketch viewport.
 *
 * Persistent labels:
 *   Iterates dimensional constraints in the editor store
 *   (length / radius / distance) and renders a small HTML pill at the
 *   midpoint of the referenced geometry. Re-projected every animation frame
 *   so labels follow camera orbit/pan/zoom without lag.
 *
 * Value input:
 *   When `store.pendingDimension` is set, renders an `<input>` at the
 *   projected screen position. Enter commits the value (applies the right
 *   constraint, snaps geometry); Esc cancels.
 *
 * Why HTML overlays instead of Three.js sprites: text legibility under
 * arbitrary camera angles, native input controls, no per-label texture
 * allocations. The cost is one DOM node per dimension, fine for sketch-scale
 * counts.
 */

import { useEffect, useRef, useState } from 'react';
import { useSketchEditorStore } from './SketchEditorStore.ts';
import type { SketchSceneManager } from './SketchSceneManager.ts';
import type {
  SketchConstraint,
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from '@tweakcad/core/src/sketch/types.ts';
import { dispatchApplyConstraint } from './sketchDispatch.ts';
import { closeDimensionPrompt } from './sketchToolsExt.ts';

interface DimensionsOverlayProps {
  sceneManager: SketchSceneManager | null;
}

/** Per-label projected position kept in React state so layout updates each frame. */
interface LabelPos {
  key: string;
  text: string;
  x: number;
  y: number;
  hidden: boolean;
  /** V11 · true if the underlying constraint has `driven: true`. Painted in
      a muted grey + italic so users can distinguish driving (enforced)
      from driven (reported). */
  driven?: boolean;
}

export function DimensionsOverlay({ sceneManager }: DimensionsOverlayProps) {
  const constraints = useSketchEditorStore(s => s.constraints);
  const points = useSketchEditorStore(s => s.points);
  const geometries = useSketchEditorStore(s => s.geometries);
  const pendingDimension = useSketchEditorStore(s => s.pendingDimension);
  const inferredHint = useSketchEditorStore(s => s.inferredHint);

  const [labels, setLabels] = useState<LabelPos[]>([]);
  const [promptPos, setPromptPos] = useState<{ x: number; y: number } | null>(null);
  const [hintPos, setHintPos] = useState<{ x: number; y: number; kind: 'horizontal' | 'vertical' } | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Re-project on every frame so labels track the camera.
  useEffect(() => {
    if (!sceneManager) return;
    let stopped = false;

    function tick() {
      if (stopped || !sceneManager) return;
      const nextLabels: LabelPos[] = [];
      for (const c of constraints.values()) {
        const target = dimensionLabelTarget(c, geometries, points);
        if (!target) continue;
        const screen = sceneManager.sketchToScreen(target.x, target.y);
        const driven = (c as { driven?: boolean }).driven === true;
        nextLabels.push({
          key: `${c.type}-${c.id}`,
          text: target.text,
          x: screen.x,
          y: screen.y,
          hidden: screen.behindCamera,
          ...(driven ? { driven: true } : {}),
        });
      }
      setLabels(nextLabels);

      if (pendingDimension) {
        const sp = sceneManager.sketchToScreen(pendingDimension.screenX, pendingDimension.screenY);
        setPromptPos({ x: sp.x, y: sp.y });
      } else {
        setPromptPos(null);
      }

      // V8 · project the inferred-constraint hint to screen space and
      // offset it ~14 px above-right of the cursor so the chip doesn't
      // sit under the user's pointer.
      if (inferredHint) {
        const sp = sceneManager.sketchToScreen(inferredHint.sketchX, inferredHint.sketchY);
        setHintPos({ x: sp.x + 14, y: sp.y - 14, kind: inferredHint.kind });
      } else {
        setHintPos(null);
      }
      animFrameRef.current = requestAnimationFrame(tick);
    }
    animFrameRef.current = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [sceneManager, constraints, points, geometries, pendingDimension, inferredHint]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 6,
      }}
    >
      {labels.map(l => (
        !l.hidden && (
          <div
            key={l.key}
            style={{
              ...styles.label,
              ...(l.driven ? styles.labelDriven : {}),
              transform: `translate(${l.x}px, ${l.y}px) translate(-50%, -50%)`,
            }}
            title={l.driven ? 'Driven dimension (reported, not enforced)' : undefined}
          >
            {l.driven ? `(${l.text})` : l.text}
          </div>
        )
      ))}

      {/* V8 · inferred-constraint hint chip. `H` for near-horizontal,
          `V` for near-vertical. Auto-applied on commit (see sketchTools
          `commitInferredHintConstraint`) — chip is just the visual
          affordance so the user knows the constraint is about to land. */}
      {hintPos && (
        <div
          style={{
            ...styles.hintChip,
            transform: `translate(${hintPos.x}px, ${hintPos.y}px) translate(-50%, -50%)`,
          }}
          title={hintPos.kind === 'horizontal' ? 'Will snap horizontal' : 'Will snap vertical'}
        >
          {hintPos.kind === 'horizontal' ? 'H' : 'V'}
        </div>
      )}

      {pendingDimension && promptPos && (
        <DimensionInput
          key={`${pendingDimension.kind}-${dimensionTargetId(pendingDimension)}`}
          initial={
            pendingDimension.kind === 'angle'
              ? Math.abs(pendingDimension.current) * 180 / Math.PI
              : (pendingDimension.kind === 'distanceX' || pendingDimension.kind === 'distanceY')
                ? Math.abs(pendingDimension.current)
                : pendingDimension.current
          }
          unit={pendingDimension.kind === 'angle' ? 'deg' : 'mm'}
          allowNonPositive={pendingDimension.kind === 'angle'}
          x={promptPos.x}
          y={promptPos.y}
          onCommit={(value) => commitPendingDimension(value)}
          onCancel={() => closeDimensionPrompt(useSketchEditorStore.getState())}
        />
      )}
    </div>
  );
}

// ---- Input ----

function DimensionInput({
  initial,
  x,
  y,
  unit = 'mm',
  allowNonPositive = false,
  onCommit,
  onCancel,
}: {
  initial: number;
  x: number;
  y: number;
  unit?: string;
  /** When true, accept 0 and negative numbers (used for angle dimensions). */
  allowNonPositive?: boolean;
  onCommit: (value: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<string>(initial.toFixed(2));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      style={{
        ...styles.inputWrap,
        transform: `translate(${x}px, ${y}px) translate(-50%, -50%)`,
        pointerEvents: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = parseFloat(value);
            if (!isNaN(n) && (allowNonPositive || n > 0)) onCommit(n);
            else onCancel();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
          e.stopPropagation();
        }}
        style={styles.input}
      />
      <span style={styles.inputUnit}>{unit}</span>
    </div>
  );
}

// ---- Commit logic ----

/**
 * Apply the pending dimension's value to the store: add the matching
 * constraint AND scale geometry so the displayed result matches. The
 * existing enforceSimpleConstraints in SketchEditorStore handles ongoing
 * preservation as the user drags; this commit handles the initial snap.
 */
function commitPendingDimension(value: number): void {
  const store = useSketchEditorStore.getState();
  const pd = store.pendingDimension;
  if (!pd) return;

  // The value-bearing constraints (length / radius /
  // distance / distanceX / distanceY / angle) all route through the bus.
  // The pre-commit solver pipeline re-positions points so a
  // separate `store.movePoint` snap is no longer needed — the solver's
  // post-solve coords come back through the hydration subscriber.
  if (pd.kind === 'length') {
    const geom = store.geometries.get(pd.geometryId);
    if (geom && geom.type === 'line') {
      dispatchApplyConstraint({ type: 'length', geometryId: pd.geometryId, value });
    }
  } else if (pd.kind === 'radius') {
    const geom = store.geometries.get(pd.geometryId);
    if (geom && (geom.type === 'circle' || geom.type === 'arc')) {
      dispatchApplyConstraint({ type: 'radius', geometryId: pd.geometryId, value });
    }
  } else if (pd.kind === 'distance') {
    const a = store.points.get(pd.pointA);
    const b = store.points.get(pd.pointB);
    if (a && b) {
      dispatchApplyConstraint({ type: 'distance', pointA: pd.pointA, pointB: pd.pointB, value });
    }
  } else if (pd.kind === 'distanceX' || pd.kind === 'distanceY') {
    // The input is the desired positive magnitude; preserve the sign of the
    // current signed difference so the orientation of the line is kept.
    const a = store.points.get(pd.pointA);
    const b = store.points.get(pd.pointB);
    if (a && b) {
      const signed = (pd.current < 0 ? -1 : 1) * value;
      if (pd.kind === 'distanceX') {
        dispatchApplyConstraint({ type: 'distanceX', pointA: pd.pointA, pointB: pd.pointB, value: signed });
      } else {
        dispatchApplyConstraint({ type: 'distanceY', pointA: pd.pointA, pointB: pd.pointB, value: signed });
      }
    }
  } else if (pd.kind === 'angle') {
    // Input is in degrees; convert to radians. We preserve the sign of the
    // current angle so dimensioning "5 deg" between lines that currently have
    // a negative relative angle still produces a CCW-positive solver target
    // that matches user intent.
    const radians = (value * Math.PI / 180) * (pd.current < 0 ? -1 : 1);
    dispatchApplyConstraint({
      type: 'angle',
      geometryA: pd.geometryA,
      geometryB: pd.geometryB,
      value: radians,
    });
  }

  closeDimensionPrompt(store);
}

// ---- Constraint → label position ----

interface LabelTarget { x: number; y: number; text: string }

function dimensionLabelTarget(
  c: SketchConstraint,
  geometries: Map<SketchGeometryId, SketchGeometry>,
  points: Map<SketchPointId, SketchPoint>,
): LabelTarget | null {
  switch (c.type) {
    case 'length': {
      const g = geometries.get(c.geometryId);
      if (!g || g.type !== 'line') return null;
      const a = points.get(g.startId);
      const b = points.get(g.endId);
      if (!a || !b) return null;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${c.value.toFixed(2)} mm` };
    }
    case 'radius': {
      const g = geometries.get(c.geometryId);
      if (!g || (g.type !== 'circle' && g.type !== 'arc')) return null;
      const center = points.get(g.centerId);
      if (!center) return null;
      return { x: center.x + g.radius * 0.6, y: center.y + g.radius * 0.6, text: `R ${c.value.toFixed(2)}` };
    }
    case 'distance': {
      const a = points.get(c.pointA);
      const b = points.get(c.pointB);
      if (!a || !b) return null;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${c.value.toFixed(2)} mm` };
    }
    case 'distanceX': {
      const a = points.get(c.pointA);
      const b = points.get(c.pointB);
      if (!a || !b) return null;
      // Place label below the midpoint horizontally.
      return { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 4, text: `↔ ${Math.abs(c.value).toFixed(2)} mm` };
    }
    case 'distanceY': {
      const a = points.get(c.pointA);
      const b = points.get(c.pointB);
      if (!a || !b) return null;
      return { x: Math.max(a.x, b.x) + 4, y: (a.y + b.y) / 2, text: `↕ ${Math.abs(c.value).toFixed(2)} mm` };
    }
    case 'angle': {
      // Label at the midpoint between the two lines' midpoints.
      const ga = geometries.get(c.geometryA);
      const gb = geometries.get(c.geometryB);
      if (!ga || ga.type !== 'line' || !gb || gb.type !== 'line') return null;
      const a1 = points.get(ga.startId);
      const a2 = points.get(ga.endId);
      const b1 = points.get(gb.startId);
      const b2 = points.get(gb.endId);
      if (!a1 || !a2 || !b1 || !b2) return null;
      const deg = (Math.abs(c.value) * 180 / Math.PI);
      return {
        x: ((a1.x + a2.x) / 2 + (b1.x + b2.x) / 2) / 2,
        y: ((a1.y + a2.y) / 2 + (b1.y + b2.y) / 2) / 2,
        text: `${deg.toFixed(1)}°`,
      };
    }
    default:
      return null;
  }
}

function dimensionTargetId(pd: NonNullable<ReturnType<typeof useSketchEditorStore.getState>['pendingDimension']>): string {
  if (pd.kind === 'distance' || pd.kind === 'distanceX' || pd.kind === 'distanceY') {
    return `${pd.kind}-${String(pd.pointA)}-${String(pd.pointB)}`;
  }
  if (pd.kind === 'angle') return `${String(pd.geometryA)}-${String(pd.geometryB)}`;
  return String(pd.geometryId);
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  label: {
    position: 'absolute',
    top: 0,
    left: 0,
    padding: '2px 6px',
    background: 'rgba(255, 255, 255, 0.92)',
    border: '1px solid #d1d5db',
    borderRadius: 3,
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
    color: '#1f2937',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  /** V11 · muted style for driven dimensions (reported, not enforced).
      Parens around the value + grey italic is the standard
      convention so users can distinguish driving dims at a glance. */
  labelDriven: {
    color: '#9ca3af',
    fontStyle: 'italic',
    background: 'rgba(243, 244, 246, 0.85)',
    borderColor: '#e5e7eb',
  },
  /** V8 · inferred-constraint hint glyph next to cursor. Bold + bright
      so it reads at-a-glance during fast cursor motion. */
  hintChip: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#3b82f6',
    color: '#fff',
    border: '1px solid #1a4cc7',
    borderRadius: 3,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  inputWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    display: 'flex',
    alignItems: 'center',
    background: '#fff',
    border: '1.5px solid #3b82f6',
    borderRadius: 4,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    padding: '2px 4px',
    gap: 4,
  },
  input: {
    width: 64,
    padding: '2px 4px',
    border: 'none',
    outline: 'none',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    background: 'transparent',
    color: '#111',
  },
  inputUnit: {
    fontSize: 10,
    color: '#6b7280',
    paddingRight: 4,
  },
};

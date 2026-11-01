/**
 * TextToolPanel — options for the sketch Text tool.
 *
 * Shown while the Text tool is active. Holds the string, font and cap height;
 * whenever one changes it lays the text out at the origin and publishes the
 * outline to `store.textPlacement`. The tool itself (sketchTools.ts) shows
 * that outline under the cursor and places a copy on click.
 *
 * Key events stop at the panel so typing (Backspace in particular) never
 * reaches the sketch editor's window-level shortcuts.
 */

import { useEffect, useRef, useState } from 'react';
import { Type } from 'lucide-react';
import { PanelHeader } from '../components/PanelHeader.tsx';
import { enqueueToast } from '../components/toastStore.ts';
import { useSketchEditorStore } from './SketchEditorStore.ts';
import { SKETCH_FONTS, loadSketchFont, type SketchFontId } from './text/sketchFonts.ts';
import { textToPrimitives } from '@tweakcad/core/src/sketch/text/textOutline.ts';
import type { DxfPrimitive } from '@tweakcad/core/src/sketch/io/dxfImport.ts';

/** Points per bezier in the cursor preview. */
const PREVIEW_SAMPLES = 8;

interface TextToolPanelProps {
  onClose: () => void;
}

export function TextToolPanel({ onClose }: TextToolPanelProps) {
  const options = useSketchEditorStore(s => s.textToolOptions);
  const setOptions = useSketchEditorStore(s => s.setTextToolOptions);
  const [heightText, setHeightText] = useState(String(options.height));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Re-layout on every option change. A stale font load (the user switched
  // fonts again before it finished) is dropped.
  useEffect(() => {
    let cancelled = false;
    const store = useSketchEditorStore.getState();
    store.setTextPlacement(null);
    store.setPreview(null);
    const text = options.text;
    if (text.trim() === '' || !(options.height > 0)) return;
    loadSketchFont(options.fontId).then(
      (font) => {
        if (cancelled) return;
        const primitives = textToPrimitives(font, text, { height: options.height });
        useSketchEditorStore.getState().setTextPlacement(
          primitives.length > 0
            ? { primitives, loops: sampleLoops(primitives), label: `Text "${text}"` }
            : null,
        );
      },
      (e: unknown) => {
        if (cancelled) return;
        enqueueToast({ tone: 'warning', title: 'Font not loaded', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => { cancelled = true; };
  }, [options.text, options.fontId, options.height]);

  // Leaving the tool drops the outline so nothing lingers under the cursor.
  useEffect(() => () => useSketchEditorStore.getState().setTextPlacement(null), []);

  const commitHeight = (raw: string): void => {
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) setOptions({ height: v });
    else setHeightText(String(options.height));
  };

  return (
    <div
      style={styles.overlay}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        if (e.key === 'Enter') (e.target as HTMLElement).blur?.();
      }}
    >
      <div style={styles.panel}>
        <PanelHeader title="Text" icon={<Type size={13} color="#0164D4" />} onClose={onClose} />
        <div style={styles.body}>
          <label style={styles.row}>
            <span style={styles.label}>Text</span>
            <input
              ref={inputRef}
              style={styles.input}
              value={options.text}
              onChange={(e) => setOptions({ text: e.target.value })}
              spellCheck={false}
            />
          </label>
          <label style={styles.row}>
            <span style={styles.label}>Font</span>
            <select
              style={styles.input}
              value={options.fontId}
              onChange={(e) => setOptions({ fontId: e.target.value as SketchFontId })}
            >
              {SKETCH_FONTS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label style={styles.row}>
            <span style={styles.label}>Height</span>
            <input
              style={{ ...styles.input, width: 70, flex: 'none' }}
              type="number"
              min={0.1}
              step={1}
              value={heightText}
              onChange={(e) => {
                setHeightText(e.target.value);
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setOptions({ height: v });
              }}
              onBlur={(e) => commitHeight(e.target.value)}
            />
            <span style={styles.unit}>mm</span>
          </label>
        </div>
      </div>
    </div>
  );
}

/** Split chained primitives into closed loops and sample them into polylines. */
function sampleLoops(prims: readonly DxfPrimitive[]): [number, number][][] {
  const loops: [number, number][][] = [];
  let loop: [number, number][] = [];
  let prevEnd: readonly [number, number] | null = null;
  for (const p of prims) {
    if (p.kind !== 'line' && p.kind !== 'bezier') continue;
    if (!prevEnd || prevEnd[0] !== p.start[0] || prevEnd[1] !== p.start[1]) {
      if (loop.length > 1) loops.push(loop);
      loop = [[p.start[0], p.start[1]]];
    }
    if (p.kind === 'line') {
      loop.push([p.end[0], p.end[1]]);
    } else {
      for (let i = 1; i <= PREVIEW_SAMPLES; i++) {
        const t = i / PREVIEW_SAMPLES, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        loop.push([
          a * p.start[0] + b * p.cp1[0] + c * p.cp2[0] + d * p.end[0],
          a * p.start[1] + b * p.cp1[1] + c * p.cp2[1] + d * p.end[1],
        ]);
      }
    }
    prevEnd = p.end;
  }
  if (loop.length > 1) loops.push(loop);
  return loops;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
    zIndex: 50, pointerEvents: 'auto',
  },
  panel: {
    background: '#fff', border: '1px solid #d0d0d0', borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)', width: 280, overflow: 'hidden',
  },
  body: { display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { width: 48, fontSize: 12, color: '#666' },
  input: {
    flex: 1, minWidth: 0, height: 28, padding: '0 8px', border: '1px solid #d0d0d0',
    borderRadius: 5, fontSize: 13, color: '#222', background: '#fff',
  },
  unit: { fontSize: 12, color: '#888' },
};

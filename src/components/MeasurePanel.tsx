/**
 * MeasurePanel — what is the thing I just clicked?
 *
 * Driven by the current selection rather than being a modal pick tool. The
 * app already resolves clicks to a body, face or edge for every other
 * operation; adding a parallel picking mode would mean a second way to point
 * at the same geometry, with its own highlight rules to keep in step. Open
 * the panel and click around instead.
 *
 * Numbers come from the kernel's BREP, not the display mesh (see
 * `cadWorker.measure`), so a cylinder reads πr²h rather than a facet count.
 */

import { useEffect, useState } from 'react';
import { PanelHeader } from './PanelHeader.tsx';
import { MeasureIcon } from '../icons/cadIcons.tsx';
import type { MeasureResult, MeasureTarget } from '@tweakcad/worker/src/protocol.ts';

interface MeasurePanelProps {
  /** What is selected right now, or null. */
  target: MeasureTarget | null;
  /** Runs the measurement in the worker. */
  measure: (target: MeasureTarget) => Promise<MeasureResult | null>;
  onClose: () => void;
}

/**
 * Significant figures rather than fixed decimals: a 0.05 mm fillet radius and
 * a 400 mm plate both have to read usefully in the same column, and `toFixed`
 * shows the first as 0.05 and the second as 400.00000.
 */
function fmt(value: number, unit: string): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 1 : abs >= 1 ? 3 : 5;
  return `${Number(value.toFixed(digits))} ${unit}`;
}

function vec(v: readonly [number, number, number]): string {
  return v.map(n => Number(n.toFixed(3))).join(', ');
}

export function MeasurePanel({ target, measure, onClose }: MeasurePanelProps) {
  // Stored with the target it describes, so "still measuring" is derived
  // rather than a second flag that can fall out of step with the first — and
  // so a result can never render under a selection it does not belong to.
  // The selection changes on every viewport click, and measurements return
  // out of order often enough for that to matter.
  const [measured, setMeasured] = useState<
    { key: string; value: MeasureResult | null } | null
  >(null);

  // Keyed by value, not identity. `target` is derived from the selection
  // store, which fires on hover as well as click, so it is a fresh object
  // many times a second while the pointer crosses a model — comparing by
  // reference would never match and the panel would sit on "Measuring…"
  // forever.
  const key = target ? JSON.stringify(target) : null;

  useEffect(() => {
    if (!target || !key) return;
    let cancelled = false;
    void measure(target)
      .then(value => { if (!cancelled) setMeasured({ key, value }); })
      .catch(() => { if (!cancelled) setMeasured({ key, value: null }); });
    return () => { cancelled = true; };
    // `key` stands in for `target` — same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, measure]);

  const current = key !== null && measured?.key === key ? measured : null;
  const pending = key !== null && current === null;
  const result = current?.value ?? null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>
        <PanelHeader
          title="Measure"
          icon={<MeasureIcon size={14} color="#0d9488" />}
          onClose={onClose}
          closeTitle="Close (Esc)"
        />
        <div style={styles.body}>
          {!target && (
            <div style={styles.hint}>Click a body, face or edge in the viewport.</div>
          )}
          {target && pending && <div style={styles.hint}>Measuring…</div>}
          {target && !pending && !result && (
            // Distinguishable from "nothing selected": the user did pick
            // something, and it could not be measured.
            <div style={styles.hint}>
              That selection can&rsquo;t be measured — it may belong to a
              feature that failed to build.
            </div>
          )}
          {result?.kind === 'edge' && (
            <Row label="Length" value={fmt(result.length, 'mm')} />
          )}
          {result?.kind === 'face' && (
            <Row label="Area" value={fmt(result.area, 'mm²')} />
          )}
          {result?.kind === 'body' && (
            <>
              <Row label="Volume" value={fmt(result.volume, 'mm³')} />
              <Row label="Surface" value={fmt(result.surfaceArea, 'mm²')} />
              <Row label="Centroid" value={vec(result.centerOfMass)} />
              <Row
                label="Size"
                value={vec([
                  result.boundingBox.max[0] - result.boundingBox.min[0],
                  result.boundingBox.max[1] - result.boundingBox.min[1],
                  result.boundingBox.max[2] - result.boundingBox.min[2],
                ])}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.row}>
      <span style={styles.label}>{label}</span>
      <span style={styles.value}>{value}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'absolute', top: 12, right: 12, zIndex: 50, pointerEvents: 'auto' },
  panel: {
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    width: 268,
    overflow: 'hidden',
  },
  body: { padding: '8px 12px 12px' },
  hint: { fontSize: 12, color: '#999', fontStyle: 'italic', padding: '4px 0' },
  row: {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: 10, padding: '4px 0',
  },
  label: {
    fontSize: 11, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.3,
  },
  value: { fontSize: 13, fontFamily: 'monospace', color: '#222' },
};

/**
 * Picking the plane a new sketch goes on: the standard planes show, and a
 * click on one of them, on a construction plane or on a flat face of the
 * part starts the sketch there; so does a standard plane clicked in the
 * browser. A curved face is a miss; a click on empty space or Escape
 * cancels. The banner counts the construction planes shown and says what
 * the pointer is over ("XY highlighted", "this face is not flat"). A
 * drawing waiting for File > Import goes into the sketch made here.
 */
import { useEffect, useState } from 'react';
import type { PanelProps } from '../AppShell';
import { useSlice } from '../hooks';
import type { AppServices } from '../services';
import { activePart, hoverNote, planeProblem, sketchOn } from './commands';
import { bindPendingDrawing, dropPendingDrawing } from './sketchFiles';
import { useTreeClicks } from './usePanel';
import { takeClicks } from './viewportClicks';

/** The construction planes shown in the part a new sketch goes in. */
function constructionPlanes(services: AppServices): number {
  const display = services.display.getState().display;
  const part = activePart(services);
  const index = part === null ? undefined : display?.parts[part];
  const definition = index === undefined ? undefined : display?.definitions[index];
  return definition?.construction.filter((c) => c.kind === 'plane' && c.visible).length ?? 0;
}

export function SketchPlanePanel({ services, viewport, close }: PanelProps) {
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const hover = useSlice(services.selection, (s) => s.hover);
  const planes = useSlice(services.display, () => constructionPlanes(services));

  // A drawing still waiting when the picker closes without a plane is dropped (not when it only mounts again).
  useEffect(
    () => () => {
      setTimeout(() => {
        if (services.app.getState().panel?.kind !== 'sketchPlane') dropPendingDrawing();
      }, 0);
    },
    [services],
  );

  useEffect(() => {
    let current = true;
    void hoverNote(services, hover).then((text) => {
      if (current) setNote(text);
    });
    return () => {
      current = false;
    };
  }, [services, hover]);

  useEffect(() => {
    const { app } = services;
    app.setState({ picking: { kinds: ['standard', 'construction', 'face'], standardPlanes: true } });
    return () => app.setState({ picking: null });
  }, [services]);

  useEffect(() => {
    if (!viewport) return;
    let busy = false;
    // A check still running when the picker closes starts no sketch.
    let live = true;
    const stop = takeClicks(services, viewport, (item) => {
      if (busy) return;
      if (!item) {
        close();
        return;
      }
      busy = true;
      void planeProblem(services, item)
        .then(async (why) => {
          if (!live) return;
          setProblem(why);
          if (why === null) await sketchOn(services, item, bindPendingDrawing);
        })
        .finally(() => {
          busy = false;
        });
    });
    return () => {
      live = false;
      stop();
    };
  }, [viewport, services, close]);

  useTreeClicks(services, (item) => {
    if ('standard' in item) void sketchOn(services, item, bindPendingDrawing);
  });

  return (
    <div style={styles.banner}>
      <div style={styles.bannerTitle}>Select a sketch plane</div>
      <div style={styles.bannerHint}>
        Click <b style={{ color: '#3b82f6' }}>XY</b>, <b style={{ color: '#22c55e' }}>XZ</b>, or{' '}
        <b style={{ color: '#ef4444' }}>YZ</b>
        {planes > 0 ? (
          <>
            , or one of the{' '}
            <b style={{ color: '#3b82f6' }}>
              {planes} construction plane{planes === 1 ? '' : 's'}
            </b>
          </>
        ) : null}
        , or a flat face of a body
        {note ? `; ${note}` : problem ? `; ${problem.charAt(0).toLowerCase()}${problem.slice(1)}` : ''}.
        <br />
        <span style={{ color: '#999' }}>Esc to cancel.</span>
      </div>
      <button type="button" style={styles.cancelBtn} onClick={close}>
        Cancel
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#fff',
    border: '1px solid #d8d8d8',
    borderRadius: 6,
    boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
    padding: '10px 16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    zIndex: 30,
    minWidth: 260,
    pointerEvents: 'auto',
  },
  bannerTitle: { fontSize: 13, fontWeight: 600, color: '#222' },
  bannerHint: { fontSize: 11, color: '#666', lineHeight: 1.4 },
  cancelBtn: {
    marginTop: 4,
    padding: '4px 10px',
    fontSize: 11,
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    background: '#f7f7f7',
    color: '#333',
    cursor: 'pointer',
  },
};

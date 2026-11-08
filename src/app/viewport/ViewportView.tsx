/**
 * The viewport in the layout: mounts a `Viewport` on its canvas and keeps it
 * in step with the display, the document's root, the selection and the
 * app's mode. Clicks select (Shift or Ctrl adds), hovering highlights.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ViewCubeOverlay } from '../../components/ViewCubeOverlay.tsx';
import { ViewportToolbar } from '../../components/ViewportToolbar.tsx';
import type { AppState, SectionView } from '../appState';
import type { AppServices } from '../services';
import { useSlice } from '../hooks';
import { assemblyDisplay, inContextOf, instanceIndex, shownOf } from '../assembly/focus';
import { clearSelection, select, setHover } from '../selection';
import { ALL_PICKS } from './ModelScene';
import { Viewport, viewAlong } from './Viewport';
import { sectionCut, sectionDistance } from './sectionCut';

export interface ViewportViewProps {
  services: AppServices;
  /** Told the viewport once it exists (and null when it goes). */
  onViewport?: (viewport: Viewport | null) => void;
  /** Drawn over the viewport: a sketch session's labels, a panel. */
  children?: React.ReactNode;
}

export function ViewportView({ services, onViewport, children }: ViewportViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const mode = useSlice(services.app, (s) => s.mode);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const vp = new Viewport(canvas);
    const resize = () => vp.resize(container.clientWidth, container.clientHeight);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    setViewport(vp);
    onViewport?.(vp);
    return () => {
      observer.disconnect();
      onViewport?.(null);
      setViewport(null);
      vp.dispose();
    };
  }, [onViewport]);

  // Display and root: redraw; a new document is framed once its first display arrives.
  useEffect(() => {
    if (!viewport) return;
    const { display, editor } = services;
    let pendingFrame = true;
    const draw = () => {
      const { focus, exploded } = services.app.getState();
      const shown = display.getState().display;
      const context = inContextOf(editor.document, focus);
      const edited = context ? instanceIndex(assemblyDisplay(shown, context.assembly), context.at) : -1;
      viewport.model.setDisplay(shown, shownOf(editor.document, focus), {
        exploded,
        ...(context && edited >= 0 ? { faded: (i: number) => i !== edited, own: edited } : {}),
      });
      if (pendingFrame && display.getState().display) {
        pendingFrame = false;
        viewport.resetView();
      }
      viewport.requestRender();
    };
    const offStore = editor.store.subscribe((change) => {
      if (change.cause === 'replace') pendingFrame = true;
    });
    draw();
    const offDisplay = display.subscribe((s, prev) => {
      if (s.display !== prev.display) draw();
    });
    const offApp = services.app.subscribe((s, prev) => {
      if (s.focus !== prev.focus || s.exploded !== prev.exploded) draw();
    });
    return () => {
      offStore();
      offDisplay();
      offApp();
    };
  }, [viewport, services]);

  // Selection and hover.
  useEffect(() => {
    if (!viewport) return;
    const { selection } = services;
    const apply = () => {
      const s = selection.getState();
      viewport.model.setSelection(s.items);
      viewport.model.setHover(s.hover);
      viewport.requestRender();
    };
    apply();
    viewport.onHover((item) => setHover(selection, item));
    viewport.onClick((item, mods) => {
      const additive = mods.shift || mods.ctrl;
      if (item) select(selection, item, additive);
      else if (!additive) clearSelection(selection);
    });
    const off = selection.subscribe(apply);
    return () => {
      off();
      viewport.onHover(null);
      viewport.onClick(null);
    };
  }, [viewport, services]);

  // Mode: bodies ghost, the edited sketch's display drawing hides and model picks stop while a sketch is open.
  // A panel that picks narrows what picks land on, and may show the standard planes to pick from.
  useEffect(() => {
    if (!viewport) return;
    const apply = () => {
      const state = services.app.getState();
      const { mode, standardPlanesVisible, picking } = state;
      const sketching = mode.kind === 'sketch';
      viewport.model.setMode(sceneMode(state));
      viewport.model.setStandardPlanesVisible(
        picking?.standardPlanes === true || (!sketching && standardPlanesVisible),
      );
      viewport.model.setPickFilter(picking ? new Set(picking.kinds) : ALL_PICKS);
      viewport.setPicking(!sketching);
      viewport.setGridVisible(!sketching);
      viewport.requestRender();
    };
    apply();
    return services.app.subscribe(apply);
  }, [viewport, services]);

  // Opaque bodies hide the regions behind them from picks, except while a panel previews its feature.
  useEffect(() => {
    if (!viewport) return;
    const apply = () => viewport.model.setRegionsOccluded(!services.display.getState().preview);
    apply();
    return services.display.subscribe(apply);
  }, [viewport, services]);

  // The section view: the cut the Section panel holds. A drag of its handle writes the distance back;
  // a cut that only moved slides, one that turned is made again.
  useEffect(() => {
    if (!viewport) return;
    let shown: SectionView | null = null;
    const follow = () => {
      const { section } = services.app.getState();
      if (section === shown) return;
      shown = section;
      if (!section) {
        viewport.setSection(null);
        return;
      }
      const cut = sectionCut(section);
      const now = viewport.sectionCut();
      const sameNormal = now !== null && cut.normal.every((c, i) => Math.abs(c - (now.normal[i] as number)) < 1e-9);
      if (sameNormal && cut.point) {
        viewport.moveSection(cut.point);
        return;
      }
      viewport.setSection({
        normal: cut.normal,
        ...(cut.point ? { point: cut.point } : {}),
        onMove: (point) => {
          const current = services.app.getState().section;
          if (current)
            services.app.setState({
              section: { ...current, distance: Math.round(sectionDistance(current, point) * 1000) / 1000 },
            });
        },
      });
      // Placed through the bodies' centre: the panel shows where that is.
      const placed = viewport.sectionCut();
      if (section.distance === null && placed)
        services.app.setState({
          section: { ...section, distance: Math.round(sectionDistance(section, placed.point) * 1000) / 1000 },
        });
    };
    follow();
    const off = services.app.subscribe(follow);
    return () => {
      off();
      viewport.setSection(null);
    };
  }, [viewport, services]);

  // Entering a sketch looks at its plane head-on, as Home does while sketching; leaving it keeps the view.
  useEffect(() => {
    if (!viewport) return;
    const follow = sketchViewFollower(viewport);
    const update = () => {
      const { mode } = services.app.getState();
      follow(mode.kind === 'sketch' ? mode.feature : null);
    };
    update();
    return services.app.subscribe(update);
  }, [viewport, services]);

  return (
    <div ref={containerRef} style={styles.container}>
      <canvas ref={canvasRef} style={styles.canvas} />
      <ViewCubeOverlay
        onViewChange={(theta, phi) => viewport?.goToView(theta, phi)}
        getMainCameraQuaternion={() => (viewport ? new THREE.Quaternion().copy(viewport.getCameraQuaternion()) : null)}
      />
      <ViewportToolbar
        controller={viewport}
        onHome={mode.kind === 'sketch' && viewport ? () => lookAtSketch(viewport, mode.feature) : undefined}
      />
      {children}
    </div>
  );
}

/** How the scene draws for the app's state: a sketch being edited ghosts the bodies and hides its own drawing; a panel's sketches show. */
export function sceneMode(state: Pick<AppState, 'mode' | 'shownSketches'>): {
  ghost: boolean;
  hiddenSketch: string | null;
  shownSketches: readonly string[];
} {
  const { mode, shownSketches } = state;
  return mode.kind === 'sketch'
    ? { ghost: true, hiddenSketch: mode.feature, shownSketches }
    : { ghost: false, hiddenSketch: null, shownSketches };
}

/**
 * What the view does as sketches are entered and left, given the sketch
 * edited now (null for none): entering one looks at it head-on, with its
 * axes to screen right and up; leaving it (Finish Sketch) keeps the view
 * where it is, with the camera's up the model's again.
 */
export function sketchViewFollower(viewport: Viewport): (feature: string | null) => void {
  let editing: string | null = null;
  return (feature) => {
    if (feature === editing) return;
    if (feature !== null) lookAtSketch(viewport, feature);
    else viewport.setCameraUp([0, 1, 0]);
    editing = feature;
  };
}

/** Turns the view to look at a sketch's plane head-on, its axes to screen right and up, framing the model. */
export function lookAtSketch(viewport: Viewport, feature: string): void {
  const frame = viewport.model.sketchFrame(feature);
  if (!frame) return;
  const { theta, phi } = viewAlong(frame.normal);
  viewport.setCameraUp(frame.y);
  viewport.goToView(theta, phi, true);
}

const styles: Record<string, React.CSSProperties> = {
  container: { flex: 1, position: 'relative', overflow: 'hidden' },
  canvas: { width: '100%', height: '100%', display: 'block' },
};

/**
 * Sketch mode over the viewport: a sketch session on the edited sketch,
 * fed by the viewport's pointer (as points on the sketch plane) and the
 * keyboard, drawing into the scene, with its palette, browser, tool options,
 * constraint glyphs and dimension labels. The project and intersect tools
 * pick model geometry here and hand the session its curves. Leaving sketch
 * mode, by Finish Sketch or otherwise, finishes and disposes the session.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { enqueueToast } from '../../components/toastStore.ts';
import { isEditableTarget } from '../../components/toolShortcuts.ts';
import {
  ConstraintGlyphs,
  DimensionLabels,
  SketchBrowser,
  SketchPalette,
  ToolOptions,
  openSketchSession,
  toolCursor,
  type ExternalShape,
  type SketchSession,
} from '../../sketcher';
import type { SketchSlotProps } from '../AppShell';
import { consoleLog } from '../console';
import { isPickedRegion } from '../picking';
import type { AppServices } from '../services';
import { settled, startExtrude } from './commands';
import { regionKeysAt } from './profiles';
import { takePendingDrawing } from './sketchFiles';

/** The open sketch session, for what sits outside the viewport (the ribbon). */
export type SessionStore = StoreApi<{ session: SketchSession | null }>;

export function createSessionStore(): SessionStore {
  return createStore(() => ({ session: null as SketchSession | null }));
}

/** The external curves the shown display built for a sketch. */
function shownExternals(services: AppServices, part: string, feature: string): ExternalShape[] {
  const display = services.display.getState().display;
  const index = display?.parts[part];
  const definition = index === undefined ? undefined : display?.definitions[index];
  return definition?.sketches.find((s) => s.feature === feature)?.externals ?? [];
}

/**
 * Selects in the model the regions of a sketch just left that held
 * `points` (sketch-frame points inside the regions selected in it), once the
 * evaluation of the finished sketch is shown; returns their keys.
 */
async function selectRegions(
  services: AppServices,
  part: string,
  feature: string,
  points: readonly (readonly [number, number])[],
): Promise<number[]> {
  if (points.length === 0) return [];
  await settled(services);
  const display = services.display.getState().display;
  const keys = regionKeysAt(display, part, feature, points);
  if (keys.length > 0)
    services.selection.setState({ items: keys.map((key) => ({ key })), generation: display?.generation ?? null });
  return keys;
}

/**
 * Ends a session as sketch mode is left: a sketch left with degrees of
 * freedom says once in the console how many, and what no dimension sizes.
 */
export function closeSketchSession(session: SketchSession): void {
  const hint = session.underDefinedHint();
  if (hint !== null) consoleLog('info', hint, 'sketch');
  session.finish();
  session.dispose();
}

export function SketchMode({ services, mode, viewport, sessions }: SketchSlotProps & { sessions: SessionStore }) {
  const [session, setSession] = useState<SketchSession | null>(null);
  const { part, feature } = mode;
  /** Set when leaving for Extrude, which carries the selected regions itself. */
  const extruding = useRef(false);

  // Open a session on the sketch once its frame is shown; finish and dispose it on the way out.
  useEffect(() => {
    if (!viewport) return;
    const { app, editor } = services;
    let cancelled = false;
    let opened: SketchSession | null = null;
    const group = new THREE.Group();
    group.name = 'sketch session';
    viewport.getScene().add(group);
    const leave = (message: string) => {
      consoleLog('warn', message, 'sketch');
      enqueueToast({ tone: 'warning', title: 'Edit Sketch', message });
      app.setState({ mode: { kind: 'model' } });
    };
    const start = async () => {
      let frame = viewport.model.sketchFrame(feature);
      if (!frame) {
        await settled(services);
        frame = viewport.model.sketchFrame(feature);
      }
      if (cancelled) return;
      if (!frame)
        return leave('This sketch is not shown, so it cannot be edited: it is past the rollback or does not build.');
      const s = await openSketchSession(
        { editor, part, feature, frame, group, requestRender: () => viewport.requestRender() },
        { externals: shownExternals(services, part, feature) },
      );
      if (cancelled) {
        s.dispose();
        return;
      }
      opened = s;
      setSession(s);
      sessions.setState({ session: s });
      // A sketch made for File > Import opens with the file's curves.
      takePendingDrawing(s, feature);
    };
    start().catch((e: unknown) => {
      if (!cancelled) leave(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      if (opened) {
        // Regions selected in the sketch stay selected in the model, for Extrude or Revolve.
        const points = extruding.current ? [] : opened.selectedRegionPoints();
        closeSketchSession(opened);
        void selectRegions(services, part, feature, points);
      }
      setSession(null);
      sessions.setState({ session: null });
      viewport.getScene().remove(group);
      viewport.requestRender();
    };
  }, [viewport, services, sessions, part, feature]);

  // Each new display brings the external curves as evaluation built them.
  useEffect(() => {
    if (!session) return;
    return services.display.subscribe((state, prev) => {
      if (state.display !== prev.display && !state.preview)
        session.setExternals(shownExternals(services, part, feature));
    });
  }, [session, services, part, feature]);

  // Pointer events on the sketch plane go to the session first; the project and intersect tools pick the model.
  useEffect(() => {
    if (!viewport || !session) return;
    const frame = session.host.frame;
    let busy = false;
    // A pick still on its way when the session closes or the tool changes adds nothing.
    let live = true;
    // A press the session took ends where the pointer was last on the plane when it is released off the canvas,
    // and is abandoned when the window loses focus mid-gesture.
    let held: { uv: [number, number]; pixel: number; shift: boolean; ctrl: boolean; alt: boolean } | null = null;
    viewport.setPointerHandler((e) => {
      const tool = session.tool;
      if ((tool === 'project' || tool === 'intersect') && e.type === 'down' && e.button === 0) {
        const item = viewport.pickAt(e.clientX, e.clientY);
        if (!item || !('key' in item) || busy) return true;
        busy = true;
        void (async () => {
          try {
            const shapes = await services.client.externalCurves(item.key, tool, frame);
            if (!live || session.tool !== tool) return;
            if ('pause' in shapes) return void session.refuseWith(capitalise(shapes.pause));
            const picked = await services.pick(item, { before: feature });
            if (!live || session.tool !== tool) return;
            if (!picked || isPickedRegion(picked))
              return void session.refuseWith('That is not in the model before this sketch');
            session.addExternal(picked, tool, shapes.shapes);
          } catch (e: unknown) {
            if (live) session.refuseWith(e instanceof Error ? e.message : String(e));
          } finally {
            busy = false;
            viewport.requestRender();
          }
        })();
        return true;
      }
      const at = viewport.planePoint(e.clientX, e.clientY, frame);
      if (!at) return false;
      const used = session.pointer({
        type: e.type,
        uv: at.uv,
        pixel: at.pixel,
        button: e.button,
        shift: e.shift,
        ctrl: e.ctrl,
        alt: e.alt,
      });
      if (e.type === 'down' && e.button === 0 && used)
        held = { uv: at.uv, pixel: at.pixel, shift: e.shift, ctrl: e.ctrl, alt: e.alt };
      else if (e.type === 'move' && held) held = { ...held, uv: at.uv, pixel: at.pixel };
      else if (e.type === 'up' && e.button === 0) held = null;
      viewport.requestRender();
      return used;
    });
    const canvas = viewport.getCanvas();
    const onUp = (e: MouseEvent) => {
      if (!held || e.button !== 0 || e.target === canvas) return;
      const { uv, pixel, shift, ctrl, alt } = held;
      held = null;
      session.pointer({ type: 'up', uv, pixel, button: 0, shift, ctrl, alt });
      viewport.requestRender();
    };
    const onBlur = () => {
      if (!held) return;
      held = null;
      session.cancelGesture();
      viewport.requestRender();
    };
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      live = false;
      viewport.setPointerHandler(null);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [viewport, session, services, feature]);

  // A crosshair over the viewport while a tool other than Select is on.
  useEffect(() => {
    if (!viewport || !session) return;
    const canvas = viewport.getCanvas();
    const show = () => {
      canvas.style.cursor = toolCursor(session.getState().tool);
    };
    show();
    const stop = session.subscribe(show);
    return () => {
      stop();
      canvas.style.cursor = '';
    };
  }, [viewport, session]);

  // Keys go to the session before the shell's own (so Escape first cancels the tool in progress).
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (session.key(e)) {
        e.preventDefault();
        viewport?.requestRender();
        return;
      }
      // E extrudes the regions selected in the sketch: the sketch is finished and Extrude opens on them.
      if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault();
        const points = session.selectedRegionPoints();
        extruding.current = true;
        services.app.setState({ mode: { kind: 'model' } });
        void selectRegions(services, part, feature, points).then((keys) => startExtrude(services, feature, keys));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [session, viewport, services, part, feature]);

  // The sketch went away (an undo removed it): back to modelling.
  useEffect(() => {
    if (!session) return;
    const check = () => {
      if (!session.getState().open) services.app.setState({ mode: { kind: 'model' } });
    };
    check();
    return session.subscribe(check);
  }, [session, services]);

  if (!session || !viewport) return null;
  const project = (at: [number, number, number]) => viewport.toScreen(at);
  return (
    <>
      <ConstraintGlyphs session={session} project={project} />
      <DimensionLabels session={session} project={project} />
      <SketchBrowser session={session} />
      <ToolOptions session={session} />
      <SketchPalette session={session} onFinish={() => services.app.setState({ mode: { kind: 'model' } })} />
    </>
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

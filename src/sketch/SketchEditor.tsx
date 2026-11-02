/**
 * SketchEditor - React component for the sketch editor.
 *
 * This replaces the old SketchOverlay. Instead of a Canvas2D overlay,
 * sketch entities are rendered as Three.js objects in the 3D scene
 * via SketchSceneManager.
 *
 * This component:
 * - Manages the SketchSceneManager lifecycle (create on enter, dispose on exit)
 * - Handles mouse events for tools (delegates to sketchTools.ts)
 * - Subscribes to the SketchEditorStore and syncs the 3D scene
 * - Renders an invisible overlay div for pointer event capture during drawing
 *
 * The actual Three.js objects are in the same scene as the CAD bodies,
 * on the sketch plane. User can orbit while sketching.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';
import type { SketchToolId } from '@tweakcad/core/src/sketch/types.ts';
import type { FeatureId } from '@tweakcad/core/src/ids.ts';
import { SketchSceneManager, type SketchPlaneInput } from './SketchSceneManager.ts';
import { useSketchEditorStore } from './SketchEditorStore.ts';
import { DimensionsOverlay } from './DimensionsOverlay.tsx';
import { TextToolPanel } from './TextToolPanel.tsx';
import { OffsetDistanceInput } from './OffsetDistanceInput.tsx';
import { subscribeSketchHydration } from './sketchHydration.ts';
import {
  resetToolSession,
  handleToolClick,
  handleToolMove,
  handleToolPointerUp,
  handleToolEscape,
  handleToolEnter,
} from './sketchTools.ts';
import { dispatchRemoveSketchEntity } from './sketchDispatch.ts';

/** Refresh the Text tool's screen frame from the camera at the cursor. */
function syncTextFrame(manager: SketchSceneManager, clientX: number, clientY: number): void {
  const frame = manager.screenFrameAt(clientX, clientY);
  if (frame) useSketchEditorStore.getState().setTextFrame(frame);
}

// ---- Props ----

interface SketchEditorProps {
  /** Whether sketch mode is active */
  isActive: boolean;
  /** The viewport controller (for scene access) */
  viewportCtrl: ViewportController | null;
  /**
   * Which plane we're sketching on. A bare 'XY'|'XZ'|'YZ' name is a default
   * datum plane; a full config carries an explicit world basis (used for
   * construction planes so geometry draws at the plane's real location).
   */
  planeName: SketchPlaneInput;
  /** Current active tool */
  activeTool: SketchToolId;
  /**
   * Active sketch feature id. Drives the document → editor hydration
   * subscription — when this id is set, the subscriber wires
   * up and reflects every doc change back into the editor store.
   * Null when no sketch is being edited.
   */
  sketchId: FeatureId | null;
  /** Callback to change the active tool — used when Escape reverts to Select. */
  onActiveToolChange?: (tool: SketchToolId) => void;
  /**
   * Fired when the hydration subscriber notices the active sketch
   * feature is gone from the document (typically: undo walked past
   * `CreateSketch`). Shell should exit sketch mode in response so the
   * editor doesn't show stale geometry without a backing feature.
   */
  onSketchRemoved?: () => void;
}

// ---- Component ----

export function SketchEditor({
  isActive,
  viewportCtrl,
  planeName,
  activeTool,
  sketchId,
  onActiveToolChange,
  onSketchRemoved,
}: SketchEditorProps) {
  const sceneManagerRef = useRef<SketchSceneManager | null>(null);
  const forwardedPointerButtonRef = useRef<number | null>(null);
  const store = useSketchEditorStore;

  // Mirror the scene manager into React state so child overlays (e.g.
  // DimensionsOverlay) re-render once it's been created.
  const [sceneManagerState, setSceneManagerState] = useState<SketchSceneManager | null>(null);

  // Create/destroy scene manager when sketch mode enters/exits
  useEffect(() => {
    if (isActive && viewportCtrl) {
      const manager = new SketchSceneManager(viewportCtrl, planeName);
      sceneManagerRef.current = manager;
      // The manager needs the live viewport, so it can only be built here;
      // overlays read it from state.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- publishes the manager this effect created
      setSceneManagerState(manager);

      // Initial sync
      const state = store.getState();
      manager.update(
        state.points,
        state.geometries,
        state.getSketchRegions(),
        state.selectedPointIds,
        state.selectedGeometryIds,
        state.selectedRegionIds,
        state.hoveredTarget,
        state.preview,
        state.activeSnap,
        state.hoveredConstraintRefs,
      );

      return () => {
        manager.dispose();
        sceneManagerRef.current = null;
        setSceneManagerState(null);
      };
    } else {
      if (sceneManagerRef.current) {
        sceneManagerRef.current.dispose();
        sceneManagerRef.current = null;
        setSceneManagerState(null);
      }
    }
  }, [isActive, viewportCtrl, planeName, store]);

  // Subscribe to documentStore so every CadCommand that mutates
  // this sketch's editorModel reflects back into the editor store. The
  // subscriber prunes selections to entities that still exist; live UI
  // state (active tool, preview, hover) is preserved across hydrations.
  // If an undo walks past `CreateSketch`, `onSketchRemoved` fires so
  // Shell can tear down sketch mode instead of leaving the editor
  // showing stale geometry without a backing feature.
  useEffect(() => {
    if (!isActive || !sketchId) return;
    const unsub = subscribeSketchHydration(sketchId, onSketchRemoved);
    return () => {
      unsub();
    };
  }, [isActive, sketchId, onSketchRemoved]);

  // Subscribe to store changes and sync 3D scene
  useEffect(() => {
    if (!isActive) return;

    const unsubscribe = store.subscribe((state: ReturnType<typeof store.getState>) => {
      const manager = sceneManagerRef.current;
      if (!manager) return;

      manager.update(
        state.points,
        state.geometries,
        state.getSketchRegions(),
        state.selectedPointIds,
        state.selectedGeometryIds,
        state.selectedRegionIds,
        state.hoveredTarget,
        state.preview,
        state.activeSnap,
        state.hoveredConstraintRefs,
      );
      // V7 · tint geometry deep-blue when fully defined (DOF=0,
      // no unsatisfied constraints). Selection highlights still
      // win — `setFullyDefinedTint` only touches the default-state
      // material.
      const fullyDefined = state.dof === 0 && state.unsatisfiedConstraints.size === 0;
      manager.setFullyDefinedTint(fullyDefined);
    });

    return unsubscribe;
  }, [isActive, store]);

  // Reset tool session when active tool changes (default to 'select' if null)
  useEffect(() => {
    const effectiveTool = activeTool ?? 'select';
    resetToolSession(effectiveTool);
    store.getState().setActiveTool(effectiveTool);
  }, [activeTool, store]);

  // ---- Mouse Handlers ----

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Forward middle/right clicks to canvas for orbit/pan
    if (e.button !== 0) {
      const canvas = viewportCtrl?.getCanvas();
      if (canvas) {
        forwardedPointerButtonRef.current = e.button;
        const mouseEvent = new MouseEvent('mousedown', {
          button: e.button,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
        });
        canvas.dispatchEvent(mouseEvent);
      }
      return;
    }

    // Left click: sketch tool interaction
    const manager = sceneManagerRef.current;
    if (!manager) return;

    const sketchPos = manager.screenToSketch(e.clientX, e.clientY);
    if (!sketchPos) return;

    // If no tool selected, default to select behavior
    if (!activeTool) {
      resetToolSession('select');
    }
    if (activeTool === 'text') syncTextFrame(manager, e.clientX, e.clientY);
    handleToolClick(store.getState(), sketchPos[0], sketchPos[1], e.shiftKey);
  }, [activeTool, store, viewportCtrl]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (forwardedPointerButtonRef.current !== null) {
      const canvas = viewportCtrl?.getCanvas();
      if (canvas) {
        canvas.dispatchEvent(new MouseEvent('mousemove', {
          button: forwardedPointerButtonRef.current,
          buttons: e.buttons,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
        }));
      }
      return;
    }

    const manager = sceneManagerRef.current;
    if (!manager) return;

    const sketchPos = manager.screenToSketch(e.clientX, e.clientY);
    if (!sketchPos) return;

    // Update hover target for highlighting
    if (activeTool === 'select' || !activeTool) {
      const state = store.getState();
      const profilePicking = state.selectionIntent === 'selectProfileForFeature';
      const hit = manager.hitTest(e.clientX, e.clientY, state.points, state.geometries, state.getSketchRegions(), profilePicking);
      state.setHoveredTarget(hit);
    }

    // Tool move (rubber-band, drag, etc.).
    // Symmetry with handlePointerDown (lines 217-221) and handlePointerUp
    // (line 292, unconditional): all three pointer phases treat a null
    // activeTool as 'select'. Without this, pointerDown would arm a
    // select-drag session and pointerUp would commit it via the bus, but
    // pointerMove would silently skip — drag transitions visible but no
    // geometry movement. Shell enters every sketch with sketchTool=null
    // (Shell.tsx:518/610/674), so the bare `if (activeTool)` branch was
    // dead for every fresh sketch session.
    if (activeTool === 'text') syncTextFrame(manager, e.clientX, e.clientY);
    handleToolMove(store.getState(), sketchPos[0], sketchPos[1]);
  }, [activeTool, store, viewportCtrl]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (forwardedPointerButtonRef.current !== null) {
      const canvas = viewportCtrl?.getCanvas();
      if (canvas) {
        canvas.dispatchEvent(new MouseEvent('mouseup', {
          button: forwardedPointerButtonRef.current,
          buttons: e.buttons,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
        }));
      }
      forwardedPointerButtonRef.current = null;
      return;
    }
    handleToolPointerUp(store.getState());
  }, [store, viewportCtrl]);

  // Keyboard handler for escape and delete
  useEffect(() => {
    if (!isActive) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Two-stage Escape: cancel any in-flight drawing (e.g. mid-line,
        // mid-rectangle) AND revert the active tool to 'select'. Without
        // the tool revert the user stays in (say) Rectangle mode after
        // bailing out, which doesn't match common CAD muscle memory.
        //
        // Exception: when Escape *finalizes* a spline (keeping its points),
        // it returns true — we stay in the spline tool so a second Escape
        // exits, matching Fusion's behavior.
        const finalized = handleToolEscape(store.getState());
        if (!finalized && activeTool !== 'select') {
          onActiveToolChange?.('select');
        }
      }
      if (e.key === 'Enter') {
        handleToolEnter(store.getState());
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Route through the bus so deletion lands in the document's
        // `editorModel` (and hits the undo stack). Going via the
        // editor-only `deleteSelected` action would mutate the editor
        // store but leave the doc unchanged — the next bus dispatch
        // would then trigger `subscribeSketchHydration` to revive the
        // "deleted" geometry from the still-intact snapshot. The
        // browser-panel × already routes this way; matching the
        // keyboard path is what closes the revert bug.
        //
        // Selected points map to their parent geometry (line endpoint,
        // circle center, `point`-type geometry's pointId, etc.). Deleting
        // the parent geometry GCs the orphan point via the shared
        // `removeGeometry` op (operations.ts), so single-point and
        // whole-geometry deletes both flow through one command.
        const state = store.getState();
        const targets = new Set<string>();
        for (const gid of state.selectedGeometryIds) targets.add(String(gid));
        for (const pid of state.selectedPointIds) {
          for (const [gid, geom] of state.geometries) {
            const ids = state.getGeometryPointIds(gid);
            if (ids.includes(pid)) {
              targets.add(String(geom.id));
              break;
            }
          }
        }
        for (const id of targets) dispatchRemoveSketchEntity(id);
        // Clear selection locally — the hydration round-trip prunes
        // selections to surviving ids but setting empty up front avoids
        // a flash of a still-highlighted but-now-gone row.
        state.clearSelection();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive, store, activeTool, onActiveToolChange]);

  // Forward wheel events to the canvas so zoom always works
  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Re-dispatch the wheel event to the canvas underneath
    const canvas = viewportCtrl?.getCanvas();
    if (canvas) {
      const wheelEvent = new WheelEvent('wheel', {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        bubbles: true,
      });
      canvas.dispatchEvent(wheelEvent);
    }
  }, [viewportCtrl]);

  // Determine the effective tool - default to 'select' when null
  const effectiveTool = activeTool ?? 'select';

  if (!isActive) return null;

  // Render an invisible overlay for pointer event capture, plus the dimension
  // labels / value input overlay and the Offset tool's distance field on top.
  return (
    <>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: 'auto',
          cursor: effectiveTool === 'select' ? 'default' : 'crosshair',
          zIndex: 5,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <DimensionsOverlay sceneManager={sceneManagerState} />
      {effectiveTool === 'text' && <TextToolPanel onClose={() => onActiveToolChange?.('select')} />}
      {effectiveTool === 'offset' && <OffsetDistanceInput />}
    </>
  );
}

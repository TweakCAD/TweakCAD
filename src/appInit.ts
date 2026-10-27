/**
 * Application initialization.
 * Wires CommandBus with all handlers, creates stores,
 * and sets up the rebuild scheduler.
 */

import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { createSelectionStore } from '@tweakcad/core/src/store/selectionStore.ts';
import { createViewportStore } from '@tweakcad/core/src/store/viewportStore.ts';
import { createSketchStore } from '@tweakcad/core/src/store/sketchStore.ts';
import {
  createPartHandler,
  renamePartHandler,
  renameProjectHandler,
} from '@tweakcad/core/src/commands/handlers/partCommands.ts';
import {
  createSketchHandler,
  createSketchFromImportHandler,
  removeSketchEntityHandler,
  createExtrudeHandler,
  createRevolveHandler,
  createLoftHandler,
  createFilletHandler,
  createChamferHandler,
  createHoleHandler,
  createMoveHandler,
  createPrimitiveHandler,
  createMirrorHandler,
  createShellHandler,
  createSweepHandler,
  createImportedGeometryHandler,
  createPatternHandler,
  createComponentHandler,
  createConstructionPlaneHandler,
  suppressFeatureHandler,
  setFeatureVisibilityHandler,
  deleteFeatureHandler,
  reorderFeatureHandler,
  updateFeatureInputHandler,
  replaceFeatureInputsHandler,
} from '@tweakcad/core/src/commands/handlers/featureCommands.ts';
import {
  sketchDrawLineHandler,
  sketchDrawRectangleHandler,
  sketchDrawCircleHandler,
  sketchDrawSlotHandler,
  sketchDrawArcHandler,
  sketchDrawArc3PointHandler,
  sketchDrawPolygonHandler,
  sketchDrawPointHandler,
  sketchDrawEllipseHandler,
  sketchDrawSplineHandler,
  sketchMovePointHandler,
  sketchMovePointsBatchHandler,
  sketchSetRadiusHandler,
  sketchApplyConstraintHandler,
  sketchRemoveConstraintHandler,
  sketchTrimHandler,
  sketchExtendHandler,
  sketchFilletHandler,
  sketchOffsetHandler,
  sketchMirrorHandler,
} from '@tweakcad/core/src/commands/handlers/sketchDrawCommands.ts';
import {
  setParameterHandler,
  deleteParameterHandler,
} from '@tweakcad/core/src/commands/handlers/parameterCommands.ts';
import {
  setConfigurationRowHandler,
  deleteConfigurationRowHandler,
  setActiveConfigurationHandler,
} from '@tweakcad/core/src/commands/handlers/configurationCommands.ts';
import { createDisplayContextStore } from '@tweakcad/core/src/store/displayContextStore.ts';
import { initPlaneGCS } from './sketch/solver/planegcsLoader.ts';

/** Singleton application state */
export type AppState = {
  documentStore: DocumentStore;
  commandBus: CommandBus;
  selectionStore: ReturnType<typeof createSelectionStore>;
  viewportStore: ReturnType<typeof createViewportStore>;
  sketchStore: ReturnType<typeof createSketchStore>;
  displayContextStore: ReturnType<typeof createDisplayContextStore>;
};

let appState: AppState | null = null;

/**
 * Initialize the application.
 * Creates stores, registers command handlers, and wires rebuild pipeline.
 * @returns The initialized application state
 */
export function initializeApp(): AppState {
  if (appState) return appState;

  // Create initial project with a default empty part. Fresh boot starts
  // with no geometry — the user adds a sketch via the ribbon. Coverage
  // for feature/sketch scenarios lives in the targeted unit + e2e tests
  // rather than via the app's default project.
  const project = newProjectWithPart('New Project', 'Part 1');

  // Create stores
  const documentStore = new DocumentStore(project);
  const commandBus = new CommandBus(documentStore);
  const selectionStore = createSelectionStore();
  const viewportStore = createViewportStore();
  const sketchStore = createSketchStore();

  // Register all command handlers
  commandBus.register('RenameProject', renameProjectHandler);
  commandBus.register('CreatePart', createPartHandler);
  commandBus.register('RenamePart', renamePartHandler);
  commandBus.register('CreateSketch', createSketchHandler);
  commandBus.register('CreateSketchFromImport', createSketchFromImportHandler);
  commandBus.register('RemoveSketchEntity', removeSketchEntityHandler);
  // Higher-level drawing commands. Both the in-app chat agent and
  // external MCP clients dispatch these to produce extrudable
  // profiles without manually building shared-point graphs.
  commandBus.register('SketchDrawLine', sketchDrawLineHandler);
  commandBus.register('SketchDrawRectangle', sketchDrawRectangleHandler);
  commandBus.register('SketchDrawCircle', sketchDrawCircleHandler);
  commandBus.register('SketchDrawSlot', sketchDrawSlotHandler);
  commandBus.register('SketchDrawArc', sketchDrawArcHandler);
  commandBus.register('SketchDrawArc3Point', sketchDrawArc3PointHandler);
  commandBus.register('SketchDrawPolygon', sketchDrawPolygonHandler);
  commandBus.register('SketchDrawPoint', sketchDrawPointHandler);
  commandBus.register('SketchDrawEllipse', sketchDrawEllipseHandler);
  commandBus.register('SketchDrawSpline', sketchDrawSplineHandler);
  commandBus.register('SketchMovePoint', sketchMovePointHandler);
  commandBus.register('SketchMovePointsBatch', sketchMovePointsBatchHandler);
  commandBus.register('SketchSetRadius', sketchSetRadiusHandler);
  commandBus.register('SketchApplyConstraint', sketchApplyConstraintHandler);
  commandBus.register('SketchRemoveConstraint', sketchRemoveConstraintHandler);
  // Modify-tool handlers
  commandBus.register('SketchTrim', sketchTrimHandler);
  commandBus.register('SketchExtend', sketchExtendHandler);
  commandBus.register('SketchFillet', sketchFilletHandler);
  commandBus.register('SketchOffset', sketchOffsetHandler);
  commandBus.register('SketchMirror', sketchMirrorHandler);
  commandBus.register('CreateExtrude', createExtrudeHandler);
  commandBus.register('CreateRevolve', createRevolveHandler);
  commandBus.register('CreateLoft', createLoftHandler);
  commandBus.register('CreateFillet', createFilletHandler);
  commandBus.register('CreateChamfer', createChamferHandler);
  commandBus.register('CreateHole', createHoleHandler);
  commandBus.register('CreatePrimitive', createPrimitiveHandler);
  commandBus.register('CreateMove', createMoveHandler);
  commandBus.register('CreateMirror', createMirrorHandler);
  commandBus.register('CreateShell', createShellHandler);
  commandBus.register('CreateSweep', createSweepHandler);
  commandBus.register('CreateImportedGeometry', createImportedGeometryHandler);
  commandBus.register('CreatePattern', createPatternHandler);
  commandBus.register('CreateComponent', createComponentHandler);
  commandBus.register('CreateConstructionPlane', createConstructionPlaneHandler);
  commandBus.register('SuppressFeature', suppressFeatureHandler);
  commandBus.register('SetFeatureVisibility', setFeatureVisibilityHandler);
  commandBus.register('DeleteFeature', deleteFeatureHandler);
  commandBus.register('ReorderFeature', reorderFeatureHandler);
  commandBus.register('UpdateFeatureInput', updateFeatureInputHandler);
  commandBus.register('ReplaceFeatureInputs', replaceFeatureInputsHandler);
  commandBus.register('SetParameter', setParameterHandler);
  commandBus.register('DeleteParameter', deleteParameterHandler);
  commandBus.register('SetConfigurationRow', setConfigurationRowHandler);
  commandBus.register('DeleteConfigurationRow', deleteConfigurationRowHandler);
  commandBus.register('SetActiveConfiguration', setActiveConfigurationHandler);

  const displayContextStore = createDisplayContextStore();

  appState = {
    documentStore,
    commandBus,
    selectionStore,
    viewportStore,
    sketchStore,
    displayContextStore,
  };

  // Dev-only: expose app state on window so the preview-eval debugger
  // (and the browser console) can introspect store state directly.
  // Vite sets import.meta.env.DEV — guarded behind a `try` so node-side
  // tests that don't have Vite's env shim still work.
  try {
    if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
      (globalThis as unknown as { __APP_STATE__: typeof appState }).__APP_STATE__ = appState;
    }
  } catch { /* not in Vite */ }

  // Fire-and-forget WASM init for the planegcs solver. Until this
  // resolves, `getSolver()` throws `PlaneGCSNotReadyError`; the only way
  // to race the boot window is to interact with a sketch within the
  // ~few hundred ms WASM takes to load.
  //
  // Failure is non-fatal at boot but every subsequent sketch operation
  // will surface the not-ready error. A future boot indicator can keep
  // the sketch ribbon disabled until the registry reports ready.
  void initPlaneGCS().catch((err) => {
    console.warn('[solver] planegcs init failed:', err);
  });

  return appState;
}

/**
 * Get the current application state.
 * @returns The current AppState or throws if not initialized
 */
export function getAppState(): AppState {
  if (!appState) throw new Error('App not initialized. Call initializeApp() first.');
  return appState;
}

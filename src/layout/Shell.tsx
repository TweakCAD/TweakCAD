import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { isSaasAvailable } from '../storage/saasState.ts';
import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { ViewportController } from '@tweakcad/viewport/src/ViewportController.ts';
import { useDocumentState, useUndoRedo, useCommandBus } from '../hooks/useDocumentStore.ts';
import { getAppState } from '../appInit.ts';
import type { PartId, FeatureId, BodyId } from '@tweakcad/core/src/ids.ts';
import type { ProfileRef, SketchFeatureInputs, SketchEntity, ExtrudeFeatureInputs, PlaneRef, ConstructionPlaneDisplay, SketchPlaneDisplay, PrimitiveFeatureInputs, PrimitiveKind, MoveFeatureInputs, EdgeRef, FaceRef, SketchEditorSnapshot, LoftFeatureInputs, HoleFeatureInputs } from '@tweakcad/core/src/document/schema.ts';
import { regionToProfileRef } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { sketchToDxf } from '@tweakcad/core/src/sketch/io/dxf.ts';
import { dxfToEditorState } from '@tweakcad/core/src/sketch/io/dxfImport.ts';
import { svgToEditorState, MAX_SVG_IMPORT_PRIMITIVES } from '@tweakcad/core/src/sketch/io/svgImport.ts';
import { toSnapshot } from '@tweakcad/core/src/sketch/operations.ts';
import { sketchToSvg } from '@tweakcad/core/src/sketch/io/svg.ts';
import { resolveAllParameters } from '@tweakcad/core/src/parameters/evaluator.ts';
import { applyActiveConfiguration } from '@tweakcad/core/src/commands/handlers/configurationCommands.ts';
import { downloadText, pickDxfForImport, pickSvgForImport } from '../storage/diskAdapter.ts';
import { computeSketchDof } from '../sketch/sketchDof.ts';
import type { SavedCameraState } from '@tweakcad/core/src/store/sketchStore.ts';
import type { SketchToolId } from '@tweakcad/core/src/sketch/types.ts';
import { useConsoleStore, consoleLog } from '@tweakcad/core/src/store/consoleStore.ts';
import { detectSketchRegions } from '@tweakcad/core/src/sketch/profileRegions.ts';
import { useDisplayMeshes, useTopologyMaps, useRebuilding, useBodyToFeatureMap, useConstructionPlanes, useFeatureResults, useSketchPlanes } from '../hooks/useViewportStore.ts';
import { withDocumentVisibility } from './planeVisibility.ts';
import { computeAllBodyDisplayModes } from '@tweakcad/viewport/src/displayMode.ts';
import type { DisplayContext } from '@tweakcad/core/src/store/displayContextStore.ts';
import { useActivePartId, useDisplayContextActions } from '../hooks/useDisplayContext.ts';
import { findFeaturePartId, resolveActivePartId } from '@tweakcad/core/src/document/featureLookup.ts';
import {
  useSketchActive,
  useSketchActions,
  useActiveSketchId,
} from '../hooks/useSketchStore.ts';
import { ViewportToolbar } from '../components/ViewportToolbar.tsx';
import { ViewCubeOverlay } from '../components/ViewCubeOverlay.tsx';
import { MainAppBar, MainRibbon } from '../components/MainToolbar.tsx';
import { TimelineBar } from '../components/TimelineBar.tsx';
import { ProjectTree } from '../components/ProjectTree.tsx';
import type { ContextMenuAction, TreeBody } from '../components/ProjectTree.tsx';
import { SketchEditor, SketchPalette, useSketchEditorStore } from '../sketch/index.ts';
import { SketchViewer } from '../sketch/SketchViewer.tsx';
import { planeConfigFromBasis, type SketchPlaneInput, type SketchPlaneConfig } from '../sketch/SketchSceneManager.ts';
import { sketchViewForPlane } from '../sketch/sketchView.ts';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { SketchBrowser } from '../sketch/SketchBrowser.tsx';
import { SketchPlanePicker } from '../sketch/SketchPlanePicker.tsx';
import type { SketchPlanePick } from '../sketch/SketchPlanePicker.tsx';
import { applySketchConstraint } from '../sketch/sketchConstraints.ts';
import type { SketchConstraintKind } from '../components/MainToolbar.tsx';
import { ExtrudeDialog } from '../components/ExtrudeDialog.tsx';
import type { ExtrudeDialogResult, ExtrudeDialogInitialValues, ExtrudeFaceSlot, ExtrudePickedFace, ExtrudeTargetPlane } from '../components/ExtrudeDialog.tsx';
import { RevolveDialog } from '../components/RevolveDialog.tsx';
import type { RevolveDialogResult } from '../components/RevolveDialog.tsx';
import { LoftDialog } from '../components/LoftDialog.tsx';
import type { LoftDialogResult, LoftDialogProfileEntry } from '../components/LoftDialog.tsx';
import { FilletDialog } from '../components/FilletDialog.tsx';
import type { FilletDialogResult, FilletDialogEdgeEntry } from '../components/FilletDialog.tsx';
import { ChamferDialog } from '../components/ChamferDialog.tsx';
import type { ChamferDialogResult, ChamferDialogEdgeEntry } from '../components/ChamferDialog.tsx';
import { resolveEdgePick, appendEdgeRefs } from './edgePick.ts';
import { ConstructionPlaneDialog } from '../components/ConstructionPlaneDialog.tsx';
import { SectionPanel, type SectionOrientation } from '../components/SectionPanel.tsx';
import { MovePanel, type MoveTransform } from '../components/MovePanel.tsx';
import type {
  ConstructionPlaneDialogResult,
  ConstructionPlaneKind,
  ConstructionPlanePickedFace,
  ConstructionPlanePickedPlane,
} from '../components/ConstructionPlaneDialog.tsx';
import { HoleDialog } from '../components/HoleDialog.tsx';
import { PrimitiveDialog } from '../components/PrimitiveDialog.tsx';
import { BooleanDialog } from '../components/BooleanDialog.tsx';
import { MeasurePanel } from '../components/MeasurePanel.tsx';
import { measureInWorker } from '../rebuildScheduler.ts';
import type { MeasureTarget } from '@tweakcad/worker/src/protocol.ts';
import type { BooleanDialogResult } from '../components/BooleanDialog.tsx';
import type { PrimitiveDialogResult } from '../components/PrimitiveDialog.tsx';
import { MirrorDialog } from '../components/MirrorDialog.tsx';
import type {
  MirrorDialogPickedBody,
  MirrorDialogResult,
} from '../components/MirrorDialog.tsx';
import { ShellDialog } from '../components/ShellDialog.tsx';
import type {
  ShellDialogFaceEntry,
  ShellDialogResult,
} from '../components/ShellDialog.tsx';
import { PatternDialog } from '../components/PatternDialog.tsx';
import type {
  PatternDialogPickedBody,
  PatternDialogResult,
} from '../components/PatternDialog.tsx';
import { SweepDialog } from '../components/SweepDialog.tsx';
import type {
  SweepDialogResult,
  SweepDialogSketchOption,
} from '../components/SweepDialog.tsx';
import type {
  HoleDialogPickedFace,
  HoleDialogResult,
} from '../components/HoleDialog.tsx';
import { ConsolePanel } from '../components/ConsolePanel.tsx';
import { ComponentsPanel } from '../components/ComponentsPanel/index.ts';
import {
  ChatPanel,
  type ChatMessage,
  type ChatTurnEvent,
  type ChatModelOption,
} from '../components/ChatPanel.tsx';
import { listAvailableModels } from '../ai/chatClient.ts';
import { createBrowserToolHost } from '../ai/browserToolHost.ts';
import { runAgentTurn } from '../ai/agentLoop.ts';
import { setActiveViewport, getActiveViewport } from '../ai/viewportRegistry.ts';
import { useComponentEditor } from '../components/ComponentDialog.tsx';
import { registerThumbnailCapture } from '../storage/thumbnailCapture.ts';
import { featureIconType } from '../icons/cadIcons.tsx';
import { targetsExactly } from '@tweakcad/worker/src/featureBuilders/buildMove.ts';
import type { SaasState } from '../storage/index.ts';

// Sketch ↔ document plumbing notes:
//   - There is no composite `SketchRectangleEntity`/`SketchSlotEntity`;
//     shapes are primitives + constraints (invariant #11).
//   - There is no `syncSketchToDocument`. Every sketch UI gesture
//     dispatches a `Sketch*` CadCommand through the bus, and each
//     handler rebuilds `inputs.buildGeometry` via the canonical
//     `editorModelToBuildGeometry` serializer before the patch lands. The
//     doc is always current; there is no exit-time sync.

/**
 * Resolve a sketch's stored plane reference to a renderer plane input.
 *
 * - A **default plane** maps to its bare name ('XY'/'XZ'/'YZ'), drawn through
 *   the world origin.
 * - A **construction plane** maps to an explicit world basis (origin + axes +
 *   normal) looked up from the live `constructionPlanes` display list the
 *   rebuilder emits — so the sketch draws at the datum plane's real offset
 *   location and orientation, NOT routed through `planeConfigFromName` (which
 *   only knows the three default planes — passing a CP ref there
 *   crashes the editor).
 *
 * - A **body face** maps to the sketch's frame as the last rebuild resolved
 *   it (`sketchPlanes`, keyed by the sketch's own id) — only the worker can
 *   resolve the face, and it moves with upstream dimensions.
 *
 * Falls back to 'XZ' when a construction plane or face hasn't been built yet
 * (or no longer resolves) so the editor degrades instead of throwing.
 */
function resolveSketchPlaneInput(
  plane: PlaneRef | undefined,
  constructionPlanes: ConstructionPlaneDisplay[],
  sketchPlanes: SketchPlaneDisplay[],
  sketchId: string,
): SketchPlaneInput {
  if (plane?.type === 'defaultPlane') return plane.name;
  if (plane?.type === 'constructionPlane') {
    const cp = constructionPlanes.find(p => String(p.featureId) === plane.planeId);
    if (cp) return planeConfigFromBasis(cp);
  }
  if (plane?.type === 'stableTopology') {
    const frame = sketchPlanes.find(p => String(p.featureId) === sketchId);
    if (frame) return planeConfigFromBasis(frame);
  }
  return 'XZ';
}

/**
 * Pick the closest default-plane name for a plane input. For a construction
 * plane this snaps to whichever default plane best matches its normal; it only
 * labels the sketch and serves as the name fallback — the camera looks along
 * the real normal via `sketchViewForPlane`.
 */
function viewNameForPlaneInput(input: SketchPlaneInput): 'XY' | 'XZ' | 'YZ' {
  if (typeof input === 'string') return input;
  const n = input.normal;
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  if (az >= ax && az >= ay) return 'XY'; // normal ≈ world Z
  if (ay >= ax && ay >= az) return 'XZ'; // normal ≈ world Y
  return 'YZ';                            // normal ≈ world X
}

/**
 * Shell - main application layout.
 *
 * Architecture layout:
 *   [Toolbar]
 *   [ProjectTree | 3D Viewport + Inspector (collapsible)]
 *   [Console (collapsible)]
 *   [Timeline]
 */
export type ShellProps = {
  /** File-ops callbacks wired by App.tsx — Shell only forwards them. */
  onFileNew?: () => void;
  onFileOpen?: () => void;
  /**
   * Import a STEP / STL / BREP file as a new feature in the current document.
   * The optional `format` hint lets the dropdown items narrow the file
   * picker to a single format; omitted = accept all.
   */
  onFileImport?: (format?: 'step' | 'stl' | 'brep') => void;
  /**
   * Import a FreeCAD `.fcstd` file as a new document (replaces the active
   * document — a .fcstd carries a whole parametric tree).
   */
  onImportFcstd?: () => void;
  /**
   * Import a parametric component (.cadcomponent / .cadjson) and embed it
   * as an `component` feature in the active part's timeline.
   */
  onComponentImport?: () => void;
  onFileSave?: () => void;
  onFileSaveAs?: () => void;
  /** Export the current part to a downloadable geometry format. */
  onFileExport?: (format: 'stl' | 'step' | 'brep' | '3mf') => Promise<void> | void;
  /** SaaS availability — drives the account chip in the title bar. */
  /** Opens the revision-history panel. Absent when the project is not in the
   *  cloud — a disk file has no history to show. */
  onOpenHistory?: (() => void) | undefined;
  saas?: SaasState;
  /** Open the inline sign-in modal. */
  onRequestSignIn?: () => void;
  /** Sign out + refresh state. */
  onSignOut?: () => void;
  /** Open the Parameters editor (project + per-part scoped). */
  onEditParameters?: () => void;
  /** Open the app-level Settings dialog (wired to the gear icon in the title bar). */
  onOpenSettings?: () => void;
};

export function Shell({
  onFileNew,
  onFileOpen,
  onFileImport,
  onImportFcstd,
  onComponentImport,
  onFileSave,
  onFileSaveAs,
  onFileExport,
  onOpenHistory,
  saas,
  onRequestSignIn,
  onSignOut,
  onEditParameters,
  onOpenSettings,
}: ShellProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<ViewportController | null>(null);
  const [viewportCtrl, setViewportCtrl] = useState<ViewportController | null>(null);
  const project = useDocumentState();
  const { openComponentEditor, componentDialogElement } = useComponentEditor();
  const { canUndo, canRedo, undoLabel, redoLabel, undo, redo } = useUndoRedo();
  const displayMeshes = useDisplayMeshes();
  const topologyMaps = useTopologyMaps();
  const builtPlanes = useConstructionPlanes();
  // The eye toggle doesn't rebuild, so plane visibility comes from the document.
  const constructionPlanes = useMemo(() => withDocumentVisibility(builtPlanes, project), [builtPlanes, project]);
  const featureResults = useFeatureResults();
  const rebuilding = useRebuilding();
  const bodyToFeatureMap = useBodyToFeatureMap();
  const sketchPlanes = useSketchPlanes();

  /**
   * The part every creation command targets. Resolved against the live
   * document so it survives the active part going away (an undo of
   * `CreatePart`), and so a single-part project needs no activation at
   * all — it resolves to that part.
   *
   * Commands that act on an *existing* feature use the feature's owner
   * part instead (`findFeaturePartId`), which is not the same thing: the
   * tree shows every part's features, so the user can right-click a
   * feature that isn't in the active part.
   */
  const rawActivePartId = useActivePartId();
  const activePartId = useMemo(
    () => resolveActivePartId(project, rawActivePartId),
    [project, rawActivePartId],
  );

  /**
   * The part a new feature belongs in, given the feature it is built
   * from: an extrude goes where its sketch lives, a fillet where the
   * body it rounds lives. Falls back to the active part when the new
   * feature references nothing yet (a primitive from numbers, a sketch
   * on a default plane).
   *
   * This matters because a non-active part's bodies are ghosted but
   * still pickable, so "what the user clicked" and "what is active" can
   * disagree — and the same id is written into the feature's own body
   * refs, so getting it from the pick keeps both ends consistent.
   */
  const partForFeature = useCallback(
    (anchorFeatureId?: string | null): PartId | null =>
      (anchorFeatureId ? findFeaturePartId(project, anchorFeatureId) : null) ?? activePartId,
    [project, activePartId],
  );

  /** Same, anchored on a body — resolved through the rebuild's body→feature map. */
  /**
   * Construction planes the active part can actually be sketched on.
   * A `constructionPlane` PlaneRef is resolved from the owning part's
   * build context, so a plane from another part would fail the rebuild
   * with "has no resolved plane output" — the picker must not offer it.
   */
  const activePartPlanes = useMemo(
    () => constructionPlanes.filter(
      cp => findFeaturePartId(project, cp.featureId) === activePartId,
    ),
    [constructionPlanes, project, activePartId],
  );

  const partForBody = useCallback(
    (bodyId?: string | null): PartId | null =>
      partForFeature(bodyId ? bodyToFeatureMap[bodyId as BodyId] : null),
    [partForFeature, bodyToFeatureMap],
  );

  /**
   * Target-picker entries for a join / cut dialog: the bodies built by the
   * part's timeline, labelled by the feature that produced them.
   */
  const bodyOptionsForPart = useCallback(
    (partId: PartId | null): { id: string; label: string }[] => {
      const part = partId ? project.parts[partId] : undefined;
      if (!part) return [];
      return Object.entries(bodyToFeatureMap)
        .filter(([, fid]) => part.timeline.some(f => f.id === fid))
        .map(([bid, fid], i) => {
          const feature = part.timeline.find(f => f.id === fid);
          return { id: String(bid), label: feature ? `Body ${i + 1} (${feature.name})` : `Body ${i + 1}` };
        });
    },
    [project.parts, bodyToFeatureMap],
  );


  // Sketch mode state (old store for mode tracking + camera save/restore)
  const sketchActive = useSketchActive();
  const sketchActions = useSketchActions();

  // New sketch editor tool state
  const [sketchTool, setSketchTool] = useState<SketchToolId>('line');
  /** Reactive subscription so the ribbon button updates when the editor
      store's constructionMode flips. */
  const editorConstructionMode = useSketchEditorStore((s) => s.constructionMode);
  /** Sidebar (ProjectTree) collapse state. Collapsed = a narrow rail with
      just the expand chevron, so the viewport + ribbon get the full width.
      Toggle button lives in the MainAppBar. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

  // Console state
  const consoleEntries = useConsoleStore(s => s.entries);
  const consoleCollapsed = useConsoleStore(s => s.collapsed);
  const consoleToggle = useConsoleStore(s => s.toggle);
  const consoleClear = useConsoleStore(s => s.clear);

  const commandBus = useCommandBus();

  const { setActivePart } = useDisplayContextActions();

  const handleActivatePart = useCallback((partId: string) => {
    setActivePart(partId as PartId);
    const name = project.parts[partId as PartId]?.name ?? partId;
    consoleLog('info', `Active part: ${name}`, 'command');
  }, [setActivePart, project.parts]);

  /**
   * Add a part and activate it, so the next feature lands there — adding
   * one and then drawing into the old part is never what the user meant.
   *
   * `CreatePart` mints the id inside the handler, so the new part is
   * found by diffing the key set. `parts` is insertion-ordered, which is
   * also what makes the first part the implicit root everywhere else.
   */
  const handleCreatePart = useCallback(() => {
    const before = new Set(Object.keys(project.parts));
    const taken = new Set(Object.values(project.parts).map(p => p.name));
    let n = before.size + 1;
    while (taken.has(`Part ${n}`)) n++;
    const name = `Part ${n}`;

    const result = commandBus.dispatch({ type: 'CreatePart', name });
    if (!result.ok) {
      consoleLog('error', `Create part failed: ${result.error.message}`, 'command');
      return;
    }
    const created = (Object.keys(getAppState().documentStore.getState().parts) as PartId[])
      .find(id => !before.has(id));
    if (created) setActivePart(created);
    consoleLog('success', `Created ${name}`, 'command');
  }, [project.parts, commandBus, setActivePart]);

  // Selection state.
  //
  // Three-way feature ↔ body ↔ viewport selection:
  //   - Click a body row → selectedBodyId = that body, selectedFeatureId =
  //     its source feature. Both rows light up; viewport emphasises ONE body.
  //   - Click a feature row → selectedFeatureId = feature, selectedBodyId =
  //     null. Feature row lit; viewport emphasises ALL bodies of that
  //     feature.
  //   - Click a body in the viewport → goes through the picker which
  //     dispatches the same per-body select via handleBodyClick below.
  //
  // The highlight useEffect lower down derives the Set<BodyId> the viewport
  // should tint from these two ids; setting/clearing always flows through
  // the helpers (`setFeatureOnly`, `setBodyAndFeature`, `clearSelection`)
  // to keep the two ids consistent.
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(null);
  const setFeatureOnly = useCallback((featureId: string | null) => {
    setSelectedFeatureId(featureId);
    setSelectedBodyId(null);
  }, []);
  const setBodyAndFeature = useCallback((bodyId: string, sourceFeatureId: string) => {
    setSelectedFeatureId(sourceFeatureId);
    setSelectedBodyId(bodyId);
  }, []);

  // Per-body visibility (independent of feature visibility)
  const [hiddenBodies, setHiddenBodies] = useState<Set<string>>(new Set());

  // Inspector panel visibility
  const [inspectorVisible, setInspectorVisible] = useState(false);

  // Components panel visibility (right-side drawer).
  const [componentsPanelOpen, setComponentsPanelOpen] = useState(false);

  // The global key handler is installed once and does not depend on `saas`,
  // so reading it through a ref keeps the shortcut's gate current without
  // re-binding the listener every time the probe resolves.
  const saasRef = useRef(saas);
  useEffect(() => { saasRef.current = saas; }, [saas]);

  // Chat panel visibility (right-side drawer, opened by the wand
  // button in MainAppBar). Lives next to the Components panel —
  // both can be open simultaneously; the layout flex-row stacks them.
  const [chatPanelOpen, setChatPanelOpen] = useState(false);

  /**
   * Bridge the chat panel's `ChatMessage[]` (flat text) to the wire
   * `NormalizedMessage[]` (text + tool_use + tool_result blocks). v1
   * has no tool execution wired client-side, so we only emit `text`
   * blocks — tool_use messages from prior rounds would only appear if
   * the model emitted them and we persisted the round, which doesn't
   * happen until the tool-execution loop is built.
   *
   * Defined as a module helper just below Shell so it's not recreated
   * per-render and so callers see the AsyncIterable shape directly.
   */
  // (helper lives below the component — see runChatTurn)

  // List of models the SaaS endpoint says are currently enabled. Empty
  // until the panel is first opened (lazy-loaded). When empty, the
  // ChatPanel hides the dropdown and the server picks the default.
  const [availableModels, setAvailableModels] = useState<readonly ChatModelOption[]>([]);
  useEffect(() => {
    if (!chatPanelOpen) return;
    if (saas?.kind !== 'available' || !saas.signedIn) return;
    let cancelled = false;
    void listAvailableModels().then((models) => {
      if (cancelled) return;
      setAvailableModels(models);
    });
    return () => {
      cancelled = true;
    };
  }, [chatPanelOpen, saas]);

  // Extrude dialog state
  const [extrudeState, setExtrudeState] = useState<{
    visible: boolean;
    sketchId: FeatureId | null;
    sketchName: string;
    profiles: ProfileRef[];
    /** When editing an existing extrude, stores its feature ID. null = creating new. */
    editingFeatureId: FeatureId | null;
    /** Pre-populate dialog when editing an existing feature */
    initialValues?: ExtrudeDialogInitialValues;
    /** Face the extrude starts from (Start: Face). */
    startFace?: ExtrudePickedFace | null;
    /** Face the extrude goes up to (Extent: To → Face). */
    endFace?: ExtrudePickedFace | null;
    /** Face slot the next viewport face click fills; null while picking profiles. */
    faceSlot?: ExtrudeFaceSlot | null;
  }>({ visible: false, sketchId: null, sketchName: '', profiles: [], editingFeatureId: null });

  // Revolve dialog state. Profiles is constrained to 0 or 1 entries — revolve
  // takes exactly one profile, picked via the SketchViewer just like extrude.
  const [revolveState, setRevolveState] = useState<{
    visible: boolean;
    sketchId: FeatureId | null;
    sketchName: string;
    profiles: ProfileRef[];
  }>({ visible: false, sketchId: null, sketchName: '', profiles: [] });

  // Loft dialog state. Profiles can span multiple sketches, picked across all
  // currently-visible SketchViewers. `picksBySketch` is the per-sketch picked
  // state SketchViewer reports back via onProfilesChanged; we diff it against
  // the previous value to maintain the global click-order list `profiles`.
  const [loftState, setLoftState] = useState<{
    visible: boolean;
    picksBySketch: Record<string, ProfileRef[]>;
    profiles: ProfileRef[];
  }>({ visible: false, picksBySketch: {}, profiles: [] });

  // Fillet dialog state. While `visible`, the Shell forces viewport pick
  // mode to 'edge' (overriding the modeling-mode default of 'face') and
  // every clicked edge is appended to `edges`. Each edge is stored as an
  // EdgeRef with stableTopology — the kernel's topology naming layer
  // resolves these back to runtime KernelEdge handles on each rebuild.
  const [filletState, setFilletState] = useState<{
    visible: boolean;
    // Stable EdgeRefs in click order. The dialog renders them as a list
    // with remove-X buttons; the entries here also drive its label text.
    edges: EdgeRef[];
  }>({ visible: false, edges: [] });

  // Chamfer-dialog state — structurally identical to filletState since
  // Chamfer is Fillet's twin (edges + scalar; just a setback distance
  // instead of a radius). Kept as a separate state slice so the two
  // dialogs can never be open simultaneously and so their edge lists
  // don't bleed into each other on cancel.
  const [chamferState, setChamferState] = useState<{
    visible: boolean;
    edges: EdgeRef[];
  }>({ visible: false, edges: [] });

  // Fillet / Chamfer "Tangent chain" toggle: an edge pick also adds the
  // edges tangent-continuous with it. Shared by both dialogs and kept
  // across openings; the ref lets the pick subscriptions read it without
  // resubscribing.
  const [edgeTangentChain, setEdgeTangentChainState] = useState(false);
  const edgeTangentChainRef = useRef(false);
  const setEdgeTangentChain = useCallback((on: boolean) => {
    edgeTangentChainRef.current = on;
    setEdgeTangentChainState(on);
  }, []);

  // Construction-plane dialog state. Tracks the dialog visibility, the
  // current plane kind (offsetFromPlane vs offsetFromFace), and the
  // picked base for each mode (a plane via the SketchPlanePicker overlay,
  // or a face via the standard face picker). Mirrors the pattern used by
  // `filletState` for edge picking.
  const [planeState, setPlaneState] = useState<{
    visible: boolean;
    kind: ConstructionPlaneKind;
    pickedPlane: ConstructionPlanePickedPlane | null;
    pickedFace: ConstructionPlanePickedFace | null;
    /**
     * The construction-plane feature this dialog edits. Set when editing an
     * existing plane, OR once create-ahead has materialized a draft plane so
     * the gizmo can preview it. Null before a base is picked in create mode.
     */
    editingFeatureId: string | null;
    /**
     * True when `editingFeatureId` points to a draft this dialog session
     * created (create-ahead) — so Cancel deletes it. False when editing a
     * pre-existing plane (Cancel just reverts the preview).
     */
    draftCreated: boolean;
    /** Live offset (mm), shared between the Distance field and the gizmo. */
    offset: number;
    /** The plane's stored offset when the dialog opened (for Cancel revert). */
    committedOffset: number;
  }>({
    visible: false, kind: 'offsetFromPlane', pickedPlane: null, pickedFace: null,
    editingFeatureId: null, draftCreated: false, offset: 10, committedOffset: 10,
  });

  // Hole-dialog state. Pickedface is captured from the standard face
  // picker (same path as CP's offsetFromFace mode). `initialValues` is
  // null on first-open and persists previous values when re-opening to
  // edit an existing hole (future enhancement — set when the user
  // clicks a Hole row in the tree).
  const [holeState, setHoleState] = useState<{
    visible: boolean;
    pickedFace: HoleDialogPickedFace | null;
    initialValues?: Partial<HoleDialogResult>;
  }>({ visible: false, pickedFace: null });

  // Measure panel. Reads whatever is selected rather than running its own
  // pick mode — every other operation already resolves a click to a body,
  // face or edge, and a parallel picker would be a second set of highlight
  // rules to keep in step with the first.
  const [measureOpen, setMeasureOpen] = useState(false);

  const handleToolbarMeasureClick = useCallback(() => {
    setMeasureOpen(v => !v);
  }, []);

  // Only subscribed while the panel is open: the selection store fires on
  // every hover-to-click transition in the viewport, and re-rendering Shell
  // for a panel nobody has opened is work for nothing.
  const subscribeMeasureSelection = useCallback(
    (onChange: () => void) => (measureOpen ? getAppState().selectionStore.subscribe(onChange) : () => {}),
    [measureOpen],
  );
  const measureSelection = useSyncExternalStore(
    subscribeMeasureSelection,
    () => (measureOpen ? getAppState().selectionStore.getState().selection : null),
  );

  /**
   * The current selection as something the worker can measure.
   *
   * Only geometry resolves: a plane selection has no body behind it, and a
   * feature or sketch-entity selection is not a solid at all.
   */
  const measureTarget = useMemo((): MeasureTarget | null => {
    const sel = measureSelection;
    if (!sel) return null;
    if (sel.type === 'body') return { kind: 'body', bodyId: String(sel.bodyId) };
    if (sel.type === 'face') {
      return { kind: 'face', bodyId: String(sel.bodyId), stableFaceId: String(sel.faceId) };
    }
    if (sel.type === 'edge') {
      return { kind: 'edge', bodyId: String(sel.bodyId), stableEdgeId: String(sel.edgeId) };
    }
    return null;
  }, [measureSelection]);

  // Boolean-dialog state. The op the ribbon entry stood for; the dialog can
  // change it. Bodies are picked in the dialog rather than the viewport, so
  // there is nothing else to hold here.
  const [booleanState, setBooleanState] = useState<{
    visible: boolean;
    operation: 'union' | 'subtract' | 'intersect';
  }>({ visible: false, operation: 'subtract' });

  // Primitive-dialog state. Nothing is picked in the viewport — a primitive
  // is numbers only — so `kind` is the whole of it: which shape the clicked
  // ribbon entry stands for, which the dialog opens on and can then change.
  const [primitiveState, setPrimitiveState] = useState<{
    visible: boolean;
    kind: PrimitiveKind;
  }>({ visible: false, kind: 'box' });

  // Mirror-dialog state. While `visible`, the Shell forces viewport pick
  // mode to 'body' so a click on a body's surface fills `pickedBody`
  // (single-body v1; multi-body lands later without a schema change).
  // The dialog itself owns plane + operation (newBody/join) selection.
  const [mirrorState, setMirrorState] = useState<{
    visible: boolean;
    pickedBody: MirrorDialogPickedBody | null;
    initialValues?: Partial<MirrorDialogResult>;
  }>({ visible: false, pickedBody: null });

  // Shell-dialog state. Face picks accumulate in `faces` as stable
  // FaceRefs; all picks must share a body (Shell hollows one body at
  // a time). The subscription below rejects cross-body picks. Initial
  // values reserve room for future re-edit flows from the project
  // tree.
  const [shellState, setShellState] = useState<{
    visible: boolean;
    faces: FaceRef[];
    initialValues?: Partial<ShellDialogResult>;
  }>({ visible: false, faces: [] });

  // Pattern-dialog state. One dialog covers both Linear and Circular
  // body patterns (a top tab switches between modes). Body picking
  // follows the same pickMode='body' override as Mirror.
  const [patternState, setPatternState] = useState<{
    visible: boolean;
    pickedBody: PatternDialogPickedBody | null;
    initialValues?: Partial<PatternDialogResult>;
  }>({ visible: false, pickedBody: null });

  // Sweep-dialog state. V1 uses two dropdowns (profile + path), no
  // viewport picking — sketches are selected from a list of all
  // sketches in the project.
  const [sweepState, setSweepState] = useState<{
    visible: boolean;
    initialValues?: Partial<SweepDialogResult>;
  }>({ visible: false });

  // Track active sketch ID for entity commits
  const activeSketchIdRef = useRef<FeatureId | null>(null);

  // Track sketch plane name
  const [sketchPlaneName, setSketchPlaneName] = useState<'XY' | 'XZ' | 'YZ'>('XZ');
  // Explicit world basis for the active sketch when it's on a CONSTRUCTION
  // plane. Null for default-plane sketches (the name above suffices). When
  // set, it's handed to SketchEditor so geometry draws at the datum plane's
  // real offset/orientation, and the camera looks along its real normal.
  const [sketchPlaneConfig, setSketchPlaneConfig] = useState<SketchPlaneConfig | null>(null);
  const wasSketchActiveRef = useRef(false);

  // Auto-position the camera when ENTERING sketch mode so the user sees
  // the active sketch plane head-on — along the plane's own normal, so an
  // oblique construction plane is square to the screen too. Ghost-mode
  // application is no longer done here — it lives in the centralized
  // computeAllBodyDisplayModes pass below so it composes correctly with
  // per-body hide state.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    if (sketchActive && !wasSketchActiveRef.current) {
      const view = sketchViewForPlane(sketchPlaneConfig ?? sketchPlaneName);
      ctrl.goToView(view.theta, view.phi);
    }
    wasSketchActiveRef.current = sketchActive;
  }, [sketchActive, sketchPlaneName, sketchPlaneConfig]);

  // Log initial message
  useEffect(() => {
    consoleLog('info', 'CAD application initialized', 'system');
  }, []);

  // Watch the sketch solver's unsatisfied set: log a one-time warning each
  // time the sketch transitions from consistent → over-constrained.
  useEffect(() => {
    let prevSize = useSketchEditorStore.getState().unsatisfiedConstraints.size;
    const unsub = useSketchEditorStore.subscribe((s) => {
      const size = s.unsatisfiedConstraints.size;
      if (size > 0 && prevSize === 0) {
        consoleLog('warn', `Over-constrained sketch: ${size} constraint${size === 1 ? '' : 's'} cannot be satisfied`, 'sketch');
      } else if (size === 0 && prevSize > 0) {
        consoleLog('success', 'Sketch is consistent again', 'sketch');
      }
      prevSize = size;
    });
    return unsub;
  }, []);

  // ---- Sketch mode handlers ----

  // True while the plane picker overlay is shown. Set by the toolbar Sketch
  // button; cleared when the user picks a plane or cancels (Esc / Cancel).
  const [sketchPickingPlane, setSketchPickingPlane] = useState(false);

  // Pending DXF import: when the user picks a DXF file, we parse it into an
  // EditorState snapshot up-front, then reuse the SAME plane-picker overlay
  // as a fresh sketch. On plane-pick, `handlePlanePicked` dispatches
  // `CreateSketchFromImport` with this snapshot instead of `CreateSketch`.
  // Held in a ref so the picker callback reads the latest value without a
  // re-render dependency. Cleared on pick / cancel.
  const pendingSketchImportRef = useRef<{
    snapshot: SketchEditorSnapshot;
    name: string;
  } | null>(null);

  // Section view (Inspect): non-destructive clip-plane cut so you can see
  // inside bodies, with a drag handle to slide the cut. View-only — no
  // document change. `sectionActive` toggles the mode; orientation picks
  // the cut plane normal.
  const [sectionActive, setSectionActive] = useState(false);
  const [sectionOrientation, setSectionOrientation] = useState<SectionOrientation>('XZ');

  // Body Move (right-click body → Move). Null when not moving.
  //
  // Where the placement lands depends on what produced the body, and the two
  // cases are genuinely different rather than a flag on one path:
  //
  //  - `scope: 'body' | 'all'` — imported geometry, which carries its own
  //    `transform` / `bodyTransforms`. The drag edits the source feature.
  //  - `scope: 'feature'` — anything derived (extrude output, a boolean
  //    result). Those have no transform field, so the drag maintains a
  //    trailing `move` feature instead; `moveFeatureId` is the one being
  //    maintained, resolved or created on the first drag.
  const [moveState, setMoveState] = useState<{
    bodyId: string;
    sourceFeatureId: string;
    mode: 'translate' | 'rotate';
    scope: 'body' | 'all' | 'feature';
    /** Placement at Move-start, restored on Cancel (each drag commits, so
     *  Cancel reverts the whole session to this snapshot). */
    snapshot: { transform: unknown; bodyTransforms: unknown };
    /**
     * `scope: 'feature'` only. The `move` feature carrying this session's
     * placement: an existing trailing one when there was a match, else null
     * until the first drag creates it. Null at Done means nothing was
     * dragged and nothing was written.
     */
    moveFeatureId?: string | null;
    /** `scope: 'feature'` only. True when this session created the feature,
     *  so Cancel deletes it rather than restoring a transform. */
    createdHere?: boolean;
  } | null>(null);

  // The gizmo callback is installed once per Move session and fires on every
  // drag, so it cannot close over `moveState` — after the first drag creates
  // the feature, the closure would still think there isn't one and create a
  // second. A ref gives it the current value without re-installing the gizmo
  // mid-session (which would drop the handles the user is holding).
  const moveStateRef = useRef(moveState);
  useEffect(() => { moveStateRef.current = moveState; }, [moveState]);

  const handleToolbarSectionClick = useCallback(() => {
    setSectionActive(prev => {
      const next = !prev;
      // Entering section view from sketch mode: leave the sketch cleanly.
      if (next && sketchActive) {
        activeSketchIdRef.current = null;
        sketchActions.exitSketch();
        useSketchEditorStore.getState().clearAll();
      }
      return next;
    });
  }, [sketchActive, sketchActions]);

  // Apply section state to the viewport. Orientation → cut-plane normal
  // (XY⊥Z, XZ⊥Y, YZ⊥X). The controller defaults the cut to the model's
  // bounding-box centre and draws the draggable handle.
  useEffect(() => {
    if (!viewportCtrl) return;
    if (!sectionActive) { viewportCtrl.setSectionPlane(null); return; }
    const normal: [number, number, number] =
      sectionOrientation === 'XY' ? [0, 0, 1]
        : sectionOrientation === 'XZ' ? [0, 1, 0]
          : [1, 0, 0];
    viewportCtrl.setSectionPlane({ normal });
    return () => { viewportCtrl.setSectionPlane(null); };
  }, [sectionActive, sectionOrientation, viewportCtrl]);

  // Body Move: attach a 3-axis translate gizmo to the body's mesh. The mesh
  // sits at the origin (geometry baked at the stored placement), so the drag
  // delta is added to the feature's stored transform.position on release —
  // one UpdateFeatureInput per drag. After the rebuild repositions the mesh,
  // this effect re-attaches to the fresh mesh (displayMeshes in deps).
  useEffect(() => {
    if (!viewportCtrl) return;
    if (!moveState) { viewportCtrl.attachBodyMoveGizmo(null); return; }
    const { bodyId, sourceFeatureId, mode, scope } = moveState;
    // Per-body placement is keyed by the body's full id (the same key the
    // builder reads), so the right body always gets the transform.
    const bodyKey = bodyId;

    type T3 = { position: [number, number, number]; rotation: [number, number, number, number] };
    const findFeature = () => {
      const proj = getAppState().documentStore.getState();
      for (const part of Object.values(proj.parts)) {
        const f = part.timeline.find(ff => ff.id === sourceFeatureId);
        if (f) return { partId: part.id as PartId, inputs: f.inputs as Record<string, unknown> };
      }
      return null;
    };
    const ID: T3 = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
    const toMatrix = (t: T3) => new THREE.Matrix4().compose(
      new THREE.Vector3(...t.position),
      new THREE.Quaternion(...t.rotation),
      new THREE.Vector3(1, 1, 1),
    );
    const r = (n: number) => Math.round(n * 1000) / 1000;
    const toT3 = (M: THREE.Matrix4): T3 => {
      const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
      M.decompose(p, q, s);
      return { position: [r(p.x), r(p.y), r(p.z)], rotation: [r(q.x), r(q.y), r(q.z), r(q.w)] };
    };

    // Which bodies move live: just this one (Move body), or all of the
    // import's bodies (Move all) so they drag together. Read the map fresh
    // (not via deps) so this effect doesn't re-run on every rebuild — the
    // controller re-attaches the gizmo itself after a rebuild.
    const btf = getAppState().viewportStore.getState().bodyToFeatureMap as Record<string, string>;
    const moveBodyIds: BodyId[] = scope === 'all'
      ? Object.entries(btf)
          .filter(([, fid]) => String(fid) === sourceFeatureId)
          .map(([bid]) => bid as BodyId)
      : [bodyId as BodyId];

    viewportCtrl.attachBodyMoveGizmo(moveBodyIds, mode, (delta) => {
      const D = new THREE.Matrix4().compose(
        new THREE.Vector3(...delta.position),
        new THREE.Quaternion(...delta.quaternion),
        new THREE.Vector3(1, 1, 1),
      );

      // Derived body: maintain a trailing `move` feature. Its transform is
      // the outermost thing applied to the body, so a world-space gesture
      // composes straight onto it — no conjugation, unlike the per-body case
      // below which sits inside the import's group transform.
      if (scope === 'feature') {
        const proj = getAppState().documentStore.getState();
        const owner = Object.values(proj.parts)
          .find(part => part.timeline.some(ff => ff.id === sourceFeatureId));
        if (!owner) return;

        const existingId = moveStateRef.current?.moveFeatureId ?? null;
        const existing = existingId
          ? owner.timeline.find(ff => ff.id === existingId)
          : undefined;

        if (existing) {
          const M = toMatrix((existing.inputs as { transform?: T3 }).transform ?? ID);
          commandBus.dispatch({
            type: 'UpdateFeatureInput', partId: owner.id as PartId,
            featureId: existingId as FeatureId,
            path: ['transform'], value: toT3(D.clone().multiply(M)),
          });
          return;
        }

        // First drag of the session with nothing to reuse — create it now
        // rather than on Move-start, so opening Move and closing it again
        // leaves no empty feature behind.
        const created = commandBus.dispatch({
          type: 'CreateMove', partId: owner.id as PartId,
          inputs: {
            targetBodies: [{ partId: owner.id as PartId, bodyId: bodyId as BodyId }],
            transform: toT3(D),
          },
        });
        if (!created.ok) {
          consoleLog('error', `Move failed: ${created.error.message}`, 'move');
          return;
        }
        const after = getAppState().documentStore.getState().parts[owner.id]!;
        const newest = [...after.timeline].reverse().find(ff => ff.type === 'move');
        setMoveState(prev => prev && {
          ...prev, moveFeatureId: newest ? String(newest.id) : null, createdHere: true,
        });
        return;
      }

      const f = findFeature();
      if (!f) return;
      // The gesture D is in WORLD space. The body is baked as G·P·raw (group
      // ∘ per-body), so a world gesture maps differently to each scope.
      const G = toMatrix((f.inputs['transform'] as T3) ?? ID);

      if (scope === 'all') {
        // Group is the outermost transform: G' = D·G.
        const Gn = D.clone().multiply(G);
        commandBus.dispatch({
          type: 'UpdateFeatureInput', partId: f.partId, featureId: sourceFeatureId as FeatureId,
          path: ['transform'], value: toT3(Gn),
        });
      } else {
        // Per-body sits INSIDE the group, so conjugate the world gesture by
        // the group to keep the body where the cursor put it:  P' = G⁻¹·D·G·P.
        const map = (f.inputs['bodyTransforms'] as Record<string, T3>) ?? {};
        const P = toMatrix(map[bodyKey] ?? ID);
        const Pn = G.clone().invert().multiply(D).multiply(G).multiply(P);
        commandBus.dispatch({
          type: 'UpdateFeatureInput', partId: f.partId, featureId: sourceFeatureId as FeatureId,
          path: ['bodyTransforms'], value: { ...map, [bodyKey]: toT3(Pn) },
        });
      }
    });

    return () => { viewportCtrl.attachBodyMoveGizmo(null); };
    // Note: NOT depending on displayMeshes — the controller re-attaches the
    // gizmo to the fresh mesh after each rebuild (see setDisplayMeshes), which
    // avoids re-running this effect against a stale mesh mid-rebuild.
  }, [viewportCtrl, moveState, commandBus]);

  // Cancel a move: restore the placement snapshot taken when Move started
  // (each drag committed, so this reverts the whole session), then exit.
  const cancelMove = useCallback(() => {
    if (moveState) {
      const cur = getAppState().documentStore.getState();

      // Derived body: the session either created the `move` feature (delete
      // it — cancelling should leave no trace) or reused an existing one
      // (restore the transform it had on entry).
      if (moveState.scope === 'feature') {
        const owner = Object.values(cur.parts)
          .find(part => part.timeline.some(ff => ff.id === moveState.moveFeatureId));
        if (owner && moveState.moveFeatureId) {
          commandBus.dispatch(moveState.createdHere
            ? {
              type: 'DeleteFeature', partId: owner.id as PartId,
              featureId: moveState.moveFeatureId as FeatureId,
            }
            : {
              type: 'UpdateFeatureInput', partId: owner.id as PartId,
              featureId: moveState.moveFeatureId as FeatureId,
              path: ['transform'], value: moveState.snapshot.transform,
            });
        }
        setMoveState(null);
        return;
      }

      for (const part of Object.values(cur.parts)) {
        const f = part.timeline.find(ff => ff.id === moveState.sourceFeatureId);
        if (!f) continue;
        commandBus.dispatch({
          type: 'UpdateFeatureInput', partId: part.id as PartId,
          featureId: moveState.sourceFeatureId as FeatureId,
          path: ['transform'], value: moveState.snapshot.transform,
        });
        commandBus.dispatch({
          type: 'UpdateFeatureInput', partId: part.id as PartId,
          featureId: moveState.sourceFeatureId as FeatureId,
          path: ['bodyTransforms'], value: moveState.snapshot.bodyTransforms,
        });
        break;
      }
    }
    setMoveState(null);
  }, [moveState, commandBus]);

  // Esc cancels (reverts) Move mode.
  useEffect(() => {
    if (!moveState) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelMove(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [moveState, cancelMove]);

  const handleSketchButton = useCallback(() => {
    // Don't show picker if already in sketch mode (Sketch button is hidden then
    // since the ribbon swaps to sketch tools).
    if (sketchActive) return;
    setSketchPickingPlane(true);
  }, [sketchActive]);

  const handleCancelPlanePick = useCallback(() => {
    setSketchPickingPlane(false);
    pendingSketchImportRef.current = null;
  }, []);

  /**
   * File → Import DXF (sketch). Picks a `.dxf` file, parses it to sketch
   * primitives, builds the EditorState, and — if any supported geometry
   * was found — opens the SAME plane picker as a fresh sketch with the
   * parsed snapshot stashed in `pendingSketchImportRef`. On plane-pick,
   * `handlePlanePicked` dispatches `CreateSketchFromImport`.
   *
   * Distinct from the 3D STEP/STL/BREP import (which produces an
   * `importedGeometry` body) — DXF becomes 2D sketch geometry.
   */
  const handleImportSketchDxf = useCallback(async () => {
    if (sketchActive) {
      consoleLog('warn', 'Exit the current sketch before importing a DXF', 'sketch');
      return;
    }
    let pick: Awaited<ReturnType<typeof pickDxfForImport>>;
    try {
      pick = await pickDxfForImport();
    } catch (err) {
      consoleLog('error', `DXF read failed: ${(err as Error).message}`, 'sketch');
      return;
    }
    if (!pick) return; // user cancelled

    const { state, skipped, unitName } = dxfToEditorState(pick.text);
    if (skipped.length > 0) {
      consoleLog('warn', `DXF: skipped unsupported entities: ${skipped.join(', ')}`, 'sketch');
    }
    if (state.geometries.size === 0) {
      consoleLog('warn', `DXF "${pick.fileName}" had no supported geometry, so nothing was imported`, 'sketch');
      return;
    }
    if (unitName) {
      consoleLog('info', `DXF "${pick.fileName}": units were ${unitName}, scaled to mm`, 'sketch');
    }

    const baseName = pick.fileName.replace(/\.dxf$/i, '');
    pendingSketchImportRef.current = {
      snapshot: toSnapshot(state) as unknown as SketchEditorSnapshot,
      name: baseName || 'Imported sketch',
    };
    consoleLog('info', `DXF "${pick.fileName}": ${state.geometries.size} curve(s). Pick a plane`, 'sketch');
    setSketchPickingPlane(true);
  }, [sketchActive]);

  /**
   * Import an SVG file as a new sketch. Same flow as the DXF importer —
   * parse → stash snapshot in `pendingSketchImportRef` → pick a plane →
   * `CreateSketchFromImport` (one undo entry). SVG curves arrive as splines
   * (the importer flattens beziers/arcs); coordinates are scaled to mm from
   * the SVG's width/viewBox and the Y axis is flipped to sketch-up.
   */
  const handleImportSketchSvg = useCallback(async () => {
    if (sketchActive) {
      consoleLog('warn', 'Exit the current sketch before importing an SVG', 'sketch');
      return;
    }
    let pick: Awaited<ReturnType<typeof pickSvgForImport>>;
    try {
      pick = await pickSvgForImport();
    } catch (err) {
      consoleLog('error', `SVG read failed: ${(err as Error).message}`, 'sketch');
      return;
    }
    if (!pick) return; // user cancelled

    const { state, skipped, tooComplex, primitiveCount } = svgToEditorState(pick.text);
    if (skipped.length > 0) {
      consoleLog('warn', `SVG: skipped unsupported elements: ${skipped.join(', ')}`, 'sketch');
    }
    if (tooComplex) {
      consoleLog(
        'warn',
        `SVG "${pick.fileName}" has ${primitiveCount} shapes, too complex for the experimental SVG import (limit ${MAX_SVG_IMPORT_PRIMITIVES}). Try a simpler file or split it up.`,
        'sketch',
      );
      return;
    }
    if (state.geometries.size === 0) {
      consoleLog('warn', `SVG "${pick.fileName}" had no supported geometry, so nothing was imported`, 'sketch');
      return;
    }

    const baseName = pick.fileName.replace(/\.svg$/i, '');
    pendingSketchImportRef.current = {
      snapshot: toSnapshot(state) as unknown as SketchEditorSnapshot,
      name: baseName || 'Imported sketch',
    };
    consoleLog('info', `SVG "${pick.fileName}": ${state.geometries.size} curve(s). Pick a plane`, 'sketch');
    setSketchPickingPlane(true);
  }, [sketchActive]);

  /** Create a sketch on the chosen plane (default or construction) and enter sketch mode. */
  const handlePlanePicked = useCallback((pick: SketchPlanePick) => {
    setSketchPickingPlane(false);

    // A sketch on a default plane anchors on nothing, so it lands in
    // the active part; on a construction plane or a body face it joins the
    // part that plane or body belongs to.
    const partId = pick.kind === 'construction'
      ? partForFeature(pick.featureId)
      : pick.kind === 'face'
        ? partForBody(pick.bodyId)
        : activePartId;
    if (!partId) return;

    // Map the picker's discriminated pick into the corresponding PlaneRef
    // variant the document schema accepts. A face is stored by its stable
    // id, so every rebuild re-resolves it and the sketch follows the face.
    const planeRef: PlaneRef =
      pick.kind === 'default'
        ? { type: 'defaultPlane', name: pick.name }
        : pick.kind === 'construction'
          ? { type: 'constructionPlane', planeId: pick.featureId }
          : {
              type: 'stableTopology',
              bodyRef: { partId, bodyId: pick.bodyId },
              stableFaceId: pick.stableFaceId,
            };

    // A pending DXF import dispatches `CreateSketchFromImport` (seeds the
    // parsed geometry as one undo entry); otherwise a fresh `CreateSketch`.
    const pendingImport = pendingSketchImportRef.current;
    pendingSketchImportRef.current = null;

    const result = pendingImport
      ? commandBus.dispatch({
          type: 'CreateSketchFromImport',
          partId,
          plane: planeRef,
          editorState: pendingImport.snapshot,
          name: pendingImport.name,
        })
      : commandBus.dispatch({
          type: 'CreateSketch',
          partId,
          plane: planeRef,
        });

    if (!result.ok) {
      if (pendingImport) consoleLog('error', `DXF import failed: ${result.error.message}`, 'sketch');
      return;
    }

    const updatedProject = getAppState().documentStore.getState();
    const updatedPart = updatedProject.parts[partId];
    const newSketch = updatedPart?.timeline[updatedPart.timeline.length - 1];
    if (!newSketch || newSketch.type !== 'sketch') return;

    const sketchFId = newSketch.id as FeatureId;
    activeSketchIdRef.current = sketchFId;

    // Resolve the picked plane to a renderer plane input. For a default
    // plane that's just the name; for a construction plane it's the real
    // world basis (origin + axes + normal) from the live display list, so
    // the sketch draws at the datum plane's actual offset location. A face
    // hasn't been built as a sketch yet, so its frame comes from the pick —
    // the same `sketchFrameOnPlane` the worker applies to the face. The
    // camera view name is derived from that basis. (A construction plane's
    // `basePlane` PlaneRef object must not be cast to a name string and fed
    // to the editor — that throws.)
    const planeInput = pick.kind === 'face'
      ? planeConfigFromBasis(pick.frame)
      : resolveSketchPlaneInput(planeRef, constructionPlanes, sketchPlanes, sketchFId);
    const editorPlaneName = viewNameForPlaneInput(planeInput);
    setSketchPlaneName(editorPlaneName);
    setSketchPlaneConfig(typeof planeInput === 'string' ? null : planeInput);

    // Clear the sketch editor store for a fresh sketch
    useSketchEditorStore.getState().clearAll();

    const savedCamera: SavedCameraState = {
      position: [0, 100, 0],
      target: [0, 0, 0],
      zoom: 1,
      isOrthographic: false,
    };

    sketchActions.enterSketch(
      sketchFId,
      planeRef,
      savedCamera,
    );
    setSketchTool(null);
    const label = pick.kind === 'default'
      ? pick.name
      : pick.kind === 'face'
        ? `face ${String(pick.stableFaceId).slice(-6)}`
        : `${pick.name} (${editorPlaneName})`;
    consoleLog('info', `Created sketch on ${label}: ${newSketch.name}`, 'sketch');
  }, [partForFeature, partForBody, activePartId, commandBus, constructionPlanes, sketchPlanes, sketchActions]);

  // There is no exit-time sketch sync. Every sketch mutation goes
  // through the bus, and every handler rebuilds `inputs.buildGeometry` via
  // `editorModelToBuildGeometry` (the canonical serializer in
  // @tweakcad/core/src/sketch/serialization.ts) before the patch lands.
  // The doc is always current, so exit-sketch is pure UI teardown:
  // clear the editor store, exit sketch mode, log.

  const handleExitSketch = useCallback(() => {
    activeSketchIdRef.current = null;
    sketchActions.exitSketch();
    useSketchEditorStore.getState().clearAll();
    setSketchPlaneConfig(null);
    consoleLog('info', 'Sketch mode exited', 'sketch');
  }, [sketchActions]);

  /**
   * Fired by the hydration subscriber when the active sketch feature is
   * no longer in the document (typically: undo walked past `CreateSketch`).
   * Tear down sketch mode WITHOUT syncing — there's no feature left to
   * sync into. Just clear the editor store + exit.
   */
  const handleSketchRemoved = useCallback(() => {
    activeSketchIdRef.current = null;
    sketchActions.exitSketch();
    useSketchEditorStore.getState().clearAll();
    setSketchPlaneConfig(null);
    consoleLog('info', 'Sketch feature undone, exiting sketch mode', 'sketch');
  }, [sketchActions]);

  // ---- Edit Sketch handler ----

  /** Re-enter sketch mode for an existing sketch feature */
  const handleEditSketch = useCallback((sketchFeatureId: string) => {
    const parts = Object.values(project.parts);
    let sketchFeature = null;

    // Find the sketch feature in the document model
    for (const part of parts) {
      const feature = part.timeline.find(f => f.id === sketchFeatureId && f.type === 'sketch');
      if (feature) {
        sketchFeature = feature;
        break;
      }
    }

    if (!sketchFeature) {
      consoleLog('error', `Sketch not found: ${sketchFeatureId}`, 'sketch');
      return;
    }

    // Clear sketch editor store and load entities from document model
    const editorStore = useSketchEditorStore.getState();
    editorStore.clearAll();

    // Preferred path: restore the editor's native snapshot (points,
    // geometries, constraints) if the sketch was saved with one. This keeps
    // point IDs, constraint IDs, and all constraint references intact across
    // edit cycles. Legacy sketches (no editorModel) fall through to the
    // entity-based reconstruction below.
    const inputs = sketchFeature.inputs as SketchFeatureInputs;
    // Resolve the sketch's plane (default-plane name or construction-plane
    // world basis). The camera view name is derived from it; the real ref is
    // handed to enterSketch so it round-trips correctly. (For a construction
    // plane, `planeConfig` is non-null and flows to the editor so geometry
    // draws at the datum plane's actual location.)
    const planeInput = resolveSketchPlaneInput(inputs.plane, constructionPlanes, sketchPlanes, sketchFeatureId);
    if (inputs.plane?.type === 'stableTopology' && typeof planeInput === 'string') {
      consoleLog('warn', `${sketchFeature.name}: its face did not resolve on the last rebuild, so it opens on XZ`, 'sketch');
    }
    const viewName = viewNameForPlaneInput(planeInput);
    const planeConfig = typeof planeInput === 'string' ? null : planeInput;
    const planeRefForEnter: PlaneRef = inputs.plane ?? { type: 'defaultPlane', name: viewName };
    if (inputs.editorModel) {
      const snap = inputs.editorModel;
      editorStore.loadFromDocument(
        snap.points as Parameters<typeof editorStore.loadFromDocument>[0],
        snap.geometries as Parameters<typeof editorStore.loadFromDocument>[1],
        snap.constraints as Parameters<typeof editorStore.loadFromDocument>[2],
      );
      activeSketchIdRef.current = sketchFeatureId as FeatureId;
      setSketchPlaneName(viewName);
      setSketchPlaneConfig(planeConfig);
      const savedCamera: SavedCameraState = {
        position: [0, 100, 0],
        target: [0, 0, 0],
        zoom: 1,
        isOrthographic: false,
      };
      sketchActions.enterSketch(
        sketchFeatureId as FeatureId,
        planeRefForEnter,
        savedCamera,
      );
      setSketchTool(null);
      consoleLog('info', `Editing sketch: ${sketchFeature.name} (restored from editor state)`, 'sketch');
      return;
    }

    // The legacy fallback that rebuilt an editor model from document
    // entities is gone. It existed for sketches carrying buildGeometry but
    // no editorModel; buildGeometry is now derived FROM editorModel, so that
    // combination cannot occur and the early return above covers every
    // sketch that has one.
    const loadedCount = 0;

    activeSketchIdRef.current = sketchFeatureId as FeatureId;
    setSketchPlaneName(viewName);
    setSketchPlaneConfig(planeConfig);

    const savedCamera: SavedCameraState = {
      position: [0, 100, 0],
      target: [0, 0, 0],
      zoom: 1,
      isOrthographic: false,
    };

    sketchActions.enterSketch(
      sketchFeatureId as FeatureId,
      planeRefForEnter,
      savedCamera,
    );
    // No tool selected by default - user picks from toolbar
    setSketchTool(null);
    consoleLog('info', `Editing sketch: ${sketchFeature.name} (${loadedCount} entities loaded)`, 'sketch');
  }, [project.parts, sketchActions, constructionPlanes, sketchPlanes]);

  // ---- Extrude handlers ----

  /** Start extrude flow from a sketch */
  const handleStartExtrude = useCallback((sketchFeatureId: string) => {
    const activeSketchId = activeSketchIdRef.current;
    if (sketchActive && activeSketchId && activeSketchId === sketchFeatureId) {
      const editorStore = useSketchEditorStore.getState();

      // Switch to profile-selection mode so clicking geometry auto-selects its region
      editorStore.setSelectionIntent('selectProfileForFeature');

      const selectedRegionIds = [...editorStore.selectedRegionIds].map(String);
      const availableRegions = editorStore.getSketchRegions();

      // Empty selection blocks extrusion -- no fallback to "all profiles"
      if (selectedRegionIds.length === 0) {
        consoleLog('warn', 'Select one or more filled sketch profiles before extruding.', 'extrude');
        return;
      }

      const selectedRegions = availableRegions.filter(region => selectedRegionIds.includes(region.id));

      if (selectedRegions.length === 0) {
        consoleLog('warn', 'Selected regions no longer exist in sketch. Select a profile first.', 'extrude');
        return;
      }

      // Convert to new ProfileRef format with wireEntityIds
      const profiles: ProfileRef[] = selectedRegions.map(region =>
        regionToProfileRef(activeSketchId, region, availableRegions),
      );

      setExtrudeState({
        visible: true,
        sketchId: activeSketchId,
        sketchName: `Active Sketch (${selectedRegions.length} profile${selectedRegions.length === 1 ? '' : 's'})`,
        profiles,
        editingFeatureId: null,
      });
      consoleLog('info', `Starting extrude from ${selectedRegions.length} selected sketch profile(s)`, 'extrude');
      return;
    }

    // Non-active sketch: use SketchViewer in picker mode for profile selection.
    // No full sketch editor needed — SketchViewer renders readonly geometry with
    // clickable regions. User clicks regions, then confirms in the dialog.
    const parts = Object.values(project.parts);
    let sketchName = 'Sketch';
    let hasProfiles = false;
    for (const part of parts) {
      const feature = part.timeline.find(f => f.id === sketchFeatureId);
      if (feature) {
        sketchName = feature.name;
        if (feature.type === 'sketch') {
          const sketchInputs = feature.inputs as unknown as SketchFeatureInputs;
          const regions = detectSketchRegions(sketchBuildGeometry(sketchInputs));
          hasProfiles = regions.length > 0;
        }
        break;
      }
    }

    if (!hasProfiles) {
      consoleLog('warn', `No closed profiles found in ${sketchName}. Draw a closed loop or circle first.`, 'extrude');
      return;
    }

    // If we're in sketch editing mode, sync and exit first
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }

    // Open extrude dialog with SketchViewer in profile-picker mode.
    // Profiles start empty — user clicks regions in the SketchViewer to select.
    setExtrudeState({
      visible: true,
      sketchId: sketchFeatureId as FeatureId,
      sketchName,
      profiles: [],
      editingFeatureId: null,
    });
    consoleLog('info', `Select profiles in ${sketchName} to extrude`, 'extrude');
  }, [project.parts, sketchActive, sketchActions]);

  /** Confirm extrude with parameters */
  /** Confirm extrude with parameters -- creates a single extrude feature with all profiles */
  const handleExtrudeConfirm = useCallback((result: ExtrudeDialogResult) => {
    // Reset selection intent back to normal editing
    useSketchEditorStore.getState().setSelectionIntent('editGeometry');

    if (!extrudeState.sketchId) return;

    const partId = partForFeature(extrudeState.sketchId);
    if (!partId) return;
    const profiles = extrudeState.profiles;

    if (profiles.length === 0) {
      consoleLog('error', 'No closed sketch profiles selected for extrusion', 'extrude');
      setExtrudeState({ visible: false, sketchId: null, sketchName: '', profiles: [], editingFeatureId: null });
      return;
    }

    // Direction is just normal/reversed now — symmetric is an extent.
    const direction = result.direction === 'reversed'
      ? { type: 'reversed' as const }
      : { type: 'normal' as const };

    // Map extent enum back to the schema union. A `toPlane` target is a
    // default plane, a construction plane (`cp:<id>`), or the picked face.
    const toPlaneRef = (target: ExtrudeTargetPlane | undefined): PlaneRef | null => {
      if (target === 'face') return extrudeState.endFace?.planeRef ?? null;
      if (target?.startsWith('cp:')) return { type: 'constructionPlane', planeId: target.slice(3) };
      return { type: 'defaultPlane', name: (target as 'XY' | 'XZ' | 'YZ' | undefined) ?? 'XY' };
    };
    const targetPlaneRef = result.extentType === 'toPlane' ? toPlaneRef(result.targetPlane) : null;
    if (result.extentType === 'toPlane' && !targetPlaneRef) {
      consoleLog('error', 'Pick the face to extrude to', 'extrude');
      return;
    }
    const extent: ExtrudeFeatureInputs['extent'] = result.extentType === 'symmetric'
      ? { type: 'symmetric' as const, value: String(result.distance) }
      : result.extentType === 'throughAll'
        ? { type: 'throughAll' as const }
        : targetPlaneRef
          ? { type: 'toPlane' as const, plane: targetPlaneRef }
          : { type: 'distance' as const, value: String(result.distance) };
    const startFrom = result.startType === 'face' ? extrudeState.startFace?.planeRef : undefined;
    if (result.startType === 'face' && !startFrom) {
      consoleLog('error', 'Pick the face to start from', 'extrude');
      return;
    }

    // Empty picker = "Auto" → leave targetBodies undefined so join and cut
    // act on the bodies the extrude touches. When the user
    // does pick, single-select for now; the schema is multi-target so
    // the array shape is right for the future multi-picker.
    const targetBodies = result.targetBodyId
      ? [{ partId, bodyId: result.targetBodyId as never }]
      : undefined;

    const inputsPayload = {
      profiles,
      operation: result.operation,
      direction,
      extent,
      startOffset: String(result.startOffset),
      ...(startFrom ? { startFrom } : {}),
      ...(targetBodies ? { targetBodies } : {}),
    };

    if (extrudeState.editingFeatureId) {
      // Editing existing feature -- replace all inputs atomically (single rebuild)
      const featureId = extrudeState.editingFeatureId;
      const r = commandBus.dispatch({
        type: 'ReplaceFeatureInputs',
        partId,
        featureId,
        inputs: inputsPayload,
      });
      if (r.ok) {
        consoleLog('success', `Updated extrude feature: ${result.extentType} ${result.distance ?? ''} mm ${result.direction}, offset ${result.startOffset} mm (${profiles.length} profile${profiles.length === 1 ? '' : 's'})`, 'extrude');
      } else {
        consoleLog('error', `Extrude update failed: ${r.error.message}`, 'extrude');
      }
    } else {
      // Creating new feature
      const cmdResult = commandBus.dispatch({
        type: 'CreateExtrude',
        partId,
        inputs: inputsPayload,
      });
      if (cmdResult.ok) {
        consoleLog('success', `Created extrude feature: ${result.extentType} ${result.distance ?? ''} mm ${result.direction}, offset ${result.startOffset} mm (${profiles.length} profile${profiles.length === 1 ? '' : 's'})`, 'extrude');
      } else {
        consoleLog('error', `Extrude failed: ${cmdResult.error.message}`, 'extrude');
      }
    }

    setExtrudeState({ visible: false, sketchId: null, sketchName: '', profiles: [], editingFeatureId: null });
  }, [extrudeState.sketchId, extrudeState.profiles, extrudeState.editingFeatureId, extrudeState.startFace, extrudeState.endFace, partForFeature, commandBus]);

  /** Arm (or disarm) an Extrude face slot for the next viewport face click. */
  const handleExtrudeArmFaceSlot = useCallback((slot: ExtrudeFaceSlot | null) => {
    // Clear the selection so clicking the face that is already selected
    // still registers as a pick.
    if (slot) getAppState().selectionStore.getState().select(null);
    setExtrudeState(prev => ({ ...prev, faceSlot: slot }));
    if (slot) consoleLog('info', `Click the face to ${slot === 'start' ? 'start the extrude from' : 'extrude to'}`, 'extrude');
  }, []);

  const handleExtrudeClearFace = useCallback((slot: ExtrudeFaceSlot) => {
    setExtrudeState(prev => (slot === 'start' ? { ...prev, startFace: null } : { ...prev, endFace: null }));
  }, []);

  /**
   * While an Extrude face slot is armed, a viewport face click fills it with
   * a stable face reference, so the extrude follows the face on rebuild.
   * Same capture as the Hole dialog's face pick.
   */
  useEffect(() => {
    if (!extrudeState.visible || !extrudeState.faceSlot) return;
    const slot = extrudeState.faceSlot;
    const { selectionStore, viewportStore } = getAppState();
    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel.type !== 'face') return;
      const prevSel = prev?.selection;
      if (prevSel?.type === 'face' && prevSel.bodyId === sel.bodyId && prevSel.faceId === sel.faceId) return;
      const topo = viewportStore.getState().topologyMaps.find(t => t.bodyId === sel.bodyId);
      const face = topo?.faces.find(f => f.faceId === sel.faceId);
      if (!face?.stableFaceId) {
        consoleLog('warn', `Face has no stable id yet (body ${sel.bodyId}); pick it again after the rebuild`, 'extrude');
        return;
      }
      const picked: ExtrudePickedFace = {
        label: `Face ${String(face.stableFaceId).slice(-6)}`,
        planeRef: {
          type: 'stableTopology',
          bodyRef: { partId: sel.partId, bodyId: sel.bodyId },
          stableFaceId: face.stableFaceId,
        },
      };
      setExtrudeState(prev => (slot === 'start'
        ? { ...prev, startFace: picked, faceSlot: null }
        : { ...prev, endFace: picked, faceSlot: null }));
    });
    return () => { unsubscribe(); };
  }, [extrudeState.visible, extrudeState.faceSlot]);

  const handleExtrudeCancel = useCallback(() => {
    useSketchEditorStore.getState().setSelectionIntent('editGeometry');
    setExtrudeState({ visible: false, sketchId: null, sketchName: '', profiles: [], editingFeatureId: null });
    consoleLog('info', 'Extrude cancelled', 'extrude');
  }, []);

  /**
   * Export a sketch feature's 2D profile geometry as DXF or SVG.
   *
   * Resolves the sketch's entities (the canonical `inputs.buildGeometry`
   * projection the worker rebuilds from) and the part's resolved parameter
   * table — same `resolveAllParameters(project.parameters,
   * applyActiveConfiguration(part))` pairing buildSketch/rebuilder use — then
   * runs the pure serializer and triggers a browser download. No 3D body is
   * involved.
   */
  const handleExportSketch = useCallback((sketchFeatureId: string, format: 'dxf' | 'svg') => {
    let sketchPart = null;
    let sketchFeature = null;
    for (const part of Object.values(project.parts)) {
      const feature = part.timeline.find(f => f.id === sketchFeatureId && f.type === 'sketch');
      if (feature) {
        sketchPart = part;
        sketchFeature = feature;
        break;
      }
    }
    if (!sketchPart || !sketchFeature) {
      consoleLog('error', `Sketch not found: ${sketchFeatureId}`, 'sketch');
      return;
    }

    const inputs = sketchFeature.inputs as unknown as SketchFeatureInputs;
    const entities = Object.values(sketchBuildGeometry(inputs)) as SketchEntity[];

    const paramResult = resolveAllParameters(
      project.parameters,
      applyActiveConfiguration(sketchPart),
    );
    const params = paramResult.ok ? paramResult.value : {};

    const safeName = sketchFeature.name.replace(/[\\/:*?"<>|]/g, '_') || 'sketch';
    if (format === 'dxf') {
      downloadText(`${safeName}.dxf`, 'image/vnd.dxf', sketchToDxf(entities, params));
    } else {
      downloadText(`${safeName}.svg`, 'image/svg+xml', sketchToSvg(entities, params));
    }
    consoleLog('info', `Exported sketch "${sketchFeature.name}" as ${format.toUpperCase()}`, 'sketch');
  }, [project.parts, project.parameters]);

  // ---- Context menu handler ----

  const handleContextAction = useCallback((action: ContextMenuAction, featureId: string) => {
    switch (action) {
      case 'extrude':
        handleStartExtrude(featureId);
        break;
      case 'move': {
        // Move the selected body (the right-click selected it). The
        // placement transform lives on the source feature (featureId).
        const bodyId = selectedBodyId;
        if (!bodyId) {
          consoleLog('warn', 'Select a body to move', 'move');
          break;
        }
        if (sketchActive) {
          activeSketchIdRef.current = null;
          sketchActions.exitSketch();
          useSketchEditorStore.getState().clearAll();
        }
        setSectionActive(false);
        // Snapshot the current placement so Cancel can revert the whole move.
        const docNow = getAppState().documentStore.getState();
        let snapshot: { transform: unknown; bodyTransforms: unknown } = { transform: undefined, bodyTransforms: undefined };
        for (const part of Object.values(docNow.parts)) {
          const f = part.timeline.find(ff => ff.id === featureId);
          if (f) {
            const inp = f.inputs as { transform?: unknown; bodyTransforms?: unknown };
            snapshot = { transform: inp.transform, bodyTransforms: inp.bodyTransforms };
            break;
          }
        }
        // Imports own a placement field; everything else needs a `move`
        // feature to hold one. Reuse a trailing move that already targets
        // exactly this body, so nudging the same body repeatedly leaves one
        // feature in the timeline rather than a dozen.
        const sourceType = Object.values(docNow.parts)
          .flatMap(prt => prt.timeline).find(ff => ff.id === featureId)?.type;
        const derived = sourceType !== 'importedGeometry';
        let reuseId: string | null = null;
        if (derived) {
          for (const part of Object.values(docNow.parts)) {
            const trailing = [...part.timeline].reverse().find(ff => ff.type === 'move');
            if (trailing && targetsExactly(
              trailing.inputs as unknown as MoveFeatureInputs, [String(bodyId)],
            )) {
              reuseId = String(trailing.id);
              snapshot = {
                transform: (trailing.inputs as { transform?: unknown }).transform,
                bodyTransforms: undefined,
              };
            }
            if (reuseId) break;
          }
        }
        setMoveState({
          bodyId, sourceFeatureId: featureId, mode: 'translate',
          scope: derived ? 'feature' : 'body',
          snapshot,
          ...(derived ? { moveFeatureId: reuseId, createdHere: false } : {}),
        });
        consoleLog('info', 'Move: drag the arrows; Esc to cancel, Done to keep', 'move');
        break;
      }
      case 'centreAtOrigin':
      case 'dropOnPlane': {
        // Place the whole import by composing a translation onto its GROUP
        // transform, so a multi-body import keeps its internal arrangement —
        // the same reason Move all edits the group rather than each body.
        //
        // The bounds come from the rendered meshes, which are the geometry as
        // currently placed (the kernel bakes transforms in), so the delta is
        // simply "where it is now" -> "where we want it". No need to unwind
        // the existing transform.
        const ids = Object.entries(bodyToFeatureMap)
          .filter(([, fid]) => String(fid) === featureId)
          .map(([bid]) => bid as BodyId);
        if (ids.length === 0) {
          consoleLog('warn', 'No body to place for this import', 'move');
          break;
        }
        const bounds = viewportCtrl?.getBodiesBounds(ids);
        if (!bounds) {
          consoleLog('warn', 'Cannot read the import bounds — is it still building?', 'move');
          break;
        }
        const { min, max } = bounds;
        const centre: [number, number, number] = [
          (min[0] + max[0]) / 2,
          (min[1] + max[1]) / 2,
          (min[2] + max[2]) / 2,
        ];
        // Centre: bbox centre -> origin. Drop: keep X/Y, put the lowest point
        // on Z=0 so the part rests on the build plate.
        const delta: [number, number, number] = action === 'centreAtOrigin'
          ? [-centre[0], -centre[1], -centre[2]]
          : [0, 0, -min[2]];

        const docP = getAppState().documentStore.getState();
        for (const part of Object.values(docP.parts)) {
          const f = part.timeline.find(ff => ff.id === featureId);
          if (!f) continue;
          const cur = (f.inputs as { transform?: { position: [number, number, number]; rotation: [number, number, number, number] } }).transform;
          const curPos = cur?.position ?? [0, 0, 0];
          const next = {
            // Translation composes additively; rotation is carried untouched
            // because both placements are pure translations.
            position: [
              Math.round((curPos[0] + delta[0]) * 1000) / 1000,
              Math.round((curPos[1] + delta[1]) * 1000) / 1000,
              Math.round((curPos[2] + delta[2]) * 1000) / 1000,
            ] as [number, number, number],
            rotation: cur?.rotation ?? ([0, 0, 0, 1] as [number, number, number, number]),
          };
          commandBus.dispatch({
            type: 'UpdateFeatureInput', partId: part.id as PartId,
            featureId: featureId as FeatureId, path: ['transform'], value: next,
          });
          const moved = Math.hypot(...delta);
          consoleLog(
            'success',
            action === 'centreAtOrigin'
              ? `Moved import to the origin (${moved.toFixed(1)} mm)`
              : `Dropped import onto the XY plane (${moved.toFixed(1)} mm)`,
            'move',
          );
          break;
        }
        break;
      }
      case 'moveAll': {
        // Move the whole import as a group (the feature's group transform).
        // The gizmo attaches to any one of its bodies for interaction.
        let bodyId: string | undefined;
        for (const [bid, fid] of Object.entries(bodyToFeatureMap)) {
          if (String(fid) === featureId) { bodyId = String(bid); break; }
        }
        if (!bodyId) { consoleLog('warn', 'No body to move for this import', 'move'); break; }
        if (sketchActive) {
          activeSketchIdRef.current = null;
          sketchActions.exitSketch();
          useSketchEditorStore.getState().clearAll();
        }
        setSectionActive(false);
        const docAll = getAppState().documentStore.getState();
        let snapAll: { transform: unknown; bodyTransforms: unknown } = { transform: undefined, bodyTransforms: undefined };
        for (const part of Object.values(docAll.parts)) {
          const f = part.timeline.find(ff => ff.id === featureId);
          if (f) {
            const inp = f.inputs as { transform?: unknown; bodyTransforms?: unknown };
            snapAll = { transform: inp.transform, bodyTransforms: inp.bodyTransforms };
            break;
          }
        }
        setMoveState({ bodyId, sourceFeatureId: featureId, mode: 'translate', scope: 'all', snapshot: snapAll });
        consoleLog('info', 'Move all: drag to move the whole import; Esc to cancel', 'move');
        break;
      }
      case 'editSketch':
        handleEditSketch(featureId);
        break;
      case 'exportSketchDxf':
        handleExportSketch(featureId, 'dxf');
        break;
      case 'exportSketchSvg':
        handleExportSketch(featureId, 'svg');
        break;
      case 'delete': {
        const owner = findFeaturePartId(project, featureId);
        if (owner) {
          commandBus.dispatch({
            type: 'DeleteFeature',
            partId: owner,
            featureId: featureId as FeatureId,
          });
          consoleLog('info', `Deleted feature: ${featureId}`, 'command');
        }
        break;
      }
      case 'suppress': {
        const owner = findFeaturePartId(project, featureId);
        if (owner) {
          commandBus.dispatch({
            type: 'SuppressFeature',
            partId: owner,
            featureId: featureId as FeatureId,
            enabled: false,
          });
          consoleLog('info', `Suppressed feature: ${featureId}`, 'command');
        }
        break;
      }
      case 'enable': {
        const owner = findFeaturePartId(project, featureId);
        if (owner) {
          commandBus.dispatch({
            type: 'SuppressFeature',
            partId: owner,
            featureId: featureId as FeatureId,
            enabled: true,
          });
          consoleLog('info', `Enabled feature: ${featureId}`, 'command');
        }
        break;
      }
      case 'editFeature': {
        const partsList = Object.values(project.parts);
        for (const part of partsList) {
          const feature = part.timeline.find(f => f.id === featureId);
          if (feature && feature.type === 'extrude') {
            const inputs = feature.inputs as unknown as ExtrudeFeatureInputs;
            const profiles = inputs.profiles ?? [];

            // Extract existing values for dialog pre-population. Direction
            // is now just normal/reversed (symmetric moved to extent), and
            // we additionally surface extentType + targetPlane + targetBodyId.
            let existingDistance = 10;
            if (inputs.extent?.type === 'distance' || inputs.extent?.type === 'symmetric') {
              existingDistance = parseFloat(String(inputs.extent.value)) || 10;
            }
            const existingOffset = parseFloat(String(inputs.startOffset ?? '0')) || 0;
            const existingDirection = inputs.direction?.type === 'reversed'
              ? 'reversed' as const
              : 'normal' as const;
            const existingExtentType =
              inputs.extent?.type === 'symmetric'  ? 'symmetric'  as const :
              inputs.extent?.type === 'throughAll' ? 'throughAll' as const :
              inputs.extent?.type === 'toPlane'    ? 'toPlane'    as const :
                                                      'distance'    as const;
            const extentPlane = inputs.extent?.type === 'toPlane' ? inputs.extent.plane : undefined;
            const existingTargetPlane: ExtrudeTargetPlane =
              extentPlane?.type === 'defaultPlane' ? extentPlane.name
                : extentPlane?.type === 'constructionPlane' ? `cp:${extentPlane.planeId}`
                  : extentPlane?.type === 'stableTopology' ? 'face'
                    : 'XY';
            const faceOf = (ref: PlaneRef | undefined): ExtrudePickedFace | null =>
              ref?.type === 'stableTopology'
                ? { label: `Face ${String(ref.stableFaceId).slice(-6)}`, planeRef: ref }
                : null;
            const existingStartFace = faceOf(inputs.startFrom);
            const existingEndFace = faceOf(extentPlane);
            const existingOperation = inputs.operation ?? 'newBody';
            const existingTargetBodyId =
              Array.isArray(inputs.targetBodies) && inputs.targetBodies.length > 0
                ? String(inputs.targetBodies[0]!.bodyId)
                : undefined;

            const sketchId = profiles.length > 0 ? profiles[0]!.sketchId : null;

            // Make the referenced sketch visible so SketchViewer shows its geometry
            // (readonly display — no sketch editor, no tools, no palette)
            if (sketchId) {
              const sketchFeature = part.timeline.find(f => f.id === String(sketchId));
              if (sketchFeature && !sketchFeature.visible) {
                commandBus.dispatch({
                  type: 'SetFeatureVisibility',
                  partId: part.id,
                  featureId: sketchId,
                  visible: true,
                });
              }
            }

            // Show the extrude dialog with existing values.
            // The SketchViewer renders the sketch geometry readonly in the viewport.
            // Profiles from the original extrude are preserved for editing.
            setExtrudeState({
              visible: true,
              sketchId: sketchId ?? featureId as FeatureId,
              sketchName: feature.name,
              profiles,
              editingFeatureId: featureId as FeatureId,
              startFace: existingStartFace,
              endFace: existingEndFace,
              faceSlot: null,
              initialValues: {
                distance: existingDistance,
                startOffset: existingOffset,
                startType: existingStartFace ? 'face' : 'profile',
                direction: existingDirection,
                extentType: existingExtentType,
                targetPlane: existingTargetPlane,
                operation: existingOperation,
                ...(existingTargetBodyId ? { targetBodyId: existingTargetBodyId } : {}),
              },
            });
            consoleLog('info', `Editing feature: ${feature.name} (${profiles.length} profile${profiles.length === 1 ? '' : 's'})`, 'command');
            break;
          }
          if (feature && feature.type === 'constructionPlane') {
            // Reopen the offset dialog pre-filled with the plane's current
            // base + offset; the dialog shows the drag handle and previews
            // live, committing one UpdateFeatureInput on OK (see the gizmo
            // effect + handlePlaneConfirm).
            const inputs = feature.inputs as {
              kind: 'offsetFromPlane' | 'offsetFromFace';
              basePlane?: PlaneRef;
              face?: FaceRef;
              offset?: number | string;
            };
            const n = typeof inputs.offset === 'number' ? inputs.offset : parseFloat(String(inputs.offset));
            const offsetNum = Number.isFinite(n) ? n : 0;

            if (inputs.kind === 'offsetFromPlane' && inputs.basePlane) {
              const ref = inputs.basePlane;
              const label = ref.type === 'defaultPlane'
                ? ref.name
                : ref.type === 'constructionPlane'
                  ? (constructionPlanes.find(p => String(p.featureId) === ref.planeId)?.name ?? 'Plane')
                  : 'Plane';
              setPlaneState({
                visible: true, kind: 'offsetFromPlane',
                pickedPlane: { label, planeRef: ref }, pickedFace: null,
                editingFeatureId: featureId, draftCreated: false,
                offset: offsetNum, committedOffset: offsetNum,
              });
            } else if (inputs.kind === 'offsetFromFace' && inputs.face) {
              const fref = inputs.face;
              const label = fref.type === 'stableTopology'
                ? `Face ${String(fref.stableFaceId).slice(-6)}`
                : 'Face';
              setPlaneState({
                visible: true, kind: 'offsetFromFace',
                pickedPlane: null, pickedFace: { label, faceRef: fref },
                editingFeatureId: featureId, draftCreated: false,
                offset: offsetNum, committedOffset: offsetNum,
              });
            }
            consoleLog('info', `Editing plane: ${feature.name}`, 'command');
            break;
          }
        }
        break;
      }
      case 'editComponent': {
        // Find the part that owns the component feature and open
        // the per-instance editor. Multi-part projects: first hit wins —
        // imported components are always inside exactly one part's
        // timeline so there's no ambiguity in practice.
        for (const part of Object.values(project.parts)) {
          const feature = part.timeline.find(f => f.id === featureId);
          if (feature && feature.type === 'component') {
            openComponentEditor(part.id, featureId as FeatureId);
            break;
          }
        }
        break;
      }
      case 'duplicateComponent': {
        // "Give me another one of these" — re-dispatch CreateComponent
        // with the same component definition (reused by hash; handler is
        // idempotent) and the same per-instance inputs. The new feature
        // lands at the end of the timeline with the auto-incremented name
        // ("Bolt", "Bolt (2)", "Bolt (3)", …) the handler already produces.
        for (const part of Object.values(project.parts)) {
          const feature = part.timeline.find(f => f.id === featureId);
          if (!feature || feature.type !== 'component') continue;
          const inputs = feature.inputs as unknown as {
            componentRef: string;
            transform: { position: [number, number, number]; rotation: [number, number, number, number] };
            parameterOverrides: Record<string, string>;
            configurationId?: string | null;
            boolean: 'newBody' | 'cut' | 'join';
          };
          const def = project.embeddedComponents?.[inputs.componentRef];
          if (!def) {
            consoleLog('error', `Cannot duplicate: embedded component "${inputs.componentRef}" missing`, 'command');
            break;
          }
          const result = commandBus.dispatch({
            type: 'CreateComponent',
            partId: part.id,
            component: def,
            inputs: {
              transform: inputs.transform,
              parameterOverrides: { ...inputs.parameterOverrides },
              configurationId: inputs.configurationId ?? null,
              boolean: inputs.boolean,
            },
          });
          if (result.ok) {
            consoleLog('success', `Duplicated component: ${def.name}`, 'command');
          } else {
            consoleLog('error', `Duplicate failed: ${result.error.message}`, 'command');
          }
          break;
        }
        break;
      }
      case 'rename':
        // Not implemented yet
        break;
    }
  }, [project.parts, commandBus, handleStartExtrude, handleEditSketch, handleExportSketch, openComponentEditor, selectedBodyId, sketchActive, sketchActions, bodyToFeatureMap]);

  // ---- Toolbar extrude click: use selected sketch ----

  const handleToolbarExtrudeClick = useCallback(() => {
    if (sketchActive && activeSketchIdRef.current) {
      handleStartExtrude(activeSketchIdRef.current);
      return;
    }

    if (selectedFeatureId) {
      const parts = Object.values(project.parts);
      for (const part of parts) {
        const feature = part.timeline.find(f => f.id === selectedFeatureId);
        if (feature && feature.type === 'sketch') {
          handleStartExtrude(selectedFeatureId);
          return;
        }
      }
    }
    const parts = Object.values(project.parts);
    for (const part of parts) {
      const sketches = part.timeline.filter(f => f.type === 'sketch');
      if (sketches.length > 0) {
        const lastSketch = sketches[sketches.length - 1]!;
        handleStartExtrude(lastSketch.id);
        return;
      }
    }
    consoleLog('warn', 'No sketch available to extrude. Create a sketch first.', 'extrude');
  }, [selectedFeatureId, project.parts, handleStartExtrude, sketchActive]);

  // ---- Revolve flow ----

  /**
   * Open the revolve dialog for a sketch. Mirrors handleStartExtrude but
   * constrains profile selection to a single region — the dialog accepts
   * the first picked region and we ignore the rest.
   */
  const handleStartRevolve = useCallback((sketchFeatureId: string) => {
    const parts = Object.values(project.parts);
    let sketchName = 'Sketch';
    let hasProfiles = false;
    for (const part of parts) {
      const feature = part.timeline.find(f => f.id === sketchFeatureId);
      if (feature) {
        sketchName = feature.name;
        if (feature.type === 'sketch') {
          const sketchInputs = feature.inputs as unknown as SketchFeatureInputs;
          const regions = detectSketchRegions(sketchBuildGeometry(sketchInputs));
          hasProfiles = regions.length > 0;
        }
        break;
      }
    }

    if (!hasProfiles) {
      consoleLog('warn', `No closed profiles found in ${sketchName}. Draw a closed loop or circle first.`, 'revolve');
      return;
    }

    // If we're in sketch editing mode, sync and exit first
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }

    setRevolveState({
      visible: true,
      sketchId: sketchFeatureId as FeatureId,
      sketchName,
      profiles: [],
    });
    consoleLog('info', `Select a profile in ${sketchName} to revolve`, 'revolve');
  }, [project.parts, sketchActive, sketchActions]);

  const handleToolbarRevolveClick = useCallback(() => {
    if (sketchActive && activeSketchIdRef.current) {
      handleStartRevolve(activeSketchIdRef.current);
      return;
    }
    if (selectedFeatureId) {
      const parts = Object.values(project.parts);
      for (const part of parts) {
        const feature = part.timeline.find(f => f.id === selectedFeatureId);
        if (feature && feature.type === 'sketch') {
          handleStartRevolve(selectedFeatureId);
          return;
        }
      }
    }
    const parts = Object.values(project.parts);
    for (const part of parts) {
      const sketches = part.timeline.filter(f => f.type === 'sketch');
      if (sketches.length > 0) {
        const lastSketch = sketches[sketches.length - 1]!;
        handleStartRevolve(lastSketch.id);
        return;
      }
    }
    consoleLog('warn', 'No sketch available to revolve. Create a sketch first.', 'revolve');
  }, [selectedFeatureId, project.parts, handleStartRevolve, sketchActive]);

  const handleRevolveConfirm = useCallback((result: RevolveDialogResult) => {
    useSketchEditorStore.getState().setSelectionIntent('editGeometry');

    if (!revolveState.sketchId) return;
    const partId = partForFeature(revolveState.sketchId);
    if (!partId) return;

    const profile = revolveState.profiles[0];
    if (!profile) {
      consoleLog('error', 'No closed sketch profile selected for revolve', 'revolve');
      setRevolveState({ visible: false, sketchId: null, sketchName: '', profiles: [] });
      return;
    }

    const cmdResult = commandBus.dispatch({
      type: 'CreateRevolve',
      partId,
      inputs: {
        profile,
        axis: { type: result.axis },
        angle: String(result.angle),
        operation: result.operation,
        startOffset: String(result.startOffset),
        ...(result.targetBodyId
          ? { targetBodies: [{ partId, bodyId: result.targetBodyId as BodyId }] }
          : {}),
      },
    });
    if (cmdResult.ok) {
      consoleLog('success', `Created revolve: ${result.angle}° around ${result.axis.toUpperCase()} (${result.operation})`, 'revolve');
    } else {
      consoleLog('error', `Revolve failed: ${cmdResult.error.message}`, 'revolve');
    }

    setRevolveState({ visible: false, sketchId: null, sketchName: '', profiles: [] });
  }, [revolveState.sketchId, revolveState.profiles, partForFeature, commandBus]);

  const handleRevolveCancel = useCallback(() => {
    useSketchEditorStore.getState().setSelectionIntent('editGeometry');
    setRevolveState({ visible: false, sketchId: null, sketchName: '', profiles: [] });
    consoleLog('info', 'Revolve cancelled', 'revolve');
  }, []);

  // ---- Loft flow ----

  /**
   * Open the loft dialog. Unlike extrude/revolve, loft doesn't bind to a
   * single sketch up front — the dialog picker accepts profiles from any
   * currently-visible sketch. The opening gate is just "do we have ≥ 2
   * sketches in the document that could potentially supply profiles?"
   */
  const handleToolbarLoftClick = useCallback(() => {
    const allSketches = Object.values(project.parts)
      .flatMap(p => p.timeline.filter(f => f.type === 'sketch'));
    if (allSketches.length < 2) {
      consoleLog(
        'warn',
        `Loft needs profiles from at least 2 sketches. Found ${allSketches.length}.`,
        'loft',
      );
      return;
    }

    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }

    setLoftState({ visible: true, picksBySketch: {}, profiles: [] });
    consoleLog('info', 'Click 2+ closed profiles in viewport, in interpolation order', 'loft');
  }, [project.parts, sketchActive, sketchActions]);

  /**
   * Merge a SketchViewer's reported per-sketch profile list into the global
   * click-ordered list. Adds appear at the end (in their per-sketch click
   * order); removes drop from wherever they sat in the global list.
   */
  const handleLoftProfilesChangedForSketch = useCallback(
    (sketchId: FeatureId, newPicks: ProfileRef[]) => {
      setLoftState(prev => {
        const sid = String(sketchId);
        const old = prev.picksBySketch[sid] ?? [];

        const key = (p: ProfileRef) => JSON.stringify(p);
        const oldKeys = new Set(old.map(key));
        const newKeys = new Set(newPicks.map(key));

        const removedKeys = new Set(
          old.filter(p => !newKeys.has(key(p))).map(key),
        );
        const added = newPicks.filter(p => !oldKeys.has(key(p)));

        const profiles = [
          ...prev.profiles.filter(p => !removedKeys.has(key(p))),
          ...added,
        ];

        return {
          ...prev,
          picksBySketch: { ...prev.picksBySketch, [sid]: newPicks },
          profiles,
        };
      });
    },
    [],
  );

  /** Remove a single profile from the global list (X button on a dialog row). */
  const handleLoftRemoveProfile = useCallback((profileKey: string) => {
    setLoftState(prev => {
      const profiles = prev.profiles.filter(p => JSON.stringify(p) !== profileKey);
      // Also drop it from picksBySketch so the SketchViewer un-highlights it.
      const picksBySketch: Record<string, ProfileRef[]> = {};
      for (const [sid, picks] of Object.entries(prev.picksBySketch)) {
        picksBySketch[sid] = picks.filter(p => JSON.stringify(p) !== profileKey);
      }
      return { ...prev, profiles, picksBySketch };
    });
  }, []);

  const handleLoftConfirm = useCallback((result: LoftDialogResult) => {
    useSketchEditorStore.getState().setSelectionIntent('editGeometry');

    const profiles = loftState.profiles;
    if (profiles.length < 2) {
      consoleLog('error', 'Loft needs at least 2 profiles', 'loft');
      return;
    }

    const partId = partForFeature(profiles[0]?.sketchId);
    if (!partId) return;

    const inputs: LoftFeatureInputs = {
      profiles,
      operation: result.operation,
      ...(result.targetBodyId
        ? { targetBodies: [{ partId, bodyId: result.targetBodyId as BodyId }] }
        : {}),
    };
    if (result.ruled) inputs.ruled = true;
    if (result.closed) inputs.closed = true;

    const r = commandBus.dispatch({ type: 'CreateLoft', partId, inputs });
    if (r.ok) {
      consoleLog(
        'success',
        `Created loft: ${profiles.length} profiles (${result.operation}${result.ruled ? ', ruled' : ''}${result.closed ? ', closed' : ''})`,
        'loft',
      );
    } else {
      consoleLog('error', `Loft failed: ${r.error.message}`, 'loft');
    }

    setLoftState({ visible: false, picksBySketch: {}, profiles: [] });
  }, [loftState.profiles, partForFeature, commandBus]);

  const handleLoftCancel = useCallback(() => {
    useSketchEditorStore.getState().setSelectionIntent('editGeometry');
    setLoftState({ visible: false, picksBySketch: {}, profiles: [] });
    consoleLog('info', 'Loft cancelled', 'loft');
  }, []);

  /**
   * Build the human-readable entries shown in the LoftDialog from the current
   * ordered profile list. Each entry's key is the JSON-stringified profile so
   * the X button can target it for removal.
   */
  const loftDialogEntries: LoftDialogProfileEntry[] = loftState.profiles.map(p => {
    const sketchFeature = Object.values(project.parts)
      .flatMap(part => part.timeline)
      .find(f => f.id === p.sketchId);
    const sketchName = sketchFeature?.name ?? String(p.sketchId);
    const wireDesc = p.wireEntityIds.length === 1
      ? p.wireEntityIds[0]
      : `${p.wireEntityIds.length} edges`;
    return {
      key: JSON.stringify(p),
      label: `${sketchName}: ${wireDesc}`,
    };
  });

  // ---- Fillet flow ----

  /**
   * Open the Fillet dialog. Gates: at least one body must exist (you can't
   * fillet what isn't there). We don't pre-select any edges; the user
   * picks them in the viewport once the dialog is open.
   */
  const handleToolbarFilletClick = useCallback(() => {
    // Check there's at least one body in the document via the viewport store.
    const { viewportStore } = getAppState();
    const bodyMap = viewportStore.getState().bodyToFeatureMap;
    if (Object.keys(bodyMap).length === 0) {
      consoleLog('warn', 'Fillet needs an existing body. Create an extrude/revolve/loft first.', 'fillet');
      return;
    }
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setFilletState({ visible: true, edges: [] });
    consoleLog('info', 'Click body edges in the viewport to fillet them, or a face for all its edges', 'fillet');
  }, [sketchActive, sketchActions]);

  /**
   * While the Fillet dialog is open, every viewport pick (pick mode is
   * 'edgeOrFace', set by the dedicated effect below) appends stable
   * EdgeRefs to filletState.edges: an edge pick adds that edge (or its
   * tangent chain), a face pick adds the face's boundary edges. Refs
   * already in the list are skipped. We subscribe directly to the
   * selection store; hover-only updates keep the same selection object
   * and are ignored.
   */
  useEffect(() => {
    if (!filletState.visible) return;
    const { selectionStore, viewportStore } = getAppState();

    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel === prev?.selection) return;
      const { refs, missingStableIds } = resolveEdgePick(
        sel, viewportStore.getState().topologyMaps, { tangentChain: edgeTangentChainRef.current },
      );
      if (missingStableIds > 0 && 'bodyId' in sel) {
        consoleLog('warn', `Edge has no stable id yet (body ${sel.bodyId}); fillet ref would not survive rebuild`, 'fillet');
      }
      if (refs.length === 0) return;
      setFilletState(prev => {
        const edges = appendEdgeRefs(prev.edges, refs);
        return edges === prev.edges ? prev : { ...prev, edges };
      });
    });

    return () => { unsubscribe(); };
  }, [filletState.visible]);

  const handleFilletRemoveEdge = useCallback((edgeKey: string) => {
    setFilletState(prev => ({
      ...prev,
      edges: prev.edges.filter(e => JSON.stringify(e) !== edgeKey),
    }));
  }, []);

  const handleFilletConfirm = useCallback((result: FilletDialogResult) => {
    const firstEdge = filletState.edges[0];
    const partId = (firstEdge?.type === 'stableTopology' ? firstEdge.bodyRef.partId : null) ?? activePartId;
    if (!partId) return;

    if (filletState.edges.length === 0) {
      consoleLog('error', 'No edges picked for fillet', 'fillet');
      return;
    }

    const r = commandBus.dispatch({
      type: 'CreateFillet',
      partId,
      inputs: {
        edges: filletState.edges,
        radius: String(result.radius),
      },
    });
    if (r.ok) {
      consoleLog('success', `Created fillet: ${filletState.edges.length} edge(s) r=${result.radius}`, 'fillet');
    } else {
      consoleLog('error', `Fillet failed: ${r.error.message}`, 'fillet');
    }

    setFilletState({ visible: false, edges: [] });
  }, [filletState.edges, activePartId, commandBus]);

  const handleFilletCancel = useCallback(() => {
    setFilletState({ visible: false, edges: [] });
    consoleLog('info', 'Fillet cancelled', 'fillet');
  }, []);

  // ---- Chamfer flow ----
  // Same edge-pick + scalar-input pattern as Fillet. The viewport
  // pickMode goes to 'edge' while either dialog is open (handled in the
  // existing pickMode effect below), and the body-gating check matches
  // Fillet's: at least one body must exist before a chamfer makes
  // sense.

  const handleToolbarChamferClick = useCallback(() => {
    const { viewportStore } = getAppState();
    const bodyMap = viewportStore.getState().bodyToFeatureMap;
    if (Object.keys(bodyMap).length === 0) {
      consoleLog('warn', 'Chamfer needs an existing body. Create an extrude/revolve/loft first.', 'chamfer');
      return;
    }
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setChamferState({ visible: true, edges: [] });
    consoleLog('info', 'Click body edges in the viewport to chamfer them, or a face for all its edges', 'chamfer');
  }, [sketchActive, sketchActions]);

  // Edge-pick subscription — mirror of the Fillet effect, routed into
  // chamferState. Kept as its own effect so each dialog deactivates
  // cleanly via its own visible flag.
  useEffect(() => {
    if (!chamferState.visible) return;
    const { selectionStore, viewportStore } = getAppState();

    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel === prev?.selection) return;
      const { refs, missingStableIds } = resolveEdgePick(
        sel, viewportStore.getState().topologyMaps, { tangentChain: edgeTangentChainRef.current },
      );
      if (missingStableIds > 0 && 'bodyId' in sel) {
        consoleLog('warn', `Edge has no stable id yet (body ${sel.bodyId}); chamfer ref would not survive rebuild`, 'chamfer');
      }
      if (refs.length === 0) return;
      setChamferState(prev => {
        const edges = appendEdgeRefs(prev.edges, refs);
        return edges === prev.edges ? prev : { ...prev, edges };
      });
    });

    return () => { unsubscribe(); };
  }, [chamferState.visible]);

  const handleChamferRemoveEdge = useCallback((edgeKey: string) => {
    setChamferState(prev => ({
      ...prev,
      edges: prev.edges.filter(e => JSON.stringify(e) !== edgeKey),
    }));
  }, []);

  const handleChamferConfirm = useCallback((result: ChamferDialogResult) => {
    const firstEdge = chamferState.edges[0];
    const partId = (firstEdge?.type === 'stableTopology' ? firstEdge.bodyRef.partId : null) ?? activePartId;
    if (!partId) return;

    if (chamferState.edges.length === 0) {
      consoleLog('error', 'No edges picked for chamfer', 'chamfer');
      return;
    }

    const r = commandBus.dispatch({
      type: 'CreateChamfer',
      partId,
      inputs: {
        edges: chamferState.edges,
        distance: String(result.distance),
      },
    });
    if (r.ok) {
      consoleLog('success', `Created chamfer: ${chamferState.edges.length} edge(s) d=${result.distance}`, 'chamfer');
    } else {
      consoleLog('error', `Chamfer failed: ${r.error.message}`, 'chamfer');
    }

    setChamferState({ visible: false, edges: [] });
  }, [chamferState.edges, activePartId, commandBus]);

  const handleChamferCancel = useCallback(() => {
    setChamferState({ visible: false, edges: [] });
    consoleLog('info', 'Chamfer cancelled', 'chamfer');
  }, []);

  // ---- Mirror Body flow ----

  /**
   * Open the Mirror dialog. Gate: at least one body must exist (you
   * can't mirror what isn't there). The dialog's body picker is fed by
   * the effect below, which subscribes to body selections in the
   * viewport while the dialog is open.
   */
  const handleToolbarMirrorClick = useCallback(() => {
    const { viewportStore } = getAppState();
    const bodyMap = viewportStore.getState().bodyToFeatureMap;
    if (Object.keys(bodyMap).length === 0) {
      consoleLog('warn', 'Mirror needs an existing body. Create an extrude/revolve/loft first.', 'mirror');
      return;
    }
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setMirrorState({ visible: true, pickedBody: null });
    consoleLog('info', 'Click a body in the viewport to mirror it', 'mirror');
  }, [sketchActive, sketchActions]);

  // Body-pick subscription — same shape as the chamfer/hole effects,
  // just routed to mirrorState. Captures the bodyId of the clicked
  // body; v1 keeps only the most recent pick (single-body mirror).
  useEffect(() => {
    if (!mirrorState.visible) return;
    const { selectionStore } = getAppState();

    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel.type !== 'body') return;
      const prevSel = prev?.selection;
      if (prevSel?.type === 'body' && prevSel.bodyId === sel.bodyId) return;

      setMirrorState(prev => ({
        ...prev,
        pickedBody: {
          bodyId: String(sel.bodyId),
          // Body labels follow a "Body N" convention; the index is just
          // the sort position of the bodyId among visible bodies. Good
          // enough without threading a body→name map through.
          label: `Body (${String(sel.bodyId).slice(0, 12)}...)`,
        },
      }));
    });

    return () => { unsubscribe(); };
  }, [mirrorState.visible]);

  const handleMirrorClearBody = useCallback(() => {
    setMirrorState(prev => ({ ...prev, pickedBody: null }));
  }, []);

  const handleMirrorConfirm = useCallback((result: MirrorDialogResult) => {
    const partId = partForBody(mirrorState.pickedBody?.bodyId);
    if (!partId) return;

    if (!mirrorState.pickedBody) {
      consoleLog('error', 'No body picked for mirror', 'mirror');
      return;
    }

    const r = commandBus.dispatch({
      type: 'CreateMirror',
      partId,
      inputs: {
        sourceBody: {
          partId,
          bodyId: mirrorState.pickedBody.bodyId as never,
        },
        plane: { type: 'defaultPlane', name: result.plane },
        operation: result.operation,
      },
    });
    if (r.ok) {
      consoleLog('success', `Created mirror across ${result.plane} (${result.operation})`, 'mirror');
    } else {
      consoleLog('error', `Mirror failed: ${r.error.message}`, 'mirror');
    }

    setMirrorState({ visible: false, pickedBody: null });
  }, [partForBody, mirrorState.pickedBody, commandBus]);

  const handleMirrorCancel = useCallback(() => {
    setMirrorState({ visible: false, pickedBody: null });
    consoleLog('info', 'Mirror cancelled', 'mirror');
  }, []);

  // ---- Shell flow ----

  /**
   * Open the Shell dialog. Gate: at least one body must exist (you
   * can't hollow what isn't there). Faces are picked from the viewport
   * via the face-pick subscription below; the first face pins the
   * target body and subsequent picks must lie on that same body.
   */
  const handleToolbarShellClick = useCallback(() => {
    const { viewportStore } = getAppState();
    const bodyMap = viewportStore.getState().bodyToFeatureMap;
    if (Object.keys(bodyMap).length === 0) {
      consoleLog('warn', 'Shell needs an existing body. Create an extrude/revolve/loft first.', 'shell');
      return;
    }
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setShellState({ visible: true, faces: [] });
    consoleLog('info', 'Click body faces in the viewport to remove them when shelling', 'shell');
  }, [sketchActive, sketchActions]);

  // Face-pick subscription. Mirrors the chamfer edge-pick effect:
  // every face selection while the dialog is open is appended to
  // shellState.faces as a stable FaceRef. Cross-body picks (a face on
  // a different body than already-picked faces) are rejected with a
  // console warning — Shell operates on one body at a time.
  useEffect(() => {
    if (!shellState.visible) return;
    const { selectionStore, viewportStore } = getAppState();

    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel.type !== 'face') return;
      const prevSel = prev?.selection;
      if (
        prevSel?.type === 'face' &&
        prevSel.bodyId === sel.bodyId &&
        prevSel.faceId === sel.faceId
      ) return;

      const topoMaps = viewportStore.getState().topologyMaps;
      const topo = topoMaps.find(t => t.bodyId === sel.bodyId);
      const face = topo?.faces.find(f => f.faceId === sel.faceId);
      if (!face?.stableFaceId) {
        consoleLog('warn', `Face has no stable id yet (body ${sel.bodyId}); shell ref would not survive rebuild`, 'shell');
        return;
      }

      const ref: FaceRef = {
        type: 'stableTopology',
        bodyRef: { partId: sel.partId, bodyId: sel.bodyId },
        stableFaceId: face.stableFaceId,
      };

      setShellState(prev => {
        // Reject cross-body picks. Shell hollows ONE body — picking a
        // face on a different body is almost certainly a misclick.
        if (prev.faces.length > 0) {
          const first = prev.faces[0]!;
          if (first.type === 'stableTopology' && String(first.bodyRef.bodyId) !== String(sel.bodyId)) {
            consoleLog('warn', `Shell faces must all belong to the same body (already picked from ${first.bodyRef.bodyId})`, 'shell');
            return prev;
          }
        }
        const key = JSON.stringify(ref);
        if (prev.faces.some(f => JSON.stringify(f) === key)) return prev;
        return { ...prev, faces: [...prev.faces, ref] };
      });
    });

    return () => { unsubscribe(); };
  }, [shellState.visible]);

  const handleShellRemoveFace = useCallback((faceKey: string) => {
    setShellState(prev => ({
      ...prev,
      faces: prev.faces.filter(f => JSON.stringify(f) !== faceKey),
    }));
  }, []);

  const handleShellConfirm = useCallback((result: ShellDialogResult) => {
    if (shellState.faces.length === 0) {
      consoleLog('error', 'No faces picked for shell', 'shell');
      return;
    }
    // First-face's body is the source body — the subscription above
    // already guarantees every face lives on it — and its part is where
    // the shell feature belongs.
    const first = shellState.faces[0]!;
    if (first.type !== 'stableTopology') {
      consoleLog('error', 'Shell faces must be stable-topology refs', 'shell');
      return;
    }
    const sourceBody = first.bodyRef;
    const partId = sourceBody.partId;

    const r = commandBus.dispatch({
      type: 'CreateShell',
      partId,
      inputs: {
        sourceBody,
        removedFaces: shellState.faces,
        thickness: String(result.thickness),
      },
    });
    if (r.ok) {
      consoleLog('success', `Created shell: ${shellState.faces.length} face(s) removed, t=${result.thickness}`, 'shell');
    } else {
      consoleLog('error', `Shell failed: ${r.error.message}`, 'shell');
    }

    setShellState({ visible: false, faces: [] });
  }, [shellState.faces, project.parts, commandBus]);

  const handleShellCancel = useCallback(() => {
    setShellState({ visible: false, faces: [] });
    consoleLog('info', 'Shell cancelled', 'shell');
  }, []);

  // ---- Pattern flow (Linear + Circular share one dialog) ----

  const handleToolbarPatternClick = useCallback(() => {
    const { viewportStore } = getAppState();
    const bodyMap = viewportStore.getState().bodyToFeatureMap;
    if (Object.keys(bodyMap).length === 0) {
      consoleLog('warn', 'Pattern needs an existing body. Create an extrude/revolve/loft first.', 'pattern');
      return;
    }
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setPatternState({ visible: true, pickedBody: null });
    consoleLog('info', 'Click a body in the viewport to pattern it', 'pattern');
  }, [sketchActive, sketchActions]);

  // Body-pick subscription — same shape as the Mirror flow.
  useEffect(() => {
    if (!patternState.visible) return;
    const { selectionStore } = getAppState();
    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel.type !== 'body') return;
      const prevSel = prev?.selection;
      if (prevSel?.type === 'body' && prevSel.bodyId === sel.bodyId) return;
      setPatternState(prev => ({
        ...prev,
        pickedBody: {
          bodyId: String(sel.bodyId),
          label: `Body (${String(sel.bodyId).slice(0, 12)}...)`,
        },
      }));
    });
    return () => { unsubscribe(); };
  }, [patternState.visible]);

  const handlePatternClearBody = useCallback(() => {
    setPatternState(prev => ({ ...prev, pickedBody: null }));
  }, []);

  const handlePatternConfirm = useCallback((result: PatternDialogResult) => {
    const partId = partForBody(patternState.pickedBody?.bodyId);
    if (!partId) return;

    if (!patternState.pickedBody) {
      consoleLog('error', 'No body picked for pattern', 'pattern');
      return;
    }

    const sourceBody = {
      partId,
      bodyId: patternState.pickedBody.bodyId as never,
    };

    // Build the inputs payload — discriminated by patternType. The
    // schema currently models linear/circular as separate types in a
    // union; CreatePattern command takes the union directly, then the
    // handler routes on patternType.
    const inputs = result.kind === 'linear'
      ? {
          patternType: 'linear' as const,
          sourceBody,
          direction: { type: result.axis } as const,
          count: String(result.count),
          spacing: String(result.spacing),
        }
      : {
          patternType: 'circular' as const,
          sourceBody,
          axis: { type: result.axis } as const,
          count: String(result.count),
          // fullAngle defaults to 360 in the builder (omitted here).
        };

    const r = commandBus.dispatch({
      type: 'CreatePattern',
      partId,
      inputs,
    });
    if (r.ok) {
      const desc = result.kind === 'linear'
        ? `Linear ${result.axis.toUpperCase()} × ${result.count} @ ${result.spacing}mm`
        : `Circular ${result.axis.toUpperCase()} × ${result.count}`;
      consoleLog('success', `Created pattern: ${desc}`, 'pattern');
    } else {
      consoleLog('error', `Pattern failed: ${r.error.message}`, 'pattern');
    }

    setPatternState({ visible: false, pickedBody: null });
  }, [partForBody, patternState.pickedBody, commandBus]);

  const handlePatternCancel = useCallback(() => {
    setPatternState({ visible: false, pickedBody: null });
    consoleLog('info', 'Pattern cancelled', 'pattern');
  }, []);

  // ---- Sweep flow ----

  const handleToolbarSweepClick = useCallback(() => {
    // Sweep needs at least 2 sketches (one for profile, one for path).
    const sketchCount = Object.values(project.parts)
      .flatMap(p => p.timeline)
      .filter(f => f.type === 'sketch').length;
    if (sketchCount < 2) {
      consoleLog('warn', `Sweep needs at least 2 sketches (profile + path). Found ${sketchCount}.`, 'sweep');
      return;
    }
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setSweepState({ visible: true });
  }, [project.parts, sketchActive, sketchActions]);

  const handleSweepConfirm = useCallback((result: SweepDialogResult) => {
    const partId = partForFeature(result.profileSketchId);
    if (!partId) return;

    const r = commandBus.dispatch({
      type: 'CreateSweep',
      partId,
      inputs: {
        profile: { sketchId: result.profileSketchId as never, wireEntityIds: [] },
        path: { sketchId: result.pathSketchId as never, wireEntityIds: [] },
        operation: 'newBody',
      },
    });
    if (r.ok) {
      consoleLog('success', `Created sweep`, 'sweep');
    } else {
      consoleLog('error', `Sweep failed: ${r.error.message}`, 'sweep');
    }
    setSweepState({ visible: false });
  }, [partForFeature, commandBus]);

  const handleSweepCancel = useCallback(() => {
    setSweepState({ visible: false });
    consoleLog('info', 'Sweep cancelled', 'sweep');
  }, []);

  // List of sketches available for the Sweep dropdowns. Computed
  // inline since Sweep is the only consumer of this exact shape (the
  // visibleSketches memo lower down filters by visibility for the
  // viewport overlay — Sweep doesn't care about visibility).
  const allSketchesForSweep: SweepDialogSketchOption[] = (() => {
    const out: SweepDialogSketchOption[] = [];
    for (const part of Object.values(project.parts)) {
      for (const feature of part.timeline) {
        if (feature.type !== 'sketch') continue;
        out.push({ sketchId: String(feature.id), label: feature.name });
      }
    }
    return out;
  })();

  // ---- Construction Plane flow ----

  /**
   * Open the construction-plane dialog. No viewport gating — a Plane is
   * pure reference geometry and can be created from an empty document.
   * If the user is mid-sketch we cleanly exit first, same as the other
   * modeling tools, so the new Plane lands in the modeling timeline.
   */
  /** Open the Offset Plane dialog. User picks a default/CP via the
   *  SketchPlanePicker overlay, then types an offset. */
  const handleToolbarOffsetPlaneClick = useCallback(() => {
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setPlaneState({
      visible: true,
      kind: 'offsetFromPlane',
      pickedPlane: null,
      pickedFace: null,
      editingFeatureId: null,
      draftCreated: false,
      offset: 10,
      committedOffset: 10,
    });
    consoleLog('info', 'Click a default plane or construction plane in the viewport', 'plane');
  }, [sketchActive, sketchActions]);

  /** Open the Plane from Face dialog. User picks a face via the
   *  standard face picker, then types an offset along the face normal. */
  const handleToolbarPlaneFromFaceClick = useCallback(() => {
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    // Gate: we need at least one body for a face to exist.
    const { viewportStore } = getAppState();
    const bodyMap = viewportStore.getState().bodyToFeatureMap;
    if (Object.keys(bodyMap).length === 0) {
      consoleLog('warn', 'Plane from Face needs an existing body. Create an extrude/revolve/loft first', 'plane');
      return;
    }
    setPlaneState({
      visible: true,
      kind: 'offsetFromFace',
      pickedPlane: null,
      pickedFace: null,
      editingFeatureId: null,
      draftCreated: false,
      offset: 10,
      committedOffset: 10,
    });
    consoleLog('info', 'Click a face on a body in the viewport', 'plane');
  }, [sketchActive, sketchActions]);

  const handlePlaneClearPickedPlane = useCallback(() => {
    setPlaneState(prev => ({ ...prev, pickedPlane: null }));
  }, []);

  const handlePlaneClearPickedFace = useCallback(() => {
    setPlaneState(prev => ({ ...prev, pickedFace: null }));
  }, []);

  /**
   * Subscribe to viewport face picks while the plane dialog is in
   * `offsetFromFace` mode. Each click captures the picked face as a
   * stable FaceRef (so it survives upstream rebuilds via the topology-
   * naming layer) plus a short human label for the dialog row.
   */
  useEffect(() => {
    if (!planeState.visible || planeState.kind !== 'offsetFromFace') return;
    const { selectionStore, viewportStore } = getAppState();

    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel.type !== 'face') return;
      const prevSel = prev?.selection;
      if (
        prevSel?.type === 'face' &&
        prevSel.bodyId === sel.bodyId &&
        prevSel.faceId === sel.faceId
      ) return;

      // Look up the stable face id from the body's topology map.
      const topoMaps = viewportStore.getState().topologyMaps;
      const topo = topoMaps.find(t => t.bodyId === sel.bodyId);
      const face = topo?.faces.find(f => f.faceId === sel.faceId);
      if (!face?.stableFaceId) {
        consoleLog('warn', `Face has no stable id yet (body ${sel.bodyId}); construction-plane ref would not survive rebuild`, 'plane');
        return;
      }

      const faceRef: FaceRef = {
        type: 'stableTopology',
        bodyRef: { partId: sel.partId, bodyId: sel.bodyId },
        stableFaceId: face.stableFaceId,
      };
      const shortId = String(face.stableFaceId).slice(-6);
      const label = `Face ${shortId}`;
      setPlaneState(prev => ({ ...prev, pickedFace: { label, faceRef } }));
    });
    return () => { unsubscribe(); };
  }, [planeState.visible, planeState.kind]);

  /**
   * Handle a plane pick from the SketchPlanePicker overlay (only mounted
   * when the dialog is in `offsetFromPlane` mode). Maps the picker's
   * discriminated pick into the PlaneRef variant the schema expects.
   */
  const handlePlaneDialogPlanePicked = useCallback((pick: SketchPlanePick) => {
    // Mounted without `pickFaces`, so a face never arrives here.
    if (pick.kind === 'face') return;
    const planeRef: PlaneRef =
      pick.kind === 'default'
        ? { type: 'defaultPlane', name: pick.name }
        : { type: 'constructionPlane', planeId: pick.featureId };
    const label = pick.kind === 'default' ? pick.name : pick.name;
    setPlaneState(prev => ({ ...prev, pickedPlane: { label, planeRef } }));
  }, []);

  const handlePlaneConfirm = useCallback((result: ConstructionPlaneDialogResult) => {
    const partId = partForFeature(planeState.editingFeatureId);
    if (!partId) return;

    const closed = {
      visible: false, kind: 'offsetFromPlane' as const,
      pickedPlane: null, pickedFace: null,
      editingFeatureId: null, draftCreated: false, offset: 10, committedOffset: 10,
    };

    // Editing an existing plane OR confirming a create-ahead draft: commit
    // ONE offset change (base unchanged) if the previewed offset differs
    // from what's stored. The drag handle previewed live; this is its single
    // command. A draft created at the committed offset needs no extra write.
    if (planeState.editingFeatureId) {
      const next = Math.round(planeState.offset * 100) / 100;
      if (next !== Math.round(planeState.committedOffset * 100) / 100) {
        commandBus.dispatch({
          type: 'UpdateFeatureInput',
          partId,
          featureId: planeState.editingFeatureId as FeatureId,
          path: ['offset'],
          value: String(next),
        });
        consoleLog('success', `Plane offset: ${next} mm`, 'plane');
      }
      setPlaneState(closed);
      return;
    }

    const inputs = result.kind === 'offsetFromPlane'
      ? {
          kind: 'offsetFromPlane' as const,
          basePlane: result.planeRef,
          offset: String(result.offset),
        }
      : {
          kind: 'offsetFromFace' as const,
          face: result.faceRef,
          offset: String(result.offset),
        };

    const r = commandBus.dispatch({
      type: 'CreateConstructionPlane',
      partId,
      inputs,
    });
    if (r.ok) {
      const desc = result.kind === 'offsetFromPlane'
        ? `from plane, offset ${result.offset} mm`
        : `from face, offset ${result.offset} mm`;
      consoleLog('success', `Created plane: ${desc}`, 'plane');
    } else {
      consoleLog('error', `Plane creation failed: ${r.error.message}`, 'plane');
    }
    // Clear face selection so its highlight doesn't obscure the new CP.
    const { selectionStore } = getAppState();
    selectionStore.getState().select(null);
    setPlaneState(closed);
  }, [partForFeature, planeState.editingFeatureId, planeState.offset, planeState.committedOffset, commandBus]);

  const handlePlaneCancel = useCallback(() => {
    const partId = partForFeature(planeState.editingFeatureId);
    if (planeState.draftCreated && planeState.editingFeatureId && partId) {
      // create-ahead draft → discard it entirely.
      commandBus.dispatch({
        type: 'DeleteFeature',
        partId,
        featureId: planeState.editingFeatureId as FeatureId,
      });
    } else if (planeState.editingFeatureId) {
      // Editing an existing plane: the mesh was moved live for preview but
      // nothing was dispatched — re-apply the committed planes to snap back.
      viewportCtrl?.setConstructionPlanes(constructionPlanes);
    }
    setPlaneState({
      visible: false, kind: 'offsetFromPlane', pickedPlane: null, pickedFace: null,
      editingFeatureId: null, draftCreated: false, offset: 10, committedOffset: 10,
    });
    consoleLog('info', 'Plane cancelled', 'plane');
  }, [partForFeature, planeState.editingFeatureId, planeState.draftCreated, commandBus, viewportCtrl, constructionPlanes]);

  // Create-ahead: once a base is picked in CREATE mode, materialize the
  // construction plane immediately as a draft so the dialog previews it with
  // the drag handle — unifying create with the edit path. OK commits any
  // offset change (handlePlaneConfirm); Cancel deletes the draft
  // (handlePlaneCancel). Guarded so it fires once per dialog session.
  useEffect(() => {
    if (!planeState.visible || planeState.editingFeatureId) return;
    const hasBase = planeState.kind === 'offsetFromPlane'
      ? !!planeState.pickedPlane
      : !!planeState.pickedFace;
    if (!hasBase) return;

    const base = planeState.kind === 'offsetFromPlane'
      ? planeState.pickedPlane!.planeRef
      : planeState.pickedFace!.faceRef;
    const partId = base.type === 'stableTopology'
      ? base.bodyRef.partId
      : base.type === 'constructionPlane'
        ? partForFeature(base.planeId)
        : activePartId;
    if (!partId) return;

    const inputs = planeState.kind === 'offsetFromPlane'
      ? { kind: 'offsetFromPlane' as const, basePlane: planeState.pickedPlane!.planeRef, offset: String(planeState.offset) }
      : { kind: 'offsetFromFace' as const, face: planeState.pickedFace!.faceRef, offset: String(planeState.offset) };

    const r = commandBus.dispatch({ type: 'CreateConstructionPlane', partId, inputs });
    if (!r.ok) {
      consoleLog('error', `Plane preview failed: ${r.error.message}`, 'plane');
      return;
    }
    const proj = getAppState().documentStore.getState();
    const part = proj.parts[partId];
    const newFeature = part?.timeline[part.timeline.length - 1];
    if (newFeature && newFeature.type === 'constructionPlane') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- records the draft this effect just dispatched
      setPlaneState(s => ({
        ...s,
        editingFeatureId: newFeature.id,
        draftCreated: true,
        committedOffset: s.offset,
      }));
    }
  }, [planeState.visible, planeState.editingFeatureId, planeState.kind, planeState.pickedPlane, planeState.pickedFace, planeState.offset, project.parts, commandBus, partForFeature, activePartId]);

  // ---- Hole flow ----

  /**
   * Open the Hole dialog. Same gating as Plane from Face — we need at
   * least one body in the scene for a face to exist (you can't drill
   * into empty space). If the user is mid-sketch we cleanly exit first.
   */
  const handleToolbarHoleClick = useCallback(() => {
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    const { viewportStore } = getAppState();
    const bodyMap = viewportStore.getState().bodyToFeatureMap;
    if (Object.keys(bodyMap).length === 0) {
      consoleLog('warn', 'Hole needs an existing body. Create an extrude/revolve/loft first', 'hole');
      return;
    }
    setHoleState({ visible: true, pickedFace: null });
    consoleLog('info', 'Click a face on a body in the viewport', 'hole');
  }, [sketchActive, sketchActions]);

  const handleHoleClearPickedFace = useCallback(() => {
    setHoleState(prev => ({ ...prev, pickedFace: null }));
  }, []);

  /**
   * Subscribe to viewport face picks while the Hole dialog is open.
   * Captures the picked face as a stable FaceRef so the hole survives
   * upstream rebuilds via the topology-naming layer. Mirrors the
   * Construction-Plane `offsetFromFace` subscription verbatim — both
   * dialogs need exactly the same "click any planar face → stable
   * FaceRef" capture, just routed into different state.
   */
  useEffect(() => {
    if (!holeState.visible) return;
    const { selectionStore, viewportStore } = getAppState();

    const unsubscribe = selectionStore.subscribe((state, prev) => {
      const sel = state.selection;
      if (!sel || sel.type !== 'face') return;
      const prevSel = prev?.selection;
      if (
        prevSel?.type === 'face' &&
        prevSel.bodyId === sel.bodyId &&
        prevSel.faceId === sel.faceId
      ) return;

      const topoMaps = viewportStore.getState().topologyMaps;
      const topo = topoMaps.find(t => t.bodyId === sel.bodyId);
      const face = topo?.faces.find(f => f.faceId === sel.faceId);
      if (!face?.stableFaceId) {
        consoleLog('warn', `Face has no stable id yet (body ${sel.bodyId}); hole ref would not survive rebuild`, 'hole');
        return;
      }

      const faceRef: FaceRef = {
        type: 'stableTopology',
        bodyRef: { partId: sel.partId, bodyId: sel.bodyId },
        stableFaceId: face.stableFaceId,
      };
      const shortId = String(face.stableFaceId).slice(-6);
      const label = `Face ${shortId}`;
      setHoleState(prev => ({ ...prev, pickedFace: { label, faceRef } }));
    });
    return () => { unsubscribe(); };
  }, [holeState.visible]);

  const handleToolbarBooleanClick = useCallback((operation: 'union' | 'subtract' | 'intersect') => {
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setBooleanState({ visible: true, operation });
  }, [sketchActive, sketchActions]);

  const handleBooleanConfirm = useCallback((result: BooleanDialogResult) => {
    const partId = partForBody(result.targetBodyId);
    if (!partId) return;
    const r = commandBus.dispatch({
      type: 'CreateBoolean',
      partId,
      inputs: {
        operation: result.operation,
        targetBody: { partId, bodyId: result.targetBodyId as BodyId },
        toolBodies: result.toolBodyIds.map(id => ({ partId, bodyId: id as BodyId })),
      },
    });
    if (r.ok) {
      consoleLog('success', `${result.operation} with ${result.toolBodyIds.length} tool body(ies)`, 'boolean');
    } else {
      consoleLog('error', `Boolean failed: ${r.error.message}`, 'boolean');
    }
    setBooleanState(s => ({ ...s, visible: false }));
  }, [partForBody, commandBus]);

  const handleToolbarPrimitiveClick = useCallback((kind: PrimitiveKind) => {
    // A primitive needs no sketch and no body, so unlike Hole there is
    // nothing to check — just leave the sketch if one is open.
    if (sketchActive) {
      activeSketchIdRef.current = null;
      sketchActions.exitSketch();
      useSketchEditorStore.getState().clearAll();
    }
    setPrimitiveState({ visible: true, kind });
  }, [sketchActive, sketchActions]);

  const handlePrimitiveConfirm = useCallback((result: PrimitiveDialogResult) => {
    const partId = partForBody(result.targetBodyId);
    if (!partId) return;

    // The dialog edits numbers; the feature stores expressions, so that a
    // primitive can later be driven by the parameter table.
    const dims = Object.fromEntries(
      Object.entries(result.dimensions).map(([key, value]) => [key, String(value)]),
    );
    const inputs: PrimitiveFeatureInputs = {
      shape: { kind: result.kind, ...dims } as PrimitiveFeatureInputs['shape'],
      transform: { position: result.position, rotation: [0, 0, 0, 1] },
      operation: result.operation,
      ...(result.targetBodyId
        ? { targetBodies: [{ partId, bodyId: result.targetBodyId as BodyId }] }
        : {}),
    };

    const r = commandBus.dispatch({ type: 'CreatePrimitive', partId, inputs });
    if (r.ok) {
      const dimDesc = Object.entries(result.dimensions)
        .map(([key, value]) => `${key} ${value}`)
        .join(', ');
      consoleLog('success', `Created ${result.kind}: ${dimDesc}`, 'primitive');
    } else {
      consoleLog('error', `${result.kind} creation failed: ${r.error.message}`, 'primitive');
    }
    setPrimitiveState({ visible: false, kind: result.kind });
  }, [partForBody, commandBus]);

  const handlePrimitiveCancel = useCallback(() => {
    setPrimitiveState(prev => ({ ...prev, visible: false }));
  }, []);

  const handleHoleConfirm = useCallback((result: HoleDialogResult) => {
    const partId = result.faceRef.type === 'stableTopology'
      ? result.faceRef.bodyRef.partId
      : activePartId;
    if (!partId) return;

    // The builder always emits center [0, 0] in face-local (u, v) for
    // v1 (face-center-auto placement). Stored as Expression strings so
    // future click-to-position can swap in real numbers without a
    // schema migration.
    const inputs: HoleFeatureInputs = {
      face: result.faceRef,
      center: ['0', '0'],
      direction: { type: 'normal' },
      diameter: String(result.diameter),
      extent: result.extent === 'throughAll'
        ? { type: 'throughAll' }
        : { type: 'distance', value: String(result.depth) },
      kind: result.kind,
    };
    if (result.kind === 'counterbore') {
      inputs.counterboreDiameter = String(result.counterboreDiameter ?? 0);
      inputs.counterboreDepth = String(result.counterboreDepth ?? 0);
    }
    if (result.kind === 'countersink') {
      inputs.countersinkDiameter = String(result.countersinkDiameter ?? 0);
      inputs.countersinkAngle = String(result.countersinkAngle ?? 90);
    }

    const r = commandBus.dispatch({
      type: 'CreateHole',
      partId,
      inputs,
    });
    if (r.ok) {
      const extentDesc = result.extent === 'throughAll' ? 'through all' : `depth ${result.depth} mm`;
      consoleLog('success', `Created ${result.kind} hole: ⌀${result.diameter} mm, ${extentDesc}`, 'hole');
    } else {
      consoleLog('error', `Hole creation failed: ${r.error.message}`, 'hole');
    }
    // Clear face selection so its highlight doesn't sit on the new hole.
    const { selectionStore } = getAppState();
    selectionStore.getState().select(null);
    setHoleState({ visible: false, pickedFace: null });
  }, [activePartId, commandBus]);

  const handleHoleCancel = useCallback(() => {
    setHoleState({ visible: false, pickedFace: null });
    consoleLog('info', 'Hole cancelled', 'hole');
  }, []);

  /**
   * Human-readable labels for the dialog. Edge IDs are opaque hex strings
   * from the topology tracker — we show a short suffix so the user can
   * at least visually correlate clicks with rows.
   */
  const filletDialogEntries: FilletDialogEdgeEntry[] = filletState.edges.map(ref => {
    if (ref.type !== 'stableTopology') {
      return { key: JSON.stringify(ref), label: '(unsupported edge ref)' };
    }
    const shortId = String(ref.stableEdgeId).slice(-6);
    return {
      key: JSON.stringify(ref),
      label: `Edge ${shortId}`,
    };
  });

  // Same label transform as Fillet — kept inline so the two dialogs
  // stay decoupled if one ever grows extra metadata (e.g. per-edge
  // override radii) the other doesn't need.
  const chamferDialogEntries: ChamferDialogEdgeEntry[] = chamferState.edges.map(ref => {
    if (ref.type !== 'stableTopology') {
      return { key: JSON.stringify(ref), label: '(unsupported edge ref)' };
    }
    const shortId = String(ref.stableEdgeId).slice(-6);
    return {
      key: JSON.stringify(ref),
      label: `Edge ${shortId}`,
    };
  });

  // Shell shows the *faces* selected for removal — same JSON.stringify
  // key strategy as Fillet/Chamfer's edge list so React keys are
  // stable and remove-by-key works on the dialog's X buttons.
  const shellDialogEntries: ShellDialogFaceEntry[] = shellState.faces.map(ref => {
    if (ref.type !== 'stableTopology') {
      return { key: JSON.stringify(ref), label: '(unsupported face ref)' };
    }
    const shortId = String(ref.stableFaceId).slice(-6);
    return {
      key: JSON.stringify(ref),
      label: `Face ${shortId}`,
    };
  });

  // Mount viewport controller
  useEffect(() => {
    if (!canvasRef.current) return;
    const ctrl = new ViewportController(canvasRef.current);
    ctrlRef.current = ctrl;
    setViewportCtrl(ctrl);
    // Register the active viewport for any tool consumer (in-app chat
    // panel + MCP bridge handlers) that needs to drive the camera
    // or capture a screenshot. One canvas per tab = one entry here.
    setActiveViewport(ctrl);
    // Wire the thumbnail capture so cloud saves can include a preview.
    const unregisterThumb = registerThumbnailCapture(() => ctrl.captureThumbnail());
    // Dev-only: expose the viewport controller so the preview-eval
    // bridge (and the browser console) can introspect mesh state
    // directly. Mirrors the __APP_STATE__ hook in appInit.ts.
    try {
      if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
        (globalThis as unknown as { __VIEWPORT_CTRL__: ViewportController }).__VIEWPORT_CTRL__ = ctrl;
      }
    } catch { /* not in Vite */ }
    return () => {
      unregisterThumb();
      ctrl.dispose();
      ctrlRef.current = null;
      setViewportCtrl(null);
      setActiveViewport(null);
    };
  }, []);

  // Wire viewport picking → selectionStore. The viewport reports topology
  // hits without partId; we look up the active part and inject it. The
  // store, in turn, drives the viewport's highlight rendering — closing
  // the loop. Pick mode is controlled by a separate effect below that
  // watches feature-dialog state.
  useEffect(() => {
    if (!viewportCtrl) return;
    const { selectionStore } = getAppState();

    // Convert PickedTopology (bodyId-only) → Selection (with partId).
    // The part is the one owning the feature that produced the body, via
    // the rebuild's body→feature map. Read fresh on every pick: the
    // document and the map both move under this callback.
    function resolvePartIdForBody(bodyId: string): PartId | null {
      const doc = getAppState().documentStore.getState();
      const featureId = getAppState().viewportStore.getState()
        .bodyToFeatureMap[bodyId as BodyId];
      return findFeaturePartId(doc, featureId ?? '')
        ?? resolveActivePartId(doc, rawActivePartId);
    }

    viewportCtrl.setPickCallback(picked => {
      if (!picked) {
        selectionStore.getState().select(null);
        return;
      }
      // Construction-plane picks are emitted by the SketchPlanePicker
      // overlay (its own scene group), not by the main viewport picker.
      // If one slips through here it's a programming bug — ignore safely.
      if (picked.type === 'constructionPlane') return;
      const partId = resolvePartIdForBody(String(picked.bodyId));
      if (!partId) return;
      if (picked.type === 'face') {
        selectionStore.getState().select({
          type: 'face',
          partId,
          bodyId: picked.bodyId,
          faceId: picked.faceId,
        });
      } else if (picked.type === 'edge') {
        selectionStore.getState().select({
          type: 'edge',
          partId,
          bodyId: picked.bodyId,
          edgeId: picked.edgeId,
        });
      } else if (picked.type === 'body') {
        selectionStore.getState().select({
          type: 'body',
          partId,
          bodyId: picked.bodyId,
        });
        // 3-way sync: viewport body pick → light up the body row
        // in the project tree AND its source feature in the timeline.
        // Mirrors the behaviour of clicking the body row directly.
        const sourceFeatureId = bodyToFeatureMap[picked.bodyId];
        if (sourceFeatureId) {
          setBodyAndFeature(String(picked.bodyId), String(sourceFeatureId));
        }
      }
    });

    viewportCtrl.setPreselectCallback(picked => {
      if (!picked) {
        selectionStore.getState().preselect(null);
        return;
      }
      if (picked.type === 'constructionPlane') return;
      const partId = resolvePartIdForBody(String(picked.bodyId));
      if (!partId) return;
      if (picked.type === 'face') {
        selectionStore.getState().preselect({
          type: 'face',
          partId,
          bodyId: picked.bodyId,
          faceId: picked.faceId,
        });
      } else if (picked.type === 'edge') {
        selectionStore.getState().preselect({
          type: 'edge',
          partId,
          bodyId: picked.bodyId,
          edgeId: picked.edgeId,
        });
      }
    });

    // Subscribe the store → viewport. On every selection change, render
    // the highlight. This closes the loop: viewport pick → store update →
    // viewport highlight. No re-entry: viewport.setSelection/setPreselection
    // don't dispatch back into the store.
    const unsubscribe = selectionStore.subscribe(state => {
      viewportCtrl.setSelection(state.selection);
      viewportCtrl.setPreselection(state.preselection);
    });
    // Initialize the highlight with the current state (in case the store
    // already had a selection from a previous mount cycle).
    {
      const s = selectionStore.getState();
      viewportCtrl.setSelection(s.selection);
      viewportCtrl.setPreselection(s.preselection);
    }

    return () => {
      unsubscribe();
      viewportCtrl.setPickCallback(null);
      viewportCtrl.setPreselectCallback(null);
    };
  }, [viewportCtrl]);

  // Pick mode follows the modeling/sketch/dialog state. In modeling mode
  // (no sketch, no feature dialog open) the viewport picks faces. Once a
  // feature dialog that needs picking is open, that feature explicitly
  // overrides the mode (e.g., Fillet sets 'edge'). The catch-all is 'none'
  // so we don't fight sketch-tool clicks or extrude/revolve/loft profile
  // pickers, which have their own raycast paths.
  useEffect(() => {
    if (!viewportCtrl) return;
    if (filletState.visible || chamferState.visible) {
      // Fillet / Chamfer pick edges; a click on a face (no edge in reach)
      // stands for all of that face's edges.
      viewportCtrl.setPickMode('edgeOrFace');
      return;
    }
    if (extrudeState.visible && extrudeState.faceSlot) {
      // An armed Extrude face slot (start / end face) takes face clicks;
      // the profile picker is paused meanwhile.
      viewportCtrl.setPickMode('face');
      return;
    }
    if (mirrorState.visible || patternState.visible) {
      // Mirror + Pattern both pick bodies — flipping pickMode to 'body'
      // lets the viewport raycaster return body-level hits even when
      // the click lands on a face surface.
      viewportCtrl.setPickMode('body');
      return;
    }
    // Plane dialog in `offsetFromFace` mode wants face picks — same as
    // the default modeling mode, so no special case there, just don't
    // disable picking. `offsetFromPlane` mode uses the SketchPlanePicker
    // overlay (which has its own raycaster); we set pickMode='none' so
    // the regular modeling picker doesn't fight the overlay.
    const planeDialogWantsFace = planeState.visible && planeState.kind === 'offsetFromFace';
    const planeDialogWantsNone = planeState.visible && planeState.kind === 'offsetFromPlane';
    // Hole dialog always picks faces (face-anchored placement is the
    // only v1 workflow). Same handling as planeDialogWantsFace.
    const holeDialogWantsFace = holeState.visible;
    // Shell dialog picks faces too (the "remove these faces" list).
    const shellDialogWantsFace = shellState.visible;
    const otherPickerActive =
      sketchActive ||
      extrudeState.visible ||
      revolveState.visible ||
      loftState.visible ||
      planeDialogWantsNone;
    if (planeDialogWantsFace || holeDialogWantsFace || shellDialogWantsFace) {
      viewportCtrl.setPickMode('face');
      return;
    }
    viewportCtrl.setPickMode(otherPickerActive ? 'none' : 'face');
  }, [viewportCtrl, sketchActive, extrudeState.visible, extrudeState.faceSlot, revolveState.visible, loftState.visible, filletState.visible, chamferState.visible, planeState.visible, planeState.kind, holeState.visible, mirrorState.visible, shellState.visible, patternState.visible]);

  // Push meshes to viewport when they change (including clearing when empty)
  useEffect(() => {
    if (ctrlRef.current) {
      ctrlRef.current.setDisplayMeshes(displayMeshes, topologyMaps);
    }
  }, [displayMeshes, topologyMaps]);

  // Mirror construction-plane updates to the viewport's CP layer. The
  // rebuilder emits a fresh `constructionPlanes` array on every build —
  // we hand it straight through so the translucent rectangles match
  // the document state without needing per-feature diffing.
  useEffect(() => {
    if (ctrlRef.current) {
      ctrlRef.current.setConstructionPlanes(constructionPlanes);
    }
  }, [constructionPlanes]);

  // Construction-plane offset gizmo. Bound to the EDIT dialog (not bare
  // selection): while editing an existing plane, attach a single-axis drag
  // handle along its normal. Dragging the handle previews the plane live
  // (mesh moves, NO command) and feeds the new value into `planeState.offset`
  // — the same value the Distance field shows. Nothing is committed here; the
  // dialog's OK dispatches one UpdateFeatureInput and Cancel reverts (see
  // handlePlaneConfirm / the dialog's onCancel). Deliberately does NOT depend
  // on `planeState.offset` so a live drag doesn't re-attach mid-gesture.
  const editingPlaneId = planeState.visible ? planeState.editingFeatureId : null;
  useEffect(() => {
    if (!viewportCtrl) return;
    // Do nothing when not editing a plane. Crucially, DON'T call
    // detachManipulator here — this effect re-runs on every rebuild
    // (constructionPlanes dep), and the manipulator is shared with body Move,
    // so an unconditional detach would tear down an active body-move gizmo on
    // the rebuild a move commit triggers. Detach happens only in the cleanup
    // below, which runs when we stop editing a plane.
    if (!editingPlaneId) return;
    const plane = constructionPlanes.find(p => String(p.featureId) === editingPlaneId) ?? null;
    if (!plane) return;

    // committedOffset = the plane's stored offset (the dialog opened with it).
    const proj = getAppState().documentStore.getState();
    let committedOffset = 0;
    for (const part of Object.values(proj.parts)) {
      const feature = part.timeline.find(f => f.id === editingPlaneId);
      if (!feature) continue;
      const offsetInput = (feature.inputs as { offset?: number | string }).offset;
      const cur = typeof offsetInput === 'number' ? offsetInput : parseFloat(String(offsetInput));
      committedOffset = Number.isFinite(cur) ? cur : 0;
      break;
    }

    viewportCtrl.attachConstructionPlaneOffsetManipulator(plane, committedOffset, {
      // Preview only — push the dragged value into the shared offset so the
      // Distance field tracks it. No dispatch (OK commits).
      onChange: (value) => setPlaneState(s => ({ ...s, offset: Math.round(value * 100) / 100 })),
      onCommit: (value) => setPlaneState(s => ({ ...s, offset: Math.round(value * 100) / 100 })),
    });

    return () => { viewportCtrl.detachManipulator(); };
  }, [viewportCtrl, editingPlaneId, constructionPlanes]);

  // Apply feature visibility to viewport bodies.
  // Subscribes directly to the document store for immediate visibility updates.
  // Uses bodyToFeatureMap from ViewportStore to map body IDs to feature IDs.
  //
  // When sketch mode is active, non-hidden bodies render as ghosted so the
  // sketch geometry on the plane stays readable while existing solids still
  // give spatial context.
  //
  // Single source of truth for body display mode. Routes EVERY input
  // (sketch context, feature visibility/enabled, per-body hide set)
  // through `computeAllBodyDisplayModes` so we can't end up with
  // inconsistent state. Replaces the previous setup which had two
  // conflicting paths (viewport-wide setGhostMode + per-body
  // applyDisplayModes) plus an eye-icon handler that hard-coded
  // 'normal' and ignored sketch context — the combination produced
  // the "hidden body becomes visible-ghost on sketch entry" and
  // "unhide returns to normal not ghosted" bugs.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;

    const { documentStore, viewportStore } = getAppState();

    function applyVisibility() {
      const doc = documentStore.getState();
      const meshes = displayMeshes;
      if (meshes.length === 0) return;

      // Synthesize the DisplayContext from the legacy sketchActive
      // flag. The displayContextStore exists but Shell still drives
      // off `useSketchActive` for the rest of its sketch UX — we
      // bridge here to avoid a bigger refactor. When the broader
      // context-mode plumbing is unified, the synth goes away.
      const context: DisplayContext = sketchActive
        ? { mode: 'editingSketch', sketchId: (activeSketchIdRef.current ?? '') as FeatureId }
        : { mode: 'viewing' };

      const modes = computeAllBodyDisplayModes({
        bodyIds: meshes.map(m => m.bodyId),
        project: doc,
        bodyToFeatureMap: viewportStore.getState().bodyToFeatureMap as Readonly<Record<string, FeatureId>>,
        hiddenBodies,
        context,
        // Fusion-style: everything outside the active part ghosts, so the
        // part being worked on reads clearly against the rest. With one
        // part every body is in it, so nothing changes.
        ...(Object.keys(doc.parts).length > 1 && activePartId ? { activePartId } : {}),
      });
      ctrl!.applyDisplayModes(modes);
    }

    // Apply immediately + on every input change (document mutations,
    // rebuild artifacts, sketchActive flips, hiddenBodies toggles
    // are all covered by the dep array + the two subscriptions).
    applyVisibility();
    const unsubDoc = documentStore.subscribe(applyVisibility);
    const unsubViewport = viewportStore.subscribe(applyVisibility);
    return () => {
      unsubDoc();
      unsubViewport();
    };
  }, [displayMeshes, sketchActive, hiddenBodies, activePartId]);

  // Resize handler
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        ctrlRef.current?.resize(width, height);
      }
    });
    const container = canvasRef.current?.parentElement;
    if (container) obs.observe(container);
    return () => obs.disconnect();
  }, []);

  // Cross-selection: derive the Set<BodyId> the viewport should tint from
  // selectedBodyId + selectedFeatureId (3-way sync — see the comment on
  // setFeatureOnly / setBodyAndFeature above).
  //
  // Precedence: if a specific body is selected, emphasise ONLY that body;
  // else if a feature is selected, emphasise ALL bodies it produced; else
  // clear. `highlightBodies` doesn't distinguish "one body" vs "feature's
  // bodies" — the visual difference comes naturally from the size of the
  // tinted set (one vs many).
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    if (selectedBodyId) {
      ctrl.highlightBodies(new Set([selectedBodyId as BodyId]));
      return;
    }
    if (!selectedFeatureId) {
      ctrl.highlightBodies(null);
      return;
    }
    const highlightSet = new Set<BodyId>();
    for (const [bodyId, featureId] of Object.entries(bodyToFeatureMap)) {
      if (featureId === selectedFeatureId) {
        highlightSet.add(bodyId as BodyId);
      }
    }
    ctrl.highlightBodies(highlightSet.size > 0 ? highlightSet : null);
  }, [selectedBodyId, selectedFeatureId, bodyToFeatureMap]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      // File ops. Ctrl+N is browser-reserved (new window) so we use Ctrl+Alt+N.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onFileSave?.();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onFileSaveAs?.();
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        onFileOpen?.();
      } else if (mod && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        onFileNew?.();
      }
      // Backtick toggles console
      if (e.key === '`' && !mod) {
        consoleToggle();
      }
      // Ctrl+I toggles the Components panel. Same gate as the toolbar
      // button: no catalog without a backend, so the shortcut is inert
      // rather than opening a panel that can only show an error.
      if (mod && e.key.toLowerCase() === 'i' && isSaasAvailable(saasRef.current)) {
        e.preventDefault();
        setComponentsPanelOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, consoleToggle, onFileNew, onFileOpen, onFileSave, onFileSaveAs]);

  // ViewCube callbacks
  const handleViewCubeClick = useCallback((theta: number, phi: number) => {
    ctrlRef.current?.goToView(theta, phi);
  }, []);

  const getMainCameraQuat = useCallback((): THREE.Quaternion | null => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return null;
    const q = ctrl.getCameraQuaternion();
    return new THREE.Quaternion(q.x, q.y, q.z, q.w);
  }, []);

  const rawParts = Object.values(project.parts);

  // Enrich each part's timeline with per-feature build status from the
  // worker. ProjectTree reads `status` + `errorMessage` to paint failed
  // features with a red border and a tooltip — so the user sees build
  // failures at a glance instead of having to read the console.
  //
  // `blockedBy` captures the upstream feature id that caused a cascade
  // block (set by the rebuilder); we resolve it to a friendly name in
  // a second pass so the timeline tooltip can read "Blocked by
  // Sketch 1 (suppressed)" instead of an opaque featureId.
  // For DOF of the currently-edited sketch, prefer the live editor
  // store over the document snapshot — the document only updates on
  // "Finish Sketch", so mid-edit changes (add/remove constraint,
  // move point) wouldn't reflect in the sidebar lock otherwise.
  const editorActiveSketchId = useActiveSketchId();
  const editorDof = useSketchEditorStore(s => s.dof);
  const parts = rawParts.map(part => ({
    ...part,
    timeline: part.timeline.map(f => {
      const result = featureResults[f.id];
      const status =
        result?.status === 'failed' ? 'failed' as const
        : result?.status === 'blocked' ? 'blocked' as const
        : result?.status === 'suppressed' ? 'suppressed' as const
        : 'success' as const;
      const errorMessage = result?.status === 'failed' ? result.error.message : undefined;
      const blockedBy = result?.status === 'blocked' ? result.blockedBy : undefined;
      // V11.5 continuation: compute sketch DOF here so the project tree
      // can render a Lock badge on fully-constrained sketches without
      // having to enter edit mode. Cheap — Immer keeps inputs
      // reference-stable when nothing mutated. For the active sketch we
      // override with the live editor store DOF so the badge updates
      // in real-time during edit.
      const dof = f.type !== 'sketch'
        ? undefined
        : editorActiveSketchId === f.id
          ? editorDof
          : computeSketchDof(f.inputs as unknown as SketchFeatureInputs);
      return {
        ...f,
        status,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(blockedBy !== undefined ? { blockedBy } : {}),
        ...(dof !== undefined ? { dof } : {}),
      };
    }),
  }));

  // Map every featureId → its name + status so blocked tooltips can
  // attribute "Blocked by Sketch 1 (suppressed)" instead of showing
  // the raw upstream id. Built once per render across all parts.
  const featureNameById = new Map<string, { name: string; status: 'success' | 'failed' | 'blocked' | 'suppressed' }>();
  for (const part of parts) {
    for (const f of part.timeline) {
      featureNameById.set(String(f.id), { name: f.name, status: f.status });
    }
  }

  // The timeline shows the active part's features. Feature order is
  // meaningful only within a part — the rebuilder walks each part's
  // timeline independently — so interleaving two parts into one strip
  // would show an order that doesn't exist. `status` picks each row's
  // icon/border, and `blockedByLabel` is the hover tooltip when
  // status === 'blocked'.
  const timelineParts = parts.filter(part => parts.length === 1 || part.id === activePartId);
  const timelineFeatures = timelineParts.flatMap(part =>
    part.timeline.map(feature => {
      const upstream = feature.status === 'blocked' && feature.blockedBy !== undefined
        ? featureNameById.get(String(feature.blockedBy))
        : undefined;
      const blockedByLabel = upstream
        ? `${upstream.name} (${upstream.status})`
        : undefined;
      return {
        id: String(feature.id),
        name: feature.name,
        type: feature.type,
        // Primitives share one feature type but five shapes; `featureIconType`
        // resolves which glyph and colour the row should use.
        iconKey: featureIconType(feature),
        enabled: feature.enabled,
        visible: feature.visible,
        status: feature.status,
        ...(feature.errorMessage !== undefined ? { errorMessage: feature.errorMessage } : {}),
        ...(blockedByLabel !== undefined ? { blockedByLabel } : {}),
      };
    })
  );

  // Build TreeBody[] from build artifacts for the ProjectTree Bodies section
  const treeBodies = useMemo((): TreeBody[] => {
    const allFeatures = parts.flatMap(p => p.timeline);
    const featureNames = new Map(allFeatures.map(f => [String(f.id), f.name]));
    const featureTypes = new Map(allFeatures.map(f => [String(f.id), f.type]));
    return displayMeshes.map((mesh, idx) => {
      const sourceFeatureId = bodyToFeatureMap[mesh.bodyId] ?? '';
      const featureName = featureNames.get(String(sourceFeatureId)) ?? 'Unknown';
      return {
        bodyId: mesh.bodyId,
        label: `Body ${idx + 1} (${featureName})`,
        sourceFeatureId,
        sourceFeatureType: featureTypes.get(String(sourceFeatureId)) ?? '',
        sourceFeatureName: featureName,
        visible: !hiddenBodies.has(mesh.bodyId),
      };
    });
  }, [displayMeshes, bodyToFeatureMap, parts, hiddenBodies]);

  // Find selected feature details for inspector
  const selectedFeature = selectedFeatureId
    ? parts.flatMap(p => p.timeline).find(f => f.id === selectedFeatureId)
    : null;

  // Collect visible sketch features for readonly SketchViewer display.
  // Excludes the sketch currently being edited (SketchEditor handles that).
  const visibleSketches = useMemo(() => {
    const result: { id: string; inputs: SketchFeatureInputs; plane: SketchPlaneInput }[] = [];
    for (const part of parts) {
      for (const feature of part.timeline) {
        if (feature.type !== 'sketch') continue;
        if (!feature.visible || !feature.enabled) continue;
        // Skip the sketch being actively edited — SketchEditor renders it
        if (sketchActive && feature.id === editorActiveSketchId) continue;
        const inputs = feature.inputs as unknown as SketchFeatureInputs;
        if (Object.keys(sketchBuildGeometry(inputs)).length === 0) continue;
        const plane = resolveSketchPlaneInput(inputs.plane, constructionPlanes, sketchPlanes, feature.id);
        result.push({ id: feature.id, inputs, plane });
      }
    }
    return result;
  }, [parts, sketchActive, editorActiveSketchId, constructionPlanes, sketchPlanes]);

  return (
    <div style={styles.root}>
      {/* Full-width title strip across the top of the window. */}
      <MainAppBar
        projectName={project.metadata.name}
        canUndo={canUndo}
        canRedo={canRedo}
        undoLabel={undoLabel}
        redoLabel={redoLabel}
        onUndo={undo}
        onRedo={redo}
        rebuilding={rebuilding}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        componentsPanelOpen={componentsPanelOpen}
        onToggleComponentsPanel={() => setComponentsPanelOpen((v) => !v)}
        onNew={onFileNew}
        onOpen={onFileOpen}
        onOpenHistory={onOpenHistory}
        onImport={onFileImport}
        onImportFcstd={onImportFcstd}
        onImportComponent={onComponentImport}
        onImportSketchDxf={handleImportSketchDxf}
        onImportSketchSvg={handleImportSketchSvg}
        onSave={onFileSave}
        onSaveAs={onFileSaveAs}
        onExport={onFileExport ? (fmt) => { void onFileExport(fmt); } : undefined}
        saas={saas}
        onRequestSignIn={onRequestSignIn}
        onSignOut={onSignOut}
        onOpenSettings={onOpenSettings}
        onRenameProject={(name) => {
          // Validation (empty / whitespace-only) happens in the
          // RenameProject handler — surface failures to the console
          // so dev-time issues are visible without a toast layer.
          const result = commandBus.dispatch({ type: 'RenameProject', name });
          if (!result.ok) {
            console.warn('[Shell] RenameProject rejected:', result.error.message);
          }
        }}
        chatPanelOpen={chatPanelOpen}
        onToggleChatPanel={() => setChatPanelOpen((v) => !v)}
      />

      {/* Sidebar + content row. The ribbon lives in the centerColumn so it
          stays aligned with the viewport regardless of sidebar state. */}
      <div style={styles.main}>
        {/* Left Panel - Project Tree (Browser). Animates between full
            width (240px) and a thin rail (8px) via CSS transition on
            width — keeps the panel mounted so React state inside
            ProjectTree (expand/collapse, hover) survives the toggle.
            `overflow: hidden` clips the tree while collapsing so labels
            don't poke into the viewport mid-animation. */}
        <div
          style={{
            ...styles.leftPanel,
            width: sidebarCollapsed ? 8 : 240,
            minWidth: sidebarCollapsed ? 8 : 180,
          }}
          aria-hidden={sidebarCollapsed}
        >
          <ProjectTree
            parts={parts}
            activePartId={activePartId}
            onActivatePart={handleActivatePart}
            onCreatePart={handleCreatePart}
            parameters={project.parameters.values}
            bodies={treeBodies}
            selectedFeatureId={selectedFeatureId}
            selectedBodyId={selectedBodyId}
            onFeatureClick={setFeatureOnly}
            onContextAction={handleContextAction}
            onEditParameters={onEditParameters}
            onBodyClick={(bodyId, sourceFeatureId) => {
              // Per-body select. Sets BOTH ids so the source-feature row
              // stays highlighted in the timeline but the viewport tint
              // emphasises only the picked body.
              setBodyAndFeature(bodyId, sourceFeatureId);
            }}
            onBodyVisibilityToggle={(bodyId, visible) => {
              // Single source of truth: update hiddenBodies and let the
              // centralized display-mode effect recompute. The effect's
              // dep array includes hiddenBodies, so it re-fires and
              // routes the new state through computeAllBodyDisplayModes
              // — which means an unhide in sketch context correctly
              // produces 'ghosted', not 'normal' (the old bug).
              setHiddenBodies(prev => {
                const next = new Set(prev);
                if (visible) next.delete(bodyId);
                else next.add(bodyId);
                return next;
              });
            }}
            onVisibilityToggle={(featureId, visible) => {
              const owner = findFeaturePartId(project, featureId);
              if (owner) {
                commandBus.dispatch({
                  type: 'SetFeatureVisibility',
                  partId: owner,
                  featureId: featureId as FeatureId,
                  visible,
                });
              }
            }}
          />
        </div>

        {/* Center column: ribbon above viewport (ribbon width = viewport width). */}
        <div style={styles.centerColumn}>
          <MainRibbon
            sketchActive={sketchActive && !extrudeState.visible && !revolveState.visible && !loftState.visible}
            sketchPickingPlane={sketchPickingPlane}
            toolShortcutsEnabled={!(
              extrudeState.visible || revolveState.visible || loftState.visible
              || sweepState.visible || filletState.visible || chamferState.visible
              || holeState.visible || planeState.visible || booleanState.visible
              || primitiveState.visible || mirrorState.visible || shellState.visible
              || patternState.visible || moveState !== null
            )}
            onSketchClick={handleSketchButton}
            onSketchCancelPlanePick={handleCancelPlanePick}
            onSketchEnd={handleExitSketch}
            sketchTool={sketchTool}
            onSketchToolChange={(tool) => setSketchTool(tool as SketchToolId)}
            onApplyConstraint={(kind: SketchConstraintKind) => {
              const applied = applySketchConstraint(useSketchEditorStore.getState(), kind);
              if (!applied.ok) {
                consoleLog('warn', applied.reason, 'sketch');
                return;
              }
              // Distinguish three outcomes so the user can see what
              // actually happened in the constraint solver:
              //   - some committed AND none conflicted → success
              //   - some committed AND some conflicted → mixed
              //   - none committed AND some conflicted → over-constrained,
              //     constraint visible in SketchBrowser as "not applied"
              // Success / mixed-success logging only — per-constraint
              // rejections (including all toasts) are emitted from inside
              // SketchEditorStore.addConstraint, so every addConstraint
              // call site gets the same UX without dispatcher-side wiring.
              if (applied.count > 0 && applied.conflicted === 0) {
                consoleLog('success', `Applied ${kind} constraint (${applied.count})`, 'sketch');
              } else if (applied.count > 0) {
                consoleLog('warn',
                  `Applied ${applied.count} ${kind} constraint(s); ${applied.conflicted} couldn't be satisfied`,
                  'sketch');
              }
            }}
            constructionMode={editorConstructionMode}
            onToggleConstructionMode={() => useSketchEditorStore.getState().toggleConstructionMode()}
            onExtrudeClick={handleToolbarExtrudeClick}
            onRevolveClick={handleToolbarRevolveClick}
            onFilletClick={handleToolbarFilletClick}
            onChamferClick={handleToolbarChamferClick}
            onMirrorClick={handleToolbarMirrorClick}
            onShellClick={handleToolbarShellClick}
            onPatternClick={handleToolbarPatternClick}
            onSweepClick={handleToolbarSweepClick}
            onLoftClick={handleToolbarLoftClick}
            onHoleClick={handleToolbarHoleClick}
            onBooleanClick={handleToolbarBooleanClick}
            onMeasureClick={handleToolbarMeasureClick}
            measureActive={measureOpen}
            onPrimitiveClick={handleToolbarPrimitiveClick}
            onOffsetPlaneClick={handleToolbarOffsetPlaneClick}
            onPlaneFromFaceClick={handleToolbarPlaneFromFaceClick}
            onSectionClick={handleToolbarSectionClick}
            sectionActive={sectionActive}
          />

          {/* Viewport */}
          <div style={styles.viewportContainer}>
          <canvas
            ref={canvasRef}
            style={styles.canvas}
          />
          {/* Sketch editor (Three.js in main scene) */}
          <SketchEditor
            isActive={sketchActive}
            viewportCtrl={viewportCtrl}
            planeName={sketchPlaneConfig ?? sketchPlaneName}
            activeTool={sketchTool}
            sketchId={editorActiveSketchId}
            onActiveToolChange={(tool) => setSketchTool(tool)}
            onSketchRemoved={handleSketchRemoved}
          />
          {/* Readonly sketch viewers for visible sketches (not actively edited).
              When the Loft dialog is open, switch each visible sketch into
              profile-picker mode so the user can click profiles across all of
              them — the parent aggregates picks into a global ordered list. */}
          {viewportCtrl && visibleSketches.map(sk => (
            // Each readonly viewer gets its own boundary so a malformed
            // sketch (e.g. one with entities that hit a SketchViewer
            // edge case) renders as a no-op overlay instead of taking
            // down the entire Shell. The boundary logs the error to
            // the console; the rest of the viewport keeps working.
            <ErrorBoundary
              key={sk.id}
              scopeLabel={`sketch "${sk.id}"`}
              resetKey={sk.inputs}
              fallback={() => null}
            >
              <SketchViewer
                sketchInputs={sk.inputs}
                viewportCtrl={viewportCtrl}
                planeName={sk.plane}
                {...(loftState.visible
                  ? {
                      sketchId: sk.id as FeatureId,
                      initialProfiles: loftState.picksBySketch[String(sk.id)] ?? [],
                      onProfilesChanged: (profiles: ProfileRef[]) =>
                        handleLoftProfilesChangedForSketch(sk.id as FeatureId, profiles),
                    }
                  : {})}
              />
            </ErrorBoundary>
          ))}
          {/* Sketch Palette (right panel with display options) */}
          {/* Hidden when any feature picker dialog is open — sketch is in profile-picking mode, not editing */}
          {sketchActive && !extrudeState.visible && !revolveState.visible && !loftState.visible && (
            <SketchPalette
              onFinishSketch={handleExitSketch}
            />
          )}
          {/* Sketch Browser (left panel: geometry + constraints) */}
          {sketchActive && !extrudeState.visible && !revolveState.visible && !loftState.visible && (
            <SketchBrowser />
          )}
          {/* Sketch plane picker overlay (shown after clicking Sketch).
              Existing construction planes are passed through so the user can pick
              one as the sketch base alongside the three default planes, and any
              flat body face is pickable too. */}
          {sketchPickingPlane && !sketchActive && viewportCtrl && (
            <SketchPlanePicker
              viewportCtrl={viewportCtrl}
              constructionPlanes={activePartPlanes}
              pickFaces
              onPick={handlePlanePicked}
              onCancel={handleCancelPlanePick}
            />
          )}
          {sectionActive && (
            <SectionPanel
              orientation={sectionOrientation}
              onOrientationChange={setSectionOrientation}
              onFlip={() => viewportCtrl?.flipSection()}
              onDone={() => setSectionActive(false)}
            />
          )}
          {moveState && (() => {
            const ID: MoveTransform = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
            const feat = parts.flatMap(p => p.timeline).find(f => f.id === moveState.sourceFeatureId);
            const inputs = feat?.inputs as { transform?: MoveTransform; bodyTransforms?: Record<string, MoveTransform> } | undefined;
            // Derived bodies read and write the trailing `move` feature; the
            // import cases edit the source feature's own placement fields.
            const moveFeat = moveState.scope === 'feature' && moveState.moveFeatureId
              ? parts.flatMap(p => p.timeline).find(f => f.id === moveState.moveFeatureId)
              : undefined;
            const targetT: MoveTransform = moveState.scope === 'all'
              ? (inputs?.transform ?? ID)
              : moveState.scope === 'feature'
                ? ((moveFeat?.inputs as { transform?: MoveTransform } | undefined)?.transform ?? ID)
                : (inputs?.bodyTransforms?.[moveState.bodyId] ?? ID);
            const partId = parts.find(p => p.timeline.some(f => f.id === moveState.sourceFeatureId))?.id as PartId | undefined;
            return (
              <MovePanel
                scope={moveState.scope}
                mode={moveState.mode}
                transform={targetT}
                onModeChange={(mode) => setMoveState(s => s && ({ ...s, mode }))}
                onTransformChange={(t) => {
                  if (!partId) return;
                  if (moveState.scope === 'feature') {
                    // Typing a number before ever dragging still has to land
                    // somewhere, so create the feature here too.
                    if (moveState.moveFeatureId) {
                      commandBus.dispatch({
                        type: 'UpdateFeatureInput', partId,
                        featureId: moveState.moveFeatureId as FeatureId,
                        path: ['transform'], value: t,
                      });
                      return;
                    }
                    const created = commandBus.dispatch({
                      type: 'CreateMove', partId,
                      inputs: {
                        targetBodies: [{ partId, bodyId: moveState.bodyId as BodyId }],
                        transform: t,
                      },
                    });
                    if (!created.ok) {
                      consoleLog('error', `Move failed: ${created.error.message}`, 'move');
                      return;
                    }
                    const after = getAppState().documentStore.getState().parts[partId]!;
                    const newest = [...after.timeline].reverse().find(f => f.type === 'move');
                    setMoveState(s => s && ({
                      ...s, moveFeatureId: newest ? String(newest.id) : null, createdHere: true,
                    }));
                    return;
                  }
                  if (moveState.scope === 'all') {
                    commandBus.dispatch({
                      type: 'UpdateFeatureInput', partId, featureId: moveState.sourceFeatureId as FeatureId,
                      path: ['transform'], value: t,
                    });
                  } else {
                    const map = inputs?.bodyTransforms ?? {};
                    commandBus.dispatch({
                      type: 'UpdateFeatureInput', partId, featureId: moveState.sourceFeatureId as FeatureId,
                      path: ['bodyTransforms'], value: { ...map, [moveState.bodyId]: t },
                    });
                  }
                }}
                onCancel={cancelMove}
                onDone={() => setMoveState(null)}
              />
            );
          })()}
          <ViewCubeOverlay
            onViewChange={handleViewCubeClick}
            getMainCameraQuaternion={getMainCameraQuat}
          />
          <ViewportToolbar
            controller={viewportCtrl}
            // While sketching, Home should re-snap to the active plane
            // head-on (same view used on sketch entry). Outside sketch
            // mode the default global iso-home is right.
            onHome={sketchActive ? () => {
              const v = sketchViewForPlane(sketchPlaneConfig ?? sketchPlaneName);
              viewportCtrl?.goToView(v.theta, v.phi);
            } : undefined}
          />

          {/* Extrude: SketchViewer in profile-picking mode + dialog */}
          {extrudeState.visible && viewportCtrl && extrudeState.sketchId && (() => {
            // Find the sketch feature to get its inputs and plane
            const sketchFeature = parts.flatMap(p => p.timeline)
              .find(f => f.id === String(extrudeState.sketchId) && f.type === 'sketch');
            if (!sketchFeature) return null;
            const skInputs = sketchFeature.inputs as unknown as SketchFeatureInputs;
            const skPlane = resolveSketchPlaneInput(skInputs.plane, constructionPlanes, sketchPlanes, sketchFeature.id);
            return (
              <ErrorBoundary
                scopeLabel="the sketch profile picker"
                resetKey={extrudeState.sketchId}
                fallback={() => null}
              >
                <SketchViewer
                  sketchInputs={skInputs}
                  viewportCtrl={viewportCtrl}
                  planeName={skPlane}
                  sketchId={extrudeState.sketchId}
                  initialProfiles={extrudeState.profiles}
                  // Display-only while a face slot is armed, so a face click
                  // doesn't also toggle the profile under it.
                  onProfilesChanged={extrudeState.faceSlot ? undefined : (profiles) => {
                    setExtrudeState(prev => ({ ...prev, profiles }));
                  }}
                />
              </ErrorBoundary>
            );
          })()}
          {extrudeState.visible && (() => {
            // Available bodies for the target-body picker. We label each
            // by the producing feature ("Body 1 (Extrude 1)"). The
            // picker is hidden when the operation is newBody so we don't
            // bother filtering by reachability here.
            const partsList = Object.values(project.parts);
            const partFor = partsList[0];
            const availableBodies = partFor
              ? Object.entries(bodyToFeatureMap)
                  .filter(([bid]) => {
                    // Only bodies that belong to this part's timeline features
                    const featureId = bodyToFeatureMap[bid as never];
                    return partFor.timeline.some(f => f.id === featureId);
                  })
                  .map(([bid, featureId], i) => {
                    const feature = partFor.timeline.find(f => f.id === featureId);
                    return {
                      id: String(bid),
                      label: feature ? `Body ${i + 1} (${feature.name})` : `Body ${i + 1}`,
                    };
                  })
              : [];
            return (
              <ExtrudeDialog
                sketchName={extrudeState.sketchName}
                profileCount={extrudeState.profiles.length}
                initialValues={extrudeState.initialValues}
                availableBodies={availableBodies}
                constructionPlanes={activePartPlanes.map(cp => ({ featureId: String(cp.featureId), name: cp.name }))}
                startFace={extrudeState.startFace ?? null}
                endFace={extrudeState.endFace ?? null}
                armedFaceSlot={extrudeState.faceSlot ?? null}
                onArmFaceSlot={handleExtrudeArmFaceSlot}
                onClearFace={handleExtrudeClearFace}
                onConfirm={handleExtrudeConfirm}
                onCancel={handleExtrudeCancel}
              />
            );
          })()}

          {/* Revolve: SketchViewer in profile-picking mode + dialog */}
          {revolveState.visible && viewportCtrl && revolveState.sketchId && (() => {
            const sketchFeature = parts.flatMap(p => p.timeline)
              .find(f => f.id === String(revolveState.sketchId) && f.type === 'sketch');
            if (!sketchFeature) return null;
            const skInputs = sketchFeature.inputs as unknown as SketchFeatureInputs;
            const skPlane = resolveSketchPlaneInput(skInputs.plane, constructionPlanes, sketchPlanes, sketchFeature.id);
            return (
              <ErrorBoundary
                scopeLabel="the sketch profile picker"
                resetKey={revolveState.sketchId}
                fallback={() => null}
              >
                <SketchViewer
                  sketchInputs={skInputs}
                  viewportCtrl={viewportCtrl}
                  planeName={skPlane}
                  sketchId={revolveState.sketchId}
                  initialProfiles={revolveState.profiles}
                  onProfilesChanged={(profiles) => {
                    // Revolve takes exactly one profile — keep the first picked.
                    const first = profiles[0];
                    setRevolveState(prev => ({
                      ...prev,
                      profiles: first ? [first] : [],
                    }));
                  }}
                />
              </ErrorBoundary>
            );
          })()}
          {revolveState.visible && (
            <RevolveDialog
              sketchName={revolveState.sketchName}
              profileCount={revolveState.profiles.length}
              availableBodies={bodyOptionsForPart(partForFeature(revolveState.sketchId))}
              onConfirm={handleRevolveConfirm}
              onCancel={handleRevolveCancel}
            />
          )}

          {/* Loft: dialog only. The cross-sketch profile picker is wired into
              the visibleSketches.map() above (each visible SketchViewer becomes
              a picker while loftState.visible is true). */}
          {loftState.visible && (
            <LoftDialog
              profiles={loftDialogEntries}
              availableBodies={bodyOptionsForPart(partForFeature(loftState.profiles[0]?.sketchId))}
              onRemoveProfile={handleLoftRemoveProfile}
              onConfirm={handleLoftConfirm}
              onCancel={handleLoftCancel}
            />
          )}

          {/* Fillet: dialog only. Edge picking happens via the standard
              viewport pick path while pickMode is overridden to 'edgeOrFace'. */}
          {filletState.visible && (
            <FilletDialog
              edges={filletDialogEntries}
              onRemoveEdge={handleFilletRemoveEdge}
              tangentChain={edgeTangentChain}
              onTangentChainChange={setEdgeTangentChain}
              onConfirm={handleFilletConfirm}
              onCancel={handleFilletCancel}
            />
          )}

          {/* Chamfer: same edge-pick pattern as Fillet (pickMode='edgeOrFace'). */}
          {chamferState.visible && (
            <ChamferDialog
              edges={chamferDialogEntries}
              onRemoveEdge={handleChamferRemoveEdge}
              tangentChain={edgeTangentChain}
              onTangentChainChange={setEdgeTangentChain}
              onConfirm={handleChamferConfirm}
              onCancel={handleChamferCancel}
            />
          )}

          {/* Construction Plane: two separate flows.
              - Offset Plane: SketchPlanePicker overlay collects a PlaneRef
                (default plane or existing CP). Mounted only while no plane
                is picked yet so it doesn't fight orbit after the pick.
              - Plane from Face: standard face picker (default modeling mode)
                feeds into the effect above, which captures stable FaceRefs.
          */}
          {planeState.visible && planeState.kind === 'offsetFromPlane' && !planeState.pickedPlane && viewportCtrl && (
            <SketchPlanePicker
              viewportCtrl={viewportCtrl}
              constructionPlanes={activePartPlanes}
              onPick={handlePlaneDialogPlanePicked}
              onCancel={handlePlaneCancel}
            />
          )}
          {planeState.visible && (
            <ConstructionPlaneDialog
              kind={planeState.kind}
              pickedPlane={planeState.pickedPlane}
              pickedFace={planeState.pickedFace}
              onClearPickedPlane={handlePlaneClearPickedPlane}
              onClearPickedFace={handlePlaneClearPickedFace}
              offsetValue={planeState.offset}
              onOffsetChange={(v) => {
                setPlaneState(s => ({ ...s, offset: v }));
                // Drive the live preview from the field too (the gizmo
                // moves the mesh itself; typing needs this).
                viewportCtrl?.setAttachedPlaneOffset(v);
              }}
              editing={!!planeState.editingFeatureId}
              onConfirm={handlePlaneConfirm}
              onCancel={handlePlaneCancel}
            />
          )}

          {/* Hole: dialog only. Face picking happens via the standard
              viewport face picker (pickMode='face' override above feeds
              the holeState face-pick subscription). */}
          {holeState.visible && (
            <HoleDialog
              pickedFace={holeState.pickedFace}
              onClearPickedFace={handleHoleClearPickedFace}
              initialValues={holeState.initialValues}
              onConfirm={handleHoleConfirm}
              onCancel={handleHoleCancel}
            />
          )}

          {measureOpen && (
            <MeasurePanel
              target={measureTarget}
              measure={measureInWorker}
              onClose={() => setMeasureOpen(false)}
            />
          )}

          {booleanState.visible && (
            <BooleanDialog
              operation={booleanState.operation}
              availableBodies={bodyOptionsForPart(activePartId)}
              onConfirm={handleBooleanConfirm}
              onCancel={() => setBooleanState(s => ({ ...s, visible: false }))}
            />
          )}

          {/* Primitive: numbers only — no viewport picking, so the dialog
              stands alone. */}
          {primitiveState.visible && (
            <PrimitiveDialog
              kind={primitiveState.kind}
              availableBodies={bodyOptionsForPart(activePartId)}
              onConfirm={handlePrimitiveConfirm}
              onCancel={handlePrimitiveCancel}
            />
          )}

          {/* Mirror: pickMode='body' override above feeds the body-pick
              subscription. Plane choice + operation toggle live in the
              dialog itself. */}
          {mirrorState.visible && (
            <MirrorDialog
              pickedBody={mirrorState.pickedBody}
              onClearBody={handleMirrorClearBody}
              initialValues={mirrorState.initialValues}
              onConfirm={handleMirrorConfirm}
              onCancel={handleMirrorCancel}
            />
          )}

          {/* Shell: face multi-pick (same pickMode='face' override path
              as Hole/Plane-from-Face). The face-pick subscription
              accumulates picks in shellState.faces and rejects
              cross-body picks. */}
          {shellState.visible && (
            <ShellDialog
              faces={shellDialogEntries}
              onRemoveFace={handleShellRemoveFace}
              initialValues={shellState.initialValues}
              onConfirm={handleShellConfirm}
              onCancel={handleShellCancel}
            />
          )}

          {/* Pattern: Linear / Circular share one dialog with a top
              tab. pickMode='body' via the override above feeds the
              body-pick subscription. */}
          {patternState.visible && (
            <PatternDialog
              pickedBody={patternState.pickedBody}
              onClearBody={handlePatternClearBody}
              initialValues={patternState.initialValues}
              onConfirm={handlePatternConfirm}
              onCancel={handlePatternCancel}
            />
          )}

          {/* Sweep: pure dropdown UX in v1 (no viewport picking). User
              picks two sketches; the builder uses each sketch's first
              detected closed region as the profile/path. */}
          {sweepState.visible && (
            <SweepDialog
              availableSketches={allSketchesForSweep}
              initialValues={sweepState.initialValues}
              onConfirm={handleSweepConfirm}
              onCancel={handleSweepCancel}
            />
          )}
          </div>
        </div>

        {/* Right Panel - Components catalog (collapsible) */}
        {componentsPanelOpen && isSaasAvailable(saas) && (
          <ComponentsPanel
            onClose={() => setComponentsPanelOpen(false)}
            commandBus={commandBus}
            partId={(parts[0]?.id as PartId | undefined) ?? null}
          />
        )}

        {/* Right Panel - chat (collapsible). Rendered after the
            Components panel so when both are open the chat sits flush
            against the right edge — matches the "secondary panel" feel
            and keeps the Components catalog closer to the viewport where
            instances are dropped. Gated on SaaS availability so the panel
            vanishes (and the wand button in MainAppBar hides) when the
            backend isn't reachable — same rule as AccountChip. */}
        {chatPanelOpen && isSaasAvailable(saas) && (
          <ChatPanel
            onClose={() => setChatPanelOpen(false)}
            saas={saas}
            onRequestSignIn={onRequestSignIn}
            // CadProject has no top-level id (storage context is the
            // identifier — filename / cloud projectId / "unsaved").
            // `metadata.createdAt` is set once at factory time and
            // never mutated, so it's the stablest in-doc key. Falls
            // back to "current" so unsaved docs still get scoped
            // history within a session.
            projectKey={project.metadata.createdAt || 'current'}
            availableModels={availableModels}
            onSendMessage={(text, history, opts) =>
              runChatTurn(text, history, opts)
            }
          />
        )}

        {/* Right Panel - Inspector (collapsible) */}
        {inspectorVisible && (
          <div style={styles.rightPanel}>
            <div style={styles.panelHeader}>
              <span>Inspector</span>
              <button
                style={styles.panelCloseBtn}
                onClick={() => setInspectorVisible(false)}
                title="Close Inspector"
              >
                x
              </button>
            </div>
            <div style={styles.panelContent}>
              {selectedFeature ? (
                <>
                  <div style={styles.inspectorSection}>
                    <div style={styles.inspectorLabel}>Feature</div>
                    <div style={styles.inspectorValue}>{selectedFeature.name}</div>
                  </div>
                  <div style={styles.inspectorSection}>
                    <div style={styles.inspectorLabel}>Type</div>
                    <div style={styles.inspectorValue}>{selectedFeature.type}</div>
                  </div>
                  <div style={styles.inspectorSection}>
                    <div style={styles.inspectorLabel}>Enabled</div>
                    <div style={styles.inspectorValue}>{selectedFeature.enabled ? 'Yes' : 'Suppressed'}</div>
                  </div>
                  <div style={styles.inspectorPlaceholder}>
                    Feature inputs and parameters will appear here when editing is implemented.
                  </div>
                </>
              ) : (
                <div style={styles.inspectorPlaceholder}>
                  Select a feature in the tree or timeline to inspect its parameters.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom - Timeline */}
      <TimelineBar
        features={timelineFeatures}
        selectedFeatureId={selectedFeatureId}
        onFeatureClick={setFeatureOnly}
        onContextAction={(action, featureId) => handleContextAction(action as ContextMenuAction, featureId)}
      />

      {/* Bottom - Console Panel (collapsible, below timeline) */}
      <ConsolePanel
        entries={consoleEntries}
        collapsed={consoleCollapsed}
        onToggle={consoleToggle}
        onClear={consoleClear}
      />

      {/* Per-instance properties editor for component features.
          Opens from the right-click → "Edit Component…" entry on a
          timeline or project-tree chip. Native <dialog> so it doesn't
          interfere with the viewport. */}
      {componentDialogElement}

    </div>
  );
}

// ---- Chat turn bridge ----

/**
 * Run one chat turn — possibly many model rounds with tool calls
 * executed locally between them. Delegates to `runAgentTurn` in
 * `ai/agentLoop.ts`. We construct the ToolHost fresh per call so it
 * always points at the current app state (handles HMR + project
 * reload without stale closures). The viewport controller is pulled
 * from the shared registry — same source the MCP bridge handlers
 * read from, so in-app and external tool consumers get identical view
 * capabilities (parity by construction).
 */
function runChatTurn(
  text: string,
  history: readonly ChatMessage[],
  opts: { modelId: string | null; signal: AbortSignal },
): AsyncIterable<ChatTurnEvent> {
  const app = getAppState();
  const host = createBrowserToolHost({
    documentStore: app.documentStore,
    commandBus: app.commandBus,
    viewportStore: app.viewportStore,
    viewportController: getActiveViewport(),
  });
  return runAgentTurn({
    text,
    history,
    modelId: opts.modelId,
    signal: opts.signal,
    host,
  });
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    background: '#f5f5f5',
    color: '#333333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  main: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPanel: {
    // width + minWidth are set inline so they respond to sidebarCollapsed
    // state. The transition animates between 240px (open) and 8px (rail).
    background: '#fafafa',
    borderRight: '1px solid #d8d8d8',
    display: 'flex',
    flexDirection: 'column',
    transition: 'width 140ms ease-out, min-width 140ms ease-out',
    // Clip the ProjectTree contents while the panel shrinks; labels would
    // otherwise spill into the viewport mid-animation.
    overflow: 'hidden',
  },
  rightPanel: {
    width: 260,
    minWidth: 200,
    background: '#fafafa',
    borderLeft: '1px solid #d8d8d8',
    display: 'flex',
    flexDirection: 'column',
  },
  centerColumn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  viewportContainer: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  canvas: {
    width: '100%',
    height: '100%',
    display: 'block',
  },
  panelHeader: {
    padding: '8px 12px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: '#888',
    borderBottom: '1px solid #d8d8d8',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  panelCloseBtn: {
    width: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 3,
    color: '#999',
    cursor: 'pointer',
    fontSize: 11,
    padding: 0,
  },
  panelContent: {
    flex: 1,
    padding: 8,
    overflow: 'auto',
  },
  inspectorSection: {
    padding: '6px 8px',
    borderBottom: '1px solid #eee',
  },
  inspectorLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#999',
    marginBottom: 2,
  },
  inspectorValue: {
    fontSize: 12,
    color: '#444',
    fontWeight: 500,
  },
  inspectorPlaceholder: {
    padding: '12px 8px',
    fontSize: 11,
    color: '#bbb',
    fontStyle: 'italic',
    lineHeight: 1.5,
  },
};

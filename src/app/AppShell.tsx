/**
 * The app's layout around the document: title bar, browser, ribbon,
 * viewport, timeline. The browser and the timeline read the document and
 * the display's pauses; their edits (rename, suppress, delete, move,
 * rollback) are editor commands.
 *
 * While a revision is previewed, a banner under the title bar names it
 * with Restore and Close, and every control that would write is left out
 * or disabled; selecting, the section view, Measure and Export stay.
 *
 * Slots for what later steps add: the ribbon takes a list of tool groups
 * per mode, a feature panel is drawn from `panels` by the app store's
 * `panel`, and sketch mode draws `renderSketch` over the viewport.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CommandResult } from '@tweakcad/editor';
import { MainAppBar, ToolRibbon, type RibbonToolGroup } from '../components/MainToolbar.tsx';
import { ConsolePanel } from '../components/ConsolePanel.tsx';
import { SectionPanel } from './modeling/SectionPanel';
import { TimelineBar, type TimelineFeature, type TimelineMenuEntry } from '../components/TimelineBar.tsx';
import { enqueueToast } from '../components/toastStore.ts';
import { isEditableTarget } from '../components/toolShortcuts.ts';
import type { SaasState } from '../storage/saasState.ts';
import type { Mode, PanelRequest } from './appState';
import { originShown, setColor, setName, setOriginShown, setVisible, type OriginItem } from './attributes';
import {
  BrowserTree,
  featureMenu,
  type BodyAction,
  type FeatureAction,
  type GroupAction,
  type MenuEntry,
} from './BrowserTree';
import { addPart, duplicateDerive } from './browserActions';
import { configurationsOf, setActiveConfiguration, shownParameters } from './parameters';
import { ParametersDialog } from './ParametersDialog';
import { clearConsole, consoleLog, consoleStore, rebuildMessage, toggleConsole } from './console';
import {
  bodiesOf,
  featureTypeLabel,
  findFeature,
  markerWhileEditing,
  partOfFeature,
  partsOf,
  partView,
  shownRoot,
  type FeatureRow,
} from './features';
import { activePartOf, liveFocus, shownAssembly } from './assembly/focus';
import { asmTimelineRows } from './assembly/asmFeatures';
import { editJoint, isJointAction, jointMenu, jointTimelineRows, runJointAction } from './assembly/jointActions';
import { activatePart, editInPlace, renameJoint } from './assembly/commands';
import { assemblyOf, jointLocked } from './assembly/assembly';
import { componentTimelines } from './assembly/componentTimelines';
import { freezeFeature, unfreezeFeature } from './modeling/freeze';
import { useDocument, useHistory, useSlice } from './hooks';
import { BuildBadge } from './display/BuildBadge';
import { ImportBadges } from './io/ImportBadges';
import { editFeature, startExtrude, startPanel, startProfileFeature, workIn } from './modeling/commands';
import { FREE_PANELS } from './modeling/panelTypes';
import { exportDrawing, importDrawingSketch } from './modeling/sketchFiles';
import { placeImported } from './modeling/placeBodies';
import { clearSelection, select, type SelectionItem } from './selection';
import { shellAction } from './shellKeys';
import { PreviewBanner } from './storage/PreviewBanner';
import { readOnlyTools, usePreview, VIEW_FEATURE_ACTIONS } from './storage/preview';
import type { AppServices } from './services';
import type { Viewport } from './viewport/Viewport';
import { ViewportView } from './viewport/ViewportView';

export interface PanelProps {
  services: AppServices;
  request: PanelRequest;
  viewport: Viewport | null;
  close: () => void;
}

export interface SketchSlotProps {
  services: AppServices;
  mode: Extract<Mode, { kind: 'sketch' }>;
  viewport: Viewport | null;
}

export interface AppShellProps {
  services: AppServices;
  /** The modelling ribbon's tools. */
  tools?: RibbonToolGroup[];
  /** The ribbon's tools while a sketch is edited. */
  sketchTools?: RibbonToolGroup[];
  /** Feature panels by `PanelRequest.kind`. */
  panels?: Record<string, (props: PanelProps) => React.ReactNode>;
  /** Drawn over the viewport while a sketch is edited. */
  renderSketch?: (props: SketchSlotProps) => React.ReactNode;
  /** Drawn over the viewport at all times (notices, side panels). */
  overlay?: React.ReactNode;
  /** The browser's rows for the document's assemblies. */
  assemblyTree?: React.ReactNode;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExport: (format: 'stl' | 'step' | 'brep' | '3mf') => void;
  onExportFreeCad?: () => void;
  /** Imports a STEP, STL or BREP file into the shown part. */
  onImport?: (format?: 'step' | 'stl' | 'brep') => void;
  /** Opens a FreeCAD file as a new document. */
  onImportFcstd?: () => void;
  /** Opens a `.f3d` or `.f3z` file as a new document. */
  onImportF3d?: () => void;
  /** Inserts a component document from disk into the shown assembly or the active part. */
  onImportComponent?: () => void;
  saas: SaasState;
  onRequestSignIn: () => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  /** Opens the cloud project's revision history; absent for a document with none. */
  onOpenHistory?: () => void;
  /** Makes a previewed revision the live document (the preview banner's Restore). */
  onRestoreRevision?: (revisionId: string) => Promise<void>;
  onViewport?: (viewport: Viewport | null) => void;
  /** The assistant: its title-bar toggle and its panel at the right; absent when the site offers none. */
  assistant?: { open: boolean; onToggle: () => void; panel: React.ReactNode };
}

/** Runs a command and tells the user when it is refused. */
export function report(result: CommandResult, what: string): boolean {
  if (result.ok) return true;
  consoleLog('warn', `${what}: ${result.error.message}`, 'edit');
  enqueueToast({ tone: 'warning', title: what, message: result.error.message });
  return false;
}

/** Feature menu actions that move the rollback marker, left out while a feature panel is open. */
const MARKER_ACTIONS: ReadonlySet<string> = new Set(['rollHere', 'rollEnd']);

export function AppShell(props: AppShellProps) {
  const { services } = props;
  const { editor, display: displayStore, selection, app } = services;
  const doc = useDocument(editor);
  const history = useHistory(editor);
  const display = useSlice(displayStore, (s) => s.display);
  // The browser and timeline list the committed model; a panel's preview shows only in the viewport.
  const committed = useSlice(displayStore, (s) => s.committed) ?? display;
  // While a panel is open on a feature, the browser lists the part just before it.
  const before = useSlice(displayStore, (s) => s.before);
  const items = useSlice(selection, (s) => s.items);
  const mode = useSlice(app, (s) => s.mode);
  const panel = useSlice(app, (s) => s.panel);
  const sidebarCollapsed = useSlice(app, (s) => s.sidebarCollapsed);
  const parametersOpen = useSlice(app, (s) => s.parametersOpen);
  const focus = useSlice(app, (s) => s.focus);
  const componentsOpen = useSlice(app, (s) => s.componentsOpen);
  const section = useSlice(app, (s) => s.section);
  const consoleEntries = useSlice(consoleStore, (s) => s.entries);
  const consoleCollapsed = useSlice(consoleStore, (s) => s.collapsed);
  // A revision's preview: the document is read-only, its editing controls left out or disabled.
  const preview = usePreview(services.session);
  const readOnly = preview !== null;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const { onViewport, onRestoreRevision } = props;
  const handleViewport = useCallback(
    (vp: Viewport | null) => {
      setViewport(vp);
      onViewport?.(vp);
    },
    [onViewport],
  );

  const root = shownRoot(doc);
  const parts = partsOf(doc).flatMap((p) => {
    const view = partView(doc, String(p.id), committed);
    if (!view) return [];
    const configuration = configurationsOf(doc, view.id)[0];
    return [
      {
        ...view,
        bodies: bodiesOf(display, view.id, committed, before),
        ...(configuration
          ? { configuration: { options: configuration.input.options, active: configuration.active } }
          : {}),
      },
    ];
  });
  const assemblies = (Array.isArray(doc.assemblies) ? (doc.assemblies as { id: string; name: string }[]) : []).map(
    (a) => ({ id: a.id, name: a.name }),
  );
  // The part the window works on; with an assembly shown, none (its timeline is not the part's).
  const workingPart = activePartOf(doc, focus);
  const activePart =
    parts.find((p) => p.id === workingPart) ??
    (shownAssembly(doc, focus)
      ? undefined
      : (parts.find((p) => root && 'part' in root && p.id === root.part) ?? parts[0]));
  const docName = String((doc.metadata as { name?: unknown }).name ?? '');
  const parameters = shownParameters(doc, activePart?.id ?? null);
  // The active part's origin shows as its document says (kept there, so a reload shows it as left); an assembly with no part active shows none.
  const shownOrigin = activePart && workingPart ? [...originShown(doc, activePart.id)].join(',') : '';
  useEffect(() => {
    const items = new Set(shownOrigin === '' ? [] : (shownOrigin.split(',') as OriginItem[]));
    const now = app.getState().originShown;
    if (now.size !== items.size || [...items].some((i) => !now.has(i))) app.setState({ originShown: items });
  }, [app, shownOrigin]);

  /** Grouping flags of a feature's menu: Group with several selected, Ungroup in a group. */
  const groupingOf = (feature: string) => {
    const view = activePart;
    const selected = view ? view.features.filter((f) => selectedFeatures.has(f.id)).map((f) => f.id) : [];
    return {
      canGroup: selected.length > 1 && selected.includes(feature),
      grouped: view?.groups.some((g) => g.members.includes(feature)) ?? false,
    };
  };

  /** An action on bodies of `part`, the part whose browser row they are listed under. */
  const runBodyAction = (part: string, keys: readonly number[], action: BodyAction) => {
    if (editor.store.readOnly) return;
    const [key] = keys;
    if (key === undefined) return;
    if (action.kind === 'place') {
      void placeImported(services, part, key, action.to).then((r) => {
        if (!r.ok) {
          consoleLog('warn', r.message, 'move');
          enqueueToast({
            tone: 'warning',
            title: action.to === 'origin' ? 'Move to origin' : 'Drop on XY plane',
            message: r.message,
          });
        }
      });
      return;
    }
    if (action.kind === 'move' || action.kind === 'remove') {
      // Their panels work in the part the window works on.
      if (part !== activePart?.id) {
        const message = 'Open the part to move or remove its bodies';
        consoleLog('warn', message, 'move');
        enqueueToast({ tone: 'warning', title: action.kind === 'move' ? 'Move' : 'Remove Body', message });
        return;
      }
      selection.setState({ items: keys.map((k) => ({ key: k })) });
      startPanel(
        services,
        action.kind === 'move' ? 'move' : 'removeBody',
        action.kind === 'move' ? 'Move' : 'Remove Body',
      );
      return;
    }
    // Every body at once, as one undo step (an import node's eye).
    const label =
      action.kind === 'color' ? 'Color' : action.kind === 'rename' ? 'Rename' : action.visible ? 'Show' : 'Hide';
    void Promise.all(keys.map((k) => services.pick({ key: k }))).then((picks) => {
      const targets = picks.flatMap((p) => (p && !('region' in p) ? [{ reference: p.reference, names: p.names }] : []));
      if (targets.length === 0) return;
      const results = editor.transaction(label, () =>
        targets.map((target) =>
          action.kind === 'visible'
            ? setVisible(editor, part, target, action.visible)
            : action.kind === 'rename'
              ? setName(editor, part, target, action.name)
              : setColor(editor, part, target, action.color),
        ),
      );
      const failed = results.find((r) => !r.ok);
      if (failed) report(failed, label);
    });
  };

  const runGroupAction = (group: string, action: GroupAction, name?: string) => {
    if (editor.store.readOnly) return;
    if (action === 'renameGroup' && name) report(editor.dispatch({ type: 'editGroup', group, name }), 'Rename');
    else if (action === 'ungroup') report(editor.dispatch({ type: 'removeGroup', group }), 'Ungroup');
  };

  // Rebuilds and their pauses go to the console; a failed evaluate also to a toast, once per message.
  useEffect(
    () =>
      displayStore.subscribe((s, prev) => {
        if (s.error && s.error !== prev.error) {
          consoleLog('error', `Rebuild failed: ${s.error}`, 'rebuild');
          enqueueToast({ tone: 'warning', title: 'The model could not be rebuilt', message: s.error });
        }
        if (!s.display || s.display === prev.display) return;
        const t = s.display.timing;
        consoleLog('info', rebuildMessage(t.evaluate + t.display, t.resumed), 'rebuild');
        const before = new Set((prev.display?.pauses ?? []).map((p) => `${p.feature}|${p.message}`));
        for (const p of s.display.pauses) {
          if (before.has(`${p.feature}|${p.message}`)) continue;
          const name = findFeature(editor.document, p.feature)?.name;
          consoleLog('warn', `${typeof name === 'string' ? name : p.feature}: ${p.message}`, 'rebuild');
        }
      }),
    [displayStore, editor],
  );

  const runFeatureAction = useCallback(
    (action: FeatureAction, feature: string) => {
      if (editor.store.readOnly && !VIEW_FEATURE_ACTIONS.has(action)) return;
      const part = partOfFeature(editor.document, feature);
      const view = part ? partView(editor.document, part, null) : null;
      const index = view ? view.features.findIndex((f) => f.id === feature) : -1;
      const row = view?.features[index];
      switch (action) {
        case 'editSketch':
          if (part) {
            workIn(services, part);
            clearSelection(selection);
            app.setState({ mode: { kind: 'sketch', part, feature }, panel: null });
          }
          return;
        case 'editFeature':
          editFeature(services, feature);
          return;
        case 'extrude':
          startExtrude(services, feature);
          return;
        case 'revolve':
          startProfileFeature(services, 'revolve', 'Revolve', feature);
          return;
        case 'rename':
          setRenaming(feature);
          return;
        case 'suppress':
        case 'unsuppress':
          report(editor.dispatch({ type: 'setSuppressed', feature, suppressed: action === 'suppress' }), 'Suppress');
          return;
        case 'freeze':
          void freezeFeature(services, feature).then((r) => {
            if (r.ok) return;
            consoleLog('warn', r.message, 'freeze');
            enqueueToast({ tone: 'warning', title: 'Freeze', message: r.message });
          });
          return;
        case 'unfreeze':
          report(unfreezeFeature(editor, feature), 'Unfreeze');
          return;
        case 'rollHere':
          if (part && view) {
            const next = view.features[index + 1];
            report(
              editor.dispatch(next ? { type: 'setRollback', part, before: next.id } : { type: 'setRollback', part }),
              'Roll back',
            );
          }
          return;
        case 'rollEnd':
          if (part) report(editor.dispatch({ type: 'setRollback', part }), 'Roll forward');
          return;
        case 'moveUp':
        case 'moveDown':
          if (part && view && row) {
            // A feature outside a group steps over the whole group, as groups hold features next to each other (7.1).
            const ownGroup = view.groups.find((g) => g.members.includes(feature));
            const groupAt = (i: number) =>
              ownGroup
                ? undefined
                : view.features[i] && view.groups.find((g) => g.members.includes(view.features[i]?.id as string));
            const positionOf = (id: string | undefined) => view.features.findIndex((f) => f.id === id);
            const above = groupAt(index - 1);
            const below = groupAt(index + 1);
            const before =
              action === 'moveUp'
                ? above
                  ? above.members[0]
                  : view.features[index - 1]?.id
                : view.features[(below ? positionOf(below.members.at(-1)) : index + 1) + 1]?.id;
            if (action === 'moveUp' && before === undefined) return;
            report(
              editor.dispatch(
                before
                  ? { type: 'moveFeature', feature, container: part, before }
                  : { type: 'moveFeature', feature, container: part },
              ),
              'Move',
            );
          }
          return;
        case 'delete':
          if (report(editor.dispatch({ type: 'removeFeature', feature }), 'Delete')) clearSelection(selection);
          return;
        case 'editComponent':
          app.setState({ panel: { kind: 'assembly.component', feature } });
          return;
        case 'duplicateComponent':
          report(duplicateDerive(editor, feature), 'Duplicate Component');
          return;
        case 'exportDxf':
        case 'exportSvg':
          void exportDrawing(services, feature, action === 'exportDxf' ? 'dxf' : 'svg');
          return;
        case 'group':
          if (part && view) {
            const chosen = new Set(selection.getState().items.flatMap((i) => ('feature' in i ? [i.feature] : [])));
            const members = view.features.filter((f) => chosen.has(f.id)).map((f) => f.id);
            const taken = new Set(view.groups.map((g) => g.name));
            let n = view.groups.length + 1;
            while (taken.has(`Group ${n}`)) n++;
            report(
              editor.dispatch({
                type: 'addGroup',
                part,
                group: { id: editor.newId('grp'), name: `Group ${n}`, members },
              }),
              'Group',
            );
          }
          return;
        case 'ungroup': {
          const group = view?.groups.find((g) => g.members.includes(feature));
          if (group) report(editor.dispatch({ type: 'removeGroup', group: group.id }), 'Ungroup');
          return;
        }
      }
    },
    [editor, selection, app, services],
  );

  // The section view ends when a panel opens or a sketch is entered: they work on the whole model.
  useEffect(
    () =>
      app.subscribe((s, prev) => {
        if (s.section && ((s.panel && !prev.panel) || (s.mode.kind === 'sketch' && prev.mode.kind !== 'sketch')))
          app.setState({ section: null });
      }),
    [app],
  );

  const finishSketch = useCallback(() => app.setState({ mode: { kind: 'model' } }), [app]);
  const closePanel = useCallback(() => app.setState({ panel: null }), [app]);
  // A feature panel holds a pending edit over the document as it was opened: undo and redo wait until it closes.
  const historyOpen = panel === null || FREE_PANELS.has(panel.kind);

  // Keyboard: undo and redo, files, the console, Escape, Delete (see shellKeys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const state = app.getState();
      const open = state.panel;
      const historyLocked = open !== null && !FREE_PANELS.has(open.kind);
      const action = shellAction(e, {
        panel: open !== null,
        section: state.section !== null,
        sketching: state.mode.kind === 'sketch',
        typing: isEditableTarget(e.target),
      });
      switch (action) {
        case 'undo':
        case 'redo':
          e.preventDefault();
          if (!historyLocked) {
            if (action === 'undo') editor.undo();
            else editor.redo();
          }
          return;
        case 'save':
        case 'saveAs':
          e.preventDefault();
          if (action === 'saveAs') props.onSaveAs();
          else props.onSave();
          return;
        case 'open':
          e.preventDefault();
          props.onOpen();
          return;
        case 'new':
          e.preventDefault();
          props.onNew();
          return;
        case 'console':
          toggleConsole();
          return;
        case 'closePanel':
          app.setState({ panel: null });
          return;
        case 'endSection':
          app.setState({ section: null });
          return;
        case 'finishSketch':
          finishSketch();
          return;
        case 'deselect':
          clearSelection(selection);
          return;
        case 'delete': {
          const features = selection.getState().items.flatMap((i) => ('feature' in i ? [i.feature] : []));
          if (features.length === 0 || editor.store.readOnly) return;
          e.preventDefault();
          editor.transaction('Delete features', () => {
            for (const f of features) editor.dispatch({ type: 'removeFeature', feature: f });
          });
          clearSelection(selection);
          return;
        }
        case null:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, selection, app, finishSketch, props]);

  const selectedFeatures = new Set(items.flatMap((i) => ('feature' in i ? [i.feature] : [])));
  const selectedKeys = new Set(items.flatMap((i) => ('key' in i && !i.instance ? [i.key] : [])));
  const selectedStandard = new Set(items.flatMap((i) => ('standard' in i ? [i.standard] : [])));
  const selectedDatums = new Set(items.flatMap((i) => ('datum' in i ? [i.datum] : [])));
  // A selected body lights the feature that made it, in the browser and the timeline (it is not selected itself).
  const litFeatures = new Set(selectedFeatures);
  for (const i of items) {
    const info = 'key' in i && !i.instance ? display?.entities[i.key] : undefined;
    if (info?.kind === 'body') litFeatures.add(info.feature);
  }
  const selectItem = (item: SelectionItem, additive: boolean) => select(selection, item, additive);
  /** A click in the browser or the timeline: to the open panel when it takes them, otherwise a selection. */
  const treeClick = (item: SelectionItem, additive: boolean) => {
    const take = app.getState().treeClicks;
    if (take) take(item);
    else selectItem(item, additive);
  };

  // With an assembly shown, the timeline is the whole design's: its top-level component, the features that copy instances, a group for each other component.
  const assemblyShown = activePart ? null : shownAssembly(doc, focus);
  const assemblyRows = assemblyShown
    ? [...asmTimelineRows(doc, assemblyShown, display), ...jointTimelineRows(doc, assemblyShown, display)]
    : [];
  const components = assemblyShown ? componentTimelines(doc, assemblyShown, parts) : null;
  const timelineRows = activePart?.features ?? [
    ...(components?.top ?? []),
    ...assemblyRows,
    ...(components?.rest ?? []),
  ];
  /** Works on the component a timeline item of the shown assembly belongs to; false for any other item. */
  const openComponent = (feature: string): boolean => {
    const instance = components?.instanceOf.get(feature);
    if (!assemblyShown || instance === undefined) return false;
    editInPlace(services, assemblyShown, instance);
    return true;
  };
  const chipOf = (f: FeatureRow): TimelineFeature => ({
    id: f.id,
    name: f.name,
    type: featureTypeLabel(f.type, f.iconKey),
    iconKey: f.iconKey,
    enabled: !f.suppressed,
    frozen: f.frozen,
    status: f.status,
    ...(f.status === 'failed' && f.message ? { errorMessage: f.message } : {}),
    ...(f.status === 'blocked' && f.message ? { blockedByLabel: f.message } : {}),
    // A feature that built but not as authored keeps the bar's amber mark, with its warning.
    ...(f.status === 'success' && f.warning ? { status: 'blocked' as const, blockedByLabel: f.warning } : {}),
    ...(f.children.length > 0 ? { children: f.children.map(chipOf) } : {}),
  });
  const timelineFeatures = timelineRows.map(chipOf);
  /** A composite's own feature, found by id among the shown part's features. */
  const nestedRow = (rows: readonly FeatureRow[], id: string): FeatureRow | undefined => {
    for (const r of rows) {
      if (r.id === id) return r;
      const inner = nestedRow(r.children, id);
      if (inner) return inner;
    }
    return undefined;
  };
  /** A timeline chip's menu; in a read-only preview, only what writes nothing; with a feature panel open, nothing that moves the marker. */
  const timelineMenu = (f: TimelineFeature): TimelineMenuEntry[] => {
    const entries = (rows: MenuEntry[]) =>
      rows
        .filter(
          (e) => (!readOnly || VIEW_FEATURE_ACTIONS.has(e.action)) && (historyOpen || !MARKER_ACTIONS.has(e.action)),
        )
        .map((e) => ({ action: e.action, label: e.label, ...(e.danger ? { danger: true } : {}) }));
    // An assembly's features have no rollback, order or rename here.
    if (components?.instanceOf.has(f.id)) return readOnly ? [] : [{ action: 'editInPlace', label: 'Edit in Place' }];
    const own = assemblyShown ? assemblyRows.find((r) => r.id === f.id) : undefined;
    if (own?.joint)
      return readOnly ? [] : jointMenu(own, jointLocked(doc, assemblyOf(doc, assemblyShown as string), own.id));
    if (own)
      return entries(
        featureMenu(own, -1, assemblyRows.length, assemblyRows.length).filter((e) => e.action !== 'rename'),
      );
    const index = activePart?.features.findIndex((r) => r.id === f.id) ?? -1;
    const row = activePart?.features[index] ?? (activePart ? nestedRow(activePart.features, f.id) : undefined);
    const top = index >= 0;
    return row && activePart
      ? entries(
          featureMenu(
            row,
            top ? index : -1,
            activePart.features.length,
            activePart.rollbackIndex,
            top ? groupingOf(row.id) : {},
          ),
        )
      : [];
  };

  const Panel = panel ? props.panels?.[panel.kind] : undefined;

  return (
    <div style={styles.root}>
      <MainAppBar
        projectName={docName}
        canUndo={history.canUndo && historyOpen}
        canRedo={history.canRedo && historyOpen}
        undoLabel={history.undoLabel}
        redoLabel={history.redoLabel}
        onUndo={() => editor.undo()}
        onRedo={() => editor.redo()}
        rebuilding={
          <>
            <ImportBadges />
            <BuildBadge store={displayStore} />
          </>
        }
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => app.setState({ sidebarCollapsed: !sidebarCollapsed })}
        onNew={props.onNew}
        onOpen={props.onOpen}
        onSave={props.onSave}
        onSaveAs={props.onSaveAs}
        onExport={props.onExport}
        onExportFreeCad={props.onExportFreeCad}
        onImport={readOnly ? undefined : props.onImport}
        onImportFcstd={props.onImportFcstd}
        onImportF3d={props.onImportF3d}
        onImportComponent={readOnly ? undefined : props.onImportComponent}
        onImportSketchDxf={readOnly ? undefined : () => importDrawingSketch(props.services, 'dxf')}
        onImportSketchSvg={readOnly ? undefined : () => importDrawingSketch(props.services, 'svg')}
        saas={props.saas}
        onRequestSignIn={props.onRequestSignIn}
        onSignOut={props.onSignOut}
        onOpenSettings={props.onOpenSettings}
        onOpenHistory={props.onOpenHistory}
        componentsPanelOpen={componentsOpen}
        onToggleComponentsPanel={
          readOnly ? undefined : () => app.setState({ componentsOpen: !app.getState().componentsOpen })
        }
        chatPanelOpen={props.assistant?.open}
        onToggleChatPanel={props.assistant?.onToggle}
        onRenameProject={
          readOnly ? undefined : (name) => report(editor.dispatch({ type: 'renameDocument', name }), 'Rename')
        }
      />
      {preview && (
        <PreviewBanner
          label={preview.label}
          onRestore={onRestoreRevision ? () => onRestoreRevision(preview.revisionId) : undefined}
          onClose={() => services.session.closePreview()}
        />
      )}
      <div style={styles.main}>
        <div
          style={{ ...styles.leftPanel, width: sidebarCollapsed ? 8 : 240, minWidth: sidebarCollapsed ? 8 : 180 }}
          aria-hidden={sidebarCollapsed}
        >
          <BrowserTree
            documentName={docName}
            parts={parts}
            assemblies={assemblies}
            assemblyTree={props.assemblyTree}
            activePart={workingPart}
            {...(readOnly
              ? { readOnly: true }
              : {
                  onNewPart: () =>
                    void addPart(services).then((r) => {
                      if (r) report(r, 'New Part');
                    }),
                })}
            onOpenPart={(part) => {
              clearSelection(selection);
              const isRoot = root && 'part' in root && root.part === part;
              app.setState({ focus: isRoot ? null : { part }, panel: null, mode: { kind: 'model' }, exploded: null });
            }}
            onActivatePart={(part) => activatePart(services, part)}
            {...(root && 'assembly' in root ? { designActive: liveFocus(doc, focus) === null } : {})}
            selectedFeatures={litFeatures}
            selectedKeys={selectedKeys}
            selectedStandard={selectedStandard}
            selectedDatums={selectedDatums}
            originShown={(part) => originShown(doc, part)}
            onSetOriginShown={(part, items, shown) =>
              report(setOriginShown(editor, part, items, shown), shown ? 'Show' : 'Hide')
            }
            onSelectStandard={(name, additive) => treeClick({ standard: name }, additive)}
            onSelectDatum={(name, additive) => treeClick({ datum: name }, additive)}
            onSelectFeature={(feature, additive) => treeClick({ feature }, additive)}
            onSelectBody={(key, additive) => treeClick({ key }, additive)}
            onFeatureAction={runFeatureAction}
            markerLocked={!historyOpen}
            onRenameFeature={(feature, name) =>
              report(editor.dispatch({ type: 'renameFeature', feature, name }), 'Rename')
            }
            parameters={parameters}
            onEditParameters={() => app.setState({ parametersOpen: true })}
            onSetConfiguration={(part, option) => {
              const configuration = configurationsOf(editor.document, part)[0];
              if (configuration) report(setActiveConfiguration(editor, configuration, option), 'Configuration');
            }}
            onToggleFeatureVisible={(feature, visible) => {
              const part = partOfFeature(editor.document, feature);
              if (part) report(setVisible(editor, part, { feature }, visible), visible ? 'Show' : 'Hide');
            }}
            onBodyAction={runBodyAction}
            renaming={renaming}
            onRenamingChange={setRenaming}
          />
        </div>
        <div style={styles.centerColumn}>
          {mode.kind === 'sketch' ? (
            <ToolRibbon groups={props.sketchTools ?? []} onFinish={finishSketch} finishLabel="Finish Sketch" />
          ) : (
            <ToolRibbon groups={readOnly ? readOnlyTools(props.tools ?? []) : (props.tools ?? [])} />
          )}
          <ViewportView services={services} onViewport={handleViewport}>
            {mode.kind === 'sketch' && props.renderSketch?.({ services, mode, viewport })}
            {props.overlay}
            {section && (
              <SectionPanel
                services={services}
                viewport={viewport}
                section={section}
                onDone={() => app.setState({ section: null })}
              />
            )}
            {panel && Panel && (
              <Panel
                key={`${panel.kind}|${panel.feature ?? ''}|${panel.from ?? ''}`}
                services={services}
                request={panel}
                viewport={viewport}
                close={closePanel}
              />
            )}
          </ViewportView>
        </div>
        {props.assistant?.open && props.assistant.panel}
      </div>
      {/* While a feature panel is open the marker is fixed; on an edit it sits just after the edited feature. */}
      <TimelineBar
        features={timelineFeatures}
        groups={activePart?.groups ?? components?.groups}
        selectedFeatureIds={litFeatures}
        rollbackIndex={
          activePart ? markerWhileEditing(activePart, historyOpen ? undefined : panel?.feature) : timelineRows.length
        }
        markerLocked={!historyOpen}
        onFeatureClick={(feature, additive) => treeClick({ feature }, additive)}
        onFeatureRangeClick={(features) => {
          if (app.getState().treeClicks) return;
          clearSelection(selection);
          for (const feature of features) select(selection, { feature }, true);
        }}
        readOnly={readOnly}
        onRename={
          readOnly
            ? undefined
            : (feature, name) =>
                assemblyShown && assemblyRows.some((r) => r.id === feature && r.joint)
                  ? void renameJoint(services, assemblyShown, feature, name)
                  : report(editor.dispatch({ type: 'renameFeature', feature, name }), 'Rename')
        }
        onGroupAction={
          readOnly || assemblyShown ? undefined : (group, action, name) => runGroupAction(group, action, name)
        }
        onFeatureDoubleClick={
          readOnly
            ? undefined
            : (feature) =>
                timelineRows.some((r) => r.id === feature && r.joint)
                  ? editJoint(services, feature)
                  : openComponent(feature) || editFeature(services, feature)
        }
        onRollbackChange={(index) => {
          if (!activePart || readOnly || !historyOpen) return;
          const before = activePart.features[index]?.id;
          report(
            editor.dispatch(
              before
                ? { type: 'setRollback', part: activePart.id, before }
                : { type: 'setRollback', part: activePart.id },
            ),
            'Roll back',
          );
        }}
        menuFor={timelineMenu}
        onContextAction={(action, feature) => {
          if (assemblyShown && isJointAction(action)) runJointAction(services, assemblyShown, action, feature);
          else if (action !== 'editInPlace' || !openComponent(feature))
            runFeatureAction(action as FeatureAction, feature);
        }}
      />
      {parametersOpen && !readOnly && (
        <ParametersDialog
          editor={editor}
          part={activePart?.id ?? null}
          onClose={() => app.setState({ parametersOpen: false })}
        />
      )}
      <ConsolePanel
        entries={consoleEntries}
        collapsed={consoleCollapsed}
        onToggle={toggleConsole}
        onClear={clearConsole}
      />
    </div>
  );
}

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
  main: { display: 'flex', flex: 1, overflow: 'hidden' },
  leftPanel: {
    background: '#fafafa',
    borderRight: '1px solid #d8d8d8',
    display: 'flex',
    flexDirection: 'column',
    transition: 'width 140ms ease-out, min-width 140ms ease-out',
    overflow: 'hidden',
  },
  centerColumn: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
};

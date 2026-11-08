/**
 * The app while a revision is previewed read-only. The editor's store
 * refuses every edit then; this module keeps the editing surfaces closed:
 * sketch mode, feature panels, the parameters dialog and the Components
 * panel close and stay closed, and the ribbon offers only the tools that
 * look at the model (Section, Measure). The selection is cleared whenever
 * the shown document changes, and what the window works on comes back as
 * it was when the preview ends.
 */
import { useSyncExternalStore } from 'react';
import type { RibbonToolGroup } from '../../components/MainToolbar.tsx';
import type { AppState, AppStore, Focus } from '../appState';
import { clearSelection, type SelectionStore } from '../selection';
import type { DocumentSession, RevisionPreview } from './session';

/** Panels that only look at the model; the others close while a preview shows. */
export const VIEW_PANELS: ReadonlySet<string> = new Set(['measure']);

/** Ribbon tools that only look at the model; the others are disabled while a preview shows. */
export const VIEW_TOOLS: ReadonlySet<string> = new Set(['section', 'measure']);

/** Feature menu actions that write nothing to the document. */
export const VIEW_FEATURE_ACTIONS: ReadonlySet<string> = new Set(['exportDxf', 'exportSvg']);

/** The ribbon as a preview offers it: every tool but the viewing ones disabled. */
export function readOnlyTools(groups: RibbonToolGroup[]): RibbonToolGroup[] {
  return groups.map((g) => ({
    ...g,
    tools: g.tools.map((t) => (VIEW_TOOLS.has(t.id) ? t : { ...t, disabled: true })),
  }));
}

/** What of `s` a preview closes, or null when nothing is open that edits. */
export function closedForPreview(s: AppState): Partial<AppState> | null {
  const next: Partial<AppState> = {};
  if (s.mode.kind !== 'model') next.mode = { kind: 'model' };
  if (s.panel && !VIEW_PANELS.has(s.panel.kind)) next.panel = null;
  if (s.parametersOpen) next.parametersOpen = false;
  if (s.componentsOpen) next.componentsOpen = false;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Keeps the app read-only while `session` previews a revision. Returns the
 * function that stops following.
 */
export function followPreview(o: { session: DocumentSession; app: AppStore; selection: SelectionStore }): () => void {
  const { session, app, selection } = o;
  let held: { focus: Focus | null; exploded: string | null } | null = null;
  const close = (s: AppState) => {
    const next = closedForPreview(s);
    if (next) app.setState(next);
  };
  const offSession = session.state.subscribe((s, prev) => {
    if (s.preview === prev.preview) return;
    clearSelection(selection);
    if (s.preview && !prev.preview) {
      const { focus, exploded } = app.getState();
      held = { focus, exploded };
      app.setState({ exploded: null });
      close(app.getState());
    } else if (!s.preview && held) {
      app.setState(held);
      held = null;
    }
  });
  const offApp = app.subscribe((s) => {
    if (session.preview) close(s);
  });
  return () => {
    offSession();
    offApp();
  };
}

/** The revision previewed, or null; the same snapshot when rendered to static markup. */
export function usePreview(session: DocumentSession): RevisionPreview | null {
  const get = () => session.preview;
  return useSyncExternalStore(session.state.subscribe, get, get);
}

/** Whether the document shown is a revision's read-only preview. */
export function useReadOnly(session: DocumentSession): boolean {
  return usePreview(session) !== null;
}

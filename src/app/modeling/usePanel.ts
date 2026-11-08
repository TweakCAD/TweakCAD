/**
 * The React side every feature panel shares, after the extrude panel:
 *
 * - what the panel writes is settled when it opens: a new feature of the
 *   active part at the rollback marker, or the feature it edits;
 * - the form is local state; a moment after it changes, the preview shows
 *   the document with the pending feature, evaluated without being
 *   committed, and the committed display returns when the panel closes;
 * - the viewport shows the part as it stands just before the feature, with
 *   the preview on top and the features after it hidden; a form that cannot
 *   build shows that state alone, at once;
 * - OK writes the feature as one undo step, Cancel writes nothing;
 * - while it is open the panel owns viewport clicks, sets what they may
 *   land on, and shows its picked references selected;
 * - it works in the part just before its feature, which the browser lists
 *   while it is open, and an edited feature's stored picks are named as
 *   that state names them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { Doc, Json } from '@tweakcad/editor';
import type { EntityRecord } from '@tweakcad/format';
import type { PanelProps } from '../AppShell';
import type { Picking } from '../appState';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import type { Viewport, ViewportPointer } from '../viewport/Viewport';
import { enqueueToast } from '../../components/toastStore.ts';
import { consoleLog } from '../console';
import { findFeature, partOfFeature } from '../features';
import { useDocument, useSlice } from '../hooks';
import { activePart } from './commands';
import { labelsOfStoredPicks, recordOf, relabelled } from './beforeState';
import {
  candidateFeature,
  editTarget,
  newTarget,
  ValueSlots,
  writeFeature,
  type Built,
  type FeatureTarget,
} from './feature';
import { disposeOutlines, outlineHit, outlineObjects, rayThrough } from './pickOutlines';
import { takeClicks } from './viewportClicks';

/** Milliseconds a form change waits before the preview follows it. */
export const PREVIEW_DELAY = 150;

export interface PanelSpec<F> {
  /** The feature type it writes, e.g. `core.revolve`. */
  type: string;
  /** The new feature's name, numbered: "Revolve 1". */
  baseName: string;
  /** The form of a new feature. */
  create(services: AppServices, part: string, request: PanelProps['request']): F;
  /** The form an existing feature reads back as, or null when this panel cannot show it. */
  read(doc: Doc, part: string, inputs: Json): F | null;
  /** The inputs the form makes. */
  build(doc: Doc, target: FeatureTarget, form: F, values: ValueSlots): Built;
}

export interface FeaturePanel<F> {
  target: FeatureTarget;
  form: F;
  /** The latest form, for callbacks that outlive a render. */
  latest: React.RefObject<F>;
  update(patch: Partial<F> | ((f: F) => Partial<F>)): void;
  error: string | null;
  setError(message: string | null): void;
  /** Why OK cannot write the form yet (a pick still to make, a value out of range), or null; OK's tooltip. */
  blocked: string | null;
  confirm(): void;
  values: ValueSlots;
}

/** The panel's target, form, preview and commit; null when it cannot open (no part, or a feature it cannot edit). */
export function useFeaturePanel<F>(
  { services, request, close }: PanelProps,
  spec: PanelSpec<F>,
): FeaturePanel<F> | null {
  const { editor, scheduler } = services;
  const setup = useMemo<{ target: FeatureTarget; form: F } | null>(() => {
    // An edit works in the feature's own part; a new feature goes into the active part.
    const part = request.feature ? partOfFeature(editor.document, request.feature) : activePart(services);
    if (!part) return null;
    if (request.feature) {
      const target = editTarget(editor.document, part, request.feature, spec.type);
      const form = target?.base ? spec.read(editor.document, part, target.base) : null;
      return target && form ? { target, form } : null;
    }
    return { target: newTarget(editor, part, spec.baseName), form: spec.create(services, part, request) };
    // The panel is keyed by its request; what it writes is settled when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A panel that cannot open (no part shown, or a feature written in a way the panel does not show) closes again.
  useEffect(() => {
    if (setup) return;
    const what = request.feature
      ? String(findFeature(editor.document, request.feature)?.name ?? 'This feature')
      : spec.baseName;
    const message = request.feature
      ? `${what} is not edited in a panel`
      : `${what} goes in a part; open the part to add one.`;
    consoleLog('warn', message, 'panel');
    enqueueToast({ tone: 'warning', title: spec.baseName, message });
    close();
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [form, setForm] = useState<F | null>(() => setup?.form ?? null);
  const [error, setError] = useState<string | null>(null);
  // Read against the document the panel opened on, as the form was.
  const values = useMemo(
    () => new ValueSlots(() => editor.newId('val'), setup?.target.base, editor.document),
    [editor, setup],
  );
  const latest = useRef<F>(form as F);
  useLayoutEffect(() => {
    latest.current = form as F;
  });
  const relabel = useCallback((next: (f: F) => F) => setForm((f) => (f === null ? f : next(f))), []);
  useBeforeState(services, setup?.target ?? null, setup?.form ?? null, relabel);

  // The preview follows the form, and the document, a moment after they change. A form that
  // cannot build shows the state before the feature at once, never the last preview it built.
  const doc = useDocument(editor);
  useEffect(() => {
    if (!setup || form === null) return;
    const built = spec.build(editor.document, setup.target, form, values);
    if (!built.ok) scheduler.setPreview(null);
    const timer = setTimeout(() => {
      if (!built.ok) {
        setError(built.quiet ? null : built.message);
        return;
      }
      const candidate = candidateFeature(editor.document, setup.target, spec.type, built, (kind) => editor.newId(kind));
      setError(candidate.ok ? null : candidate.message);
      scheduler.setPreview(candidate.ok ? candidate.doc : null);
    }, PREVIEW_DELAY);
    return () => clearTimeout(timer);
    // `spec` is a module constant of each panel; `doc` rebuilds the preview when the document changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, form, values, editor, scheduler, doc]);
  useEffect(() => () => scheduler.setPreview(null), [scheduler]);

  // What OK would refuse, by the check the preview and OK make.
  const check = useMemo(() => {
    if (!setup || form === null) return null;
    const built = spec.build(editor.document, setup.target, form, values);
    return built.ok ? null : built.message;
    // `spec` is a module constant of each panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, form, values, editor]);

  const update = useCallback((patch: Partial<F> | ((f: F) => Partial<F>)) => {
    setForm((f) => (f === null ? f : { ...f, ...(typeof patch === 'function' ? patch(f) : patch) }));
    setError(null);
  }, []);

  const confirm = useCallback(() => {
    if (!setup) return;
    const built = spec.build(editor.document, setup.target, latest.current, values);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    const result = writeFeature(editor, setup.target, spec.type, built, spec.baseName);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, editor, values, close]);

  // Why the feature as the form stands does not build: the panel says so, as it does a form it cannot write; OK still writes it.
  const feature = setup?.target.feature;
  const paused = useSlice(services.display, (s) =>
    feature === undefined || !s.candidate
      ? null
      : (s.display?.pauses.find((p) => p.feature === feature)?.message ?? null),
  );

  if (!setup || form === null) return null;
  return {
    target: setup.target,
    form,
    latest,
    update,
    error: error ?? pausedLine(paused),
    setError,
    blocked: check ?? error,
    confirm,
    values,
  };
}

/** The panel's line for a feature that does not build: the evaluator's reason, as a sentence. */
export function pausedLine(message: string | null): string | null {
  if (message === null) return null;
  const reason = message.charAt(0).toUpperCase() + message.slice(1);
  return `The feature does not build. ${reason.endsWith('.') ? reason : `${reason}.`}`;
}

/**
 * While a panel is open on `target`, the browser lists the part just
 * before it (`RebuildScheduler.setBefore`); for an edit, the picks of the
 * form it opened with are named as that state names them, or as missing,
 * through `setForm`.
 */
export function useBeforeState<F>(
  services: AppServices,
  target: FeatureTarget | null,
  opened: F | null,
  setForm: (next: (f: F) => F) => void,
): void {
  const { scheduler } = services;
  useEffect(() => {
    if (!target) return;
    scheduler.setBefore({ part: target.part, feature: target.feature });
    return () => scheduler.setBefore(null);
  }, [scheduler, target]);
  const set = useRef(setForm);
  useLayoutEffect(() => {
    set.current = setForm;
  });
  useEffect(() => {
    if (!target?.base || opened === null) return;
    let live = true;
    void labelsOfStoredPicks(services, target, opened).then((labels) => {
      if (live && labels.size > 0) set.current((f) => relabelled(f, labels));
    });
    return () => {
      live = false;
    };
  }, [services, target, opened]);
}

/** What viewport picks may land on while the panel is open. */
export function usePicking(services: AppServices, picking: Picking): void {
  const { app } = services;
  const key = `${picking.kinds.join(',')}|${picking.standardPlanes}`;
  useEffect(() => {
    app.setState({ picking });
    // Keyed by its content: callers build the object inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, key]);
  useEffect(() => () => app.setState({ picking: null }), [app]);
}

/**
 * Viewport clicks go to `onClick` instead of selecting, while the panel is
 * open; a click waits for the newest display. `gizmo` says whether a
 * gizmo of the panel is being dragged, so its drags do not click. `onMove`
 * follows the pointer while no button is pressed.
 */
export function useClicks(
  services: AppServices,
  viewport: Viewport | null,
  onClick: (item: SelectionItem | null, e: ViewportPointer) => void,
  gizmo?: () => boolean,
  onMove?: (e: ViewportPointer) => void,
): void {
  const handler = useRef(onClick);
  const dragging = useRef(gizmo);
  const moved = useRef(onMove);
  useLayoutEffect(() => {
    handler.current = onClick;
    dragging.current = gizmo;
    moved.current = onMove;
  });
  useEffect(() => {
    if (!viewport) return;
    return takeClicks(
      services,
      viewport,
      (item, e) => handler.current(item, e),
      () => dragging.current?.() ?? false,
      (e) => moved.current?.(e),
    );
  }, [services, viewport]);
}

/**
 * Features, bodies and standard planes clicked in the browser or the
 * timeline go to `onClick` instead of selecting, while the panel is open.
 */
export function useTreeClicks(services: AppServices, onClick: (item: SelectionItem) => void): void {
  const { app } = services;
  const handler = useRef(onClick);
  useLayoutEffect(() => {
    handler.current = onClick;
  });
  useEffect(() => {
    const take = (item: SelectionItem) => handler.current(item);
    app.setState({ treeClicks: take });
    return () => {
      if (app.getState().treeClicks === take) app.setState({ treeClicks: null });
    };
  }, [app]);
}

/** The keys of the shown display that stored references land on. */
export async function keysOf(
  services: AppServices,
  part: string,
  references: readonly Json[],
): Promise<SelectionItem[]> {
  const out: SelectionItem[] = [];
  for (const ref of references) {
    if ('standard' in ref) {
      const name = (ref.standard as { name?: string }).name;
      if (name === 'xy' || name === 'xz' || name === 'yz') out.push({ standard: name });
      else if (name === 'x' || name === 'y' || name === 'z' || name === 'origin') out.push({ datum: name });
      continue;
    }
    const entity = ref.entity as EntityRecord | undefined;
    if (entity) {
      const r = await services.client.resolve(entity, { part });
      if (r.outcome === 'same') for (const key of r.keys) out.push({ key });
      continue;
    }
    const feature = ((ref.object as Json | undefined)?.feature as Json | undefined)?.id;
    if (typeof feature === 'string') out.push({ feature });
  }
  return out;
}

/**
 * Shows the panel's references selected in whatever the viewport shows:
 * they are resolved again on each new display, and the selection is
 * cleared when the panel closes.
 */
export function useShownPicks(services: AppServices, part: string | null, references: readonly Json[]): void {
  const { display: displayStore, selection } = services;
  const key = JSON.stringify(references);
  const refs = useRef(references);
  useLayoutEffect(() => {
    refs.current = references;
  });
  useEffect(() => {
    if (!part) return;
    let run = 0;
    const show = async () => {
      const mine = ++run;
      const generation = displayStore.getState().display?.generation ?? null;
      // Always after a turn, so a panel's own opening effects still read what was selected when it opened.
      const items = await (refs.current.length === 0
        ? Promise.resolve([])
        : keysOf(services, part, refs.current).catch(() => []));
      if (mine !== run || (displayStore.getState().display?.generation ?? null) !== generation) return;
      selection.setState({ items, generation });
    };
    void show();
    const off = displayStore.subscribe((s, prev) => {
      if (s.display !== prev.display) void show();
    });
    return () => {
      run++;
      off();
    };
  }, [part, key, services, displayStore, selection]);
  useEffect(() => () => selection.setState({ items: [], hover: null }), [selection]);
}

/**
 * Draws those of a panel's picks that the shown display lacks (its preview
 * replaced them: an edge a fillet rounds, a face a shell opens, a body a
 * combine consumes) where they lie in the state the feature starts from,
 * over the preview. Returns what a viewport click lands on among them: its
 * reference, or null. A panel asks it first when a click comes in, so that
 * clicking a picked one again drops it, preview or not.
 */
export function usePickOutlines(
  services: AppServices,
  viewport: Viewport | null,
  target: FeatureTarget | null,
  references: readonly Json[],
): (e: ViewportPointer) => Json | null {
  const { client, display: displayStore } = services;
  const key = JSON.stringify(references);
  const refs = useRef(references);
  useLayoutEffect(() => {
    refs.current = references;
  });
  const drawn = useRef<{ objects: THREE.Object3D[]; references: Json[] }>({ objects: [], references: [] });
  useEffect(() => {
    const outlinesBefore = client.outlinesBefore?.bind(client);
    if (!viewport || !target || !outlinesBefore) return;
    let run = 0;
    const clear = () => {
      if (drawn.current.objects.length === 0) return;
      disposeOutlines(drawn.current.objects);
      drawn.current = { objects: [], references: [] };
      viewport.requestRender();
    };
    const show = async () => {
      const mine = ++run;
      const generation = displayStore.getState().display?.generation ?? null;
      const lacking: { reference: Json; record: EntityRecord }[] = [];
      for (const reference of refs.current) {
        const record = recordOf(reference);
        if (!record) continue;
        const found = await client.resolve(record, { part: target.part }).catch(() => null);
        if (found?.outcome !== 'same') lacking.push({ reference, record });
      }
      const outlines =
        lacking.length === 0
          ? []
          : await outlinesBefore(
              { part: target.part, feature: target.feature },
              lacking.map((l) => l.record),
            ).catch(() => []);
      if (mine !== run || (displayStore.getState().display?.generation ?? null) !== generation) return;
      clear();
      const objects = outlineObjects(outlines);
      for (const o of objects) viewport.getScene().add(o);
      drawn.current = { objects, references: lacking.map((l) => l.reference) };
      if (objects.length > 0) viewport.requestRender();
    };
    void show();
    const off = displayStore.subscribe((s, prev) => {
      if (s.display !== prev.display) void show();
    });
    return () => {
      run++;
      off();
      clear();
    };
  }, [viewport, target, key, client, displayStore]);
  return useCallback(
    (e: ViewportPointer) => {
      if (!viewport || drawn.current.objects.length === 0) return null;
      const ray = rayThrough(viewport.getCanvas(), viewport.getCamera(), e.clientX, e.clientY);
      if (!ray) return null;
      viewport.getScene().updateMatrixWorld();
      const at = outlineHit(ray, drawn.current.objects, viewport.model.root, viewport.pixelSize());
      return at === null ? null : (drawn.current.references[at] ?? null);
    },
    [viewport],
  );
}

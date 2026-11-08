/**
 * The modelling commands as the ribbon, the browser and the timeline start
 * them: a sketch on a picked plane, then into sketch mode on it; an
 * extrude panel on a sketch's profiles, or on an existing extrude.
 */
import { consoleLog } from '../console';
import { enqueueToast } from '../../components/toastStore.ts';
import { bodiesOf, findFeature, partOf, partOfFeature } from '../features';
import { activePartOf, inContextOf, shownAssembly } from '../assembly/focus';
import { ASM_FEATURES, assemblyFeatureOf } from '../assembly/asmFeatures';
import { open } from '../assembly/commands';
import { isFrozen } from './freeze';
import { clearSelection, type SelectionItem } from '../selection';
import type { AppServices } from '../services';
import { isPickedRegion, type PickedReference } from '../picking';
import { regionAt, sketchesOf } from './profiles';
import { PANEL_OF_TYPE } from './panelTypes';
import { addSketch } from './sketch';

export type Outcome = { ok: true } | { ok: false; message: string };

function warn(title: string, message: string, source: string): Outcome {
  consoleLog('warn', message, source);
  enqueueToast({ tone: 'warning', title, message });
  return { ok: false, message };
}

/** The part new features go into: the part the window works on (the shown root, or a part opened or edited in context). */
export function activePart(services: AppServices): string | null {
  return activePartOf(services.editor.document, services.app.getState().focus);
}

/** Opens `part` when the window works on another part (or on an assembly), so what is started there works in it. */
export function workIn(services: AppServices, part: string): void {
  if (activePart(services) !== part) open(services, { part });
}

/** Waits until the newest document is shown. */
export async function settled(services: AppServices): Promise<void> {
  do await services.scheduler.whenIdle();
  while (services.scheduler.busy);
}

/**
 * Whether a selection item can carry a sketch: a standard plane, a
 * construction plane, or a flat face. Null when it can, otherwise why not.
 */
export async function planeProblem(services: AppServices, item: SelectionItem): Promise<string | null> {
  if ('standard' in item) return null;
  if ('feature' in item || 'datum' in item) return 'Pick a plane or a flat face';
  // Another part's face carries a sketch only while the part is edited in the assembly's context (12.4).
  if (item.instance && !inContextOf(services.editor.document, services.app.getState().focus))
    return 'Sketch on a face of the part itself';
  const info = services.display.getState().display?.entities[item.key];
  if (info?.kind === 'plane') return null;
  if (info?.kind !== 'face') return 'Pick a plane or a flat face';
  const props = await services.client.properties(item.key);
  return props?.measures.surface === 'plane' ? null : 'This face is not flat';
}

/** What the sketch plane picker's banner says of the item under the pointer, or null for nothing to say. */
export async function hoverNote(services: AppServices, item: SelectionItem | null): Promise<string | null> {
  if (!item || 'feature' in item || 'datum' in item) return null;
  if ('standard' in item) return `${item.standard.toUpperCase()} highlighted`;
  const kind = services.display.getState().display?.entities[item.key]?.kind;
  if (kind === 'plane') return 'construction plane highlighted';
  if (kind !== 'face') return null;
  const why = await planeProblem(services, item);
  return why === null ? 'face highlighted' : `${why.charAt(0).toLowerCase()}${why.slice(1)}`;
}

/** Adds a sketch on `item` (already checked by `planeProblem`) and enters sketch mode on it; `onAdded` hears the new sketch's id. */
export async function sketchOn(
  services: AppServices,
  item: SelectionItem,
  onAdded?: (feature: string) => void,
): Promise<Outcome> {
  const part = activePart(services);
  if (!part) return warn('Sketch', 'Sketches go in a part; open the part to sketch in it.', 'sketch');
  const picked = await services.pick(item);
  if (!picked || isPickedRegion(picked))
    return warn('Sketch', 'That plane is no longer shown; pick it again.', 'sketch');
  const added = addSketch(services.editor, part, picked as PickedReference);
  if (!added.ok) return warn('Sketch', added.message, 'sketch');
  onAdded?.(added.feature);
  clearSelection(services.selection);
  services.app.setState({ panel: null, picking: null });
  await settled(services);
  // The sketch may have gone again (an undo) while it was evaluated.
  if (!findFeature(services.editor.document, added.feature)) return { ok: true };
  services.app.setState({ mode: { kind: 'sketch', part, feature: added.feature } });
  consoleLog(
    'info',
    `Created sketch on ${'standard' in item ? item.standard.toUpperCase() : 'the picked plane'}: ${String(findFeature(services.editor.document, added.feature)?.name ?? 'Sketch')}`,
    'sketch',
  );
  return { ok: true };
}

/**
 * The Sketch tool: with one plane or flat face selected, a sketch on it at
 * once; otherwise the plane picker. Clicking it while picking cancels.
 */
export async function startSketch(services: AppServices): Promise<void> {
  const { app, selection } = services;
  if (app.getState().panel?.kind === 'sketchPlane') {
    app.setState({ panel: null });
    return;
  }
  if (app.getState().mode.kind === 'sketch') return;
  const items = selection.getState().items;
  if (items.length === 1 && (await planeProblem(services, items[0] as SelectionItem)) === null) {
    await sketchOn(services, items[0] as SelectionItem);
    return;
  }
  app.setState({ panel: { kind: 'sketchPlane' } });
}

/** The sketches of a part, in timeline order up to its rollback, that show at least one region. */
function sketchesWithRegions(services: AppServices, part: string): string[] {
  const display = services.display.getState().display;
  const shown = new Map(sketchesOf(display, part).map((s) => [s.feature, s.regions.length]));
  const timeline = partOf(services.editor.document, part)?.timeline;
  return (Array.isArray(timeline) ? (timeline as { id: string; type: string }[]) : [])
    .filter((f) => f.type === 'core.sketch' && (shown.get(f.id) ?? 0) > 0)
    .map((f) => f.id);
}

/**
 * Starts a tool that takes sketch profiles (Extrude, Revolve): on the
 * sketch being edited (which finishes first), else the selected sketch
 * or the sketch of selected regions, else the last sketch with a closed
 * region. With `guess` false (Sweep, Loft) there is no last-sketch guess:
 * with nothing chosen the panel opens with no profile.
 */
export function startProfileFeature(
  services: AppServices,
  kind: string,
  label: string,
  from?: string,
  regions?: readonly number[],
  guess = true,
): Outcome {
  const { app, selection, editor } = services;
  // A sketch of another part is used in its own part.
  const owner = from ? partOfFeature(editor.document, from) : null;
  if (owner) workIn(services, owner);
  const part = activePart(services);
  if (!part) return warn(label, `${label} features go in a part; open the part to add one.`, kind);
  const mode = app.getState().mode;
  let sketch = from;
  if (!sketch && mode.kind === 'sketch') sketch = mode.feature;
  if (!sketch) {
    const display = services.display.getState().display;
    for (const item of selection.getState().items) {
      if ('feature' in item && findFeature(editor.document, item.feature)?.type === 'core.sketch')
        sketch = item.feature;
      else if ('key' in item && !item.instance) sketch = regionAt(display, part, item.key)?.sketch.feature;
      if (sketch) break;
    }
  }
  if (guess) sketch ??= sketchesWithRegions(services, part).at(-1);
  if (!sketch && guess)
    return warn(label, `No sketch available to ${label.toLowerCase()}. Create a sketch first.`, kind);
  if (mode.kind === 'sketch') app.setState({ mode: { kind: 'model' } });
  app.setState({
    panel: { kind, ...(sketch ? { from: sketch } : {}), ...(regions && regions.length > 0 ? { regions } : {}) },
  });
  return { ok: true };
}

/** The Extrude tool; `regions` are the display's region keys it starts with. */
export function startExtrude(services: AppServices, from?: string, regions?: readonly number[]): Outcome {
  return startProfileFeature(services, 'extrude', 'Extrude', from, regions);
}

/**
 * Opens a feature panel that needs no sketch. `needsBody` refuses it in a
 * part with no body yet; while the document is being evaluated the display
 * may not show its bodies yet, so the panel opens.
 */
export function startPanel(
  services: AppServices,
  kind: string,
  label: string,
  o: { needsBody?: boolean; from?: string } = {},
): Outcome {
  const { app } = services;
  const part = activePart(services);
  if (!part) return warn(label, `${label} goes in a part; open the part to add one.`, kind);
  const shown = services.display.getState();
  if (o.needsBody && !shown.evaluating && bodiesOf(shown.display, part).length === 0) {
    return warn(label, `${label} needs an existing body. Create one first.`, kind);
  }
  if (app.getState().mode.kind === 'sketch') app.setState({ mode: { kind: 'model' } });
  app.setState({ panel: { kind, ...(o.from ? { from: o.from } : {}) } });
  return { ok: true };
}

/** Opens the panel of an existing feature, or the sketch editor for a sketch. */
export function editFeature(services: AppServices, feature: string): Outcome {
  const doc = services.editor.document;
  const inAssembly = assemblyFeatureOf(doc, feature);
  if (inAssembly) {
    // An assembly feature is edited with its assembly shown.
    const kind = ASM_FEATURES[inAssembly.row.type as keyof typeof ASM_FEATURES]?.panel;
    if (!kind) return { ok: false, message: `${String(inAssembly.row.name)} is not edited in a panel` };
    if (shownAssembly(doc, services.app.getState().focus) !== inAssembly.assembly)
      open(services, { assembly: inAssembly.assembly });
    if (services.app.getState().mode.kind === 'sketch') services.app.setState({ mode: { kind: 'model' } });
    services.app.setState({ panel: { kind, feature } });
    return { ok: true };
  }
  const row = findFeature(doc, feature);
  const part = partOfFeature(doc, feature);
  if (!row || !part) return { ok: false, message: 'There is no such feature' };
  if (isFrozen(row)) return warn('Edit', `${String(row.name)} is frozen; unfreeze it to edit it`, 'freeze');
  // A feature is edited in its own part.
  if (row.type === 'core.sketch') {
    workIn(services, part);
    clearSelection(services.selection);
    services.app.setState({ mode: { kind: 'sketch', part, feature }, panel: null });
    return { ok: true };
  }
  const kind = PANEL_OF_TYPE[String(row.type)];
  if (kind) {
    workIn(services, part);
    if (services.app.getState().mode.kind === 'sketch') services.app.setState({ mode: { kind: 'model' } });
    services.app.setState({ panel: { kind, feature } });
    return { ok: true };
  }
  return { ok: false, message: `${String(row.name)} is not edited in a panel` };
}

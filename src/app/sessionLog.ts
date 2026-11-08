/**
 * The session's own lines in the console: the app starting, the active
 * part changing, sketch mode ending, and each extrude written or edited
 * (undo and redo log nothing, since they write no new extrude).
 */
import type { Doc, Json, StoreChange } from '@tweakcad/editor';
import type { AppState } from './appState';
import { consoleLog } from './console';
import { findFeature, partOf, partsOf } from './features';
import { activePartOf } from './assembly/focus';
import { readExtrude } from './modeling/extrude';
import type { AppServices } from './services';

/** Every extrude of the document, by id: its part and its inputs as text, to tell a change. */
function extrudesOf(doc: Doc): Map<string, { part: string; inputs: string }> {
  const out = new Map<string, { part: string; inputs: string }>();
  const walk = (part: string, features: unknown) => {
    if (!Array.isArray(features)) return;
    for (const f of features as Json[]) {
      if (f.type === 'core.extrude') out.set(String(f.id), { part, inputs: JSON.stringify(f.inputs) });
      walk(part, f.children);
    }
  };
  for (const p of partsOf(doc)) walk(String(p.id), p.timeline);
  return out;
}

const EXTENTS: Record<string, string> = {
  distance: 'distance',
  throughAll: 'through all',
  toFace: 'to face',
  toBody: 'to body',
  upToNext: 'to next',
  upToLast: 'to last',
};

/** An extrude as one line: how far, which way, from where, and how many profiles. */
export function describeExtrude(doc: Doc, part: string, feature: string): string {
  const name = String(findFeature(doc, feature)?.name ?? 'Extrude');
  const read = readExtrude(doc, part, feature);
  if (!read) return name;
  const { form, profiles } = read;
  const side = (extent: string, distance: string) =>
    extent === 'distance' ? `distance ${distance}` : (EXTENTS[extent] ?? extent);
  const how =
    form.sides === 'symmetric'
      ? `symmetric ${form.distance}`
      : form.sides === 'two' && form.side2
        ? `two sides, ${side(form.extent, form.distance)} and ${side(form.side2.extent, form.side2.distance)}`
        : side(form.extent, form.distance);
  const n = profiles.length;
  return `${name}: ${how} ${form.reversed ? 'reversed' : 'normal'}, offset ${form.startOffset ?? '0 mm'} (${n} profile${n === 1 ? '' : 's'})`;
}

/** The lines one document change logs: an extrude added or edited. */
export function extrudeLines(before: Doc, after: Doc): string[] {
  const was = extrudesOf(before);
  const lines: string[] = [];
  for (const [id, now] of extrudesOf(after)) {
    const old = was.get(id);
    if (!old) lines.push(`Created extrude feature: ${describeExtrude(after, now.part, id)}`);
    else if (old.inputs !== now.inputs) lines.push(`Updated extrude feature: ${describeExtrude(after, now.part, id)}`);
  }
  return lines;
}

/** Logs the session's lines for `services` until the returned function is called. */
export function installSessionLog(services: AppServices): () => void {
  const { app, editor } = services;
  consoleLog('info', 'CAD application initialized', 'system');
  let doc = editor.document;
  let active = activePartOf(doc, app.getState().focus);
  const offEditor = editor.store.subscribe((change: StoreChange) => {
    const before = doc;
    doc = change.document;
    if (change.cause === 'edit') for (const line of extrudeLines(before, doc)) consoleLog('success', line, 'extrude');
    // Another document shown (opened, a revision previewed, the live one back) changes the active part without a word.
    if (change.cause === 'replace' || change.cause === 'readOnly' || change.cause === 'live')
      active = activePartOf(doc, app.getState().focus);
  });
  const offApp = app.subscribe((s: AppState, prev: AppState) => {
    if (prev.mode.kind === 'sketch' && s.mode.kind !== 'sketch') consoleLog('info', 'Sketch mode exited', 'sketch');
    if (s.focus === prev.focus) return;
    const next = activePartOf(editor.document, s.focus);
    if (next !== null && next !== active)
      consoleLog('info', `Active part: ${String(partOf(editor.document, next)?.name ?? next)}`, 'command');
    active = next;
  });
  return () => {
    offEditor();
    offApp();
  };
}

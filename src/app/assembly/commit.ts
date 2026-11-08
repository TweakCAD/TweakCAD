/**
 * Writing an assembly edit: the edit is evaluated first as a preview, and
 * the pose its solve gives (12.2: instance placements and joint states) is
 * written back with it, as one undo step. So the stored pose is always the
 * one the document's joints solve to, and undoing the edit puts the
 * instances back where they were.
 */
import { CommandError, Editor, formatRefusals, type Doc, type EditorCommand } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import type { AppServices } from '../services';
import { solvedCommands } from './assembly';

export type Written = { ok: true } | { ok: false; message: string };

/** Runs `commands` in order on `editor` as one undo step; throws `CommandError` at the first refusal. */
function runAll(editor: Editor, commands: readonly EditorCommand[]): void {
  for (const c of commands) {
    const r = editor.dispatch(c);
    if (!r.ok) throw new CommandError(r.error.code, r.error.message);
  }
}

/** The document `commands` make from `doc`, unchecked, or why they cannot be run. */
export function candidateOf(
  doc: Doc,
  commands: readonly EditorCommand[],
): { ok: true; doc: Doc } | { ok: false; message: string } {
  const scratch = new Editor(doc, { validate: () => [] });
  try {
    scratch.transaction('Preview', () => runAll(scratch, commands));
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const refusals = formatRefusals(scratch.document);
  if (refusals.length > 0) return { ok: false, message: (refusals[0] as { message: string }).message };
  return { ok: true, doc: scratch.document };
}

/** Waits until the newest requested document is shown, and returns its display. */
export async function shownDisplay(services: AppServices): Promise<Display | null> {
  do await services.scheduler.whenIdle();
  while (services.scheduler.busy);
  return services.display.getState().display;
}

/** What `commitSolved` returns when it was called off while the solve was waiting. */
export const CANCELLED = 'Cancelled';

/**
 * Writes `commands` as one undo step labelled `label`, with the pose they
 * solve to written back. The candidate document is evaluated as a preview
 * first, and the pose is read from that preview's display only; the
 * preview is cleared again afterwards. `live` is asked once the solve is
 * shown: false (the panel that asked was closed) writes nothing.
 */
export async function commitSolved(
  services: AppServices,
  label: string,
  commands: readonly EditorCommand[],
  live: () => boolean = () => true,
): Promise<Written> {
  const { editor, scheduler } = services;
  const candidate = candidateOf(editor.document, commands);
  if (!candidate.ok) return candidate;
  const assemblies = Array.isArray(candidate.doc.assemblies) ? candidate.doc.assemblies.length : 0;
  let solved: EditorCommand[] = [];
  try {
    if (assemblies > 0) {
      scheduler.setPreview(candidate.doc);
      const display = await shownDisplay(services);
      if (!live()) return { ok: false, message: CANCELLED };
      // Another preview set while this one waited: its display is not this candidate's.
      if (scheduler.previewDocument !== candidate.doc)
        return { ok: false, message: 'The model changed before it was solved; try again' };
      const state = services.display.getState();
      solved = display && state.preview && state.error === null ? solvedCommands(candidate.doc, display) : [];
    }
    editor.transaction(label, () => runAll(editor, [...commands, ...solved]));
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    // Only its own preview: another one set meanwhile belongs to whoever set it.
    if (scheduler.previewDocument === candidate.doc) scheduler.setPreview(null);
  }
}

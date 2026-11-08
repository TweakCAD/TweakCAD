/**
 * Captured contexts (12.4) in the app: a part edited in an assembly's
 * context references the other instances' geometry through its context,
 * which captures each instance it points into; a context out of date says
 * which and why, and is updated by the user (`manual`) or after each edit
 * (`automatic`).
 *
 * Captures run in the worker, apart from the shown evaluation. A context's
 * first capture of an instance is written as the reference into it is made,
 * so the feature that uses the reference is valid when it is written. An
 * automatic update joins the undo step of the edit it follows, so undoing
 * the edit takes the update back with it.
 */
import { canonicalize, isPlainObject, nameHash } from '@tweakcad/format';
import type { Doc, EditorCommand, Json } from '@tweakcad/editor';
import type { ContextsUpdate, Display } from '@tweakcad/worker/src/v2/service/types';
import { enqueueToast } from '../../components/toastStore.ts';
import { consoleLog } from '../console';
import { formatTime } from '../document';
import { partOf, partsOf } from '../features';
import { pickReference, type PickResult } from '../picking';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import { assemblyOf, instanceLabel, instanceOfPath } from './assembly';
import { candidateOf, type Written } from './commit';
import { assemblyDisplay, inContextOf, instanceIndex } from './focus';

export type Policy = 'manual' | 'automatic';

export function contextsOf(doc: Doc, part: string): Json[] {
  const row = partOf(doc, part);
  return row && Array.isArray(row.contexts) ? (row.contexts as Json[]) : [];
}

/** A part's context for an assembly at an instance path, if it has one. */
export function contextFor(doc: Doc, part: string, assembly: string, at: unknown): Json | undefined {
  const key = canonicalize(at);
  return contextsOf(doc, part).find(
    (c) => isPlainObject(c.assembly) && c.assembly.id === assembly && canonicalize(c.at) === key,
  );
}

/** The instance paths a context holds a capture of. */
export function capturedPaths(context: Json | undefined): string[] {
  const entries =
    isPlainObject(context?.captured) && Array.isArray(context.captured.set) ? (context.captured.set as Json[]) : [];
  return entries.map((e) => canonicalize(e.instance));
}

/** A new, empty context row; its first capture fills it. */
export function contextRow(id: string, assembly: string, at: Json, policy: Policy = 'automatic'): Json {
  return {
    id,
    assembly: { id: assembly },
    at,
    captured: { set: [] },
    source: nameHash({}),
    policy,
    capturedAt: formatTime(new Date()),
  };
}

/**
 * The commands that write re-captured contexts: each context's captured
 * set, source and time, with the stored shapes' asset rows and the names
 * they bring on the first.
 */
export function updateCommands(update: ContextsUpdate, label?: string): EditorCommand[] {
  return update.contexts.map((c, i): EditorCommand => ({
    type: 'editContext',
    context: c.context,
    set: { captured: c.row.captured as Json, source: c.row.source as Json, capturedAt: c.row.capturedAt as Json },
    ...(i === 0 ? { assets: update.assets as Json, names: update.names as unknown as Json } : {}),
    ...(label ? { label } : {}),
  }));
}

function client(services: AppServices) {
  const update = services.client.updateContexts?.bind(services.client);
  if (!update) throw new Error('this worker service cannot capture contexts');
  return update;
}

/**
 * Makes sure the context of the part edited in context holds a capture of
 * the instance at `path`, writing the context (and its capture) as its own
 * undo step when it does not. Returns the context's id.
 */
export async function ensureCaptured(
  services: AppServices,
  part: string,
  assembly: string,
  at: Json,
  path: Json,
  label: string,
): Promise<string> {
  const { editor } = services;
  const doc = editor.document;
  const existing = contextFor(doc, part, assembly, at);
  if (existing && capturedPaths(existing).includes(canonicalize(path))) return existing.id as string;
  const row = existing ?? contextRow(editor.newId('ctx'), assembly, at);
  const id = row.id as string;
  let base: Doc = doc;
  if (!existing) {
    const added = candidateOf(doc, [{ type: 'addContext', part, context: row }]);
    if (!added.ok) throw new Error(added.message);
    base = added.doc;
  }
  const update = await client(services)(base, [{ part, context: id, include: [path] }], {
    capturedAt: formatTime(new Date()),
  });
  const captured = update.contexts[0]?.row;
  if (!update.settled || !captured) throw new Error('the instance could not be captured');
  editor.transaction(label, () => {
    if (!existing) {
      const r = editor.dispatch({
        type: 'addContext',
        part,
        context: captured,
        assets: update.assets as Json,
        names: update.names as unknown as Json,
      });
      if (!r.ok) throw new Error(r.error.message);
      return;
    }
    for (const c of updateCommands(update)) {
      const r = editor.dispatch(c);
      if (!r.ok) throw new Error(r.error.message);
    }
  });
  return id;
}

/** Whether `path` lies at or under `at`: the part's own instance, which its context never captures. */
function within(path: unknown, at: unknown): boolean {
  const steps = (p: unknown) =>
    isPlainObject(p) && Array.isArray(p.path) ? (p.path as unknown[]).map((s) => canonicalize(s)) : [];
  const a = steps(at);
  const p = steps(path);
  return a.length > 0 && a.length <= p.length && a.every((s, i) => s === p[i]);
}

/**
 * What a pick becomes while a part is edited in an assembly's context: on
 * the part's own instance, a reference in the part; on another instance,
 * an in-context reference through the part's context (9.1), its snapshot
 * written in the edited part's frame (9.7), the context capturing that
 * instance first. Outside in-context editing, the pick as it comes.
 */
export async function inContextPick(
  services: AppServices,
  item: SelectionItem,
  options: { before?: string } = {},
): Promise<PickResult | null> {
  const { editor, app } = services;
  const ctx = inContextOf(editor.document, app.getState().focus);
  if (!ctx || !('key' in item) || !item.instance || item.instance.assembly !== ctx.assembly)
    return pickReference(services.client, item, options);
  const shown = assemblyDisplay(services.display.getState().display, ctx.assembly);
  const inst = shown?.instances[item.instance.index];
  if (!inst) return null;
  if (item.instance.index === instanceIndex(shown, ctx.at))
    return pickReference(services.client, { key: item.key }, options);
  if (within(inst.path, ctx.at)) return null;
  const picked = await pickReference(services.client, item, { frameOf: ctx.at });
  if (!picked || 'region' in picked) return null;
  const asm = assemblyOf(editor.document, ctx.assembly);
  const id = instanceOfPath(inst.path);
  const label = `Capture ${asm && id ? instanceLabel(editor.document, asm, id) : 'instance'}`;
  try {
    const context = await ensureCaptured(services, ctx.part, ctx.assembly, ctx.at, inst.path as Json, label);
    return {
      reference: { inContext: { context: { id: context }, instance: inst.path as Json, ref: picked.reference } },
      names: picked.names,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    consoleLog('warn', `In-context pick: ${message}`, 'assembly');
    enqueueToast({ tone: 'warning', title: 'In-context pick', message });
    return null;
  }
}

/** Re-captures one context from the current assembly, as its own undo step (the Update of a `manual` context, or any on request). */
export async function updateContext(services: AppServices, part: string, context: string): Promise<Written> {
  const { editor } = services;
  const name = String(partOf(editor.document, part)?.name ?? 'part');
  try {
    const update = await client(services)(editor.document, [{ part, context }], { capturedAt: formatTime(new Date()) });
    if (!update.settled) return { ok: false, message: 'The context could not be captured' };
    editor.transaction(`Update ${name} context`, () => {
      for (const c of updateCommands(update)) {
        const r = editor.dispatch(c);
        if (!r.ok) throw new Error(r.error.message);
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Sets a context's update policy. */
export function setPolicy(services: AppServices, context: string, policy: Policy): Written {
  const r = services.editor.dispatch({
    type: 'editContext',
    context,
    set: { policy },
    label: policy === 'automatic' ? 'Update context automatically' : 'Update context by hand',
  });
  return r.ok ? { ok: true } : { ok: false, message: r.error.message };
}

/** The out-of-date notes of a display, by context, with the context's part and policy. */
export function outOfDate(
  doc: Doc,
  display: Display | null,
): { part: string; partName: string; context: string; reasons: string[]; policy: Policy }[] {
  const byContext = new Map<
    string,
    { part: string; partName: string; context: string; reasons: string[]; policy: Policy }
  >();
  for (const o of display?.outOfDate ?? []) {
    const row = contextsOf(doc, o.part).find((c) => c.id === o.context);
    if (!row) continue;
    const entry = byContext.get(o.context) ?? {
      part: o.part,
      partName: String(partOf(doc, o.part)?.name ?? 'Part'),
      context: o.context,
      reasons: [],
      policy: row.policy === 'automatic' ? 'automatic' : 'manual',
    };
    if (!entry.reasons.includes(o.reason)) entry.reasons.push(o.reason);
    byContext.set(o.context, entry);
  }
  return [...byContext.values()];
}

/**
 * Automatic updates (12.4): after an edit, every `automatic` context the
 * shown evaluation reports out of date is re-captured in synchronous passes
 * (at most the number of parts plus one) and written into the edit's own
 * undo step. Passes that do not settle leave the contexts as they were and
 * say so. Returns the function that stops following.
 */
export function followContextUpdates(services: AppServices): () => void {
  const { editor, display } = services;
  let lastCause: string | undefined;
  let amended = -1;
  let running = false;
  const offStore = editor.store.subscribe((change) => {
    lastCause = change.cause;
  });
  const run = async (shown: Display, revision: number) => {
    const doc = editor.document;
    const wanted = outOfDate(doc, shown).filter((o) => o.policy === 'automatic');
    if (wanted.length === 0 || !services.client.updateContexts) return;
    running = true;
    try {
      const update = await services.client.updateContexts(
        doc,
        wanted.map((w) => ({ part: w.part, context: w.context })),
        { passes: partsOf(doc).length + 1, capturedAt: formatTime(new Date()) },
      );
      // An edit made meanwhile gets its own update when its display comes.
      if (editor.store.revision !== revision || editor.store.inTransaction) return;
      if (!update.settled) {
        const names = wanted.map((w) => w.partName).join(', ');
        consoleLog('warn', `The context of ${names} did not settle; it was left as it was`, 'assembly');
        enqueueToast({
          tone: 'warning',
          title: 'Context did not settle',
          message: `The context of ${names} was left as it was.`,
        });
        amended = revision;
        return;
      }
      editor.amend('Update contexts', () => {
        for (const c of updateCommands(update)) {
          const r = editor.dispatch(c);
          if (!r.ok) throw new Error(r.error.message);
        }
      });
      amended = editor.store.revision;
    } catch (e) {
      consoleLog('warn', `Context update failed: ${e instanceof Error ? e.message : String(e)}`, 'assembly');
      amended = revision;
    } finally {
      running = false;
    }
  };
  const offDisplay = display.subscribe((s, prev) => {
    if (!s.display || s.display === prev.display || s.preview || running) return;
    const revision = editor.store.revision;
    if (s.revision !== revision || lastCause !== 'edit' || amended === revision) return;
    void run(s.display, revision);
  });
  return () => {
    offStore();
    offDisplay();
  };
}

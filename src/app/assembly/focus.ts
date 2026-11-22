/**
 * What the window works on: the document's root, or a part or assembly the
 * user opened, or a part edited in an assembly's context. The shown root is
 * what the viewport draws; the active part is where new features go.
 */
import { canonicalize, isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import type { AssemblyDisplay, Display } from '@tweakcad/worker/src/v2/service/types';
import type { Focus } from '../appState';
import { partOf, partsOf, shownRoot } from '../features';
import type { ShownRoot } from '../viewport/ModelScene';

const assemblyOf = (doc: Doc, id: string): Json | undefined =>
  (Array.isArray(doc.assemblies) ? (doc.assemblies as Json[]) : []).find((a) => a.id === id);

/** The focus, or null when what it names is gone (an undo, a delete). */
export function liveFocus(doc: Doc, focus: Focus | null): Focus | null {
  if (!focus) return null;
  if ('assembly' in focus) return assemblyOf(doc, focus.assembly) ? focus : null;
  if (!partOf(doc, focus.part)) return null;
  if (focus.context && !assemblyOf(doc, focus.context.assembly)) return { part: focus.part };
  return focus;
}

/** What the viewport draws: the focused part or assembly (the assembly, for a part edited in context), else the root. */
export function shownOf(doc: Doc, focus: Focus | null): ShownRoot {
  const f = liveFocus(doc, focus);
  if (!f) return shownRoot(doc);
  if ('assembly' in f) return { assembly: f.assembly };
  return f.context ? { assembly: f.context.assembly } : { part: f.part };
}

/**
 * Whether the window shows the whole design of a document whose root is a
 * part: with no focus (the root part active), or with a part made active in
 * the design.
 */
export function inDesign(doc: Doc, focus: Focus | null): boolean {
  const root = shownRoot(doc);
  if (!root || !('part' in root)) return false;
  const f = liveFocus(doc, focus);
  return f === null || ('part' in f && f.design === true);
}

/**
 * The parts drawn beside the shown part in the whole design of a document
 * whose root is a part: every other part, faded while a part is made active.
 * Null outside the design, or with no other part.
 */
export function partsBeside(doc: Doc, focus: Focus | null): { parts: string[]; faded: boolean } | null {
  if (!inDesign(doc, focus)) return null;
  const shown = activePartOf(doc, focus);
  const parts = partsOf(doc)
    .map((p) => String(p.id))
    .filter((p) => p !== shown);
  return parts.length > 0 ? { parts, faded: liveFocus(doc, focus) !== null } : null;
}

/** The part shown on its own (opened, not made active in the design or edited in context), or null. */
export function openedPartOf(doc: Doc, focus: Focus | null): string | null {
  const f = liveFocus(doc, focus);
  return f && 'part' in f && !f.context && !f.design ? f.part : null;
}

/** The part new features go into: the focused part, else the root when it is a part. */
export function activePartOf(doc: Doc, focus: Focus | null): string | null {
  const f = liveFocus(doc, focus);
  if (f && 'part' in f) return f.part;
  if (f) return null;
  const root = shownRoot(doc);
  return root && 'part' in root ? root.part : null;
}

/** The assembly the window shows, or null when it shows a part. */
export function shownAssembly(doc: Doc, focus: Focus | null): string | null {
  const shown = shownOf(doc, focus);
  return shown && 'assembly' in shown ? shown.assembly : null;
}

/** The part edited in an assembly's context, with that assembly and the instance path; null otherwise. */
export function inContextOf(doc: Doc, focus: Focus | null): { part: string; assembly: string; at: Json } | null {
  const f = liveFocus(doc, focus);
  if (!f || !('part' in f) || !f.context) return null;
  return { part: f.part, assembly: f.context.assembly, at: f.context.at as Json };
}

/** The index in an assembly's display of the instance at `path`, or -1. */
export function instanceIndex(assembly: AssemblyDisplay | undefined, path: unknown): number {
  if (!assembly || !isPlainObject(path)) return -1;
  const key = canonicalize(path);
  return assembly.instances.findIndex((i) => canonicalize(i.path) === key);
}

/** The display of an assembly. */
export function assemblyDisplay(display: Display | null, assembly: string | null): AssemblyDisplay | undefined {
  return assembly ? display?.assemblies.find((a) => a.id === assembly) : undefined;
}

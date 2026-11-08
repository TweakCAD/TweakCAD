/**
 * The one way references to model entities resolve (9.1, 9.6): an `entity`
 * record in the part before the feature, an `inContext` reference in its
 * captured context (12.4), and a `selection` as its set's members, each
 * resolved as if written in its place.
 */
import { canonicalize, resolve, type EntityRecord, type NamedEntity, type NamedState } from '@tweakcad/format';
import { FeaturePause, type BuildContext, type Json } from './context';
import { contextOf, partRowOf } from './contexts';
import type { Rigid } from './rigid';

type Where = Pick<BuildContext, 'ev' | 'part'>;

/** An `inContext` reference, opened: where its inner reference is read, and its instance's placement. */
export interface InContext {
  w: Where;
  ref: Json;
  placement: Rigid;
}

/** Opens an `inContext` reference; undefined for every other form. */
export function inContextOf(w: Where, ref: Json): InContext | undefined {
  const ic = ref.inContext as Json | undefined;
  if (!ic) return undefined;
  const context = contextOf(w, (ic.context as Json).id as string);
  const placement = context.instances.get(canonicalize(ic.instance));
  if (!placement) throw new FeaturePause('the context did not capture the instance this reference lies in');
  return { w: { ev: w.ev, part: context.place }, ref: ic.ref as Json, placement };
}

/** The members of the part's selection set `id`. */
function membersOf(w: Where, id: string): Json[] {
  const set = ((partRowOf(w).row.sets as Json[]) ?? []).find((s) => s.id === id);
  if (!set) throw new FeaturePause(`the selection ${id} is not in this part`);
  return (set.members as Json).set as Json[];
}

/** A reference with selections opened into their members; selections that hold each other pause. */
export function membersOrSelf(w: Where, ref: Json, open: ReadonlySet<string> = new Set()): Json[] {
  const selection = ref.selection as Json | undefined;
  if (!selection) return [ref];
  const id = selection.id as string;
  if (open.has(id)) throw new FeaturePause(`the selection ${id} holds itself`);
  const inner = new Set([...open, id]);
  return membersOf(w, id).flatMap((m) => membersOrSelf(w, m, inner));
}

/**
 * The model entities `ref` names, resolved in `state` (the part before the
 * feature unless given), or in its context for an `inContext` reference.
 * `what` names it in pauses; an ambiguous or gone reference pauses.
 */
export function entitiesOf(w: Where, ref: Json, what: string, state?: NamedState): NamedEntity[] {
  const opened = inContextOf(w, ref);
  if (opened) return entitiesOf(opened.w, opened.ref, what);
  if ('selection' in ref) return membersOrSelf(w, ref).flatMap((m) => entitiesOf(w, m, what, state));
  const record = (ref.entity ?? null) as EntityRecord | null;
  if (!record) throw new FeaturePause(`only entity references are built yet as ${what}`);
  const found = resolve(record, state ?? w.part.state, w.ev.adapter);
  if (found.outcome !== 'same') throw new FeaturePause(`${what} is ${found.outcome === 'ask' ? 'ambiguous' : 'gone'}`);
  return [...found.entities];
}

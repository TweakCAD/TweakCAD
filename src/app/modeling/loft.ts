/**
 * The loft command's model (appendix A `core.loft`): an ordered list of
 * sections, each a region of any sketch; ruled or smooth, open or closed;
 * joined, cut or kept as a new body. A section the panel does not offer (a
 * face, a point) is kept as written; one whose region is gone is missing, and
 * a region clicked takes its place in the order.
 */
import { isPlainObject, makeSet } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import { profileSketch, type ExtrudeProfile, type Operation } from './extrude';
import {
  at,
  fieldReader,
  needsPick,
  namesOf,
  operationInput,
  readTargets,
  type Built,
  type FeatureTarget,
  type PickedRef,
  type ValueSlots,
} from './feature';
import { isMissingProfile, profileReferences, readProfiles } from './profiles';
import type { ProfileSketchInputs } from './profileSketches';

/** One section by its row id: a profile, which may be missing, or a section the panel does not offer, as written. */
export type LoftSection = { id: string; profile: ExtrudeProfile } | { id: string; written: Json };

export interface LoftForm {
  sections: LoftSection[];
  ruled: boolean;
  closed: boolean;
  operation: Operation;
  /** The bodies a join, cut or intersect acts on; none: all bodies. */
  targets: PickedRef[];
}

export const LOFT_OPERATIONS: readonly Operation[] = ['new', 'join', 'cut', 'intersect'];

export function newLoftForm(hasBody: boolean): LoftForm {
  return { sections: [], ruled: false, closed: false, operation: hasBody ? 'join' : 'new', targets: [] };
}

/** The sections' profiles, in order. */
export function sectionProfiles(sections: readonly LoftSection[]): ExtrudeProfile[] {
  return sections.flatMap((s) => ('profile' in s ? [s.profile] : []));
}

/**
 * `sections` with their profiles replaced by `profiles`, the same list after
 * a click. Sections that stay keep their rows and places, and those written
 * keep theirs. A new profile takes the row and place of a missing one that
 * went, so what points at that section still does; others go at the end.
 */
export function withProfiles(
  sections: readonly LoftSection[],
  profiles: readonly ExtrudeProfile[],
  newId: () => string,
): LoftSection[] {
  const added = profiles.filter((p) => !sections.some((s) => 'profile' in s && s.profile === p));
  const out = sections.flatMap((s): LoftSection[] => {
    if (!('profile' in s) || profiles.includes(s.profile)) return [s];
    const next = isMissingProfile(s.profile) ? added.shift() : undefined;
    return next ? [{ id: s.id, profile: next }] : [];
  });
  return [...out, ...added.map((profile) => ({ id: newId(), profile }))];
}

/** What the panel shows sketches from: every section's, with the sketches of what it keeps as written, rails and a centerline among them. */
export function loftSketches(form: LoftForm, base: Json | undefined, from: string | undefined): ProfileSketchInputs {
  const written = form.sections.flatMap((s) => ('written' in s ? [s.written] : []));
  return {
    profiles: sectionProfiles(form.sections),
    alongside: [written, at(base, 'rails'), at(base, 'centerline')],
    from,
  };
}

/** What the list's heading counts: all the sections, or those found and those missing. */
export function sectionsCount(sections: readonly LoftSection[]): string {
  const missing = sectionProfiles(sections).filter(isMissingProfile).length;
  return missing === 0 ? String(sections.length) : `${sections.length - missing}, ${missing} missing`;
}

export function buildLoft(_doc: Doc, target: FeatureTarget, form: LoftForm, values: ValueSlots): Built {
  if (form.sections.length < 2) return needsPick('Pick at least two profiles', 'sections');
  if (form.closed && form.sections.length < 3)
    return { ok: false, message: 'A closed loft has at least three profiles', field: 'sections' };
  const { names, regions } = profileReferences(sectionProfiles(form.sections));
  const sections = form.sections.map((s) => ({
    id: s.id,
    section: 'written' in s ? s.written : { profiles: makeSet(profileReferences([s.profile]).refs) as unknown as Json },
  }));
  const rails = at(target.base, 'rails');
  const inputs: Json = {
    ...(target.base ?? {}),
    sections,
    rails: Array.isArray(rails) ? structuredClone(rails) : [],
    ruled: values.flag(['ruled'], form.ruled),
    closed: values.flag(['closed'], form.closed),
    operation: operationInput(
      values,
      at(target.base, 'operation'),
      form.operation,
      form.operation === 'new' ? [] : form.targets,
    ),
  };
  return {
    ok: true,
    inputs,
    names: { ...names, ...namesOf(form.targets) },
    regions,
    sketches: sectionProfiles(form.sections).flatMap((p) => profileSketch(p) ?? []),
  };
}

export function readLoft(doc: Doc, part: string, inputs: Json): LoftForm {
  const form = newLoftForm(false);
  const rows = (at(inputs, 'sections') as Json[] | undefined) ?? [];
  form.sections = rows.map((row) => {
    const section = row.section as Json;
    const profiles = isPlainObject(section) && 'profiles' in section ? readProfiles(doc, part, section.profiles) : [];
    const [only] = profiles;
    return profiles.length === 1 && only
      ? { id: row.id as string, profile: only }
      : { id: row.id as string, written: section };
  });
  const read = fieldReader(doc);
  form.ruled = read.flag(inputs.ruled);
  form.closed = read.flag(inputs.closed);
  const op = read.choice(at(inputs, 'operation', 'op'));
  if ((LOFT_OPERATIONS as readonly string[]).includes(op)) form.operation = op as Operation;
  form.targets = readTargets(inputs.operation);
  return form;
}

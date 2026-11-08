/**
 * The sweep command's model (appendix A `core.sweep`): sketch regions run
 * along a path, following it, keeping one orientation, or turned by a guide;
 * joined, cut or kept as new bodies. The path is a chain of sketch curves and
 * edges, or a region standing for its outer loop. A section the panel does not
 * offer (a circle) is kept as written.
 */
import { isPlainObject, makeSet } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import { profileSketch, regionRowOf, type ExtrudeProfile, type Operation } from './extrude';
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
import { profileReferences, readProfiles } from './profiles';
import type { ProfileSketchInputs } from './profileSketches';

export type SweepOrientation = 'followPath' | 'fixed' | 'guide';

/** One link of a chain: a picked curve or edge, or a region. */
export type ChainPick = PickedRef | { region: ExtrudeProfile; label: string };

export interface SweepForm {
  /** The row id of the one section. */
  section: string;
  profiles: ExtrudeProfile[];
  /** A section the panel does not offer, as written. */
  keptSection: Json | null;
  path: ChainPick[];
  orientation: SweepOrientation;
  guide: ChainPick[];
  operation: Operation;
  /** The bodies a join, cut or intersect acts on; none: all bodies. */
  targets: PickedRef[];
}

export const SWEEP_OPERATIONS: readonly Operation[] = ['new', 'join', 'cut', 'intersect'];

export function newSweepForm(section: string, hasBody: boolean): SweepForm {
  return {
    section,
    profiles: [],
    keptSection: null,
    path: [],
    orientation: 'followPath',
    guide: [],
    operation: hasBody ? 'join' : 'new',
    targets: [],
  };
}

/** The references of a chain, the names they need, and the region rows to add first. */
export function chainReferences(chain: readonly ChainPick[]): {
  refs: Json[];
  names: Json;
  regions: NonNullable<ReturnType<typeof profileReferences>['regions']>;
} {
  const names: Json = {};
  const regions: ReturnType<typeof profileReferences>['regions'] = [];
  const refs = chain.map((link) => {
    if ('reference' in link) {
      Object.assign(names, link.names);
      return link.reference;
    }
    const r = profileReferences([link.region]);
    Object.assign(names, r.names);
    regions.push(...r.regions);
    return r.refs[0] as Json;
  });
  return { refs, names, regions };
}

/** What the panel shows sketches from: the profiles', with the path's and the guide's. */
export function sweepSketches(form: SweepForm, from: string | undefined): ProfileSketchInputs {
  const path = chainReferences(form.path);
  const guide = chainReferences(form.orientation === 'guide' ? form.guide : []);
  return {
    profiles: form.profiles,
    alongside: [path.refs, guide.refs],
    names: { ...path.names, ...guide.names },
    from,
  };
}

function orientationInput(form: SweepForm, guide: readonly Json[]): Json {
  return form.orientation === 'guide' ? { guide: { chain: guide } } : { [form.orientation]: {} };
}

export function buildSweep(_doc: Doc, target: FeatureTarget, form: SweepForm, values: ValueSlots): Built {
  if (form.profiles.length === 0 && !form.keptSection) return needsPick('Pick a profile', 'profiles');
  if (form.path.length === 0) return needsPick('Pick the path', 'path');
  if (form.orientation === 'guide' && form.guide.length === 0) return needsPick('Pick the guide', 'guide');
  const profiles = profileReferences(form.profiles);
  const path = chainReferences(form.path);
  const guide = chainReferences(form.orientation === 'guide' ? form.guide : []);
  const section = form.keptSection ?? { profiles: makeSet(profiles.refs) as unknown as Json };
  const inputs: Json = {
    ...(target.base ?? {}),
    sections: [{ id: form.section, section }],
    path: path.refs,
    orientation: orientationInput(form, guide.refs),
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
    names: { ...profiles.names, ...path.names, ...guide.names, ...namesOf(form.targets) },
    regions: [...profiles.regions, ...path.regions, ...guide.regions],
    sketches: form.profiles.flatMap((p) => profileSketch(p) ?? []),
  };
}

/** A stored chain as picks, labelled `label n`. */
function readChain(doc: Doc, part: string, chain: unknown, label: string): ChainPick[] {
  return ((chain as Json[] | undefined) ?? []).map((reference, i) => {
    const row = regionRowOf(doc, part, reference);
    return row ? { region: row, label: `${label} ${i + 1}` } : { reference, names: {}, label: `${label} ${i + 1}` };
  });
}

/** The form of an existing sweep; null for one of several sections, which the panel does not show. */
export function readSweep(doc: Doc, part: string, inputs: Json): SweepForm | null {
  const rows = (at(inputs, 'sections') as Json[] | undefined) ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row) return null;
  const form = newSweepForm(row.id as string, false);
  const section = row.section as Json;
  if (isPlainObject(section) && 'profiles' in section) form.profiles = readProfiles(doc, part, section.profiles);
  else form.keptSection = section;
  form.path = readChain(doc, part, inputs.path, 'Path');
  const orientation = at(inputs, 'orientation') as Json | undefined;
  if (orientation && 'fixed' in orientation) form.orientation = 'fixed';
  else if (orientation && 'guide' in orientation) {
    form.orientation = 'guide';
    form.guide = readChain(doc, part, at(orientation, 'guide', 'chain'), 'Guide');
  }
  const op = fieldReader(doc).choice(at(inputs, 'operation', 'op'));
  if ((SWEEP_OPERATIONS as readonly string[]).includes(op)) form.operation = op as Operation;
  form.targets = readTargets(inputs.operation);
  return form;
}

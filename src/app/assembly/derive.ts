/**
 * `core.derive` (11.1) as the Derive panel writes it: the bodies of another
 * part or assembly of this document, or of a library component, brought
 * into the active part, placed by an offset, optionally reflected in a
 * default plane (an opposite-hand part), as a new body, joined to the
 * part's bodies or cut from them.
 */
import { isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import { partsOf } from '../features';
import {
  at,
  bindValue,
  exprText,
  fieldReader,
  fieldText,
  type Built,
  type FeatureTarget,
  type ValueSlots,
} from '../modeling/feature';
import { vectorText } from '../modeling/hole';
import { assembliesOf, libraryOf } from './assembly';
import { readPlacementText } from './placement';

export type DeriveSource = { part: string } | { assembly: string } | { component: string };

export interface DeriveForm {
  source: DeriveSource | null;
  x: string;
  y: string;
  z: string;
  operation: 'new' | 'join' | 'cut';
  mirror: 'none' | 'xy' | 'xz' | 'yz';
  /** The frame's rotation expression, kept as written (Edit Component sets it); absent, none. */
  rotation?: string;
  /** The derive's own instance id (11.1), made once. */
  instance: string;
  /** Inputs the panel does not show (items, overrides), kept as found. */
  kept?: { items?: Json; overrides?: Json };
}

export const sourceKey = (s: DeriveSource | null): string =>
  !s ? '' : 'part' in s ? `part:${s.part}` : 'assembly' in s ? `assembly:${s.assembly}` : `component:${s.component}`;

export function sourceOfKey(key: string): DeriveSource | null {
  const [kind, id] = key.split(':');
  if (!id) return null;
  return kind === 'part'
    ? { part: id }
    : kind === 'assembly'
      ? { assembly: id }
      : kind === 'component'
        ? { component: id }
        : null;
}

/** What a part can derive from: the other parts, the assemblies and the library's documents. */
export function deriveSources(doc: Doc, part: string): { key: string; label: string }[] {
  return [
    ...partsOf(doc)
      .filter((p) => p.id !== part)
      .map((p) => ({ key: `part:${String(p.id)}`, label: String(p.name) })),
    ...assembliesOf(doc).map((a) => ({ key: `assembly:${String(a.id)}`, label: `${String(a.name)} (assembly)` })),
    ...libraryOf(doc)
      .filter((e) => e.kind === 'document')
      .map((e) => ({ key: `component:${String(e.id)}`, label: `${String(e.name)} (component)` })),
  ];
}

/** The frame's rotation of a derive that is not turned. */
export const IDENTITY_ROTATION = 'rotate(vector(0, 0, 1), 0 deg)';

export function newDeriveForm(doc: Doc, part: string, instance: string): DeriveForm {
  const first = deriveSources(doc, part)[0];
  return {
    source: first ? sourceOfKey(first.key) : null,
    x: '0',
    y: '0',
    z: '0',
    operation: 'new',
    mirror: 'none',
    instance,
  };
}

const PLACEMENT = { type: 'placement' } as const;

export function buildDerive(doc: Doc, target: FeatureTarget, form: DeriveForm, values: ValueSlots): Built {
  if (!form.source) return { ok: false, message: 'Choose what to derive', field: 'source' };
  const from: Json =
    'part' in form.source
      ? { part: { id: form.source.part } }
      : 'assembly' in form.source
        ? { assembly: { id: form.source.assembly } }
        : {
            component: {
              value: values.value(['from', 'component', 'value'], {
                expr: {
                  text: 'component',
                  grammar: 1,
                  refs: { component: { library: { id: form.source.component } } },
                },
              }),
            },
          };
  // Names in the fields are the part's parameters and named values.
  const offset = bindValue(
    doc,
    target,
    values,
    ['frame', 'fixed', 'placement'],
    `placement(${vectorText([form.x, form.y, form.z])}, ${form.rotation?.trim() || IDENTITY_ROTATION})`,
    PLACEMENT,
    'x',
  );
  if (!offset.ok) return offset;
  const inputs: Json = {
    ...(target.base ?? {}),
    from,
    instance: form.instance,
    items: form.kept?.items ?? { all: {} },
    overrides: form.kept?.overrides ?? [],
    frame: { fixed: { placement: offset.value } },
    operation: {
      op: values.choice(['operation', 'op'], form.operation),
      targets: { all: {} },
      keepTools: values.flag(['operation', 'keepTools'], false),
    },
  };
  delete inputs.mirror;
  if (form.mirror !== 'none') inputs.mirror = { plane: { standard: { name: form.mirror } } };
  return { ok: true, inputs, names: {} };
}

export function readDerive(doc: Doc, _part: string, inputs: Json): DeriveForm | null {
  const from = inputs.from as Json | undefined;
  let source: DeriveSource | null = null;
  if (isPlainObject(from?.part)) source = { part: String(from.part.id) };
  else if (isPlainObject(from?.assembly)) source = { assembly: String(from.assembly.id) };
  else if (isPlainObject(from?.component)) {
    const refs = at(from.component, 'value', 'def', 'expr', 'refs') as Json | undefined;
    const ref = refs ? Object.values(refs)[0] : undefined;
    const id = isPlainObject(ref) && isPlainObject(ref.library) ? String(ref.library.id) : null;
    if (!id) return null;
    source = { component: id };
  }
  if (!source) return null;
  const frame = inputs.frame as Json | undefined;
  if (!isPlainObject(frame?.fixed)) return null;
  const placed = readPlacementText(exprText(frame.fixed.placement));
  if (!placed) return null;
  const parts = placed.position;
  const mirror = at(inputs, 'mirror', 'plane', 'standard', 'name');
  const op = fieldReader(doc).choice(at(inputs, 'operation', 'op'));
  return {
    source,
    x: fieldText(parts[0] ?? '0'),
    y: fieldText(parts[1] ?? '0'),
    z: fieldText(parts[2] ?? '0'),
    operation: op === 'join' || op === 'cut' ? op : 'new',
    mirror: mirror === 'xy' || mirror === 'xz' || mirror === 'yz' ? mirror : 'none',
    rotation: placed.rotation,
    instance: String(inputs.instance),
    kept: { items: inputs.items as Json, overrides: inputs.overrides as Json },
  };
}

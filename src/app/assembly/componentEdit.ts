/**
 * Editing a component after it is inserted: the values of its public parameters (insertion overrides, 6.4),
 * the configuration row it uses (by overriding its configuration's input
 * parameter, 7.4), where it is placed, and for a component derived into a
 * part, whether it is a new body, joined or cut. An instance in an
 * assembly keeps its overrides and placement on its row; a derive in its
 * inputs (`frame`). The embedded document is never touched.
 *
 * A configuration can be chosen only when its input parameter is public,
 * since an insertion sets public values only (6.2).
 */
import { GRAMMAR, ValueEvaluator, ValuePause, isPlainObject, toStored, type ExprValue } from '@tweakcad/format';
import type { Doc, EditorCommand, Json } from '@tweakcad/editor';
import type { Placement } from '@tweakcad/worker/src/v2/service/types';
import { findFeature, partOfFeature } from '../features';
import { kindTarget, storedText } from '../parameters';
import { exprText, fieldReader, fieldText, namesBound } from '../modeling/feature';
import { vectorText } from '../modeling/hole';
import { assemblyOf, instanceLabel, libraryEntryOf, rowsOf, storedPlacement } from './assembly';
import {
  boundOverrides,
  componentConfigurations,
  overridesFrom,
  publicParameters,
  rowOverrides,
  type ComponentConfiguration,
  type DeriveOperation,
  type PublicParameter,
} from './library';
import {
  anglesOfRotationText,
  parseTriple,
  placementFields,
  placementOf,
  readPlacementText,
  rotationText,
  tidy,
} from './placement';

export type { ComponentConfiguration, DeriveOperation } from './library';

/** Where an inserted component stands: an instance of an assembly, or a derive feature of a part. */
export type ComponentSite = { assembly: string; instance: string } | { feature: string };

type Triple = [string, string, string];

/**
 * Where the component is placed, as typed: a translation (mm) and a
 * rotation (deg, about X, then the turned Y, then the turned Z). An
 * instance's are numbers; a derive's translation may be expressions.
 */
export interface PlacementEdit {
  position: Triple;
  rotation: Triple;
}

export interface ComponentEdit {
  /** The component's name and its label in the host ("Bracket:2", "Bracket 1"). */
  name: string;
  label: string;
  /** Where the component came from: its catalogue id, or "local". */
  origin: string;
  /** Public parameters other than configuration inputs. */
  params: PublicParameter[];
  configurations: ComponentConfiguration[];
  /**
   * Field text by parameter id: the override's, or empty where this
   * insertion sets nothing and the component's own value (under the chosen
   * configuration rows) applies.
   */
  values: Record<string, string>;
  /** The row chosen by configuration input id; null keeps the component's own. */
  rows: Record<string, string | null>;
  /** A derive's operation; absent for an instance. */
  operation?: DeriveOperation;
  /** The expression a derive's operation is stored as, when it is not a literal. */
  operationBound?: string;
  /** Absent for a derive placed other than by a fixed placement. */
  placement?: PlacementEdit;
}

interface SiteRow {
  overrides: Json[];
  component: unknown;
  label: string;
  operation?: DeriveOperation;
  operationBound?: string;
  placement?: PlacementEdit;
}

/** The text a derive's fixed frame shows, when it is a `placement(...)` with a rotation of numbers. */
function derivePlacement(inputs: Json): PlacementEdit | undefined {
  const frame = inputs.frame as Json | undefined;
  if (!isPlainObject(frame?.fixed)) return undefined;
  const placed = readPlacementText(exprText(frame.fixed.placement));
  const angles = placed ? anglesOfRotationText(placed.rotation) : null;
  if (!placed || !angles) return undefined;
  return { position: placed.position.map((t) => fieldText(t)) as Triple, rotation: angles.map(tidy) as Triple };
}

/** The site's row (instance) or inputs (derive), and the library value naming the component. */
function siteOf(doc: Doc, site: ComponentSite): SiteRow | null {
  if ('assembly' in site) {
    const asm = assemblyOf(doc, site.assembly);
    const row = rowsOf(asm, 'instances').find((r) => r.id === site.instance);
    const of = row?.of as Json | undefined;
    if (!asm || !row || !isPlainObject(of?.component)) return null;
    const fields = placementFields(
      (row.placement as Placement | undefined) ?? { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    );
    return {
      overrides: Array.isArray(row.overrides) ? (row.overrides as Json[]) : [],
      component: of.component.value,
      label: instanceLabel(doc, asm, site.instance),
      placement: { position: fields.position.map(tidy) as Triple, rotation: fields.rotation.map(tidy) as Triple },
    };
  }
  const feature = findFeature(doc, site.feature);
  const inputs = feature?.inputs as Json | undefined;
  const from = inputs?.from as Json | undefined;
  if (feature?.type !== 'core.derive' || !inputs || !isPlainObject(from?.component)) return null;
  const read = fieldReader(doc);
  const op = read.choice((inputs.operation as Json | undefined)?.op);
  const bound = read.bound((inputs.operation as Json | undefined)?.op);
  const placement = derivePlacement(inputs);
  return {
    overrides: Array.isArray(inputs.overrides) ? (inputs.overrides as Json[]) : [],
    component: from.component.value,
    label: String(feature.name ?? 'Component'),
    operation: op === 'join' || op === 'cut' ? op : 'new',
    ...(bound ? { operationBound: bound.text } : {}),
    ...(placement ? { placement } : {}),
  };
}

/** The text a value override of parameter `id` writes, if the list has one. */
function overrideText(overrides: readonly Json[], id: string): string | undefined {
  for (const o of overrides) {
    const v = o.value as Json | undefined;
    if ((((v?.target as Json | undefined)?.parameter as Json | undefined)?.id as unknown) !== id) continue;
    const text = ((v?.def as Json | undefined)?.expr as Json | undefined)?.text;
    if (typeof text === 'string') return text;
  }
  return undefined;
}

const unquoted = (text: string): string => /^\s*"(.*)"\s*$/.exec(text)?.[1] ?? text;

/** Where a library entry came from, as one line. */
function originOf(entry: Json): string {
  const source = entry.source as Json | undefined;
  const catalogue = source?.catalogue as Json | undefined;
  return isPlainObject(catalogue) ? `catalog:${String(catalogue.id)}` : 'local';
}

/** The component document a site holds. */
function definitionOf(doc: Doc, at: SiteRow): { entry: Json; definition: Doc } | null {
  const entry = libraryEntryOf(doc, at.component);
  const definition = ((entry?.content as Json | undefined)?.inline as Json | undefined)?.definition as Doc | undefined;
  return entry && isPlainObject(definition) ? { entry, definition } : null;
}

/** What the Edit Component panel shows for a site, or null when it holds no component. */
export function readComponentEdit(doc: Doc, site: ComponentSite): ComponentEdit | null {
  const at = siteOf(doc, site);
  const found = at ? definitionOf(doc, at) : null;
  if (!at || !found) return null;
  const pub = publicParameters(found.definition);
  const configurations = componentConfigurations(found.definition, pub);
  const inputs = new Set(configurations.map((c) => c.input.id));
  const params = pub.filter((p) => !inputs.has(p.id));
  const values: Record<string, string> = {};
  for (const p of params) values[p.id] = overrideText(at.overrides, p.id) ?? '';
  const rows: Record<string, string | null> = {};
  for (const c of configurations) {
    const text = overrideText(at.overrides, c.input.id);
    rows[c.input.id] = text === undefined ? null : unquoted(text);
  }
  return {
    name: String(found.entry.name),
    label: at.label,
    origin: originOf(found.entry),
    params,
    configurations,
    values,
    rows,
    ...(at.operation ? { operation: at.operation } : {}),
    ...(at.operationBound !== undefined ? { operationBound: at.operationBound } : {}),
    ...(at.placement ? { placement: at.placement } : {}),
  };
}

/** The insertion overrides an edit makes: changed public values, then each chosen configuration row. */
export function editOverrides(edit: ComponentEdit): Json[] {
  return [...overridesFrom(edit.params, edit.values), ...rowOverrides(edit.configurations, edit.rows)];
}

/** True when a parameter's field overrides the component's own value. */
export function isOverridden(edit: ComponentEdit, p: PublicParameter): boolean {
  return overridesFrom([p], edit.values).length > 0;
}

/** True when every placement field reads as a number (a derive's translation may be an expression). */
export function placementValid(edit: ComponentEdit, derive: boolean): boolean {
  const p = edit.placement;
  if (!p) return true;
  return (
    parseTriple(p.rotation) !== null &&
    (derive ? p.position.every((t) => t.trim() !== '') : parseTriple(p.position) !== null)
  );
}

/** The commands that write an edit to its site. A placement field that does not read keeps the placement stored. */
export function componentEditCommands(doc: Doc, site: ComponentSite, edit: ComponentEdit): EditorCommand[] {
  // Names in the overrides are the host's: the assembly's, or the part's up to the derive. Unchanged ones stay as stored.
  const stored = siteOf(doc, site);
  const previous = stored?.overrides ?? [];
  const scope =
    'assembly' in site
      ? { part: site.assembly, feature: '' }
      : { part: partOfFeature(doc, site.feature) ?? '', feature: site.feature };
  const overrides = boundOverrides(doc, scope, editOverrides(edit), previous);
  if ('assembly' in site) {
    const set: Json = { overrides };
    const position = edit.placement ? parseTriple(edit.placement.position) : null;
    const rotation = edit.placement ? parseTriple(edit.placement.rotation) : null;
    if (position && rotation) set.placement = storedPlacement(placementOf(position, rotation)) as unknown as Json;
    return [{ type: 'editAssemblyRow', row: site.instance, set }];
  }
  const feature = findFeature(doc, site.feature);
  const inputs = structuredClone((feature?.inputs ?? {}) as Json);
  inputs.overrides = overrides;
  const operation = inputs.operation as Json | undefined;
  // An operation left as it reads keeps its stored value, an expression included.
  if (
    edit.operation &&
    edit.operation !== stored?.operation &&
    isPlainObject(operation) &&
    isPlainObject(operation.op)
  ) {
    operation.op = { ...operation.op, def: { expr: { text: `"${edit.operation}"`, grammar: GRAMMAR, refs: {} } } };
  }
  const frame = inputs.frame as Json | undefined;
  const rotation = edit.placement ? parseTriple(edit.placement.rotation) : null;
  if (
    edit.placement &&
    rotation &&
    placementValid(edit, true) &&
    isPlainObject(frame?.fixed) &&
    isPlainObject(frame.fixed.placement)
  ) {
    const text = `placement(${vectorText(edit.placement.position)}, ${rotationText(rotation)})`;
    if (text !== exprText(frame.fixed.placement))
      frame.fixed.placement = {
        ...frame.fixed.placement,
        def: namesBound(doc, { ...scope, self: String(frame.fixed.placement.id) }, text),
      };
  }
  return [{ type: 'replaceInput', feature: site.feature, pointer: '', with: inputs }];
}

/** The site a browser row names: a component instance, or a derive of a component; null for anything else. */
export function componentSite(doc: Doc, site: ComponentSite): ComponentSite | null {
  if ('feature' in site && !partOfFeature(doc, site.feature)) return null;
  return siteOf(doc, site) ? site : null;
}

/** True when a feature is a derive of a library component. */
export function isComponentDerive(feature: Json): boolean {
  return (
    feature.type === 'core.derive' &&
    isPlainObject((feature.inputs as Json | undefined)?.from) &&
    isPlainObject(((feature.inputs as Json).from as Json).component)
  );
}

/** Fields as a reset leaves them: nothing set for the insertion, every value the component's own. */
export function defaults(edit: ComponentEdit): Pick<ComponentEdit, 'values' | 'rows'> {
  return {
    values: Object.fromEntries(edit.params.map((p) => [p.id, ''])),
    rows: Object.fromEntries(edit.configurations.map((c) => [c.input.id, null])),
  };
}

/** The placement of the origin, unturned. */
export const ORIGIN: PlacementEdit = { position: ['0', '0', '0'], rotation: ['0', '0', '0'] };

export type Resolved = { ok: true; text: string } | { ok: false; message: string };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What each public parameter of the edited component comes to with the
 * edit's overrides: each override evaluated in the host (6.4), then the
 * component's own values and configuration rows under them.
 */
export function resolvedValues(doc: Doc, site: ComponentSite, edit: ComponentEdit): Record<string, Resolved> {
  const at = siteOf(doc, site);
  const found = at ? definitionOf(doc, at) : null;
  if (!found) return {};
  const pub = [...edit.params, ...edit.configurations.map((c) => c.input)];
  const out: Record<string, Resolved> = {};
  const host = new ValueEvaluator(doc);
  const insertion = new Map<string, ExprValue>();
  for (const o of editOverrides(edit)) {
    const value = o.value as Json;
    const id = String(((value.target as Json).parameter as Json).id);
    const p = pub.find((x) => x.id === id);
    if (!p) continue;
    try {
      insertion.set(id, host.evaluateDefinition(value.def as Json, p.name, kindTarget(p.kind, p.options) as never));
    } catch (e) {
      out[id] = { ok: false, message: e instanceof ValuePause ? e.message : messageOf(e) };
    }
  }
  let inner: ValueEvaluator;
  try {
    inner = new ValueEvaluator(found.definition, insertion);
  } catch (e) {
    for (const p of edit.params) out[p.id] ??= { ok: false, message: messageOf(e) };
    return out;
  }
  for (const p of edit.params) {
    if (out[p.id]) continue;
    try {
      out[p.id] = {
        ok: true,
        text: storedText(p.kind, toStored(inner.parameter(p.id), kindTarget(p.kind, p.options) as never)),
      };
    } catch (e) {
      out[p.id] = { ok: false, message: messageOf(e) };
    }
  }
  return out;
}

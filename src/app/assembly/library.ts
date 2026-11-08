/**
 * Components from the library (11): a published document embedded as a
 * library `document` entry, its asset bytes moved into the host's assets
 * (an embedded document's asset rows carry no data), and inserted with the
 * values its public parameters take (6.4 insertion overrides): as an
 * instance in an assembly, or derived into a part (11.1).
 */
import { GRAMMAR, isPlainObject, nameHash } from '@tweakcad/format';
import {
  withDefaultUnit,
  type Doc,
  type Editor,
  type EditorCommand,
  type ExpressionScope,
  type Json,
} from '@tweakcad/editor';
import { featureBefore, featureRow, insertionPoint, literal, nextFeatureName } from '../modeling/common';
import { namesBound } from '../modeling/feature';
import { configurationsOf, kindOf, type ParameterKind } from '../parameters';
import { instanceRow, libraryOf, libraryValue, IDENTITY_PLACEMENT } from './assembly';

/** One public parameter of a component: what an insertion may set. */
export interface PublicParameter {
  id: string;
  name: string;
  /** Its own value, as written. */
  text: string;
  unit: string;
  description: string;
  kind: ParameterKind;
  /** A choice parameter's options. */
  options: string[];
}

/** The part or assembly a document is: its root's tables, for public parameters. */
function rootRow(doc: Doc): Json | undefined {
  const root = isPlainObject(doc.root) ? doc.root : {};
  const list = (field: string) => (Array.isArray(doc[field]) ? (doc[field] as Json[]) : []);
  if (isPlainObject(root.part)) return list('parts').find((p) => p.id === (root.part as Json).id);
  if (isPlainObject(root.assembly)) return list('assemblies').find((a) => a.id === (root.assembly as Json).id);
  return undefined;
}

const unitOf = (p: Json) => (p.quantity === 'length' ? 'mm' : p.quantity === 'angle' ? 'deg' : '');

/** The public parameters of a component document: its document tables', then its root's. */
export function publicParameters(doc: Doc): PublicParameter[] {
  const tables = [
    ...(Array.isArray(doc.parameters) ? (doc.parameters as Json[]) : []),
    ...((rootRow(doc)?.parameters as Json[] | undefined) ?? []),
  ];
  return tables.flatMap((t) =>
    (Array.isArray(t.parameters) ? (t.parameters as Json[]) : [])
      .filter((p) => p.public === true)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        text: String((((p.value as Json | undefined)?.def as Json | undefined)?.expr as Json | undefined)?.text ?? ''),
        unit: unitOf(p),
        description: String(p.description ?? ''),
        kind: kindOf(p),
        options: Array.isArray(p.options) ? (p.options as unknown[]).map(String) : [],
      })),
  );
}

/** Field text as the expression an override writes: a bare number takes the parameter's unit. */
const written = (p: PublicParameter, text: string): string => (p.unit ? withDefaultUnit(text, p.unit) : text.trim());

/**
 * Insertion overrides for the values that differ from the component's own
 * (`baseline`, by parameter id: its text under the chosen configuration
 * rows; absent, the parameter's own); an equal value would shield it from
 * its own configurations (6.4).
 */
export function overridesFrom(
  params: readonly PublicParameter[],
  values: Readonly<Record<string, string>>,
  baseline: Readonly<Record<string, string>> = {},
): Json[] {
  return params.flatMap((p) => {
    const text = values[p.id];
    if (text === undefined || text.trim() === '') return [];
    const base = (baseline[p.id] ?? p.text).trim();
    if (text.trim() === base || written(p, text) === base) return [];
    return [
      {
        value: {
          target: { parameter: { id: p.id } },
          def: { expr: { text: written(p, text), grammar: GRAMMAR, refs: {} } },
        },
      },
    ];
  });
}

/** The parameter an override sets and its expression text. */
function overrideKey(o: Json): string {
  const value = o.value as Json | undefined;
  const id = ((value?.target as Json | undefined)?.parameter as Json | undefined)?.id;
  const text = ((value?.def as Json | undefined)?.expr as Json | undefined)?.text;
  return JSON.stringify([id, typeof text === 'string' ? text.trim() : null]);
}

/**
 * Insertion overrides with the names their expressions use bound in the
 * host's `scope` (an assembly, or a part up to the derive). One that sets
 * the same parameter to the same text as one of `previous` is that one,
 * kept as it was.
 */
export function boundOverrides(
  doc: Doc,
  scope: ExpressionScope,
  overrides: readonly Json[],
  previous: readonly Json[] = [],
): Json[] {
  return overrides.map((o) => {
    const kept = previous.find((p) => overrideKey(p) === overrideKey(o));
    if (kept) return kept;
    const value = o.value as Json | undefined;
    const text = ((value?.def as Json | undefined)?.expr as Json | undefined)?.text;
    if (!value || typeof text !== 'string') return o;
    return { ...o, value: { ...value, def: namesBound(doc, scope, text) } };
  });
}

/** The part a component document is, when its root is a part. */
export function rootPart(component: Doc): string | null {
  const root = component.root as Json | undefined;
  return isPlainObject(root?.part) ? String(root.part.id) : null;
}

/** A configuration of a component that a host may choose a row of. */
export interface ComponentConfiguration {
  input: PublicParameter;
  options: string[];
  /** The row the component itself selects. */
  own: string | null;
  /** Each row's overrides: expression text by parameter id. */
  rows: { option: string; overrides: Map<string, string> }[];
}

/**
 * The configurations of a component document a host can choose rows of:
 * those of its root part whose input parameter is public, since an
 * insertion sets public values only (6.2).
 */
export function componentConfigurations(
  component: Doc,
  params: readonly PublicParameter[] = publicParameters(component),
): ComponentConfiguration[] {
  const part = rootPart(component);
  return (part ? configurationsOf(component, part) : []).flatMap((c) => {
    const input = params.find((p) => p.id === c.input.id);
    return input ? [{ input, options: c.rows.map((r) => r.option), own: c.active, rows: c.rows }] : [];
  });
}

/**
 * The text each public parameter takes under the chosen rows (by input id;
 * null or absent keeps the component's own row): a row's override, the
 * later configuration winning (7.4), else the parameter's own.
 */
export function valuesUnder(
  params: readonly PublicParameter[],
  configurations: readonly ComponentConfiguration[],
  rows: Readonly<Record<string, string | null>>,
): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(params.map((p) => [p.id, p.text]));
  for (const c of configurations) {
    const option = rows[c.input.id] ?? c.own;
    const row = c.rows.find((r) => r.option === option);
    for (const [id, text] of row?.overrides ?? []) if (id in out) out[id] = text;
  }
  return out;
}

/** The insertion overrides that choose configuration rows: one per input whose row is set. */
export function rowOverrides(
  configurations: readonly ComponentConfiguration[],
  rows: Readonly<Record<string, string | null>>,
): Json[] {
  return configurations.flatMap((c) => {
    const row = rows[c.input.id];
    if (row === null || row === undefined) return [];
    return [
      {
        value: {
          target: { parameter: { id: c.input.id } },
          def: { expr: { text: JSON.stringify(row), grammar: GRAMMAR, refs: {} } },
        },
      },
    ];
  });
}

/**
 * A library entry for a component document, and the asset rows the host
 * takes for its files. `source` says where it came from (a catalogue
 * component and version, pinned).
 */
export function embedDocument(component: Doc, name: string, id: string, source: Json): { entry: Json; assets: Json } {
  const definition = structuredClone(component);
  const assets: Json = {};
  const inner: Json = {};
  for (const [hash, row] of Object.entries(isPlainObject(definition.assets) ? definition.assets : {})) {
    if (!isPlainObject(row)) continue;
    const { data, ...rest } = row;
    inner[hash] = rest;
    if (data !== undefined) assets[hash] = row;
  }
  definition.assets = inner;
  const content = { inline: { definition } };
  return { entry: { id, hash: nameHash(content), kind: 'document', content, source, name }, assets };
}

/** The library entry of the host that holds the same content, if it has one. */
export function sameEntry(host: Doc, entry: Json): Json | undefined {
  return libraryOf(host).find((e) => e.hash === entry.hash && e.kind === 'document');
}

export type InsertTarget = { assembly: string } | { part: string };

/** How a component derived into a part meets the part's bodies. */
export type DeriveOperation = 'new' | 'join' | 'cut';

/**
 * The commands that insert a component: its library entry (unless the
 * host holds the same content already), then an instance of it in the
 * assembly, or a derive of it into the part, as a new body or joined to
 * or cut from the part's bodies.
 */
export function insertComponentCommands(
  editor: Editor,
  embedded: { entry: Json; assets: Json },
  target: InsertTarget,
  overrides: Json[],
  operation: DeriveOperation = 'new',
): EditorCommand[] {
  const known = sameEntry(editor.document, embedded.entry);
  const entry = (known?.id as string | undefined) ?? (embedded.entry.id as string);
  const commands: EditorCommand[] = known
    ? []
    : [{ type: 'addLibraryEntry', entry: embedded.entry, assets: embedded.assets as Record<string, Json> }];
  const of = { component: { value: libraryValue(editor, entry) } };
  const doc = editor.document;
  if ('assembly' in target) {
    const bound = boundOverrides(doc, { part: target.assembly, feature: '' }, overrides);
    commands.push({
      type: 'addAssemblyRow',
      assembly: target.assembly,
      table: 'instances',
      row: instanceRow(editor, of, { placement: IDENTITY_PLACEMENT, overrides: bound }),
    });
    return commands;
  }
  const before = insertionPoint(doc, target.part);
  const inputs = {
    from: of,
    instance: editor.newId('inst'),
    items: { all: {} },
    overrides: boundOverrides(
      doc,
      { part: target.part, feature: featureBefore(doc, target.part, before) ?? '' },
      overrides,
    ),
    frame: {
      fixed: { placement: literal(editor, 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))') },
    },
    operation: {
      op: literal(editor, JSON.stringify(operation)),
      targets: { all: {} },
      keepTools: literal(editor, 'false'),
    },
  };
  const name = nextFeatureName(doc, target.part, String(embedded.entry.name));
  commands.push({
    type: 'addFeature',
    container: target.part,
    feature: featureRow(editor, editor.newId('feat'), 'core.derive', name, inputs),
    ...(before ? { before } : {}),
  });
  return commands;
}

/** What the Components panel's configure view edits for a component before it is inserted. */
export interface InsertForm {
  /** Public parameters other than configuration inputs. */
  params: PublicParameter[];
  configurations: ComponentConfiguration[];
  /** The row chosen by configuration input id; null keeps the component's own. */
  rows: Record<string, string | null>;
  /** Field text by parameter id. */
  values: Record<string, string>;
  operation: DeriveOperation;
}

/** The configure view of a downloaded component: its own rows and the values they give. */
export function newInsertForm(component: Doc): InsertForm {
  const pub = publicParameters(component);
  const configurations = componentConfigurations(component, pub);
  const inputs = new Set(configurations.map((c) => c.input.id));
  const params = pub.filter((p) => !inputs.has(p.id));
  const rows: Record<string, string | null> = Object.fromEntries(configurations.map((c) => [c.input.id, null]));
  return { params, configurations, rows, values: valuesUnder(params, configurations, rows), operation: 'new' };
}

/** Choosing a configuration row seeds the fields with the values that row gives. */
export function chooseRow(form: InsertForm, input: string, option: string): InsertForm {
  const c = form.configurations.find((x) => x.input.id === input);
  const rows = { ...form.rows, [input]: c && option === c.own ? null : option };
  return { ...form, rows, values: valuesUnder(form.params, form.configurations, rows) };
}

/** The insertion overrides of a configure view: the values that differ from the chosen rows', then the rows chosen. */
export function insertOverrides(form: InsertForm): Json[] {
  return [
    ...overridesFrom(form.params, form.values, valuesUnder(form.params, form.configurations, form.rows)),
    ...rowOverrides(form.configurations, form.rows),
  ];
}

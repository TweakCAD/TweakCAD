/**
 * What the browser and the timeline show, read from the document and the
 * display: the shown root, a part's features with their build status (a
 * paused feature shows its message as a failed one does, a frozen one that
 * replays a body an earlier edit changed carries a warning), and its
 * rollback.
 */
import { ValueEvaluator, isPlainObject } from '@tweakcad/format';
import type { Doc, Json } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import type { BeforeListing } from './display/scheduler';
import type { ShownRoot } from './viewport/ModelScene';

export type FeatureStatus = 'success' | 'suppressed' | 'failed' | 'blocked';

export interface FeatureRow {
  id: string;
  name: string;
  /** The feature type, e.g. `core.extrude`. */
  type: string;
  /** The short name the icons and colours are keyed by, e.g. `extrude`. */
  iconKey: string;
  suppressed: boolean;
  /** Its effect is stored as it last built (7.2): edits upstream do not change it. */
  frozen: boolean;
  status: FeatureStatus;
  /** Why it paused (`failed`) or what it waits on (`blocked`). */
  message?: string;
  /** It built, but not as authored: a frozen feature replaying its stored shape over a body an earlier edit changed. */
  warning?: string;
  /** An attribute hides what it shows (16.1). */
  hidden: boolean;
  /** A derive of a library component, which Edit Component edits. */
  component?: boolean;
  /** An assembly joint shown in the assembly's timeline, not a feature. */
  joint?: boolean;
  /** A sketch's degrees of freedom as the display solved it (0: fully constrained); absent for other features or when unknown. */
  dof?: number;
  children: FeatureRow[];
}

/** A feature group of a part's timeline (7.1). */
export interface FeatureGroup {
  id: string;
  name: string;
  members: string[];
}

export interface PartView {
  id: string;
  name: string;
  features: FeatureRow[];
  /** Where the part is rolled back to: the index in `features` of the feature it shows the part before, or `features.length`. */
  rollbackIndex: number;
  groups: FeatureGroup[];
}

const ICON_KEYS: Record<string, string> = {
  'core.sketch': 'sketch',
  'core.extrude': 'extrude',
  'core.revolve': 'revolve',
  'core.loft': 'loft',
  'core.sweep': 'sweep',
  'core.hole': 'hole',
  'core.fillet': 'fillet',
  'core.chamfer': 'chamfer',
  'core.shell': 'shell',
  'core.mirror': 'mirror',
  'core.pattern': 'pattern',
  'core.boolean': 'boolean',
  'core.move': 'move',
  'core.import': 'importedGeometry',
  'core.constructionPlane': 'constructionPlane',
  'core.primitive': 'primitive',
  'core.derive': 'component',
  'core.asm.pattern': 'pattern',
  'core.asm.mirror': 'mirror',
  'core.asm.replicate': 'component',
};

/** What each feature type is called in the interface. */
const TYPE_LABELS: Record<string, string> = {
  'core.sketch': 'Sketch',
  'core.extrude': 'Extrude',
  'core.revolve': 'Revolve',
  'core.loft': 'Loft',
  'core.sweep': 'Sweep',
  'core.hole': 'Hole',
  'core.thread': 'Thread',
  'core.fillet': 'Fillet',
  'core.chamfer': 'Chamfer',
  'core.shell': 'Shell',
  'core.mirror': 'Mirror',
  'core.pattern': 'Pattern',
  'core.boolean': 'Combine',
  'core.move': 'Move',
  'core.removeBody': 'Remove Body',
  'core.import': 'Import',
  'core.composite': 'Composite',
  'core.constructionPlane': 'Plane',
  'core.constructionAxis': 'Axis',
  'core.constructionPoint': 'Point',
  'core.constructionFrame': 'Frame',
  'core.primitive': 'Primitive',
  'core.derive': 'Derive',
  'core.measure': 'Measure',
  'core.asm.pattern': 'Component Pattern',
  'core.asm.mirror': 'Component Mirror',
  'core.asm.replicate': 'Replicate',
};

const SHAPE_LABELS: Record<string, string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  cone: 'Cone',
  torus: 'Torus',
};

/**
 * A feature type's name as the interface shows it ("Loft", "Box"), never
 * the format's type id; `iconKey` names a primitive's shape.
 */
export function featureTypeLabel(type: string, iconKey?: string): string {
  if (type === 'core.primitive' && iconKey !== undefined && SHAPE_LABELS[iconKey]) return SHAPE_LABELS[iconKey];
  const known = TYPE_LABELS[type];
  if (known) return known;
  const words = type
    .replace(/^core\.(asm\.)?/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** True when a feature has a name of its own: not empty, and not just its type id. */
function ownName(feature: Json): boolean {
  const name = typeof feature.name === 'string' ? feature.name.trim() : '';
  return name !== '' && name !== String(feature.type);
}

/**
 * The name a feature shows: its own, or for a feature with none (or one
 * that is only its type id), its type's label, numbered among the part's
 * features of that type without a name ("Sketch 2") when `doc` is given.
 */
export function featureDisplayName(feature: Json, doc?: Doc): string {
  if (ownName(feature)) return String(feature.name).trim();
  const label = featureTypeLabel(String(feature.type), iconKeyOf(feature));
  const part = doc ? partOfFeature(doc, String(feature.id)) : null;
  if (!doc || !part) return label;
  let n = 0;
  let found = 0;
  const visit = (features: unknown): void => {
    if (!Array.isArray(features) || found > 0) return;
    for (const f of features as Json[]) {
      if (f.type === feature.type && !ownName(f) && iconKeyOf(f) === iconKeyOf(feature)) n++;
      if (f.id === feature.id) {
        found = n;
        return;
      }
      visit(f.children);
      if (found > 0) return;
    }
  };
  visit(partOf(doc, part)?.timeline);
  return found > 0 ? `${label} ${found}` : label;
}

/**
 * The names `featureDisplayName` gives the features of one timeline, its
 * groups' children included, in one walk: what a part's rows show.
 */
function displayNames(timeline: unknown): Map<string, string> {
  const counts = new Map<string, number>();
  const out = new Map<string, string>();
  const visit = (features: unknown): void => {
    if (!Array.isArray(features)) return;
    for (const f of features as Json[]) {
      if (ownName(f)) out.set(String(f.id), String(f.name).trim());
      else {
        const icon = iconKeyOf(f);
        const kind = `${String(f.type)}|${icon}`;
        const n = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, n);
        out.set(String(f.id), `${featureTypeLabel(String(f.type), icon)} ${n}`);
      }
      visit(f.children);
    }
  };
  visit(timeline);
  return out;
}

export function iconKeyOf(feature: Json): string {
  const type = String(feature.type);
  if (type === 'core.primitive') {
    const shape = (feature.inputs as Json | undefined)?.shape;
    if (isPlainObject(shape)) {
      const kind = Object.keys(shape)[0];
      if (kind) return kind;
    }
  }
  return ICON_KEYS[type] ?? type.replace(/^core\./, '');
}

/** True when a flag value is the literal `true`. */
export function literalTrue(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const def = value.def;
  if (!isPlainObject(def) || !isPlainObject(def.expr)) return false;
  return String(def.expr.text).trim() === 'true';
}

const FLAG = { type: 'boolean' } as const;

/**
 * Reads flag values (suppressed, grounded) as the document evaluates them:
 * expressions over parameters, with the selected configuration rows
 * applied. A flag that does not evaluate (a measured value, an error) reads
 * as its literal text.
 */
export function flagReader(doc: Doc): (value: unknown) => boolean {
  let reader = flagReaders.get(doc);
  if (!reader) flagReaders.set(doc, (reader = newFlagReader(doc)));
  return reader;
}

/** One reader per document: the evaluator behind it is built once, whoever reads its flags. */
const flagReaders = new WeakMap<Doc, (value: unknown) => boolean>();

function newFlagReader(doc: Doc): (value: unknown) => boolean {
  let values: ValueEvaluator | null | undefined;
  return (value) => {
    if (values === undefined) {
      try {
        values = new ValueEvaluator(doc);
      } catch {
        values = null;
      }
    }
    if (values && isPlainObject(value) && typeof value.id === 'string') {
      try {
        return values.literal(value, FLAG) === true;
      } catch {
        // Falls back to the text.
      }
    }
    return literalTrue(value);
  };
}

export function shownRoot(doc: Doc): ShownRoot {
  const root = doc.root;
  if (!isPlainObject(root)) return null;
  if (isPlainObject(root.part) && typeof root.part.id === 'string') return { part: root.part.id };
  if (isPlainObject(root.assembly) && typeof root.assembly.id === 'string') return { assembly: root.assembly.id };
  return null;
}

export function partsOf(doc: Doc): Json[] {
  return Array.isArray(doc.parts) ? (doc.parts as Json[]) : [];
}

export function partOf(doc: Doc, id: string): Json | undefined {
  return partsOf(doc).find((p) => p.id === id);
}

/** The part a feature belongs to, searching composites too. */
export function partOfFeature(doc: Doc, feature: string): string | null {
  const holds = (features: unknown): boolean =>
    Array.isArray(features) && (features as Json[]).some((f) => f.id === feature || holds(f.children));
  return (partsOf(doc).find((p) => holds(p.timeline))?.id as string | undefined) ?? null;
}

export function findFeature(doc: Doc, feature: string): Json | undefined {
  const find = (features: unknown): Json | undefined => {
    if (!Array.isArray(features)) return undefined;
    for (const f of features as Json[]) {
      if (f.id === feature) return f;
      const inner = find(f.children);
      if (inner) return inner;
    }
    return undefined;
  };
  for (const p of partsOf(doc)) {
    const f = find(p.timeline);
    if (f) return f;
  }
  return undefined;
}

export function partView(doc: Doc, partId: string, display: Display | null): PartView | null {
  const part = partOf(doc, partId);
  if (!part) return null;
  const paused = new Map<string, string>();
  const blocked = new Map<string, string>();
  for (const p of display?.pauses ?? []) {
    paused.set(p.feature, p.message);
    for (const t of p.through ?? []) if (!paused.has(t)) blocked.set(t, p.message);
  }
  const stale = new Map((display?.stale ?? []).map((s) => [s.feature, s.message] as const));
  const hiddenFeatures = new Set<string>();
  for (const a of Array.isArray(part.attributes) ? (part.attributes as Json[]) : []) {
    const target = (a.target as Json | undefined)?.object as Json | undefined;
    const feature = (target?.feature as Json | undefined)?.id;
    const visible = ((a.properties as Json | undefined)?.visible as Json | undefined)?.def as Json | undefined;
    if (typeof feature === 'string' && String((visible?.expr as Json | undefined)?.text ?? '').trim() === 'false')
      hiddenFeatures.add(feature);
  }
  const definition =
    display?.parts[partId] === undefined ? undefined : display.definitions[display.parts[partId] as number];
  const dofs = new Map(
    (definition?.sketches ?? []).flatMap((s) => (s.dof !== undefined ? [[s.feature, s.dof] as const] : [])),
  );
  const flag = flagReader(doc);
  const names = displayNames(part.timeline);
  const rowOf = (f: Json): FeatureRow => {
    const id = String(f.id);
    const dof = dofs.get(id);
    const suppressed = flag(f.suppressed);
    const message = paused.get(id) ?? blocked.get(id);
    const warning = stale.get(id);
    const status: FeatureStatus = suppressed
      ? 'suppressed'
      : paused.has(id)
        ? 'failed'
        : blocked.has(id)
          ? 'blocked'
          : 'success';
    return {
      id,
      name: names.get(id) ?? featureDisplayName(f, doc),
      type: String(f.type),
      iconKey: iconKeyOf(f),
      suppressed,
      frozen: isPlainObject(f.frozen) && 'frozen' in f.frozen,
      status,
      ...(message !== undefined && !suppressed ? { message } : {}),
      ...(status === 'success' && warning !== undefined ? { warning } : {}),
      hidden: hiddenFeatures.has(id),
      ...(f.type === 'core.derive' &&
      isPlainObject((f.inputs as Json | undefined)?.from) &&
      isPlainObject(((f.inputs as Json).from as Json).component)
        ? { component: true }
        : {}),
      ...(dof !== undefined && status === 'success' ? { dof } : {}),
      children: Array.isArray(f.children) ? (f.children as Json[]).map(rowOf) : [],
    };
  };
  const features = (Array.isArray(part.timeline) ? (part.timeline as Json[]) : []).map(rowOf);
  const rollback = part.rollback;
  let rollbackIndex = features.length;
  if (isPlainObject(rollback) && isPlainObject(rollback.before)) {
    const i = features.findIndex((f) => f.id === (rollback.before as Json).id);
    if (i >= 0) rollbackIndex = i;
  }
  const groups = (Array.isArray(part.groups) ? (part.groups as Json[]) : []).map((g) => ({
    id: String(g.id),
    name: String(g.name),
    members: Array.isArray(g.members) ? (g.members as string[]) : [],
  }));
  return { id: partId, name: typeof part.name === 'string' ? part.name : partId, features, rollbackIndex, groups };
}

export interface BodyRow {
  /** The body's key in the shown display, or in the evaluation it was listed from; -1 when neither holds it. */
  key: number;
  /** Its identity, the same in a preview's display and the committed one. */
  id: string;
  name: string;
  feature: string;
  color: string;
  visible: boolean;
}

function definitionOf(display: Display | null, partId: string) {
  const index = display?.parts[partId];
  return index === undefined ? undefined : display?.definitions[index];
}

/**
 * The bodies of a part, one per body, with name, creating feature, colour
 * and visibility. They are `listed`'s bodies (the browser passes the
 * committed display, so a panel's preview adds or drops none), each keyed
 * by the same body's key in `shown`, the display the worker holds.
 *
 * While a panel on a feature of the part is open, `before` holds the part
 * as it stands just before that feature, and the bodies are those: keyed
 * by `shown` where it holds the body, otherwise by the listing's own key
 * while the listing comes from `shown`'s evaluation.
 */
export function bodiesOf(
  shown: Display | null,
  partId: string,
  listed: Display | null = shown,
  before: BeforeListing | null = null,
): BodyRow[] {
  const shownKeys = () => new Map((definitionOf(shown, partId)?.bodies ?? []).map((b) => [b.id, b.key]));
  if (before && before.part === partId) {
    const keys = shownKeys();
    const current = before.generation === shown?.generation;
    return before.bodies.map((b) => ({
      key: keys.get(b.id) ?? (current ? b.key : -1),
      id: b.id,
      name: b.name,
      feature: b.feature,
      color: b.color,
      visible: b.visible,
    }));
  }
  const bodies = definitionOf(listed, partId)?.bodies ?? [];
  const keys = listed === shown ? null : shownKeys();
  return bodies.map((b) => ({
    key: keys ? (keys.get(b.id) ?? -1) : b.key,
    id: b.id,
    name: b.name,
    feature: b.feature,
    color: b.color,
    visible: b.visible,
  }));
}

/**
 * Where the timeline marker shows for `view` while a panel edits `feature`:
 * just after the top-level row that is the feature or holds it, so the rows
 * after it show as rolled back. The part's own rollback when `feature` is
 * absent or not in the part (a new feature, or none edited).
 */
export function markerWhileEditing(view: PartView, feature: string | undefined): number {
  if (feature === undefined) return view.rollbackIndex;
  const holds = (row: FeatureRow): boolean => row.id === feature || row.children.some(holds);
  const index = view.features.findIndex(holds);
  return index < 0 ? view.rollbackIndex : index + 1;
}

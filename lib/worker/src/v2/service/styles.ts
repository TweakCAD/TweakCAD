/**
 * Appearance and visibility from a part's attributes (16.1). A property set
 * on a face wins over its body's, a body's over the feature's that created
 * the body, and a feature's over the part's. After a join an attribute whose
 * target resolves directly wins over one that reaches the body only through
 * an alias; among those, the alias created first wins. An entity is shown
 * when no `visible` along its path is false.
 */
import {
  ValuePause,
  finest,
  resolve,
  type EntityRecord,
  type NamedEntity,
  type NamedState,
  type ShapeKey,
} from '@tweakcad/format';
import { FLAG, INTEGER, RATIO, TEXT, type Evaluation, type Json } from '../context';

/** The colour of a body no attribute colours. */
export const DEFAULT_COLOR = '#6699cc';

/** The properties one attribute sets, read. Absent: not set. */
export interface Properties {
  color?: string;
  opacity?: number;
  visible?: boolean;
  filamentSlot?: number;
  name?: string;
}

const TARGETS: Record<keyof Properties, { type: string; quantity?: string }> = {
  color: TEXT,
  opacity: RATIO,
  visible: FLAG,
  filamentSlot: INTEGER,
  name: TEXT,
};

/** An attribute's properties that evaluate; one that does not is left unset. */
export function readProperties(ev: Evaluation, row: Json): Properties {
  const out: Properties = {};
  const props = (row.properties as Json | undefined) ?? {};
  for (const [name, target] of Object.entries(TARGETS) as [keyof Properties, (typeof TARGETS)[keyof Properties]][]) {
    if (!(name in props)) continue;
    try {
      const v = ev.values.literal(props[name], target as never);
      if (name === 'color' && typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) out.color = v.toLowerCase();
      else if (name === 'opacity' && typeof v === 'number') out.opacity = Math.max(0, Math.min(1, v));
      else if (name === 'visible' && typeof v === 'boolean') out.visible = v;
      else if (name === 'filamentSlot' && typeof v === 'number') out.filamentSlot = v;
      else if (name === 'name' && typeof v === 'string') out.name = v;
    } catch (e) {
      if (!(e instanceof ValuePause)) throw e;
    }
  }
  return out;
}

/** Fills what `into` lacks from `from`. */
function under(into: Properties, from: Properties | undefined): Properties {
  if (!from) return into;
  const out: Properties = { ...into };
  for (const k of Object.keys(from) as (keyof Properties)[])
    if (out[k] === undefined) (out as Record<string, unknown>)[k] = from[k];
  return out;
}

/** The attributes of one part, resolved against one state of it. */
export class PartStyles {
  private readonly part: Properties = {};
  private readonly features = new Map<string, Properties>();
  /** By sub-shape key: properties set directly, then through aliases ordered by creation. */
  private readonly direct = new Map<ShapeKey, Properties>();
  private readonly aliased = new Map<ShapeKey, { rank: [number, string]; props: Properties }[]>();
  private visibleFalse = { part: false };

  constructor(
    private readonly ev: Evaluation,
    row: Json,
    private readonly state: NamedState,
  ) {
    const ordinals = new Map(((row.timeline as Json[]) ?? []).map((f, i) => [f.id as string, i]));
    const sets = new Map(
      ((row.sets as Json[]) ?? []).map((s) => [s.id as string, ((s.members as Json)?.set as Json[]) ?? []]),
    );
    for (const attr of (row.attributes as Json[]) ?? []) {
      const props = readProperties(ev, attr);
      for (const target of this.expand(attr.target as Json, sets)) this.apply(target, props, ordinals);
    }
    this.visibleFalse.part = this.part.visible === false;
  }

  /** A selection target as its members. */
  private expand(target: Json, sets: Map<string, Json[]>, depth = 0): Json[] {
    const selection = target.selection as Json | undefined;
    if (!selection || depth > 8) return [target];
    return (sets.get(selection.id as string) ?? []).flatMap((m) => this.expand(m, sets, depth + 1));
  }

  private apply(target: Json, props: Properties, ordinals: Map<string, number>): void {
    const object = target.object as Json | undefined;
    if (object?.part) {
      Object.assign(this.part, props);
      return;
    }
    if (object?.feature) {
      const id = (object.feature as Json).id as string;
      this.features.set(id, { ...this.features.get(id), ...props });
      return;
    }
    const record = target.entity as EntityRecord | undefined;
    if (!record) return;
    const found = resolve(record, this.state, this.ev.adapter);
    if (found.outcome !== 'same') return;
    const hash = finest(record.id);
    for (const e of found.entities) {
      if (e.ladder.includes(hash)) {
        this.direct.set(e.key, { ...this.direct.get(e.key), ...props });
        continue;
      }
      const level = this.ev.names.get(hash) as Json | undefined;
      const feature = ((level?.feature as Json | undefined)?.id as string | undefined) ?? '';
      const list = this.aliased.get(e.key) ?? [];
      list.push({ rank: [ordinals.get(feature) ?? Number.MAX_SAFE_INTEGER, hash], props });
      list.sort((a, b) => a.rank[0] - b.rank[0] || (a.rank[1] < b.rank[1] ? -1 : a.rank[1] > b.rank[1] ? 1 : 0));
      this.aliased.set(e.key, list);
    }
  }

  /** What is set on one entity itself: directly, then through its aliases. */
  private own(key: ShapeKey): Properties {
    let out: Properties = { ...this.direct.get(key) };
    for (const a of this.aliased.get(key) ?? []) out = under(out, a.props);
    return out;
  }

  /** A body's properties: its own, then its feature's, then the part's. */
  body(body: NamedEntity): Properties {
    const props = under(under(this.own(body.key), this.features.get(body.createdBy)), this.part);
    // Visibility is not inherited by precedence: any false along the path hides it.
    const hidden =
      this.own(body.key).visible === false ||
      this.features.get(body.createdBy)?.visible === false ||
      this.visibleFalse.part;
    return { ...props, visible: !hidden };
  }

  /** A face's properties over its body's. */
  face(face: NamedEntity, body: Properties): Properties {
    const own = this.own(face.key);
    const props = under(own, body);
    return { ...props, visible: body.visible !== false && own.visible !== false };
  }

  /** Whether something a feature made (a sketch, a construction output) is shown. */
  featureShown(feature: string): boolean {
    return !this.visibleFalse.part && this.features.get(feature)?.visible !== false;
  }
}

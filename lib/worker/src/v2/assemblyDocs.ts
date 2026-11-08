/**
 * Composes version-2 documents with several parts, assemblies and library
 * components, for tests: parts of boxes with public parameters, derives,
 * instances, joint origins, joints, relations and assembly features.
 * References into instances are written as an editor would, from the name
 * the part gives the entity with the instance path's steps in its `chain`.
 */
import { NameTable, base32Encode, ladderOf, makeSet, nameHash, type CopyStep, type JsonValue } from '@tweakcad/format';
import { instanceStep } from './variants';

type Json = Record<string, unknown>;
type V3 = readonly [number, number, number];

export class Docs {
  readonly names = new NameTable();
  private counter = 0;
  readonly parameters: Json[] = [];
  readonly parts: Json[] = [];
  readonly assemblies: Json[] = [];
  readonly library: Json[] = [];

  constructor(private readonly seed = 0) {}

  id(kind: string): string {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, this.seed);
    view.setUint32(12, ++this.counter);
    return `${kind}_${base32Encode(bytes)}`;
  }

  /** A value object; `refs` names parameters by id. */
  val(text: string, refs: Record<string, string> = {}): Json {
    const bound = Object.fromEntries(
      Object.entries(refs).map(([name, id]) => [
        name,
        id.startsWith('par_') ? { parameter: { id } } : id.startsWith('lib_') ? { library: { id } } : { value: { id } },
      ]),
    );
    return { id: this.id('val'), def: { expr: { text, grammar: 1, refs: bound } } };
  }

  flag(on: boolean): Json {
    return this.val(on ? 'true' : 'false');
  }

  placementValue(at: V3 = [0, 0, 0], turnZ = 0): Json {
    return this.val(`placement(vector(${at[0]} mm, ${at[1]} mm, ${at[2]} mm), rotate(vector(0, 0, 1), ${turnZ} deg))`);
  }

  part(name: string): PartDraft {
    const draft = new PartDraft(this, name);
    this.parts.push(draft.json);
    return draft;
  }

  assembly(name: string): AssemblyDraft {
    const draft = new AssemblyDraft(this, name);
    this.assemblies.push(draft.json);
    return draft;
  }

  /** Embeds `doc` as a library document entry; returns its id. */
  embed(doc: Json, name = 'Component'): string {
    const id = this.id('lib');
    const content = { inline: { definition: doc } };
    this.library.push({
      id,
      hash: nameHash(content as JsonValue),
      kind: 'document',
      content,
      source: { local: {} },
      name,
    });
    return id;
  }

  document(root: Json): Json {
    return {
      format: 'tweakcad.document',
      schemaVersion: 2,
      namingRules: 1,
      id: this.id('doc'),
      metadata: {
        name: 'Test',
        description: '',
        createdAt: '2026-11-05T00:00:00Z',
        updatedAt: '2026-11-05T00:00:00Z',
        writer: { app: 'test', version: '0' },
        origin: { original: {} },
      },
      properties: {},
      settings: {},
      parameters: this.parameters,
      parts: this.parts,
      assemblies: this.assemblies,
      root,
      folders: [],
      views: [],
      library: this.library,
      assets: {},
      names: this.names.toJson(),
    };
  }

  /** A reference whose name is the entity's in its part with `steps` appended (9.5); box faces stop at level 1. */
  ref(kind: 'face' | 'body', feature: string, role: string, steps: readonly CopyStep[] = [], src: Json[] = []): Json {
    const id = ladderOf({ kind, chain: steps, feature, role, src: src as never }, this.names);
    return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
  }

  /** A face of a box primitive seen through an instance (`role` +x, -z, …). */
  faceThrough(instance: string, feature: string, role: string): Json {
    return this.ref('face', feature, role, [instanceStep(instance)]);
  }

  /** An attached frame on one face in mode `plane`, optionally flipped and offset. */
  planeFrame(face: Json, o: { flip?: boolean; at?: V3; turnZ?: number } = {}): Json {
    return {
      attach: {
        support: [face],
        mode: this.val('"plane"'),
        offset: this.placementValue(o.at, o.turnZ),
        flip: this.flag(o.flip ?? false),
      },
    };
  }

  fixedFrame(at: V3 = [0, 0, 0], turnZ = 0): Json {
    return { fixed: { placement: this.placementValue(at, turnZ) } };
  }

  override(target: string, text: string, refs: Record<string, string> = {}): Json {
    const kind = target.startsWith('par_') ? 'parameter' : 'value';
    const v = this.val(text, refs);
    return { value: { target: { [kind]: { id: target } }, def: v.def } };
  }

  feature(type: string, inputs: Json): Json {
    return {
      id: this.id('feat'),
      type,
      typeVersion: 1,
      name: type,
      suppressed: this.flag(false),
      frozen: { live: {} },
      command: { alone: {} },
      inputs,
    };
  }

  parameter(name: string, text: string, o: { public?: boolean; quantity?: string; type?: string } = {}): Json {
    return {
      id: this.id('par'),
      name,
      type: o.type ?? 'number',
      ...((o.type ?? 'number') === 'number' ? { quantity: o.quantity ?? 'length' } : {}),
      value: this.val(text),
      range: { unbounded: {} },
      public: o.public ?? false,
      published: false,
      description: '',
    };
  }
}

export class PartDraft {
  readonly json: Json;
  readonly id: string;
  private readonly table: Json[] = [];

  constructor(
    private readonly d: Docs,
    name: string,
  ) {
    this.id = d.id('part');
    this.json = {
      id: this.id,
      name,
      parameters: [{ id: d.id('tbl'), name: 'Parameters', parameters: this.table }],
      timeline: [],
      rollback: { end: {} },
      groups: [],
      sets: [],
      contexts: [],
      attributes: [],
      configurations: [],
      notes: [],
      properties: {},
    };
  }

  /** A parameter of this part; returns its id. */
  parameter(name: string, text: string, isPublic = true): string {
    const p = this.d.parameter(name, text, { public: isPublic });
    this.table.push(p);
    return p.id as string;
  }

  add(feature: Json): string {
    (this.json.timeline as Json[]).push(feature);
    return feature.id as string;
  }

  /**
   * A box centred at `at`. Each dimension is value text, or a parameter id
   * the dimension takes as it is.
   */
  box(width: string, depth: string, height: string, at: V3 = [0, 0, 0], op: 'new' | 'join' = 'new'): string {
    const dim = (v: string) => (v.startsWith('par_') ? this.d.val('p', { p: v }) : this.d.val(v));
    return this.add(
      this.d.feature('core.primitive', {
        shape: { box: { width: dim(width), depth: dim(depth), height: dim(height) } },
        frame: this.d.fixedFrame(at),
        operation: { op: this.d.val(`"${op}"`), targets: { all: {} }, keepTools: this.d.flag(false) },
      }),
    );
  }

  /** A `core.derive` of every body of `from`, placed at `at`. */
  derive(
    from: Json,
    o: { overrides?: Json[]; at?: V3; mirror?: string; op?: 'new' | 'join' | 'cut' | 'intersect'; items?: Json[] } = {},
  ): string {
    return this.add(
      this.d.feature('core.derive', {
        from,
        instance: this.d.id('inst'),
        items: o.items ? { items: makeSet(o.items) } : { all: {} },
        overrides: o.overrides ?? [],
        frame: this.d.fixedFrame(o.at),
        operation: { op: this.d.val(`"${o.op ?? 'new'}"`), targets: { all: {} }, keepTools: this.d.flag(false) },
        ...(o.mirror ? { mirror: { plane: { standard: { name: o.mirror } } } } : {}),
      }),
    );
  }
}

export interface InstanceOptions {
  at?: V3;
  turnZ?: number;
  grounded?: boolean;
  suppressed?: boolean;
  overrides?: Json[];
}

/** A unit quaternion about z, in the canonical sign. */
function aboutZ(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  const q: [number, number, number, number] = [0, 0, Math.sin(h), Math.cos(h)];
  return q[3] < 0 ? (q.map((c) => -c) as typeof q) : q;
}

export class AssemblyDraft {
  readonly json: Json;
  readonly id: string;

  constructor(
    private readonly d: Docs,
    name: string,
  ) {
    this.id = d.id('asm');
    this.json = {
      id: this.id,
      name,
      parameters: [],
      configurations: [],
      instances: [],
      jointOrigins: [],
      joints: [],
      relations: [],
      rigidGroups: [],
      contactSets: [],
      timeline: [],
      positions: [],
      activePosition: { current: {} },
      explodedViews: [],
      attributes: [],
      notes: [],
      properties: {},
      solver: 1,
    };
  }

  private rows(table: string): Json[] {
    return this.json[table] as Json[];
  }

  instance(of: Json, o: InstanceOptions = {}): string {
    const id = this.d.id('inst');
    this.rows('instances').push({
      id,
      of,
      placement: { position: [...(o.at ?? [0, 0, 0])], rotation: aboutZ(o.turnZ ?? 0) },
      grounded: this.d.flag(o.grounded ?? false),
      suppressed: this.d.flag(o.suppressed ?? false),
      overrides: o.overrides ?? [],
    });
    return id;
  }

  origin(frame: Json): string {
    const id = this.d.id('jor');
    this.rows('jointOrigins').push({ id, frame });
    return id;
  }

  /** A joint between two ends, each a joint origin's id or `{"frame": attached frame}`. */
  joint(
    kind: string,
    a: string | Json,
    b: string | Json,
    o: {
      state?: Record<string, number>;
      rest?: Record<string, string>;
      limits?: Record<string, [string, string]>;
    } = {},
  ): string {
    const id = this.d.id('jnt');
    const end = (e: string | Json) => (typeof e === 'string' ? { origin: { id: e } } : e);
    this.rows('joints').push({
      id,
      kind,
      a: end(a),
      b: end(b),
      limits: Object.fromEntries(
        Object.entries(o.limits ?? {}).map(([k, [min, max]]) => [
          k,
          { between: { min: this.d.val(min), max: this.d.val(max) } },
        ]),
      ),
      rest: Object.fromEntries(Object.entries(o.rest ?? {}).map(([k, v]) => [k, this.d.val(v)])),
      state: o.state ?? {},
      suppressed: this.d.flag(false),
    });
    return id;
  }

  relation(kind: string, joints: string[], ratio: string): string {
    const id = this.d.id('rel');
    this.rows('relations').push({ id, kind, joints, ratio: this.d.val(ratio) });
    return id;
  }

  feature(type: string, inputs: Json): string {
    const f = this.d.feature(type, inputs);
    this.rows('timeline').push(f);
    return f.id as string;
  }

  position(name: string, state: Record<string, Record<string, number>>): string {
    const id = this.d.id('pos');
    this.rows('positions').push({ id, name, state });
    return id;
  }

  exploded(name: string, steps: { instances: Json[]; at: V3 }[]): string {
    const id = this.d.id('exp');
    this.rows('explodedViews').push({
      id,
      name,
      steps: steps.map((s) => ({ instances: makeSet(s.instances), transform: this.d.placementValue(s.at) })),
    });
    return id;
  }
}

/** An instance path of one instance. */
export const pathOf = (...steps: Json[]): Json => ({ path: steps });
export const instancePath = (id: string): Json => ({ instance: { id } });

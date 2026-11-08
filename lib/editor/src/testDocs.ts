/**
 * Small version-2 documents for the editor's tests: parameter tables, a
 * part with a rectangle sketch whose region is detected as the editor
 * writes it, an extrude of that region, and an assembly with instances,
 * joint origins, a joint and a position. Ids are deterministic.
 */
import {
  NameTable,
  base32Encode,
  detectRegions,
  idItem,
  isPlainObject,
  ladderOf,
  makeSet,
  type SolvedCurve,
  type SolvedSketch,
} from '@tweakcad/format';
import type { Json } from './rows';

export const PLACEMENT_TEXT = 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))';

export class TestDoc {
  readonly names = new NameTable();
  readonly parameters: Json[] = [];
  readonly parts: Json[] = [];
  readonly assemblies: Json[] = [];
  private counter = 0;

  /** A fresh id whose first byte sets it apart from generated ones. */
  id(kind: string): string {
    const bytes = new Uint8Array(16);
    bytes[0] = 0xee;
    new DataView(bytes.buffer).setUint32(12, ++this.counter);
    return `${kind}_${base32Encode(bytes)}`;
  }

  /** A value object; `refs` names parameters (`par_`) or values (`val_`) by id. */
  val(text: string, refs: Record<string, string> = {}, extra: Json = {}): Json {
    const bound = Object.fromEntries(
      Object.entries(refs).map(([name, id]) => [
        name,
        id.startsWith('par_') ? { parameter: { id } } : { value: { id } },
      ]),
    );
    return { id: this.id('val'), ...extra, def: { expr: { text, grammar: 1, refs: bound } } };
  }

  flag(on: boolean): Json {
    return this.val(on ? 'true' : 'false');
  }

  parameter(
    name: string,
    text: string,
    o: { type?: string; quantity?: string; options?: string[]; refs?: Record<string, string> } = {},
  ): Json {
    const type = o.type ?? 'number';
    return {
      id: this.id('par'),
      name,
      type,
      ...(type === 'number' ? { quantity: o.quantity ?? 'length' } : {}),
      ...(o.options ? { options: o.options } : {}),
      value: this.val(text, o.refs ?? {}),
      range: { unbounded: {} },
      public: false,
      published: false,
      description: '',
    };
  }

  table(name: string, parameters: Json[]): Json {
    return { id: this.id('tbl'), name, parameters };
  }

  feature(type: string, inputs: Json, name = type): Json {
    return {
      id: this.id('feat'),
      type,
      typeVersion: 1,
      name,
      suppressed: this.flag(false),
      frozen: { live: {} },
      command: { alone: {} },
      inputs,
    };
  }

  part(name: string): Json {
    const part: Json = {
      id: this.id('part'),
      name,
      parameters: [],
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
    this.parts.push(part);
    return part;
  }

  assembly(name: string): Json {
    const assembly: Json = {
      id: this.id('asm'),
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
    this.assemblies.push(assembly);
    return assembly;
  }

  fixedFrame(): Json {
    return { fixed: { placement: this.val(PLACEMENT_TEXT) } };
  }

  point(x: number, y: number): Json {
    return { id: this.id('pt'), x, y };
  }

  line(start: string, end: string): Json {
    return { id: this.id('crv'), kind: 'line', construction: this.flag(false), origin: { drawn: {} }, start, end };
  }

  /** A sketch on the xy plane with an axis-aligned rectangle; its region row is detected. */
  rectangleSketch(
    x: number,
    y: number,
    w: number,
    h: number,
  ): { feature: Json; points: string[]; lines: string[]; region: string } {
    const points = [this.point(x, y), this.point(x + w, y), this.point(x + w, y + h), this.point(x, y + h)];
    const lines = points.map((p, i) => this.line(p.id as string, (points[(i + 1) % 4] as Json).id as string));
    const inputs: Json = {
      frame: {
        attach: {
          support: [{ standard: { name: 'xy' } }],
          mode: this.val('"plane"'),
          offset: this.val(PLACEMENT_TEXT),
          flip: this.flag(false),
        },
      },
      points,
      curves: lines,
      constraints: [],
      regions: [],
      retired: [],
      text: [],
    };
    const regions = detectRegions(solvedSketch(inputs)).regions.map((r) => ({
      id: this.id('reg'),
      loop: r.loop,
      holes: r.holes,
      origin: { detected: {} },
    }));
    inputs.regions = regions;
    return {
      feature: this.feature('core.sketch', inputs, 'Sketch'),
      points: points.map((p) => p.id as string),
      lines: lines.map((l) => l.id as string),
      region: (regions[0] as Json).id as string,
    };
  }

  /** A reference to a sketch region, with its names interned. */
  regionRef(feature: string, region: string, names: NameTable = this.names): Json {
    const id = ladderOf({ kind: 'region', chain: [], feature, role: 'region', src: [idItem(region)] }, names);
    return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
  }

  extrude(sketch: string, profiles: Json[], depth: Json): Json {
    return this.feature(
      'core.extrude',
      {
        profiles: makeSet(profiles),
        sides: [{ extent: { distance: { d: depth } }, taper: this.val('0 deg') }],
        direction: { normal: { ref: { object: { feature: { id: sketch } } }, reversed: this.flag(false) } },
        thin: { solid: {} },
        operation: { op: this.val('"new"'), targets: { all: {} }, keepTools: this.flag(false) },
      },
      'Extrude',
    );
  }

  instance(part: string): Json {
    return {
      id: this.id('inst'),
      of: { part: { id: part } },
      placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      grounded: this.flag(false),
      suppressed: this.flag(false),
      overrides: [],
    };
  }

  document(root?: Json): Json {
    const first = this.parts[0];
    return {
      format: 'tweakcad.document',
      schemaVersion: 2,
      namingRules: 1,
      id: this.id('doc'),
      metadata: {
        name: 'Test',
        description: '',
        createdAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:00Z',
        writer: { app: 'test', version: '0' },
        origin: { original: {} },
      },
      properties: {},
      settings: {},
      parameters: this.parameters,
      parts: this.parts,
      assemblies: this.assemblies,
      root: root ?? (first ? { part: { id: first.id } } : { parameters: {} }),
      folders: [],
      views: [],
      library: [],
      assets: {},
      names: this.names.toJson(),
    };
  }
}

/**
 * The solved geometry of a sketch's line, circle and arc rows at their
 * stored positions, for region detection; construction curves are left out.
 */
export function solvedSketch(inputs: Json): SolvedSketch {
  const points = (inputs.points as Json[]).map((p) => ({ id: p.id as string, x: p.x as number, y: p.y as number }));
  const at = new Map(points.map((p) => [p.id, [p.x, p.y] as const]));
  const pt = (id: unknown) => {
    const p = at.get(id as string);
    if (!p) throw new Error(`no point ${String(id)}`);
    return p;
  };
  const curves: SolvedCurve[] = [];
  for (const c of inputs.curves as Json[]) {
    const construction = c.construction;
    if (isPlainObject(construction) && JSON.stringify(construction.def).includes('"text":"true"')) continue;
    const key = { drawn: { id: rootOf(c, inputs) } };
    if (c.kind === 'line') {
      curves.push({
        key,
        shape: { kind: 'line', start: pt(c.start), end: pt(c.end) },
        anchors: { kind: 'points', start: c.start as string, end: c.end as string },
      });
    } else if (c.kind === 'circle') {
      curves.push({
        key,
        shape: { kind: 'circle', center: pt(c.center), radius: c.radius as number },
        anchors: { kind: 'none' },
      });
    } else if (c.kind === 'arc') {
      curves.push({
        key,
        shape: { kind: 'arc', center: pt(c.center), start: pt(c.start), end: pt(c.end) },
        anchors: { kind: 'points', start: c.start as string, end: c.end as string },
      });
    }
  }
  return { points, curves };
}

function rootOf(curve: Json, inputs: Json): string {
  const parents = new Map<string, string>();
  for (const c of inputs.curves as Json[]) {
    const from = (c.origin as Json).from as Json | undefined;
    if (from) parents.set(c.id as string, from.id as string);
  }
  for (const r of inputs.retired as Json[]) {
    const was = (r.was as Json).curve as Json | undefined;
    const from = was && ((was.origin as Json).from as Json | undefined);
    if (from) parents.set(r.id as string, from.id as string);
  }
  let id = curve.id as string;
  const seen = new Set<string>();
  while (parents.has(id) && !seen.has(id)) {
    seen.add(id);
    id = parents.get(id) as string;
  }
  return id;
}

/** The ids of `standardDocument`'s rows. */
export interface StandardIds {
  docTable: string;
  width: string;
  size: string;
  part: string;
  partTable: string;
  height: string;
  sketch: string;
  points: string[];
  lines: string[];
  region: string;
  dimension: string;
  extrude: string;
  depth: string;
  extrude2: string;
  configuration: string;
  attribute: string;
  selection: string;
  note: string;
  assembly: string;
  instances: string[];
  origins: string[];
  joint: string;
  position: string;
}

/**
 * A document with something of every kind the commands edit: document and
 * part parameters, a sketch with a dimension, two extrudes whose depths
 * chain through a named value, a configuration, an attribute, a selection
 * set, a note, and an assembly of two instances joined by a revolute joint.
 */
export function standardDocument(): { doc: Json; ids: StandardIds; t: TestDoc } {
  const t = new TestDoc();
  const width = t.parameter('width', '40 mm');
  const size = t.parameter('size', '"small"', { type: 'choice', options: ['small', 'large'] });
  const docTable = t.table('Document', [width, size]);
  t.parameters.push(docTable);

  const part = t.part('Bracket');
  const height = t.parameter('height', 'width / 2', { refs: { width: width.id as string } });
  const partTable = t.table('Bracket', [height]);
  (part.parameters as Json[]).push(partTable);

  const sketch = t.rectangleSketch(0, 0, 40, 20);
  const sketchInputs = sketch.feature.inputs as Json;
  const dimension = {
    id: t.id('con'),
    kind: 'distanceX',
    active: t.flag(true),
    a: { point: { id: sketch.points[0] } },
    b: { point: { id: sketch.points[1] } },
    value: t.val('width', { width: width.id as string }),
    solved: 40,
    label: { auto: {} },
  };
  (sketchInputs.constraints as Json[]).push(dimension);
  const timeline = part.timeline as Json[];
  timeline.push(sketch.feature);

  const sketchId = sketch.feature.id as string;
  const depth = t.val('height', { height: height.id as string }, { name: 'depth' });
  const extrude = t.extrude(sketchId, [t.regionRef(sketchId, sketch.region)], depth);
  timeline.push(extrude);
  const extrude2 = t.extrude(
    sketchId,
    [t.regionRef(sketchId, sketch.region)],
    t.val('depth * 2', { depth: depth.id as string }),
  );
  extrude2.name = 'Extrude 2';
  timeline.push(extrude2);

  const override = (text: string) => ({ value: { target: { parameter: { id: height.id } }, def: t.val(text).def } });
  const configuration = {
    id: t.id('cfg'),
    input: { id: size.id },
    rows: [
      { option: { equals: { literal: 'small' } }, overrides: [override('10 mm')] },
      { option: { equals: { literal: 'large' } }, overrides: [override('30 mm')] },
    ],
  };
  (part.configurations as Json[]).push(configuration);

  const attribute = {
    id: t.id('attr'),
    target: { object: { part: { id: part.id } } },
    properties: { color: t.val('"#ff0000"') },
  };
  (part.attributes as Json[]).push(attribute);
  const selection = { id: t.id('set'), name: 'Top', members: makeSet([t.regionRef(sketchId, sketch.region)]) };
  (part.sets as Json[]).push(selection);
  const note = { id: t.id('note'), anchor: { at: { v: [0, 0, 0] } }, text: 'Check the depth', kind: 'info' };
  (part.notes as Json[]).push(note);

  const assembly = t.assembly('Assembly');
  const instances = [t.instance(part.id as string), t.instance(part.id as string)];
  (instances[0] as Json).grounded = t.flag(true);
  (assembly.instances as Json[]).push(...instances);
  const origins = [
    { id: t.id('jor'), frame: t.fixedFrame() },
    { id: t.id('jor'), frame: t.fixedFrame() },
  ];
  (assembly.jointOrigins as Json[]).push(...origins);
  const joint = {
    id: t.id('jnt'),
    kind: 'revolute',
    a: { origin: { id: (origins[0] as Json).id } },
    b: { origin: { id: (origins[1] as Json).id } },
    limits: {},
    rest: {},
    state: { rz: 0 },
    suppressed: t.flag(false),
  };
  (assembly.joints as Json[]).push(joint);
  const position = { id: t.id('pos'), name: 'Open', state: { [joint.id]: { rz: 45 } } };
  (assembly.positions as Json[]).push(position);

  const doc = t.document({ part: { id: part.id } });
  return {
    doc,
    t,
    ids: {
      docTable: docTable.id as string,
      width: width.id as string,
      size: size.id as string,
      part: part.id as string,
      partTable: partTable.id as string,
      height: height.id as string,
      sketch: sketchId,
      points: sketch.points,
      lines: sketch.lines,
      region: sketch.region,
      dimension: dimension.id,
      extrude: extrude.id as string,
      depth: depth.id as string,
      extrude2: extrude2.id as string,
      configuration: configuration.id,
      attribute: attribute.id,
      selection: selection.id,
      note: note.id,
      assembly: assembly.id as string,
      instances: instances.map((i) => i.id as string),
      origins: origins.map((o) => o.id),
      joint: joint.id,
      position: position.id,
    },
  };
}

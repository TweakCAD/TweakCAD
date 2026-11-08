import { describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { contentHash, nameHash } from '../hash';
import { readDocument, type ReadResult } from './document';
import type { Json } from './reader';

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
let nextValue = 1;
const val = (text: string): Json => ({ id: id('val', nextValue++), def: { expr: { text, grammar: 1, refs: {} } } });

const PART = id('part', 1);
const bytes = new TextEncoder().encode('DBRep_DrawableShape\n');
const ASSET = contentHash(bytes);
const base64 = btoa(String.fromCharCode(...bytes));
const asset = (extra: Json = {}): Json => ({
  mediaType: 'model/x-brep',
  name: 'shape.brep',
  size: bytes.length,
  data: { inline: { base64 } },
  ...extra,
});

const stored = (map: Json[] = [], representation: Json = { name: 'brep', version: 1 }): Json => ({
  asset: ASSET,
  representation,
  map,
});
const entry = (children: number[]): Json => ({
  ladder: [],
  aliases: { set: [] },
  branch: [],
  snapshot: {},
  children: { set: children },
});

function part(extra: Json = {}): Json {
  return {
    id: PART,
    name: 'Part',
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
    ...extra,
  };
}

function doc(extra: Json = {}, partExtra: Json = {}): Json {
  return {
    format: 'tweakcad.document',
    schemaVersion: 2,
    namingRules: 1,
    id: id('doc', 1),
    metadata: {
      name: 'Storage',
      description: '',
      createdAt: '2026-11-05T00:00:00Z',
      updatedAt: '2026-11-05T00:00:00Z',
      writer: { app: 'test', version: '0' },
      origin: { original: {} },
    },
    properties: {},
    settings: {},
    parameters: [],
    parts: [part(partExtra)],
    assemblies: [],
    root: { part: { id: PART } },
    folders: [],
    views: [],
    library: [],
    assets: {},
    names: {},
    ...extra,
  };
}

const feature = (n: number, type: string, inputs: Json, extra: Json = {}): Json => ({
  id: id('feat', n),
  type,
  typeVersion: 1,
  name: type,
  suppressed: val('false'),
  frozen: { live: {} },
  command: { alone: {} },
  inputs,
  ...extra,
});

const importInputs = (extra: Json = {}): Json => ({
  source: { file: { asset: ASSET } },
  stored: stored([entry([1]), entry([])]),
  importer: { format: 'step', version: '1' },
  units: val('"mm"'),
  upAxis: val('"z"'),
  ...extra,
});

const read = (value: Json): ReadResult => readDocument(JSON.parse(JSON.stringify(value)));
const codes = (result: ReadResult, severity: string) =>
  result.diagnostics.filter((d) => d.severity === severity).map((d) => `${d.code} ${d.path}`);

describe('assets and imports', () => {
  it('reads an import whose asset is inline and verified', () => {
    const result = read(
      doc({ assets: { [ASSET]: asset() } }, { timeline: [feature(1, 'core.import', importInputs())] }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses inline data that does not match its hash or size', () => {
    const other = contentHash(new TextEncoder().encode('other'));
    expect(codes(read(doc({ assets: { [other]: asset() } })), 'refuse')).toEqual([`bad-hash /assets/${other}`]);
    expect(codes(read(doc({ assets: { [ASSET]: asset({ size: 3 }) } })), 'refuse')).toEqual([
      `bad-value /assets/${ASSET}/size`,
    ]);
  });

  it('refuses altered data under a key it verified before', () => {
    expect(codes(read(doc({ assets: { [ASSET]: asset() } })), 'refuse')).toEqual([]);
    // The same length of other bytes, then the right bytes with the wrong size, under the same key.
    const altered = btoa(String.fromCharCode(...bytes.map((b, i) => (i === 0 ? b + 1 : b))));
    expect(
      codes(read(doc({ assets: { [ASSET]: asset({ data: { inline: { base64: altered } } }) } })), 'refuse'),
    ).toEqual([`bad-hash /assets/${ASSET}`]);
    expect(codes(read(doc({ assets: { [ASSET]: asset({ size: bytes.length + 1 }) } })), 'refuse')).toEqual([
      `bad-value /assets/${ASSET}/size`,
    ]);
    expect(codes(read(doc({ assets: { [ASSET]: asset() } })), 'refuse')).toEqual([]);
  });

  it('refuses a used asset missing from assets', () => {
    const result = read(doc({}, { timeline: [feature(1, 'core.import', importInputs())] }));
    expect(codes(result, 'refuse')).toEqual([
      'dangling /parts/0/timeline/0/inputs/source/file/asset',
      'dangling /parts/0/timeline/0/inputs/stored/asset',
    ]);
  });

  it('pauses an unknown representation and refuses a broken shape map', () => {
    const unknownRep = importInputs({ stored: stored([], { name: 'brep', version: 9 }) });
    const result = read(doc({ assets: { [ASSET]: asset() } }, { timeline: [feature(1, 'core.import', unknownRep)] }));
    expect(codes(result, 'pause')).toEqual(['unknown-version /parts/0/timeline/0/inputs/stored/representation']);
    const badMap = importInputs({ stored: stored([entry([5])]) });
    const broken = read(doc({ assets: { [ASSET]: asset() } }, { timeline: [feature(1, 'core.import', badMap)] }));
    expect(codes(broken, 'refuse')).toEqual(['bad-value /parts/0/timeline/0/inputs/stored/map/0/children/set/0']);
  });
});

describe('frozen features', () => {
  const frozen = (effects: Json[], values: Json = {}) => ({ frozen: { effects, construction: [], values } });
  const body = { kind: 'body', chain: [], feature: { id: id('feat', 1) } };
  const key = { hash: nameHash(body), branch: [] };

  it('reads stored effects and typed literals; a frozen feature of an unknown type does not pause', () => {
    const size = val('10 mm');
    const f = feature(
      1,
      'acme.box',
      { size },
      {
        frozen: frozen([{ create: { ladder: [], branch: [], stored: stored() } }, { remove: { body: key } }], {
          [size.id as string]: { type: 'number', quantity: 'length', value: 10 },
        }),
      },
    );
    const result = read(doc({ assets: { [ASSET]: asset() }, names: { [key.hash]: body } }, { timeline: [f] }));
    expect(codes(result, 'refuse')).toEqual([]);
    expect(codes(result, 'pause')).toEqual([]);
    const live = read(doc({}, { timeline: [feature(1, 'acme.box', { size: val('10 mm') })] }));
    expect(codes(live, 'pause')).toEqual(['unknown-variant /parts/0/timeline/0/type']);
  });

  it('refuses a typed literal for a value that does not exist', () => {
    const f = feature(
      1,
      'acme.box',
      {},
      {
        frozen: frozen([], { [id('val', 99)]: { type: 'boolean', value: true } }),
      },
    );
    expect(codes(read(doc({}, { timeline: [f] })), 'refuse')).toEqual([
      `dangling /parts/0/timeline/0/frozen/frozen/values/${id('val', 99)}`,
    ]);
  });
});

describe('library', () => {
  const embedded = (): Json => ({
    ...doc(),
    id: id('doc', 2),
    assets: { [ASSET]: { mediaType: 'model/x-brep', name: 'shape.brep', size: bytes.length } },
  });
  const entryFor = (definition: Json, extra: Json = {}): Json => ({
    id: id('lib', 1),
    kind: 'document',
    content: { inline: { definition } },
    hash: nameHash({ inline: { definition } }),
    source: { catalogue: { id: 'bolt-m3', version: '1', policy: 'pinned' } },
    name: 'Bolt',
    ...extra,
  });

  it('reads an embedded document whose assets the host holds', () => {
    const result = read(doc({ library: [entryFor(embedded())], assets: { [ASSET]: asset() } }));
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a wrong content hash and embedded assets the host lacks', () => {
    expect(
      codes(
        read(doc({ library: [entryFor(embedded(), { hash: nameHash({}) })], assets: { [ASSET]: asset() } })),
        'refuse',
      ),
    ).toEqual(['bad-hash /library/0/hash']);
    expect(codes(read(doc({ library: [entryFor(embedded())] })), 'refuse')).toEqual([
      `dangling /library/0/content/inline/definition/assets/${ASSET}`,
    ]);
  });

  it("refuses bytes in an embedded document's asset row, and a host row without data", () => {
    const inner = embedded();
    (inner.assets as Json)[ASSET] = asset({ data: { inline: { base64: 'AAAA' } } });
    expect(codes(read(doc({ library: [entryFor(inner)], assets: { [ASSET]: asset() } })), 'refuse')).toEqual([
      `bad-value /library/0/content/inline/definition/assets/${ASSET}/data`,
    ]);
    const bare = asset();
    delete bare.data;
    expect(codes(read(doc({ assets: { [ASSET]: bare } })), 'refuse')).toEqual([`missing-field /assets/${ASSET}/data`]);
  });

  it('reports problems inside an embedded document at their full path', () => {
    const inner = { ...embedded(), futureThing: 1 };
    const result = read(doc({ library: [entryFor(inner)], assets: { [ASSET]: asset() } }));
    expect(codes(result, 'pause')).toEqual(['unknown-key /library/0/content/inline/definition/futureThing']);
  });
});

describe('assemblies and captured contexts', () => {
  const ASM = id('asm', 1);
  const inst = (n: number, of: Json) => ({
    id: id('inst', n),
    of,
    placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    grounded: val('false'),
    suppressed: val('false'),
    overrides: [],
  });
  const assembly = (extra: Json = {}): Json => ({
    id: ASM,
    name: 'Assembly',
    parameters: [],
    configurations: [],
    instances: [inst(1, { part: { id: PART } }), inst(2, { part: { id: PART } })],
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
    ...extra,
  });
  const frame = () => ({
    fixed: { placement: val('placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))') },
  });
  const joint = (kind: string, extra: Json = {}): Json => ({
    id: id('jnt', 1),
    kind,
    a: { frame: frame() },
    b: { frame: frame() },
    limits: {},
    rest: {},
    state: {},
    suppressed: val('false'),
    ...extra,
  });

  it("checks an insertion override's expression where the host writes it", () => {
    const over = (text: string) => ({
      value: { target: { parameter: { id: id('par', 9) } }, def: { expr: { text, grammar: 1, refs: {} } } },
    });
    const placed = (text: string) =>
      assembly({ instances: [{ ...inst(1, { part: { id: PART } }), overrides: [over(text)] }] });
    expect(codes(read(doc({ assemblies: [placed('2 mm')] })), 'refuse')).toEqual([]);
    expect(codes(read(doc({ assemblies: [placed('nope')] })), 'refuse')).toEqual([
      'bad-expression /assemblies/0/instances/0/overrides/0/value/def/expr',
    ]);
  });

  it('reads an assembly with a revolute joint', () => {
    const result = read(
      doc({
        assemblies: [assembly({ joints: [joint('revolute', { state: { rz: 30 }, rest: { rz: val('0 deg') } })] })],
      }),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("refuses an assembly feature value that uses a later assembly feature's value", () => {
    const feature = (n: number, size: Json): Json => ({
      id: id('feat', n),
      type: 'test.box',
      typeVersion: 1,
      name: `Box ${n}`,
      suppressed: val('false'),
      frozen: { live: {} },
      command: { alone: {} },
      inputs: { size },
    });
    const later: Json = { ...val('1 mm'), name: 'later' };
    const early: Json = {
      id: id('val', nextValue++),
      def: { expr: { text: 'later', grammar: 1, refs: { later: { value: { id: later.id } } } } },
    };
    const ordered = read(doc({ assemblies: [assembly({ timeline: [feature(1, later), feature(2, { ...early })] })] }));
    expect(codes(ordered, 'refuse')).toEqual([]);
    const result = read(doc({ assemblies: [assembly({ timeline: [feature(1, early), feature(2, later)] })] }));
    expect(codes(result, 'refuse')).toEqual(['bad-value /assemblies/0/timeline/0/inputs/size/def']);
  });

  it('reads a joint name, and an attribute that locks a joint', () => {
    const lock = (properties: Json, n = 1) => ({
      id: id('attr', n),
      target: { object: { joint: { id: id('jnt', 1) } } },
      properties,
    });
    const named = read(
      doc({
        assemblies: [
          assembly({ joints: [joint('revolute', { name: 'Hinge' })], attributes: [lock({ locked: val('true') })] }),
        ],
      }),
    );
    expect(named.diagnostics).toEqual([]);
    expect(
      codes(read(doc({ assemblies: [assembly({ joints: [joint('revolute', { name: 3 })] })] })), 'refuse'),
    ).toEqual(['wrong-type /assemblies/0/joints/0/name']);
    // A joint is not drawn: only `locked` applies to it.
    const coloured = read(
      doc({
        assemblies: [
          assembly({
            joints: [joint('revolute')],
            attributes: [lock({ locked: val('true'), color: val('"#ff0000"') })],
          }),
        ],
      }),
    );
    expect(codes(coloured, 'ignore')).toEqual(['bad-value /assemblies/0/attributes/0/properties/color']);
    const twice = read(
      doc({
        assemblies: [
          assembly({
            joints: [joint('revolute')],
            attributes: [lock({ locked: val('true') }), lock({ locked: val('false') }, 2)],
          }),
        ],
      }),
    );
    expect(codes(twice, 'refuse')).toEqual(['bad-value /assemblies/0/attributes/1/properties/locked']);
    // Only an assembly's attributes target joints.
    expect(codes(read(doc({}, { attributes: [lock({ locked: val('true') })] })), 'pause').length).toBeGreaterThan(0);
  });

  it('refuses a degree of freedom the joint kind lacks, and pauses unknown kinds', () => {
    const bad = read(doc({ assemblies: [assembly({ joints: [joint('slider', { state: { rz: 1 } })] })] }));
    expect(codes(bad, 'refuse')).toEqual(['bad-value /assemblies/0/joints/0/state/rz']);
    const unknown = read(doc({ assemblies: [assembly({ joints: [joint('cam')] })] }));
    expect(codes(unknown, 'pause')).toEqual(['unknown-variant /assemblies/0/joints/0/kind']);
  });

  it('refuses an assembly that contains itself and a non-canonical rotation', () => {
    const self = assembly({ instances: [inst(1, { assembly: { id: ASM } })] });
    expect(codes(read(doc({ assemblies: [self] })), 'refuse')).toEqual(['cycle /assemblies']);
    const flipped = assembly({
      instances: [{ ...inst(1, { part: { id: PART } }), placement: { position: [0, 0, 0], rotation: [0, 0, 0, -1] } }],
    });
    expect(codes(read(doc({ assemblies: [flipped] })), 'refuse')).toEqual([
      'bad-rotation /assemblies/0/instances/0/placement/rotation',
    ]);
  });

  it('refuses an in-context reference to an instance its context did not capture', () => {
    const path = (n: number) => ({ path: [{ instance: { id: id('inst', n) } }] });
    const context = {
      id: id('ctx', 1),
      assembly: { id: ASM },
      at: path(1),
      captured: {
        set: [
          {
            instance: path(2),
            stored: stored(),
            construction: [],
            placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
          },
        ],
      },
      source: nameHash({}),
      policy: 'manual',
      capturedAt: '2026-11-05T00:00:00Z',
    };
    const ref = (n: number) => ({
      inContext: { context: { id: id('ctx', 1) }, instance: path(n), ref: { standard: { name: 'xy' } } },
    });
    const set = (n: number) => [{ id: id('set', 1), name: 'S', members: { set: [ref(n)] } }];
    const names = { [nameHash({})]: {} };
    const ok = read(
      doc({ assemblies: [assembly()], assets: { [ASSET]: asset() }, names }, { contexts: [context], sets: set(2) }),
    );
    expect(ok.diagnostics).toEqual([]);
    const bad = read(
      doc({ assemblies: [assembly()], assets: { [ASSET]: asset() }, names }, { contexts: [context], sets: set(3) }),
    );
    expect(codes(bad, 'refuse')).toEqual(['dangling /parts/0/sets/0/members/set/0/inContext/instance']);
  });

  it("refuses an in-context entity whose name chain does not end with its instance path's steps", () => {
    const inst = (n: number) => ({ instance: { id: id('inst', n) } });
    const copy = { op: { id: id('feat', 9) }, key: { mirror: {} } };
    const instancePath = { path: [{ copy }, inst(2)] };
    const context = {
      id: id('ctx', 1),
      assembly: { id: ASM },
      at: { path: [inst(1)] },
      captured: {
        set: [
          {
            instance: instancePath,
            stored: stored(),
            construction: [],
            placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
          },
        ],
      },
      source: nameHash({}),
      policy: 'manual',
      capturedAt: '2026-11-05T00:00:00Z',
    };
    const using = (chain: Json[]) => {
      const name = { kind: 'face', chain, feature: { id: id('feat', 1) } };
      const hash = nameHash(name);
      const entity = { entity: { id: [hash], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
      const ref = { inContext: { context: { id: id('ctx', 1) }, instance: instancePath, ref: entity } };
      const sets = [{ id: id('set', 1), name: 'S', members: { set: [ref] } }];
      return read(
        doc(
          { assemblies: [assembly()], assets: { [ASSET]: asset() }, names: { [hash]: name } },
          { contexts: [context], sets },
        ),
      );
    };
    // Innermost first: the instance step, then the copy step.
    const steps = [{ op: { id: id('inst', 2) }, key: { instance: { id: id('inst', 2) } } }, copy];
    expect(using(steps).diagnostics).toEqual([]);
    expect(using([{ op: { id: id('feat', 7) }, key: { derive: {} } }, ...steps]).diagnostics).toEqual([]);
    const contradicting = '/parts/0/sets/0/members/set/0/inContext/ref/entity/id/0';
    expect(codes(using([]), 'refuse')).toEqual([`dangling ${contradicting}`]);
    expect(codes(using([...steps].reverse()), 'refuse')).toEqual([`dangling ${contradicting}`]);
  });

  describe('copy steps in instance paths', () => {
    const copyPath = (step: Json) => ({ path: [{ copy: step }, { instance: { id: id('inst', 2) } }] });
    const opKey = { op: { id: id('feat', 9) }, key: { slot: { i: 1, j: 0 } } };
    const keyOp = { key: { slot: { j: 0, i: 1 } }, op: { id: id('feat', 9) } };
    const withRef = (captured: Json, used: Json) => {
      const context = {
        id: id('ctx', 1),
        assembly: { id: ASM },
        at: { path: [{ instance: { id: id('inst', 1) } }] },
        captured: {
          set: [
            {
              instance: captured,
              stored: stored(),
              construction: [],
              placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
            },
          ],
        },
        source: nameHash({}),
        policy: 'manual',
        capturedAt: '2026-11-05T00:00:00Z',
      };
      const ref = { inContext: { context: { id: id('ctx', 1) }, instance: used, ref: { standard: { name: 'xy' } } } };
      const sets = [{ id: id('set', 1), name: 'S', members: { set: [ref] } }];
      return read(doc({ assemblies: [assembly()], assets: { [ASSET]: asset() } }, { contexts: [context], sets }));
    };

    it('compares paths by content, not by the order members were written in', () => {
      expect(withRef(copyPath(opKey), copyPath(keyOp)).diagnostics).toEqual([]);
    });

    it("checks a copy step's op, key and slot indices", () => {
      const empty = withRef(copyPath({}), copyPath(opKey));
      expect(codes(empty, 'refuse')).toEqual(
        expect.arrayContaining([
          'missing-field /parts/0/contexts/0/captured/set/0/instance/path/0/copy/op',
          'missing-field /parts/0/contexts/0/captured/set/0/instance/path/0/copy/key',
        ]),
      );
      const bad = { op: { id: id('val', 9) }, key: { mirror: {}, slot: { i: 1, j: 0 } } };
      expect(codes(withRef(copyPath(opKey), copyPath(bad)), 'refuse')).toEqual(
        expect.arrayContaining([
          'bad-id /parts/0/sets/0/members/set/0/inContext/instance/path/0/copy/op/id',
          'wrong-type /parts/0/sets/0/members/set/0/inContext/instance/path/0/copy/key',
        ]),
      );
      const fraction = { op: { id: id('feat', 9) }, key: { slot: { i: 0.5, j: 0 } } };
      expect(codes(withRef(copyPath(fraction), copyPath(opKey)), 'refuse')).toContain(
        'wrong-type /parts/0/contexts/0/captured/set/0/instance/path/0/copy/key/slot/i',
      );
    });
  });
});

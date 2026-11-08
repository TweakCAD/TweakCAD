import { beforeAll, describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { canonicalize } from '../canonical';
import { contentHash, nameHash } from '../hash';
import { parseDocument, readDocument, writeDocument, type ReadResult } from './document';
import { registerFeatureType } from './features';
import type { Json } from './reader';
import { readValue } from './values';

/** A well-formed id whose 16 bytes are all `n`. */
const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;

const PART = id('part', 1);
const DOC = id('doc', 1);

let nextValue = 100;
const val = (text: string, refs: Json = {}, extra: Json = {}): Json => ({
  id: id('val', nextValue++),
  def: { expr: { text, grammar: 1, refs } },
  ...extra,
});

const param = (n: number, name: string, text: string, extra: Json = {}): Json => ({
  id: id('par', n),
  name,
  type: 'number',
  quantity: 'length',
  value: val(text),
  range: { unbounded: {} },
  public: false,
  published: false,
  description: '',
  ...extra,
});

const feature = (n: number, inputs: Json, extra: Json = {}): Json => ({
  id: id('feat', n),
  type: 'test.box',
  typeVersion: 1,
  name: `Box ${n}`,
  suppressed: val('false'),
  frozen: { live: {} },
  command: { alone: {} },
  inputs,
  ...extra,
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
    id: DOC,
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

const codes = (result: ReadResult, severity?: string) =>
  result.diagnostics.filter((d) => !severity || d.severity === severity).map((d) => `${d.code} ${d.path}`);

const read = (value: Json) => readDocument(JSON.parse(JSON.stringify(value)));

beforeAll(() => {
  registerFeatureType('test.box', {
    versions: [1],
    readInputs(r, index, inputs, path, scope) {
      r.object(inputs, path, { required: ['size'], optional: ['nested'] });
      readValue(r, index, inputs.size, `${path}/size`, scope);
      if (inputs.nested !== undefined) readValue(r, index, (inputs.nested as Json).v, `${path}/nested/v`, scope);
    },
  });
  // Rows addressed by id, a list with fixed positions, a list without, and a typed length.
  registerFeatureType('test.rows', {
    versions: [1],
    positional: ['/pair'],
    readInputs(r, index, inputs, path, scope) {
      r.object(inputs, path, { required: ['rows', 'pair', 'loose', 'length'] });
      (inputs.rows as Json[]).forEach((row, i) => {
        const o = r.object(row, `${path}/rows/${i}`, { required: ['id', 'x'] });
        if (o && r.define(o.id, `${path}/rows/${i}/id`, 'pt')) readValue(r, index, o.x, `${path}/rows/${i}/x`, scope);
      });
      for (const list of ['pair', 'loose']) {
        (inputs[list] as unknown[]).forEach((v, i) => readValue(r, index, v, `${path}/${list}/${i}`, scope));
      }
      readValue(r, index, inputs.length, `${path}/length`, scope, { type: 'number', quantity: 'length' });
    },
  });
});

describe('a well-formed document', () => {
  it('reads with no diagnostics', () => {
    const result = read(doc({}, { timeline: [feature(1, { size: val('10 mm') })] }));
    expect(result.diagnostics).toEqual([]);
    expect(result.refused).toBe(false);
  });

  it('writes canonically and re-reads to the same bytes', () => {
    const text = writeDocument(doc({}, { timeline: [feature(1, { size: val('10 mm') })] }));
    const again = parseDocument(text);
    expect(again.refused).toBe(false);
    expect(writeDocument(again.document as Json)).toBe(text);
  });

  it('keeps unknown keys and extensions in place', () => {
    const value = doc({ extensions: { acme: { x: 1 } } }, { extensions: { acme: [1, 2] } });
    const result = read(value);
    expect(result.diagnostics).toEqual([]);
    expect(canonicalize(result.document)).toBe(canonicalize(value));
  });
});

describe('format and version', () => {
  it('refuses other formats and versions with a plain message', () => {
    expect(codes(read(doc({ format: 'other' })))).toEqual(['bad-value /format']);
    const newer = read(doc({ schemaVersion: 3 }));
    expect(newer.refused).toBe(true);
    expect(newer.diagnostics[0]?.message).toMatch(/newer version/);
    expect(codes(read(doc({ schemaVersion: 1 })))).toEqual(['unknown-version /schemaVersion']);
  });
});

describe('strict text', () => {
  it('refuses duplicate member names', () => {
    const text = writeDocument(doc()).replace('"assemblies":[]', '"assemblies":[],"assemblies":[]');
    expect(parseDocument(text).refused).toBe(true);
  });

  it('refuses an integer written with a fraction or exponent', () => {
    const text = writeDocument(doc()).replace('"schemaVersion":2', '"schemaVersion":2.0');
    expect(codes(parseDocument(text))).toEqual(['wrong-type /schemaVersion']);
  });

  it('refuses a byte-order mark and lone surrogates', () => {
    const bom = parseDocument(`\uFEFF${writeDocument(doc())}`);
    expect(bom.diagnostics[0]?.message).toMatch(/byte-order mark/);
    const text = writeDocument(doc()).replace('"name":"Test"', '"name":"\\ud800"');
    expect(parseDocument(text).refused).toBe(true);
  });
});

describe('unknown content', () => {
  it('pauses on unknown schema keys and ignores unknown presentational keys', () => {
    const result = read(doc({ futureThing: 1, metadata: { ...(doc().metadata as Json), mood: 'happy' } }));
    expect(codes(result, 'pause')).toEqual(['unknown-key /futureThing']);
    expect(codes(result, 'ignore')).toEqual(['unknown-key /metadata/mood']);
    expect(result.refused).toBe(false);
  });

  it('refuses null and the reserved extension namespace', () => {
    expect(codes(read(doc({ settings: null })), 'refuse')).toContain('null /settings');
    expect(codes(read(doc({ extensions: { core: {} } })), 'refuse')).toEqual(['bad-extensions /extensions/core']);
  });

  it('pauses an unknown feature type and still checks the values inside it', () => {
    const shared = val('1');
    const result = read(
      doc({}, { timeline: [feature(1, { size: shared }, { type: 'acme.weld' }), feature(2, { size: shared })] }),
    );
    expect(codes(result, 'pause')).toEqual(['unknown-variant /parts/0/timeline/0/type']);
    expect(codes(result, 'refuse')).toEqual(['duplicate-id /parts/0/timeline/1/inputs/size/id']);
  });

  it('pauses an unknown typeVersion', () => {
    const result = read(doc({}, { timeline: [feature(1, { size: val('1') }, { typeVersion: 9 })] }));
    expect(codes(result, 'pause')).toEqual(['unknown-version /parts/0/timeline/0/typeVersion']);
  });

  it('pauses an unknown union variant and an unknown grammar', () => {
    const result = read(
      doc(
        {},
        {
          timeline: [
            feature(
              1,
              { size: { id: id('val', 9), def: { expr: { text: '1', grammar: 2, refs: {} } } } },
              { frozen: { thawed: {} } },
            ),
          ],
        },
      ),
    );
    expect(codes(result, 'pause').sort()).toEqual([
      'unknown-variant /parts/0/timeline/0/frozen/thawed',
      'unknown-version /parts/0/timeline/0/inputs/size/def/expr/grammar',
    ]);
  });
});

describe('ids', () => {
  it('refuses duplicate, malformed and dangling ids', () => {
    const dup = read(doc({ parts: [part(), part()] }));
    expect(codes(dup, 'refuse')).toContain('duplicate-id /parts/1/id');
    expect(codes(read(doc({ id: 'doc_123' })), 'refuse')).toEqual(['bad-id /id']);
    expect(codes(read(doc({ root: { part: { id: id('part', 7) } } })), 'refuse')).toEqual(['dangling /root/part/id']);
  });

  it('refuses a rollback to a feature of another timeline and a feature in two groups', () => {
    const f = feature(1, { size: val('1') });
    const g = (n: number) => ({ id: id('grp', n), name: 'G', members: [id('feat', 1)] });
    const result = read(doc({}, { timeline: [f], groups: [g(1), g(2)], rollback: { before: { id: id('feat', 1) } } }));
    expect(codes(result, 'refuse')).toEqual(['bad-value /parts/0/groups/1/members/0']);
    const other = read(doc({}, { rollback: { before: { id: id('part', 1) } } }));
    expect(codes(other, 'refuse')).toContain('bad-id /parts/0/rollback/before/id');
  });

  it('reads a group of features next to each other, and refuses a gap, another order or an empty group', () => {
    const timeline = [1, 2, 3, 4].map((n) => feature(n, { size: val('1') }));
    const group = (...members: number[]) => ({
      id: id('grp', 1),
      name: 'G',
      members: members.map((n) => id('feat', n)),
    });
    expect(codes(read(doc({}, { timeline, groups: [group(2, 3, 4)] })), 'refuse')).toEqual([]);
    expect(codes(read(doc({}, { timeline, groups: [group(1, 3)] })), 'refuse')).toEqual([
      'bad-value /parts/0/groups/0/members/1',
    ]);
    expect(codes(read(doc({}, { timeline, groups: [group(3, 2)] })), 'refuse')).toEqual([
      'bad-value /parts/0/groups/0/members/1',
    ]);
    expect(codes(read(doc({}, { timeline, groups: [group()] })), 'refuse')).toEqual([
      'bad-value /parts/0/groups/0/members',
    ]);
  });

  it('refuses folder cycles', () => {
    const folder = (n: number, parent: number) => ({
      id: id('fld', n),
      name: 'F',
      members: [],
      parent: { folder: { id: id('fld', parent) } },
    });
    expect(codes(read(doc({ folders: [folder(1, 2), folder(2, 1)] })), 'refuse')).toContain('cycle /folders/0/parent');
  });
});

describe('parameters and values', () => {
  it('refuses reserved, malformed and duplicate names', () => {
    const tables = (params: Json[]) => [{ id: id('tbl', 1), name: 'T', parameters: params }];
    expect(codes(read(doc({ parameters: tables([param(1, 'mm', '1 mm')]) })), 'refuse')).toEqual([
      'reserved-name /parameters/0/parameters/0/name',
    ]);
    expect(codes(read(doc({ parameters: tables([param(1, '2x', '1 mm')]) })), 'refuse')).toEqual([
      'bad-name /parameters/0/parameters/0/name',
    ]);
    expect(codes(read(doc({ parameters: tables([param(1, 'w', '1 mm'), param(2, 'w', '2 mm')]) })), 'refuse')).toEqual([
      'duplicate-name /parameters/0/parameters/1/name',
    ]);
  });

  it('requires a quantity for numbers and options for choices', () => {
    const tables = (p: Json) => [{ id: id('tbl', 1), name: 'T', parameters: [p] }];
    const noQuantity = { ...param(1, 'w', '1 mm') };
    delete noQuantity.quantity;
    expect(codes(read(doc({ parameters: tables(noQuantity) })), 'refuse')).toEqual([
      'missing-field /parameters/0/parameters/0/quantity',
    ]);
    const choice = { ...param(1, 'size', '"small"', { type: 'choice' }) };
    delete choice.quantity;
    expect(codes(read(doc({ parameters: tables(choice) })), 'refuse')).toEqual([
      'missing-field /parameters/0/parameters/0/options',
    ]);
  });

  it('pauses a parameter of an unknown type without refusing what that type might allow', () => {
    const tables = (p: Json) => [{ id: id('tbl', 1), name: 'T', parameters: [p] }];
    const future = param(1, 'w', '1 mm', { type: 'futureNumber', options: ['a'] });
    const result = read(doc({ parameters: tables(future) }));
    expect(codes(result, 'refuse')).toEqual([]);
    expect(codes(result, 'pause')).toContain('unknown-variant /parameters/0/parameters/0/type');
    const config = {
      id: id('cfg', 1),
      input: { id: id('par', 1) },
      rows: [{ option: { equals: { literal: 'a' } }, overrides: [] }],
    };
    const configured = read(doc({}, { parameters: tables(future), configurations: [config] }));
    expect(codes(configured, 'refuse')).toEqual([]);
    expect(codes(configured, 'pause')).toContain('unknown-variant /parts/0/configurations/0/input');
  });

  it('refuses cycles among table parameters and measures in tables', () => {
    const a = param(1, 'a', 'b', { value: val('b', { b: { parameter: { id: id('par', 2) } } }) });
    const b = param(2, 'b', 'a', { value: val('a', { a: { parameter: { id: id('par', 1) } } }) });
    const tables = [{ id: id('tbl', 1), name: 'T', parameters: [a, b] }];
    expect(codes(read(doc({ parameters: tables })), 'refuse').some((c) => c.startsWith('cycle'))).toBe(true);

    const m = param(3, 'vol', '', { value: { id: id('val', 50), def: { measure: { kind: 'volume', of: [] } } } });
    expect(codes(read(doc({ parameters: [{ id: id('tbl', 2), name: 'T', parameters: [m] }] })), 'refuse')).toEqual([
      'bad-value /parameters/0/parameters/0/value/def',
    ]);
  });

  it('refuses a value name that is a parameter name in scope', () => {
    const tables = [{ id: id('tbl', 1), name: 'T', parameters: [param(1, 'width', '1 mm')] }];
    const result = read(
      doc({ parameters: tables }, { timeline: [feature(1, { size: val('2 mm', {}, { name: 'width' }) })] }),
    );
    expect(codes(result, 'refuse')).toEqual(['duplicate-name /parts/0/timeline/0/inputs/size/name']);
  });

  it('refuses malformed expressions with diagnostics, never an exception', () => {
    const broken = (value: Json) =>
      read(doc({ parameters: [{ id: id('tbl', 1), name: 'T', parameters: [param(1, 'a', '', { value })] }] }));
    const nullRef = broken({ id: id('val', 60), def: { expr: { text: 'x', grammar: 1, refs: { x: null } } } });
    expect(codes(nullRef, 'refuse')).toContain('wrong-type /parameters/0/parameters/0/value/def/expr/refs/x');
    const nullRefs = broken({ id: id('val', 61), def: { expr: { text: 'x', grammar: 1, refs: null } } });
    expect(nullRefs.refused).toBe(true);
    expect(codes(nullRefs, 'refuse')).toContain('null /parameters/0/parameters/0/value/def/expr/refs');
    const textDef = read(doc({}, { timeline: [feature(1, { size: { id: id('val', 62), def: 'x' } })] }));
    expect(codes(textDef, 'refuse')).toContain('wrong-type /parts/0/timeline/0/inputs/size/def');
    for (const r of [nullRef, nullRefs, textDef])
      expect(r.diagnostics.some((d) => /malformed:/.test(d.message))).toBe(false);
  });

  it("refuses a feature value that uses a later feature's value", () => {
    const later = val('1 mm', {}, { name: 'later' });
    const early = val('later', { later: { value: { id: later.id } } });
    const result = read(doc({}, { timeline: [feature(1, { size: early }), feature(2, { size: later })] }));
    expect(codes(result, 'refuse')).toEqual(['bad-value /parts/0/timeline/0/inputs/size/def']);
  });
});

describe('visibility and types of every definition', () => {
  const choice = (n: number) => {
    const p = param(n, 'size', '"small"', { type: 'choice', options: ['small', 'large'] });
    delete p.quantity;
    return p;
  };
  const override = (target: Json, text: string, refs: Json = {}) => ({
    value: { target, def: { expr: { text, grammar: 1, refs } } },
  });
  const configured = (overrides: Json[], timeline: Json[]) =>
    read(
      doc(
        {},
        {
          parameters: [{ id: id('tbl', 1), name: 'T', parameters: [choice(1)] }],
          configurations: [
            {
              id: id('cfg', 1),
              input: { id: id('par', 1) },
              rows: [{ option: { equals: { literal: 'small' } }, overrides }],
            },
          ],
          timeline,
        },
      ),
    );

  it("refuses a value of another part's timeline", () => {
    const theirs = val('1 mm', {}, { name: 'theirs' });
    const other = { ...part({ timeline: [feature(2, { size: theirs })] }), id: id('part', 2) };
    const mine = feature(1, { size: val('theirs', { theirs: { value: { id: theirs.id } } }) });
    const result = read(doc({ parts: [part({ timeline: [feature(3, { size: val('1 mm') }), mine] }), other] }));
    expect(codes(result, 'refuse')).toEqual(['bad-value /parts/0/timeline/1/inputs/size/def']);
  });

  it("refuses a configuration override using a value later than its target's feature", () => {
    const first = val('1 mm');
    const later = val('2 mm', {}, { name: 'later' });
    const result = configured(
      [override({ value: { id: first.id } }, 'later', { later: { value: { id: later.id } } })],
      [feature(1, { size: first }), feature(2, { size: later })],
    );
    expect(codes(result, 'refuse')).toEqual(['bad-value /parts/0/configurations/0/rows/0/overrides/0/value/def']);
  });

  it("refuses a suppressed flag that uses its own feature's values, and one that is no boolean", () => {
    const width = val('1 mm', {}, { name: 'width' });
    const own = feature(
      1,
      { size: width },
      { suppressed: val('width > 0 mm', { width: { value: { id: width.id } } }) },
    );
    expect(codes(read(doc({}, { timeline: [own] })), 'refuse')).toEqual([
      'bad-value /parts/0/timeline/0/suppressed/def',
    ]);
    const length = feature(1, { size: val('1 mm') }, { suppressed: val('10 mm') });
    expect(codes(read(doc({}, { timeline: [length] })), 'refuse')).toEqual([
      'bad-expression /parts/0/timeline/0/suppressed/def/expr',
    ]);
  });

  it('types a same-document value reference by what its schema makes it', () => {
    const first = feature(1, { size: val('1 mm') });
    const flag = (first.suppressed as Json).id as string;
    const mixed = feature(2, { size: val('true ? 10 mm : off', { off: { value: { id: flag } } }) });
    expect(codes(read(doc({}, { timeline: [first, mixed] })), 'refuse')).toEqual([
      'bad-expression /parts/0/timeline/1/inputs/size/def/expr',
    ]);
  });

  it("checks a configuration override against its target value's type", () => {
    const first = feature(1, { size: val('1 mm') });
    const flag = (first.suppressed as Json).id as string;
    const result = configured([override({ value: { id: flag } }, '10 mm')], [first]);
    expect(codes(result, 'refuse')).toEqual([
      'bad-expression /parts/0/configurations/0/rows/0/overrides/0/value/def/expr',
    ]);
  });
});

describe('configurations', () => {
  const choice = (n: number, name: string) => {
    const p = param(n, name, '"small"', { type: 'choice', options: ['small', 'large'] });
    delete p.quantity;
    return p;
  };
  const row = (literal: unknown, overrides: Json[] = []) => ({ option: { equals: { literal } }, overrides });
  const config = (input: number, rows: Json[], n = 1) => ({ id: id('cfg', n), input: { id: id('par', input) }, rows });
  const withConfig = (configurations: Json[], params: Json[], timeline: Json[] = []) =>
    read(doc({}, { parameters: [{ id: id('tbl', 1), name: 'T', parameters: params }], configurations, timeline }));

  it('accepts a choice configuration overriding a part value', () => {
    const size = val('10 mm');
    const result = withConfig(
      [
        config(1, [
          row('small'),
          row('large', [
            { value: { target: { value: { id: size.id } }, def: { expr: { text: '20 mm', grammar: 1, refs: {} } } } },
          ]),
        ]),
      ],
      [choice(1, 'size')],
      [feature(1, { size })],
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses a number input, mismatched options and two rows for one value', () => {
    expect(codes(withConfig([config(1, [row('a')])], [param(1, 'w', '1 mm')]), 'refuse')).toEqual([
      'bad-configuration /parts/0/configurations/0/input',
      'bad-configuration /parts/0/configurations/0/rows/0/option',
    ]);
    expect(codes(withConfig([config(1, [row('small'), row('small')])], [choice(1, 'size')]), 'refuse')).toEqual([
      'bad-configuration /parts/0/configurations/0/rows/1/option',
    ]);
  });

  it('refuses overriding an input parameter, or a value another owner defines', () => {
    const over = (target: Json, text = '"large"') => ({
      value: { target, def: { expr: { text, grammar: 1, refs: {} } } },
    });
    const result = withConfig(
      [config(1, [row('small', [over({ parameter: { id: id('par', 1) } })])])],
      [choice(1, 'size')],
    );
    expect(codes(result, 'refuse')).toContain('bad-override /parts/0/configurations/0/rows/0/overrides/0');

    const docParam = param(5, 'gap', '1 mm');
    const elsewhere = read(
      doc(
        { parameters: [{ id: id('tbl', 9), name: 'D', parameters: [docParam] }] },
        {
          parameters: [{ id: id('tbl', 1), name: 'T', parameters: [choice(1, 'size')] }],
          configurations: [config(1, [row('small', [over({ parameter: { id: id('par', 5) } }, '2 mm')])])],
        },
      ),
    );
    expect(codes(elsewhere, 'refuse')).toEqual(['bad-override /parts/0/configurations/0/rows/0/overrides/0']);
  });

  it('refuses input overrides that replace public values or overlap', () => {
    const size = val('10 mm', {}, { public: true });
    const input = (pointer: string, replacement: Json = val('2 mm')) => ({
      input: { feature: { id: id('feat', 1) }, pointer, with: replacement },
    });
    const replacesPublic = withConfig(
      [config(1, [row('small', [input('/size')])])],
      [choice(1, 'size')],
      [feature(1, { size })],
    );
    expect(codes(replacesPublic, 'refuse')).toEqual(['bad-override /parts/0/configurations/0/rows/0/overrides/0']);

    const nested = { v: val('1 mm') };
    const overlap = withConfig(
      [config(1, [row('small', [input('/nested', { v: val('2 mm') }), input('/nested/v')])])],
      [choice(1, 'size')],
      [feature(1, { size: val('1 mm'), nested })],
    );
    expect(codes(overlap, 'refuse')).toEqual(['bad-override /parts/0/configurations/0/rows/0/overrides/1']);
  });

  describe('an input override against its feature type', () => {
    const ROW = id('pt', 1);
    const rows = () => ({
      id: id('feat', 1),
      type: 'test.rows',
      typeVersion: 1,
      name: 'Rows',
      suppressed: val('false'),
      frozen: { live: {} },
      command: { alone: {} },
      inputs: {
        rows: [{ id: ROW, x: val('1 mm') }],
        pair: [val('1 mm'), val('2 mm')],
        loose: [val('3 mm')],
        length: val('4 mm'),
      },
    });
    const overriding = (pointer: string, replacement: unknown, f: Json = rows()) =>
      withConfig(
        [config(1, [row('small', [{ input: { feature: { id: f.id }, pointer, with: replacement } }])])],
        [choice(1, 'size')],
        [f],
      );
    const at = '/parts/0/configurations/0/rows/0/overrides/0';

    it('refuses a replacement the schema rejects, reported at its with', () => {
      expect(codes(overriding('/size', 42, feature(1, { size: val('1 mm') })), 'refuse')).toEqual([
        `wrong-type ${at}/input/with`,
      ]);
      expect(codes(overriding('/rows', [{ id: ROW }]), 'refuse')).toContain(`missing-field ${at}/input/with/0/x`);
    });

    it('gives the values inside with the types the schema gives them', () => {
      expect(codes(overriding('/length', val('10 deg')), 'refuse')).toEqual([
        `bad-expression ${at}/input/with/def/expr`,
      ]);
      expect(overriding('/length', val('10 mm')).diagnostics).toEqual([]);
    });

    it('steps into a table by row id and into fixed positions by position, never otherwise', () => {
      expect(overriding(`/rows/${ROW}/x`, val('2 mm')).diagnostics).toEqual([]);
      expect(overriding('/pair/1', val('5 mm')).diagnostics).toEqual([]);
      expect(codes(overriding('/rows/0/x', val('2 mm')), 'refuse')).toEqual([`bad-override ${at}/input/pointer`]);
      expect(codes(overriding('/loose/0', val('2 mm')), 'refuse')).toEqual([`bad-override ${at}/input/pointer`]);
      expect(overriding('/loose', [val('2 mm')]).diagnostics).toEqual([]);
    });
  });

  it('pauses an input override whose pointer does not resolve', () => {
    const result = withConfig(
      [config(1, [row('small', [{ input: { feature: { id: id('feat', 1) }, pointer: '/missing', with: {} } }])])],
      [choice(1, 'size')],
      [feature(1, { size: val('1 mm') })],
    );
    expect(codes(result, 'pause')).toEqual(['bad-override /parts/0/configurations/0/rows/0/overrides/0']);
  });
});

describe('expressions', () => {
  const tables = (params: Json[]) => [{ id: id('tbl', 1), name: 'T', parameters: params }];

  it('refuses text errors and a value of the wrong type for its parameter', () => {
    const syntax = read(doc({ parameters: tables([param(1, 'w', '1 +')]) }));
    expect(codes(syntax, 'refuse')).toEqual(['bad-expression /parameters/0/parameters/0/value/def/expr']);
    const unused = param(1, 'w', '1 mm', { value: val('1 mm', { x: { parameter: { id: id('par', 1) } } }) });
    expect(codes(read(doc({ parameters: tables([unused]) })), 'refuse')).toContain(
      'bad-expression /parameters/0/parameters/0/value/def/expr',
    );
    const wrongType = read(doc({ parameters: tables([param(1, 'w', '1 deg')]) }));
    expect(codes(wrongType, 'refuse')).toEqual(['bad-expression /parameters/0/parameters/0/value/def/expr']);
  });

  it('checks types through parameter references', () => {
    const a = param(1, 'a', '2 mm');
    const ok = param(2, 'b', 'a * 2', { value: val('a * 2', { a: { parameter: { id: id('par', 1) } } }) });
    expect(read(doc({ parameters: tables([a, ok]) })).diagnostics).toEqual([]);
    const bad = param(2, 'b', 'a + 1', { value: val('a + 1', { a: { parameter: { id: id('par', 1) } } }) });
    expect(codes(read(doc({ parameters: tables([a, bad]) })), 'refuse')).toEqual([
      'bad-expression /parameters/0/parameters/1/value/def/expr',
    ]);
  });
});

describe('attributes, sets and names', () => {
  const target = { object: { part: { id: PART } } };
  const attr = (n: number, properties: Json) => ({ id: id('attr', n), target, properties });

  it('refuses two attributes setting one property on one target', () => {
    const result = read(
      doc({}, { attributes: [attr(1, { color: val('"#ff0000"') }), attr(2, { color: val('"#00ff00"') })] }),
    );
    expect(codes(result, 'refuse')).toEqual(['bad-value /parts/0/attributes/1/properties/color']);
  });

  it('refuses selection-set members out of canonical order', () => {
    const a = { standard: { name: 'xy' } };
    const b = { standard: { name: 'xz' } };
    const set = (members: Json[]) => ({ id: id('set', 1), name: 'S', members: { set: members } });
    expect(read(doc({}, { sets: [set([a, b])] })).refused).toBe(false);
    expect(codes(read(doc({}, { sets: [set([b, a])] })), 'refuse')).toEqual(['bad-set /parts/0/sets/0/members/set/1']);
  });

  it('refuses selection sets that hold themselves, directly or through others', () => {
    const selection = (n: number) => ({ selection: { id: id('set', n) } });
    const set = (n: number, members: Json[]) => ({ id: id('set', n), name: `S${n}`, members: { set: members } });
    expect(codes(read(doc({}, { sets: [set(1, [selection(1)])] })), 'refuse')).toEqual(['cycle /parts/0/sets/0']);
    const loop = read(doc({}, { sets: [set(1, [selection(2)]), set(2, [selection(1)])] }));
    expect(codes(loop, 'refuse')).toEqual(['cycle /parts/0/sets/1']);
    expect(read(doc({}, { sets: [set(1, [selection(2)]), set(2, [])] })).refused).toBe(false);
  });

  it('checks the name table and pauses references whose names are missing', () => {
    const name = { kind: 'face', chain: [], feature: { id: id('feat', 1) } };
    const hash = nameHash(name);
    const record = { entity: { id: [hash], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
    const ok = read(
      doc({ names: { [hash]: name } }, { sets: [{ id: id('set', 1), name: 'S', members: { set: [record] } }] }),
    );
    expect(ok.diagnostics).toEqual([]);
    const missing = read(doc({}, { sets: [{ id: id('set', 1), name: 'S', members: { set: [record] } }] }));
    expect(codes(missing, 'pause')).toEqual(['missing-name /parts/0/sets/0/members/set/0/entity/id/0']);
    const wrong = read(doc({ names: { [hash]: { kind: 'edge' } } }));
    expect(codes(wrong, 'refuse')).toEqual([`bad-hash /names/${hash}`]);
  });

  describe('name objects the document uses', () => {
    const using = (hash: string, names: Json) => {
      const record = { entity: { id: [hash], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
      return read(doc({ names }, { sets: [{ id: id('set', 1), name: 'S', members: { set: [record] } }] }));
    };

    it('refuses an entry that is no name object, or holds a known field of the wrong shape', () => {
      const h = nameHash(42);
      expect(codes(using(h, { [h]: 42 }), 'refuse')).toEqual([`wrong-type /names/${h}`]);
      const badUses = {
        kind: 'edge',
        chain: [],
        feature: { id: id('feat', 1) },
        role: 'edge',
        src: [{ uses: { set: [{ item: 7, count: 0 }] } }],
      };
      const u = nameHash(badUses);
      expect(codes(using(u, { [u]: badUses }), 'refuse')).toEqual([
        `bad-hash /names/${u}/src/0/uses/set/0/item`,
        `bad-value /names/${u}/src/0/uses/set/0/count`,
      ]);
      const badStep = { kind: 'face', chain: [{ op: { id: id('feat', 2) }, key: {} }], feature: { id: id('feat', 1) } };
      const s = nameHash(badStep);
      expect(codes(using(s, { [s]: badStep }), 'refuse')).toEqual([`wrong-type /names/${s}/chain/0/key`]);
    });

    it("keeps unused entries and later naming levels' unknown content", () => {
      const unused = nameHash(42);
      expect(read(doc({ names: { [unused]: 42 } })).refused).toBe(false);
      const later = {
        kind: 'face',
        chain: [],
        feature: { id: id('feat', 1) },
        role: 'side',
        src: [{ future: {} }],
        extra: 1,
      };
      const l = nameHash(later);
      expect(codes(using(l, { [l]: later }), 'refuse')).toEqual([]);
    });

    it('pauses a reference whose name holds a hash the table lacks, at any depth', () => {
      const leaf = { kind: 'face', chain: [], feature: { id: id('feat', 1) } };
      const face = {
        kind: 'face',
        chain: [],
        feature: { id: id('feat', 2) },
        role: 'blend',
        src: [{ name: { hash: nameHash(leaf) } }],
      };
      const edge = {
        kind: 'edge',
        chain: [],
        feature: { id: id('feat', 3) },
        role: 'edge',
        src: [{ uses: { set: [{ item: nameHash(face), count: 1 }] } }],
      };
      const e = nameHash(edge);
      const complete = { [e]: edge, [nameHash(face)]: face, [nameHash(leaf)]: leaf };
      expect(using(e, complete).diagnostics).toEqual([]);
      const lacking = Object.fromEntries(Object.entries(complete).filter(([hash]) => hash !== nameHash(leaf)));
      expect(codes(using(e, lacking), 'pause')).toEqual(['missing-name /parts/0/sets/0/members/set/0/entity/id/0']);
      expect(using(e, lacking).refused).toBe(false);
    });
  });
});

describe('font library entries', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = contentHash(bytes);
  const entry = (content: Json): Json => ({
    id: id('lib', 3),
    hash: nameHash(content),
    kind: 'font',
    content,
    source: { local: {} },
    name: 'f.ttf',
  });
  const asset = { [hash]: { mediaType: 'font/ttf', name: 'f.ttf', size: 4, data: { inline: { base64: 'AQIDBA==' } } } };

  it('reads a font as its file in the assets', () => {
    const content = { inline: { definition: { asset: hash } } };
    expect(read(doc({ library: [entry(content)], assets: asset })).diagnostics).toEqual([]);
  });

  it('refuses a font whose file is not in the assets, or that names none', () => {
    const content = { inline: { definition: { asset: hash } } };
    expect(codes(read(doc({ library: [entry(content)] })), 'refuse')).toEqual([
      'dangling /library/0/content/inline/definition/asset',
    ]);
    const none = { inline: { definition: {} } };
    expect(codes(read(doc({ library: [entry(none)], assets: asset })), 'refuse')).toEqual([
      'missing-field /library/0/content/inline/definition/asset',
    ]);
  });
});

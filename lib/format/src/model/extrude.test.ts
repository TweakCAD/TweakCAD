import { describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { readDocument, type ReadResult } from './document';
import type { Json } from './reader';

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
let nextValue = 1;
const val = (text: string): Json => ({ id: id('val', nextValue++), def: { expr: { text, grammar: 1, refs: {} } } });

const PART = id('part', 1);
const region = { object: { feature: { id: id('feat', 1) } } };

/** An extrude of 5 mm along the XY plane's normal, with `start` when given. */
function extrude(start?: unknown): Json {
  return {
    profiles: { set: [region] },
    sides: [{ extent: { distance: { d: val('5 mm') } }, taper: val('0 deg') }],
    direction: { normal: { ref: { standard: { name: 'xy' } }, reversed: val('false') } },
    thin: { solid: {} },
    operation: { op: val('"new"'), targets: { all: {} }, keepTools: val('false') },
    ...(start === undefined ? {} : { start }),
  };
}

function read(inputs: Json): ReadResult {
  const feature = {
    id: id('feat', 1),
    type: 'core.extrude',
    typeVersion: 1,
    name: 'Extrude',
    suppressed: val('false'),
    frozen: { live: {} },
    command: { alone: {} },
    inputs,
  };
  const part = {
    id: PART,
    name: 'Part',
    parameters: [],
    timeline: [feature],
    rollback: { end: {} },
    groups: [],
    sets: [],
    contexts: [],
    attributes: [],
    configurations: [],
    notes: [],
    properties: {},
  };
  return readDocument(
    JSON.parse(
      JSON.stringify({
        format: 'tweakcad.document',
        schemaVersion: 2,
        namingRules: 1,
        id: id('doc', 1),
        metadata: {
          name: 'Extrude',
          description: '',
          createdAt: '2026-11-06T00:00:00Z',
          updatedAt: '2026-11-06T00:00:00Z',
          writer: { app: 'test', version: '0' },
          origin: { original: {} },
        },
        properties: {},
        settings: {},
        parameters: [],
        parts: [part],
        assemblies: [],
        root: { part: { id: PART } },
        folders: [],
        views: [],
        library: [],
        assets: {},
        names: {},
      }),
    ),
  );
}

const found = (result: ReadResult, severity: string) =>
  result.diagnostics
    .filter((d) => d.severity === severity)
    .map((d) => `${d.code} ${d.path.replace('/parts/0/timeline/0/inputs', '')}`);

describe('core.extrude start', () => {
  it('reads an extrude with no start, and each start form', () => {
    expect(read(extrude()).diagnostics).toEqual([]);
    const starts = [
      { profilePlane: {} },
      { offset: { d: val('-3 mm') } },
      { object: { face: { standard: { name: 'xz' } }, offset: val('0 mm') } },
      { object: { face: { object: { feature: { id: id('feat', 1) } } }, offset: val('2 mm') } },
    ];
    for (const start of starts) expect(read(extrude(start)).diagnostics).toEqual([]);
  });

  it('refuses a missing offset or face and an offset that is not a length', () => {
    expect(found(read(extrude({ offset: {} })), 'refuse')).toContain('missing-field /start/offset/d');
    expect(found(read(extrude({ object: { offset: val('0 mm') } })), 'refuse')).toContain(
      'missing-field /start/object/face',
    );
    expect(found(read(extrude({ object: { face: { standard: { name: 'xy' } } } })), 'refuse')).toContain(
      'missing-field /start/object/offset',
    );
    expect(found(read(extrude({ offset: { d: val('3 deg') } })), 'refuse')).toEqual([
      'bad-expression /start/offset/d/def/expr',
    ]);
  });

  it('pauses a start form it does not know', () => {
    expect(found(read(extrude({ vertex: {} })), 'pause')).toEqual(['unknown-variant /start/vertex']);
  });
});

describe('operation targets', () => {
  const withTargets = (targets: unknown): Json => {
    const inputs = extrude();
    (inputs.operation as Json).targets = targets as Json;
    return inputs;
  };
  const body = { object: { feature: { id: id('feat', 1) } } };

  it('reads all bodies and a body set', () => {
    expect(read(withTargets({ all: {} })).diagnostics).toEqual([]);
    expect(read(withTargets({ bodies: { set: [body] } })).diagnostics).toEqual([]);
  });

  it('refuses a body set wrapped in a second bodies object', () => {
    expect(found(read(withTargets({ bodies: { bodies: { set: [body] } } })), 'refuse')).toEqual([
      'bad-set /operation/targets/bodies',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { readDocument, type ReadResult } from './document';
import type { Json } from './reader';

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
let nextValue = 1;
const val = (text: string): Json => ({ id: id('val', nextValue++), def: { expr: { text, grammar: 1, refs: {} } } });

const PART = id('part', 1);
const body = { object: { feature: { id: id('feat', 1) } } };
const axis = { axis: { axis: val('"x"'), reversed: val('false') } };

/** A pattern of one body along X, its direction row extended by `more`. */
function pattern(more: Json = {}, skip: Json[] = []): Json {
  return {
    of: { bodies: { set: [body] } },
    layout: {
      linear: { directions: [{ direction: axis, count: val('3'), spacing: { equal: { s: val('10 mm') } }, ...more }] },
    },
    skip: { set: skip },
    vary: [],
    operation: { op: val('"new"'), targets: { all: {} }, keepTools: val('false') },
  };
}

function read(inputs: Json): ReadResult {
  const feature = {
    id: id('feat', 1),
    type: 'core.pattern',
    typeVersion: 1,
    name: 'Pattern',
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
          name: 'Pattern',
          description: '',
          createdAt: '2026-11-07T00:00:00Z',
          updatedAt: '2026-11-07T00:00:00Z',
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

describe('core.pattern symmetric direction', () => {
  it('reads a direction with no symmetric, and one with a symmetric flag', () => {
    expect(read(pattern()).diagnostics).toEqual([]);
    expect(read(pattern({ symmetric: val('true') })).diagnostics).toEqual([]);
    expect(read(pattern({ symmetric: val('false') })).diagnostics).toEqual([]);
  });

  it('refuses a symmetric that is not a flag', () => {
    expect(found(read(pattern({ symmetric: val('3 mm') })), 'refuse')).toEqual([
      'bad-expression /layout/linear/directions/0/symmetric/def/expr',
    ]);
  });

  it('reads a negative slot in skip', () => {
    expect(read(pattern({ symmetric: val('true') }, [{ slot: { i: -2, j: 0 } }])).diagnostics).toEqual([]);
  });
});

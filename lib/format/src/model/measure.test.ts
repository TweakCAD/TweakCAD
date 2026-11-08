import { describe, expect, it } from 'vitest';
import { base32Encode } from '../base32';
import { readDocument, type ReadResult } from './document';
import type { Json } from './reader';

const id = (kind: string, n: number) => `${kind}_${base32Encode(new Uint8Array(16).fill(n))}`;
let nextValue = 1;
const val = (text: string): Json => ({ id: id('val', nextValue++), def: { expr: { text, grammar: 1, refs: {} } } });

const PART = id('part', 1);

function read(type: string, inputs: Json): ReadResult {
  const feature = {
    id: id('feat', 1),
    type,
    typeVersion: 1,
    name: 'Measure',
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
          name: 'Measure',
          description: '',
          createdAt: '2026-11-05T00:00:00Z',
          updatedAt: '2026-11-05T00:00:00Z',
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

const refused = (result: ReadResult) =>
  result.diagnostics
    .filter((d) => d.severity === 'refuse')
    .map((d) => `${d.code} ${d.path.replace('/parts/0/timeline/0/inputs', '')}`);

describe('core.measure', () => {
  const ref = { standard: { name: 'origin' } };
  const measured = (name: string | undefined, kind: string): Json => ({
    id: id('val', nextValue++),
    ...(name === undefined ? {} : { name }),
    def: { measure: { kind, of: [ref, { standard: { name: 'x' } }] } },
  });

  it('reads a table of named measured values', () => {
    expect(
      read('core.measure', { values: [measured('gap', 'distance'), measured('turn', 'angle')] }).diagnostics,
    ).toEqual([]);
  });

  it('refuses a value with no name and one that is not measured', () => {
    expect(refused(read('core.measure', { values: [measured(undefined, 'distance')] }))).toEqual([
      'missing-field /values/0/name',
    ]);
    expect(refused(read('core.measure', { values: [{ ...val('1 mm'), name: 'gap' }] }))).toEqual([
      'bad-value /values/0/def',
    ]);
  });
});

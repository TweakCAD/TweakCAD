/**
 * The version-2 regression fixtures (`lib/testing/fixtures/v2`): every
 * document there is read, evaluated on the real kernel and solver, and
 * compared with its checked-in expectation: each part's and assembly's
 * bodies (volume, bounding box, face and edge counts), its cosmetic
 * threads, and the exact list of pauses. The fixtures are written by
 * `src/fixtures/generate.occt.test.ts`; regenerate them when the format
 * changes on purpose.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument } from '@tweakcad/format';
import { evaluateDocument } from './evaluate';
import { differences, summarize, type FixtureSummary } from './fixtureSummary';
import type { Json } from './context';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolvePath(HERE, '../../../testing/fixtures/v2');
const NAMES = readdirSync(DIR)
  .filter((f) => f.endsWith('.cadjson'))
  .map((f) => f.replace(/\.cadjson$/, ''))
  .sort();

let k: OcctKernel;
let gcs: GcsWrapper;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(HERE, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
}, 60_000);
afterAll(() => k.releaseAll());

describe('version-2 regression fixtures', () => {
  it('has the fixtures it should, each with an expectation', () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(14);
    for (const name of NAMES) expect(existsSync(resolvePath(DIR, `${name}.expected.json`))).toBe(true);
  });

  for (const name of NAMES) {
    it(`builds ${name} as expected`, { timeout: 180_000 }, () => {
      const doc = JSON.parse(readFileSync(resolvePath(DIR, `${name}.cadjson`), 'utf8')) as Json;
      const read = readDocument(structuredClone(doc));
      expect(read.refused).toBe(false);
      expect(read.diagnostics.filter((d) => d.severity !== 'ignore')).toEqual([]);
      const expected = JSON.parse(readFileSync(resolvePath(DIR, `${name}.expected.json`), 'utf8')) as FixtureSummary;
      const ev = evaluateDocument(doc, k, { solver: gcs });
      try {
        expect(differences(expected, summarize(ev, doc))).toEqual([]);
      } finally {
        ev.adapter.dispose();
      }
    });
  }

  /** The fixtures whose root part has a public Size configuration: the fasteners. */
  const sized = NAMES.flatMap((name) => {
    const doc = JSON.parse(readFileSync(resolvePath(DIR, `${name}.cadjson`), 'utf8')) as Json;
    const part = (doc.parts as Json[])[0] as Json;
    const input = ((part.configurations as Json[])[0]?.input as Json | undefined)?.id;
    const size = (part.parameters as Json[])
      .flatMap((t) => t.parameters as Json[])
      .find((p) => p.id === input && p.name === 'Size');
    return size ? [{ name, doc, size }] : [];
  });

  it('has the fasteners as sized components', () => {
    expect(sized.map((s) => s.name)).toEqual([
      'dowel-pin',
      'hex-bolt-iso4017',
      'hex-nut-iso4032',
      'hex-standoff',
      'socket-screw-iso4762',
      'threaded-rod',
      'washer-iso7089',
    ]);
    for (const { size } of sized)
      expect(size).toMatchObject({
        public: true,
        type: 'choice',
        options: ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'],
      });
  });

  for (const { name, doc, size } of sized) {
    it(`builds ${name} in every size, each wider than the last`, { timeout: 180_000 }, () => {
      const widths: number[] = [];
      for (const option of size.options as string[]) {
        const variant = structuredClone(doc);
        const row = (((variant.parts as Json[])[0] as Json).parameters as Json[])
          .flatMap((t) => t.parameters as Json[])
          .find((p) => p.id === size.id) as Json;
        (row.value as Json).def = { expr: { text: JSON.stringify(option), grammar: 1, refs: {} } };
        const ev = evaluateDocument(variant, k, { solver: gcs });
        try {
          expect(ev.pauses).toEqual([]);
          const [body] = summarize(ev, variant).parts[0]?.bodies ?? [];
          expect(body).toBeDefined();
          widths.push((body?.max[0] as number) - (body?.min[0] as number));
          const threads = [
            ...(ev.parts.get(((variant.parts as Json[])[0] as Json).id as string)?.threads.values() ?? []),
          ].flat();
          for (const t of threads) expect(t.designation).toBe(option);
        } finally {
          ev.adapter.dispose();
        }
      }
      for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1] as number);
    });
  }
});

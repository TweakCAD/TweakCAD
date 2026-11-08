/**
 * Generates the version-2 regression fixtures in `lib/testing/fixtures/v2`:
 * each document written through the CAD tools and the app's command
 * helpers, never by hand, then evaluated on the kernel for its checked-in
 * expectation. Runs only when asked:
 *
 *   WRITE_V2_FIXTURES=1 pnpm exec vitest run src/fixtures/generate.occt.test.ts
 *
 * `V2_FIXTURES=washer-iso7089,hex-nut-iso4032` writes only those.
 *
 * `lib/worker/src/v2/fixtures.occt.test.ts` loads every fixture and compares
 * it with its expectation.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDocument, saveDocument, type Json } from '@tweakcad/editor';
import { readDocument } from '@tweakcad/format';
import { evaluateDocument } from '@tweakcad/worker/src/v2/evaluate';
import { summarize, type FixtureSummary } from '@tweakcad/worker/src/v2/fixtureSummary';
import { loadKernel, type Kernel } from './harness';
import { FIXTURES, type Fixture } from './scripts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolvePath(HERE, '../../lib/testing/fixtures/v2');
const SOLVER = resolvePath(HERE, '../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm');
const WRITE = process.env.WRITE_V2_FIXTURES === '1';
/** Optional: a comma-separated list of the fixtures to write. */
const ONLY = process.env.V2_FIXTURES?.split(',');

let kernel: Kernel;

beforeAll(async () => {
  if (WRITE) kernel = await loadKernel(realpathSync(SOLVER));
}, 60_000);
afterAll(() => {
  if (!WRITE) return;
  kernel.service.release();
  kernel.k.releaseAll();
});

/** Evaluates a written document on its own, as the regression test does, and summarizes it. */
function expectationOf(doc: Json): FixtureSummary {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((d) => d.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, kernel.k, { solver: kernel.gcs });
  try {
    return summarize(ev, doc);
  } finally {
    ev.adapter.dispose();
  }
}

async function write(f: Fixture): Promise<void> {
  const doc = await f.build(kernel);
  const text = saveDocument(doc);
  const loaded = loadDocument(text);
  expect(loaded.ok).toBe(true);
  const expected = expectationOf(doc);
  expect(expected.pauses).toEqual(f.pauses ?? []);
  f.check?.(
    expected,
    (name) => JSON.parse(readFileSync(resolvePath(OUT, `${name}.expected.json`), 'utf8')) as FixtureSummary,
  );
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolvePath(OUT, `${f.name}.cadjson`), text);
  writeFileSync(resolvePath(OUT, `${f.name}.expected.json`), `${JSON.stringify(expected, null, 1)}\n`);
}

describe.runIf(WRITE)('version-2 regression fixtures', { timeout: 600_000 }, () => {
  for (const f of FIXTURES.filter((x) => !ONLY || ONLY.includes(x.name))) it(`writes ${f.name}`, () => write(f));
});

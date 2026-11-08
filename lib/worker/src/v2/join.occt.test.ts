/**
 * `core.boolean`'s join on the real kernel: a converted vase whose twelve
 * fins are combined with its body. One fin lies on the revolve's seam, a few
 * 1e-7 from the body's edges, where a plain fuse loses the body.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { saveDocument } from '@tweakcad/editor';
import type { Json } from './context';
import { evaluateDocument } from './evaluate';

const HERE = dirname(fileURLToPath(import.meta.url));
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

describe('joining many bodies', () => {
  it('keeps the body when a tool lies on its seam', { timeout: 120_000 }, () => {
    const text = readFileSync(resolvePath(HERE, '../../../testing/fixtures/vase-combine.cadjson'), 'utf8');
    // Saved as the app saves it, with the tools in canonical order: the order that lost the body.
    const doc = JSON.parse(saveDocument(JSON.parse(text) as never)) as Json;
    const ev = evaluateDocument(doc, k, { solver: gcs });
    try {
      expect(ev.pauses).toEqual([]);
      const [part] = [...ev.parts.values()];
      const bodies = [...(part?.state.entities.values() ?? [])].filter((e) => e.kind === 'body');
      expect(bodies).toHaveLength(1);
      expect(ev.adapter.measures((bodies[0] as { key: number }).key).volume).toBeCloseTo(62686, -1);
    } finally {
      ev.adapter.dispose();
    }
  });
});

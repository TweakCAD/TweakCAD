/**
 * An imported body through the cloud on the real kernel: its stored shape
 * goes up once as a file and the document as stored names it external, so
 * the stored document alone does not build the body; opened again, the file
 * comes back and the body builds as before.
 */
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Editor, loadDocument, type Json } from '@tweakcad/editor';
import { DocBuilder } from '@tweakcad/worker/src/v2/docBuilder';
import { imported } from '@tweakcad/worker/src/v2/primitivesDocs';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { CloudProjects } from './cloud';
import { FakeSite } from './fakeSite';

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  service = new EvaluationService(k);
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

/** The shown part's bodies: how many, and their total volume. */
function bodies(display: Display, part: string): { count: number; volume: number } {
  const definition = display.definitions[display.parts[part] as number];
  let volume = 0;
  for (const b of definition?.bodies ?? []) {
    const m = service.measure('volume', [b.key]);
    if ('value' in m) volume += m.value;
  }
  return { count: definition?.bodies.length ?? 0, volume };
}

describe('an imported body through the cloud', { timeout: 60_000 }, () => {
  it('stores the shape once by hash and builds the same body when opened again', async () => {
    const d = new DocBuilder();
    const fixture = imported(d, k, [k.makeBox(20, 10, 5)]);
    const doc = d.document();
    Object.assign(doc.assets as Json, fixture.assets);
    const loaded = loadDocument(new Editor(doc).save());
    if (!loaded.ok) throw new Error(loaded.message);
    const before = service.evaluate(loaded.document);
    expect(before.pauses).toEqual([]);
    expect(bodies(before, d.partId)).toEqual({ count: 1, volume: expect.closeTo(1000, 6) as unknown as number });

    const site = new FakeSite();
    const cloud = new CloudProjects(site, site);
    const { id } = await cloud.create('Imported');
    await cloud.save(id, loaded.document);
    const [hash] = Object.keys(fixture.assets);
    expect(site.uploads).toEqual([hash]);

    const stored = loadDocument(site.projects.get(id)!.text!);
    if (!stored.ok) throw new Error(stored.message);
    const alone = service.evaluate(stored.document);
    expect(alone.pauses.map((p) => p.message).join(' ')).toMatch(/not loaded/);

    const opened = await new CloudProjects(site, site).open(id);
    expect(opened.missing).toEqual([]);
    const after = service.evaluate(opened.doc!);
    expect(after.pauses).toEqual([]);
    expect(bodies(after, d.partId).volume).toBeCloseTo(1000, 6);
  });
});

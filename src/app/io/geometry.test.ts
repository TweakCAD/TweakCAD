import { describe, expect, it } from 'vitest';
import { contentHash } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import type { ImportedShape } from '@tweakcad/worker/src/v2/service/client';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { importGeometry, type GeometryClient } from './geometry';
import { ImportCancelled } from './importJobs';

const BYTES = new TextEncoder().encode('ISO-10303-21; a block');
const HASH = contentHash(BYTES);

/** A client whose read finishes when the test says so. */
function deferredClient(): { client: GeometryClient; finish: () => void } {
  let finish: () => void = () => undefined;
  const shape: ImportedShape = {
    stored: { asset: HASH, representation: { name: 'brep', version: 1 }, map: [], derived: { fingerprint: HASH } },
    assets: {},
    source: HASH,
    bodies: 1,
  };
  return {
    client: { importFile: () => new Promise((resolve) => (finish = () => resolve(shape))) },
    finish: () => finish(),
  };
}

function twoParts() {
  const d = new Docs(7);
  const base = d.part('Base');
  const arm = d.part('Arm');
  const editor = new Editor(d.document({ part: { id: base.id } }), { ids: seededIds(5), validate: () => [] });
  const timeline = (part: string) =>
    (((editor.document.parts as Json[]).find((p) => p.id === part)?.timeline ?? []) as Json[]).map((f) => f.type);
  return { editor, base: base.id, arm: arm.id, timeline };
}

describe('importing a file', () => {
  it('adds it to the part it was started in, not the document root', async () => {
    const { editor, base, arm, timeline } = twoParts();
    const { client, finish } = deferredClient();
    const pending = importGeometry(editor, client, { name: 'block.step', bytes: BYTES }, 'step', arm);
    finish();
    expect(await pending).toMatchObject({ ok: true, name: 'block' });
    expect(timeline(arm)).toEqual(['core.import']);
    expect(timeline(base)).toEqual([]);
  });

  it('adds nothing when its part went while the file was read', async () => {
    const { editor, arm } = twoParts();
    const { client, finish } = deferredClient();
    const pending = importGeometry(editor, client, { name: 'block.step', bytes: BYTES }, 'step', arm);
    expect(editor.dispatch({ type: 'removePart', part: arm }).ok).toBe(true);
    const before = editor.save();
    finish();
    expect(await pending).toEqual({ ok: false, dropped: true, message: 'The part the file was imported into is gone' });
    expect(editor.save()).toBe(before);
  });

  it('adds nothing, and warns of nothing, when the import is cancelled', async () => {
    const { editor, arm, timeline } = twoParts();
    const client: GeometryClient = { importFile: () => Promise.reject(new ImportCancelled()) };
    const outcome = await importGeometry(editor, client, { name: 'block.step', bytes: BYTES }, 'step', arm);
    expect(outcome).toEqual({ ok: false, dropped: true, message: 'The import was cancelled' });
    expect(timeline(arm)).toEqual([]);
  });
});

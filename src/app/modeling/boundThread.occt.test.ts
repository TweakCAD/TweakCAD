/**
 * A tapped hole and a thread whose size a parameter sets, edited through
 * their panels' models on the real kernel: opened, left as they are and
 * confirmed, they keep the binding, so switching the part's Size
 * configuration still resizes the thread the display draws.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display, ThreadDisplay } from '@tweakcad/worker/src/v2/service/types';
import { findFeature } from '../features';
import { configurationsOf, setActiveConfiguration } from '../parameters';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { editTarget, ValueSlots, writeFeature, type Built, type FeatureTarget } from './feature';
import { buildHole, readHole } from './hole';
import { buildThread, readThread } from './thread';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolvePath(HERE, '../../../lib/testing/fixtures/v2');

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(HERE, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  service = new EvaluationService(k, await make_gcs_wrapper(realpathSync(wasm)));
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

function client(s: EvaluationService): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(s.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(s.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(s.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(s.properties(key)),
    externalCurves: (key, mode, frame) => Promise.resolve(s.externalCurves(key, mode, frame)),
    measure: (kind, targets) => Promise.resolve(s.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(s.resolve(record, scope)),
    bodiesBefore: (scope, records, options) => Promise.resolve(s.bodiesBefore(scope, records, options)),
  };
}

async function settled(s: AppServices): Promise<Display> {
  do await s.scheduler.whenIdle();
  while (s.scheduler.busy);
  const display = s.display.getState().display;
  if (!display) throw new Error('nothing shown');
  return display;
}

async function open(name: string): Promise<{ s: AppServices; part: string }> {
  const { services: s } = await bootApp({
    client: client(service),
    workingCopy: new MemoryWorkingCopy(),
    localId: null,
    ids: seededIds(41),
    name: () => name,
  });
  const doc = JSON.parse(readFileSync(resolvePath(FIXTURES, `${name}.cadjson`), 'utf8')) as Json;
  s.editor.store.replace(doc);
  await settled(s);
  return { s, part: ((doc.parts as Json[])[0] as Json).id as string };
}

const threadOf = (display: Display, part: string): ThreadDisplay | undefined =>
  display.definitions[display.parts[part] as number]?.threads[0];

/** What OK does: builds the form as it stands and writes it as one step. */
function ok(s: AppServices, target: FeatureTarget, type: string, build: (values: ValueSlots) => Built): void {
  const built = build(new ValueSlots(() => s.editor.newId('val'), target.base, s.editor.document));
  if (!built.ok) throw new Error(built.message);
  const written = writeFeature(s.editor, target, type, built);
  if (!written.ok) throw new Error(written.error.message);
}

async function switchSize(s: AppServices, part: string, size: string): Promise<Display> {
  const [configuration] = configurationsOf(s.editor.document, part);
  if (!configuration) throw new Error('no configuration');
  const r = setActiveConfiguration(s.editor, configuration, size);
  if (!r.ok) throw new Error(r.error.message);
  return settled(s);
}

describe('a thread sized by a parameter, edited in its panel', { timeout: 120_000 }, () => {
  it("keeps the nut's Hole 1 bound to the parameter through an unchanged edit, and follows the configuration", async () => {
    const { s, part } = await open('hex-nut-iso4032');
    expect(threadOf(await settled(s), part)).toMatchObject({ designation: 'M6', pitch: 1 });
    const hole = ((s.editor.document.parts as Json[])[0]!.timeline as Json[]).find((f) => f.name === 'Hole 1') as Json;
    const target = editTarget(s.editor.document, part, hole.id as string, 'core.hole')!;
    const form = readHole(s.editor.document, part, target.base!)!;
    expect(form.designation).toBe('M6');
    ok(s, target, 'core.hole', (values) => buildHole(s.editor.document, target, form, values));

    const stored = ((findFeature(s.editor.document, hole.id as string)!.inputs as Json).thread as Json).thread as Json;
    expect(((stored.designation as Json).def as Json).expr).toMatchObject({
      text: 'thread',
      refs: { thread: { parameter: {} } },
    });
    expect(threadOf(await settled(s), part)).toMatchObject({ designation: 'M6', pitch: 1 });

    const m10 = threadOf(await switchSize(s, part, 'M10'), part);
    expect(m10).toMatchObject({ designation: 'M10', internal: true, pitch: 1.5 });
    expect(m10?.radius).toBeCloseTo(4.25, 6);
    expect(
      readHole(s.editor.document, part, editTarget(s.editor.document, part, hole.id as string, 'core.hole')!.base!)
        ?.designation,
    ).toBe('M10');
    s.dispose();
  });

  it("keeps the bolt's Thread 1 bound the same way", async () => {
    const { s, part } = await open('hex-bolt-iso4017');
    const thread = ((s.editor.document.parts as Json[])[0]!.timeline as Json[]).find(
      (f) => f.type === 'core.thread',
    ) as Json;
    const target = editTarget(s.editor.document, part, thread.id as string, 'core.thread')!;
    const form = readThread(s.editor.document, part, target.base!);
    expect(form.designation).toBe('M6');
    ok(s, target, 'core.thread', (values) => buildThread(s.editor.document, target, form, values));
    const stored = findFeature(s.editor.document, thread.id as string)!.inputs as Json;
    expect(((stored.designation as Json).def as Json).expr).toMatchObject({ text: 'thread' });

    const m10 = threadOf(await switchSize(s, part, 'M10'), part);
    expect(m10).toMatchObject({ designation: 'M10', internal: false, pitch: 1.5 });
    expect(m10?.radius).toBeCloseTo(5, 6);
    s.dispose();
  });
});

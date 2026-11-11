/**
 * What FreeCAD 26.3 writes that 1.1 does not. No 26.3 build is at hand, so these
 * files are FreeCAD 1.1 fixtures with their properties rewritten the way 26.3
 * saves them (`Revolved::onDocumentRestored`, `FeatureExtrude`, tag 26.3rc2),
 * keeping the shape FreeCAD stored as the answer.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { seededIds } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { complete } from './complete';
import { importFcstd } from './index';
import type { Json } from './writer';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures');

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  service = new EvaluationService(k, gcs);
});
afterAll(() => {
  service.release();
  k.releaseAll();
});

const client = {
  evaluate: (doc: unknown, options?: { meshes?: boolean }) => Promise.resolve(service.evaluate(doc as Json, options)),
  locate: (
    part: string,
    before: string | undefined,
    brep: string,
    kind: 'edge' | 'face',
    indices: number[] | 'all',
    ofFaces?: number[],
  ) => Promise.resolve(service.locate(part, before, brep, kind, indices, ofFaces)),
  bodyRecords: (part: string, before: string | undefined) => Promise.resolve(service.bodyRecords(part, before)),
  importFile: (bytes: Uint8Array, format: 'brep', name: string) =>
    Promise.resolve(service.importFile(bytes, format, name)),
  shapeMeasures: (brep: string) => Promise.resolve(service.shapeMeasures(brep)),
  stepMeasures: (part: string, feature: string) => Promise.resolve(service.stepMeasures(part, feature)),
};

const property = (name: string, type: string, inner: string) =>
  `<Property name="${name}" type="App::Property${type}">${inner}</Property>`;
const enumeration = (name: string, index: number) => property(name, 'Enumeration', `<Integer value="${index}"/>`);
const float = (name: string, type: string, v: number) => property(name, type, `<Float value="${v}"/>`);

/** The fixture with the properties of object `name` set, replacing any of the same name. */
function rewritten(file: string, name: string, props: Record<string, string>): Uint8Array {
  const entries = unzipSync(new Uint8Array(readFileSync(join(FIXTURES, file))));
  let xml = strFromU8(entries['Document.xml'] as Uint8Array);
  const at = xml.indexOf(`<Object name="${name}"`);
  if (at < 0) throw new Error(`no object ${name}`);
  const end = xml.indexOf('</Object>', at);
  let body = xml.slice(at, end);
  let added = 0;
  for (const [prop, text] of Object.entries(props)) {
    const old = new RegExp(`<Property name="${prop}"[^>]*>[\\s\\S]*?</Property>`);
    if (old.test(body)) body = body.replace(old, text);
    else {
      body = body.replace('</Properties>', `${text}</Properties>`);
      added++;
    }
  }
  body = body.replace(/<Properties Count="(\d+)"/, (_, n: string) => `<Properties Count="${Number(n) + added}"`);
  xml = xml.slice(0, at) + body + xml.slice(end);
  return zipSync({ ...entries, 'Document.xml': strToU8(xml) });
}

/** The import with no stored shape standing in, so what the converter wrote is what is measured. */
async function imported(bytes: Uint8Array) {
  const result = importFcstd(bytes, {
    ids: seededIds(3),
    writer: { app: 'test', version: '0' },
    name: 'newer',
    now: '2026-11-06T00:00:00Z',
  });
  if (!result.ok) throw new Error(result.error);
  const { document, steps, notes } = result.value;
  const late = await complete(document, steps, client);
  const display = service.evaluate(document);
  const def = display.definitions[0] as Display['definitions'][number];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  for (const b of def.bodies) {
    const m = service.measure('volume', [b.key]);
    if ('value' in m) volume += m.value;
    b.mesh.positions.forEach((v, i) => {
      min[i % 3] = Math.min(min[i % 3] as number, v);
      max[i % 3] = Math.max(max[i % 3] as number, v);
    });
  }
  return { document, display, volume, min, max, notes: [...notes, ...late] };
}

const timeline = (doc: Json) => ((doc.parts as Json[])[0] as Json).timeline as Json[];
const featureOf = (doc: Json, type: string) => timeline(doc).find((f) => f.type === type) as Json;

const threadOf = (doc: Json) => ((featureOf(doc, 'core.hole').inputs as Json).thread as Json).thread as Json;
const text = (v: unknown) => (((v as Json).def as Json).expr as Json).text;

describe('threads in a Hole', { timeout: 120_000 }, () => {
  it('reads ModelThread as a modelled thread, which rebuilds with no stored shape', async () => {
    const { document, notes, display } = await imported(
      new Uint8Array(readFileSync(join(FIXTURES, 'hole_model_thread.FCStd'))),
    );
    const t = threadOf(document);
    expect(text(t.modelled)).toBe('true');
    expect(text(t.class)).toBe('"6H"');
    expect(text(t.designation)).toBe('"M6x1.0"');
    expect(notes.filter((n) => n.severity === 'warning')).toEqual([]);
    expect(display.pauses).toEqual([]);
  });

  it('keeps a thread that is not modelled as one', async () => {
    const { document } = await imported(new Uint8Array(readFileSync(join(FIXTURES, 'hole_threaded.FCStd'))));
    expect(text(threadOf(document).modelled)).toBe('false');
  });

  it('says so when a modelled thread stops short of the bore, and keeps a left-hand thread left-handed', async () => {
    const { document, notes } = await imported(
      rewritten('hole_model_thread_blind.FCStd', 'Hole', {
        ThreadDepthType: enumeration('ThreadDepthType', 1),
        ThreadDirection: enumeration('ThreadDirection', 1),
      }),
    );
    expect(notes.filter((n) => n.object === 'Hole' && n.severity === 'warning').map((n) => n.message)).toEqual([
      'its thread depth was not imported; the thread runs the whole bore',
    ]);
    expect(text(threadOf(document).hand)).toBe('"left"');
  });
});

describe('odd Bodies', { timeout: 120_000 }, () => {
  it("finds a Body's features from its Tip when its group leaves them out", async () => {
    const { document, volume } = await imported(
      rewritten('pocket_reversed.FCStd', 'Body', {
        Group: property('Group', 'LinkList', '<LinkList count="0"></LinkList>'),
      }),
    );
    const plain = await imported(new Uint8Array(readFileSync(join(FIXTURES, 'pocket_reversed.FCStd'))));
    expect(timeline(document).filter((f) => f.type === 'core.extrude')).toHaveLength(2);
    expect(volume).toBeCloseTo(plain.volume, 6);
  });
});

describe('files from FreeCAD 26.3', { timeout: 120_000 }, () => {
  it('reads a symmetric revolve from SideType', async () => {
    const before = await imported(new Uint8Array(readFileSync(join(FIXTURES, 'revolution_symmetric.FCStd'))));
    const after = await imported(
      rewritten('revolution_symmetric.FCStd', 'Revolution', {
        Midplane: property('Midplane', 'Bool', '<Bool value="false"/>'),
        SideType: enumeration('SideType', 2),
        Type2: enumeration('Type2', 0),
      }),
    );
    expect(
      ((featureOf(after.document, 'core.revolve').inputs as Json).sides as Json[]).map((s) => Object.keys(s)),
    ).toEqual([['symmetric']]);
    expect(after.volume).toBeCloseTo(before.volume, 6);
    expect(after.min).toEqual(before.min);
  });

  it('reads two sides from SideType and Type2', async () => {
    const before = await imported(new Uint8Array(readFileSync(join(FIXTURES, 'revolution_two_angles.FCStd'))));
    const after = await imported(
      rewritten('revolution_two_angles.FCStd', 'Revolution', {
        Type: enumeration('Type', 0),
        SideType: enumeration('SideType', 1),
        Type2: enumeration('Type2', 0),
      }),
    );
    expect(((featureOf(after.document, 'core.revolve').inputs as Json).sides as Json[]).length).toBe(2);
    expect(after.volume).toBeCloseTo(before.volume, 6);
  });

  it('turns two sides that add up to a whole turn into a full revolve', async () => {
    const after = await imported(
      rewritten('revolution_two_angles.FCStd', 'Revolution', {
        Type: enumeration('Type', 0),
        SideType: enumeration('SideType', 1),
        Type2: enumeration('Type2', 0),
        Angle: float('Angle', 'Angle', 200),
        Angle2: float('Angle2', 'Angle', 170),
      }),
    );
    expect(
      ((featureOf(after.document, 'core.revolve').inputs as Json).sides as Json[]).map((s) => Object.keys(s)),
    ).toEqual([['full']]);
  });

  it('does not write signed angles on one side as a revolve', async () => {
    const after = await imported(
      rewritten('revolution_two_angles.FCStd', 'Revolution', {
        Type: enumeration('Type', 0),
        SideType: enumeration('SideType', 1),
        Type2: enumeration('Type2', 0),
        Angle: float('Angle', 'Angle', 50),
        Angle2: float('Angle2', 'Angle', -20),
      }),
    );
    expect(featureOf(after.document, 'core.revolve')).toBeUndefined();
    expect(after.notes.map((n) => n.object)).toContain('Revolution');
  });

  it('says so when a revolve has a start it cannot keep', async () => {
    const after = await imported(
      rewritten('revolution_partial.FCStd', 'Revolution', {
        StartType: enumeration('StartType', 1),
        StartOffset: float('StartOffset', 'Angle', 30),
      }),
    );
    expect(after.notes.filter((n) => n.severity === 'warning').map((n) => n.message)).toEqual([
      'its start of 30° was not imported; it revolves from the sketch plane',
    ]);
  });

  it('says so for a groove too', async () => {
    const after = await imported(
      rewritten('groove_partial.FCStd', 'Groove', { StartType: enumeration('StartType', 2) }),
    );
    expect(after.notes.filter((n) => n.severity === 'warning').map((n) => n.message)).toEqual([
      'its start reference was not imported; it revolves from the sketch plane',
    ]);
  });

  it('moves a pad by its start offset', async () => {
    const before = await imported(new Uint8Array(readFileSync(join(FIXTURES, 'constrained_plate.FCStd'))));
    const after = await imported(
      rewritten('constrained_plate.FCStd', 'Pad', {
        StartType: enumeration('StartType', 1),
        StartOffset: float('StartOffset', 'Length', 3),
      }),
    );
    expect(after.volume).toBeCloseTo(before.volume, 6);
    expect(after.min[2]).toBeCloseTo((before.min[2] as number) + 3, 5);
    expect(after.max[2]).toBeCloseTo((before.max[2] as number) + 3, 5);
  });

  it('moves a pocket along the way it cuts, so a negative start begins outside the block', async () => {
    const plain = await imported(new Uint8Array(readFileSync(join(FIXTURES, 'pocket_reversed.FCStd'))));
    const after = await imported(
      rewritten('pocket_reversed.FCStd', 'Pocket', {
        StartType: enumeration('StartType', 1),
        StartOffset: float('StartOffset', 'Length', -1.5),
      }),
    );
    expect(after.volume - plain.volume).toBeCloseTo(10 * 10 * 1.5, 3);
  });

  it('takes the axis FreeCAD stored when ProjectAxis moved it off its reference', async () => {
    // The sketch lies at z = 4, its reference the x axis at z = 0: projected, the axis is the sketch's own x axis.
    const after = await imported(
      rewritten('revolution_projected.FCStd', 'Revolution', {
        ReferenceAxis: property(
          'ReferenceAxis',
          'LinkSub',
          '<LinkSub value="X_Axis" count="1"><Sub value=""/></LinkSub>',
        ),
        ProjectAxis: property('ProjectAxis', 'Bool', '<Bool value="true"/>'),
      }),
    );
    const before = await imported(new Uint8Array(readFileSync(join(FIXTURES, 'revolution_projected.FCStd'))));
    expect(after.display.pauses).toEqual([]);
    expect('through' in ((featureOf(after.document, 'core.revolve').inputs as Json).axis as Json)).toBe(true);
    expect(after.volume).toBeCloseTo(before.volume, 6);
  });
});

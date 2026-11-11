/**
 * The version-2 fixtures written as FreeCAD files and imported back: each part
 * must come back with its volume. With FCSTD_EXPORT_OUT set the files are also
 * written there, for FreeCAD itself to open and recompute.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { OcctKernel } from 'occt-wasm';
import { seededIds } from '@tweakcad/editor';
import { complete, importFcstd } from '@tweakcad/fcstd-import';
import { findChild, parseXml } from '../../../../fcstd-import/src/xml';
import { EvaluationService } from '../service/service';
import type { Display } from '../service/types';

type Json = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolvePath(here, '../../../../testing/fixtures/v2');
const OUT = process.env.FCSTD_EXPORT_OUT;

/**
 * What FreeCAD would stop at reading `gui`, in the order its GUI document
 * reader takes: a Document of schema 1, a ViewProviderData holding as many
 * ViewProviders as it counts, each naming an object of the file with its
 * properties counted, then a Camera. Null when it reads through.
 */
function guiProblem(gui: string, documentXml: string): string | null {
  const parsed = parseXml(gui);
  if (!parsed.ok) return parsed.error;
  const root = parsed.value;
  if (root.name !== 'Document' || root.attrs.SchemaVersion !== '1') return 'no Document of schema 1';
  const [data, camera] = root.children;
  if (data?.name !== 'ViewProviderData') return 'no ViewProviderData first';
  if (Number(data.attrs.Count) !== data.children.length || data.children.some((c) => c.name !== 'ViewProvider')) {
    return 'ViewProviderData does not hold as many view providers as it counts';
  }
  const objects = new Set([...documentXml.matchAll(/<Object type="[^"]+" name="([^"]+)"/g)].map((m) => m[1]));
  for (const view of data.children) {
    if (!objects.has(view.attrs.name)) return `a view provider names ${view.attrs.name}, which is not in the file`;
    const props = findChild(view, 'Properties');
    if (!props || Number(props.attrs.Count) !== props.children.filter((c) => c.name === 'Property').length) {
      return `the properties of ${view.attrs.name} are not as counted`;
    }
  }
  if (camera?.name !== 'Camera' || camera.attrs.settings === undefined) return 'no Camera after the view providers';
  return null;
}

/** The pads and pockets of `documentXml` that set Midplane, which FreeCAD 1.1 warns of on opening. */
function midplaneExtrudes(documentXml: string): string[] {
  const extrudes = new Set(
    [...documentXml.matchAll(/<Object type="PartDesign::(?:Pad|Pocket)" name="([^"]+)"/g)].map((m) => m[1]),
  );
  return [...documentXml.matchAll(/<Object name="([^"]+)"[^>]*>([\s\S]*?)<\/Object>/g)]
    .filter((m) => extrudes.has(m[1]) && /<Property name="Midplane"/.test(m[2] as string))
    .map((m) => m[1] as string);
}

let k: OcctKernel;
let gcs: GcsWrapper;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5, 6]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  if (OUT) mkdirSync(OUT, { recursive: true });
});
afterAll(() => k.releaseAll());

/** The volume shown: every placed part of an assembly, or the root part's bodies. */
function volume(service: EvaluationService, display: Display, doc: Json): number {
  const of = (index: number) => {
    let sum = 0;
    for (const b of (display.definitions[index] as Display['definitions'][number]).bodies) {
      const m = service.measure('volume', [b.key]);
      if ('value' in m) sum += m.value;
    }
    return sum;
  };
  const root = doc.root as Json;
  if ('part' in root) {
    const id = (root.part as Json).id;
    return of(display.definitions.findIndex((d) => d.part === id && d.variant === ''));
  }
  return (display.assemblies[0]?.instances ?? []).reduce((sum, i) => sum + of(i.definition), 0);
}

/** The box of what the root part shows; an assembly's parts are placed, so it has none here. */
function boxOf(display: Display, doc: Json): number[] | null {
  const root = doc.root as Json;
  if (!('part' in root)) return null;
  const def = display.definitions.find((d) => d.part === (root.part as Json).id && d.variant === '');
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const b of def?.bodies ?? []) {
    const p = b.mesh.positions;
    for (let i = 0; i < p.length; i++) {
      const a = i % 3;
      box[a] = Math.min(box[a] as number, p[i] as number);
      box[a + 3] = Math.max(box[a + 3] as number, p[i] as number);
    }
  }
  return box;
}

/** What comes back as stored shapes: a whole-body pattern in two directions is a chain of bodies, which is not built yet. */
const STORED: Record<string, string[]> = {
  'features-patterns.cadjson': ['Pattern 1'],
};

const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.cadjson'))
  .sort();

const IMPORTED = resolvePath(here, '../../../../fcstd-import/fixtures');
const client = (s: EvaluationService) => ({
  evaluate: (d: unknown) => Promise.resolve(s.evaluate(d as Json)),
  locate: (part: string, before: string | undefined, brep: string, kind: 'edge' | 'face', indices: number[] | 'all') =>
    Promise.resolve(s.locate(part, before, brep, kind, indices)),
  bodyRecords: (part: string, before: string | undefined) => Promise.resolve(s.bodyRecords(part, before)),
  importFile: (b: Uint8Array, format: 'brep', name: string) => Promise.resolve(s.importFile(b, format, name)),
  shapeMeasures: (brep: string) => Promise.resolve(s.shapeMeasures(brep)),
  stepMeasures: (part: string, feature: string) => Promise.resolve(s.stepMeasures(part, feature)),
});

/** FreeCAD files round the other way: imported, written out, and imported again. */
describe('FreeCAD files through the document', { timeout: 120_000 }, () => {
  for (const file of readdirSync(IMPORTED)
    .filter((f) => f.endsWith('.FCStd'))
    .sort()) {
    it(`keeps ${file}`, async () => {
      const service = new EvaluationService(k, gcs);
      const first = importFcstd(new Uint8Array(readFileSync(join(IMPORTED, file))), {
        ids: seededIds(7),
        writer: { app: 'test', version: '0' },
        name: 'first',
        now: '2026-11-06T00:00:00Z',
      });
      if (!first.ok) throw new Error(first.error);
      await complete(first.value.document, first.value.steps, client(service), first.value.checks, first.value.styles);
      const display = service.evaluate(first.value.document);
      const want = volume(service, display, first.value.document);
      const out = service.exportFreeCad();
      if (OUT) {
        const stem = `fc-${file.replace(/\.FCStd$/, '')}`;
        writeFileSync(join(OUT, `${stem}.FCStd`), out.bytes);
        writeFileSync(
          join(OUT, `${stem}.json`),
          JSON.stringify(
            { volume: want, box: boxOf(display, first.value.document), notes: out.notes, bodies: out.bodies },
            null,
            1,
          ),
        );
      }
      service.release();
      const back = new EvaluationService(k, gcs);
      const second = importFcstd(out.bytes, {
        ids: seededIds(8),
        writer: { app: 'test', version: '0' },
        name: 'second',
        now: '2026-11-06T00:00:00Z',
      });
      if (!second.ok) throw new Error(second.error);
      await complete(second.value.document, second.value.steps, client(back), second.value.checks, second.value.styles);
      const again = back.evaluate(second.value.document);
      const got = volume(back, again, second.value.document);
      // A part the document does not show, such as a Body another was cut by, has no look to keep.
      const looks = (d: Display, doc: Json) => {
        const root = doc.root as Json;
        const shown = 'part' in root ? d.definitions.filter((x) => x.part === (root.part as Json).id) : d.definitions;
        return shown.flatMap((x) => x.bodies.map((b) => [b.color, b.opacity]));
      };
      expect(looks(again, second.value.document)).toEqual(looks(display, first.value.document));
      back.release();
      expect(got / want).toBeCloseTo(1, 4);
    });
  }
});

describe('FreeCAD export', { timeout: 120_000 }, () => {
  for (const file of files) {
    it(`writes ${file} and reads it back`, async () => {
      const doc = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as Json;
      const service = new EvaluationService(k, gcs);
      const display = service.evaluate(doc);
      const want = volume(service, display, doc);
      const out = service.exportFreeCad();
      const archive = unzipSync(out.bytes);
      const documentXml = strFromU8(archive['Document.xml'] as Uint8Array);
      const gui = archive['GuiDocument.xml'];
      if (gui) expect(guiProblem(strFromU8(gui), documentXml)).toBeNull();
      expect(midplaneExtrudes(documentXml)).toEqual([]);
      if (OUT) {
        const stem = file.replace(/\.cadjson$/, '');
        writeFileSync(join(OUT, `${stem}.FCStd`), out.bytes);
        writeFileSync(
          join(OUT, `${stem}.json`),
          JSON.stringify({ volume: want, box: boxOf(display, doc), notes: out.notes, bodies: out.bodies }, null, 1),
        );
      }
      service.release();

      const back = new EvaluationService(k, gcs);
      const imported = importFcstd(out.bytes, {
        ids: seededIds(5),
        writer: { app: 'test', version: '0' },
        name: 'back',
        now: '2026-11-06T00:00:00Z',
      });
      if (!imported.ok) throw new Error(imported.error);
      const { document, steps, notes, checks } = imported.value;
      const late = await complete(
        document,
        steps,
        {
          evaluate: (d) => Promise.resolve(back.evaluate(d as Json)),
          locate: (part, before, brep, kind, indices) =>
            Promise.resolve(back.locate(part, before, brep, kind, indices)),
          bodyRecords: (part, before) => Promise.resolve(back.bodyRecords(part, before)),
          importFile: (b, format, name) => Promise.resolve(back.importFile(b, format, name)),
          shapeMeasures: (brep) => Promise.resolve(back.shapeMeasures(brep)),
          stepMeasures: (part, feature) => Promise.resolve(back.stepMeasures(part, feature)),
        },
        checks,
      );
      const again = back.evaluate(document);
      const got = volume(back, again, document);
      back.release();
      if (OUT)
        writeFileSync(
          join(OUT, `${file.replace(/\.cadjson$/, '')}.back.json`),
          JSON.stringify({ want, got, notes: [...notes, ...late], pauses: again.pauses }, null, 1),
        );
      expect([...notes, ...late].filter((n) => n.severity === 'warning').map((n) => n.object)).toEqual(
        STORED[file] ?? [],
      );
      expect(again.pauses.map((p) => p.message)).toEqual([]);
      expect(got / want).toBeCloseTo(1, 5);
      const before = ((doc.parts as Json[])[0] as Json).timeline as Json[];
      const after = ((document.parts as Json[])[0] as Json).timeline as Json[];
      const flag = (rows: Json[]) =>
        rows
          .filter((f) => f.type === 'core.hole' && 'thread' in ((f.inputs as Json).thread as Json))
          .map(
            (f) => (((((f.inputs as Json).thread as Json).thread as Json).modelled as Json).def as Json).expr as Json,
          )
          .map((e) => e.text);
      expect(flag(after)).toEqual(flag(before));
    });
  }
});

describe('FreeCAD export of threads', { timeout: 120_000 }, () => {
  it('writes a fine, left-hand tapped hole as a FreeCAD fine thread turning left', async () => {
    const doc = JSON.parse(readFileSync(join(FIXTURES, 'hex-nut-iso4032.cadjson'), 'utf8')) as Json;
    const part = (doc.parts as Json[])[0] as Json;
    const hole = (part.timeline as Json[]).find((f) => f.type === 'core.hole') as Json;
    const thread = ((hole.inputs as Json).thread as Json).thread as Json;
    (thread.designation as Json).def = { expr: { grammar: 1, refs: {}, text: '"M6x0.75"' } };
    thread.hand = { def: { expr: { grammar: 1, refs: {}, text: '"left"' } }, id: 'val_lefthandaaaaaaaaaaaaaaaaaa' };

    const service = new EvaluationService(k, gcs);
    const display = service.evaluate(doc);
    expect(display.pauses).toEqual([]);
    const out = service.exportFreeCad();
    service.release();
    expect(out.notes.map((n) => n.message).filter((m) => /coarse|right-hand|no M6/.test(m))).toEqual([]);

    const back = importFcstd(out.bytes, {
      ids: seededIds(5),
      writer: { app: 'test', version: '0' },
      name: 'back',
      now: '2026-11-06T00:00:00Z',
    });
    if (!back.ok) throw new Error(back.error);
    const read = (((back.value.document.parts as Json[])[0] as Json).timeline as Json[]).find(
      (f) => f.type === 'core.hole',
    ) as Json;
    const got = ((read.inputs as Json).thread as Json).thread as Json;
    const text = (v: unknown) => (((v as Json).def as Json).expr as Json).text;
    expect(text(got.designation)).toBe('"M6x0.75"');
    expect(text(got.hand)).toBe('"left"');
  });
});

/** The properties written for the first object of `type`, each by its value attribute; undefined when there is none. */
function written(bytes: Uint8Array, type: string): Record<string, string> | undefined {
  const xml = strFromU8(unzipSync(bytes)['Document.xml'] as Uint8Array);
  const name = xml.match(new RegExp(`<Object type="${type}" name="([^"]+)"`))?.[1];
  if (!name) return undefined;
  const at = xml.indexOf(`<Object name="${name}"`);
  const object = xml.slice(at, xml.indexOf('</Object>', at));
  return Object.fromEntries(
    [...object.matchAll(/<Property name="([^"]+)"[^>]*><[A-Za-z]+ value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
}

/** Writes `doc`, imports it back, and gives the export and the boxes of what the root part shows before and after. */
async function roundTrip(doc: Json) {
  const service = new EvaluationService(k, gcs);
  const display = service.evaluate(doc);
  expect(display.pauses).toEqual([]);
  const box = boxOf(display, doc);
  const out = service.exportFreeCad();
  service.release();
  const back = new EvaluationService(k, gcs);
  const imported = importFcstd(out.bytes, {
    ids: seededIds(5),
    writer: { app: 'test', version: '0' },
    name: 'back',
    now: '2026-11-06T00:00:00Z',
  });
  if (!imported.ok) throw new Error(imported.error);
  const { document, steps, checks } = imported.value;
  await complete(document, steps, client(back), checks);
  const again = back.evaluate(document);
  back.release();
  return { out, box, back: boxOf(again, document) };
}

describe('FreeCAD export of patterns', { timeout: 120_000 }, () => {
  /** The features at `keep` of the patterns fixture, one solid and its pattern, the last's inputs changed by `edit`. */
  const patterns = (keep: number[], edit: (inputs: Json) => void): Json => {
    const doc = JSON.parse(readFileSync(join(FIXTURES, 'features-patterns.cadjson'), 'utf8')) as Json;
    const part = (doc.parts as Json[])[0] as Json;
    const timeline = keep.map((n) => (part.timeline as Json[])[n] as Json);
    part.timeline = timeline;
    edit((timeline[timeline.length - 1] as Json).inputs as Json);
    return doc;
  };
  const text = (v: Json, value: string) => {
    ((v.def as Json).expr as Json).text = value;
  };
  /** The first direction of the fixture's linear pattern alone, three copies 10 mm apart along x. */
  const oneDirection = (i: Json): Json => {
    const linear = (i.layout as Json).linear as Json;
    const row = (linear.directions as Json[])[0] as Json;
    linear.directions = [row];
    return row;
  };
  const close = (got: number[] | null, want: number[] | null) => {
    expect(got).toHaveLength(6);
    got?.forEach((x, n) => expect(x).toBeCloseTo(want?.[n] as number, 3));
  };

  it('keeps a symmetric linear direction as the solid it built, its copies on both sides', async () => {
    const doc = patterns([0, 1], (i) => {
      oneDirection(i).symmetric = {
        def: { expr: { grammar: 1, refs: {}, text: 'true' } },
        id: 'val_symmetricaaaaaaaaaaaaaaaaa',
      };
    });
    const { out, box, back } = await roundTrip(doc);
    expect(written(out.bytes, 'PartDesign::LinearPattern')).toBeUndefined();
    expect(out.notes).toContainEqual({
      object: 'Pattern 1',
      message: 'it has no FreeCAD feature here, so it is stored as the solid it built',
    });
    close(back, box);
  });

  it('writes a negative step as its length the other way', async () => {
    const doc = patterns([0, 1], (i) => text(((oneDirection(i).spacing as Json).equal as Json).s as Json, '-10 mm'));
    const { out, box, back } = await roundTrip(doc);
    const p = written(out.bytes, 'PartDesign::LinearPattern');
    expect([p?.Reversed, p?.Length, p?.Offset]).toEqual(['true', '20', '10']);
    close(back, box);
  });

  for (const angle of [-90, -360]) {
    it(`writes a ${angle} deg circular pattern as its angle the other way`, async () => {
      const turn = (a: number) =>
        patterns([2, 4, 5], (i) => text(((i.layout as Json).circular as Json).angle as Json, `${a} deg`));
      const { out, box, back } = await roundTrip(turn(angle));
      const p = written(out.bytes, 'PartDesign::PolarPattern');
      const plus = written((await roundTrip(turn(-angle))).out.bytes, 'PartDesign::PolarPattern');
      expect(p?.Angle).toBe(String(-angle));
      expect(p?.Reversed).toBe(plus?.Reversed === 'true' ? 'false' : 'true');
      close(back, box);
    });
  }
});

describe('FreeCAD export of parameters', { timeout: 120_000 }, () => {
  it('writes the text of a parameter that is neither a length nor an angle as XML', async () => {
    const doc = JSON.parse(readFileSync(join(FIXTURES, 'dowel-pin.cadjson'), 'utf8')) as Json;
    const table = (((doc.parts as Json[])[0] as Json).parameters as Json[])[0] as Json;
    (table.parameters as Json[]).push({
      description: '',
      id: 'par_comparisonaaaaaaaaaaaaaaa',
      name: 'n',
      public: false,
      published: false,
      quantity: 'ratio',
      range: { unbounded: {} },
      type: 'number',
      value: {
        def: { expr: { grammar: 1, refs: {}, text: '1 < 2 && 3 > 2 ? 4 : 5' } },
        id: 'val_comparisonaaaaaaaaaaaaaaa',
      },
    });
    const service = new EvaluationService(k, gcs);
    expect(service.evaluate(doc).pauses).toEqual([]);
    const out = service.exportFreeCad();
    service.release();
    const xml = strFromU8(unzipSync(out.bytes)['Document.xml'] as Uint8Array);
    expect(xml).toContain('content="=1 &lt; 2 &amp;&amp; 3 &gt; 2 ? 4 : 5" alias="n"');
    expect(
      importFcstd(out.bytes, { ids: seededIds(5), writer: { app: 'test', version: '0' }, now: '2026-11-06T00:00:00Z' })
        .ok,
    ).toBe(true);
  });
});

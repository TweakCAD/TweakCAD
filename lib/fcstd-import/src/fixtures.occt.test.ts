/**
 * FreeCAD files made by `fixtures/generate.py`, imported and evaluated on the
 * real kernel and solver: each part must hold the volume of the shape FreeCAD
 * stored for its Body, and the box of its Tip's shape.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { complete } from './complete';
import { importFcstd } from './index';
import { readArchive } from './archive';
import { link, parseDocument, shapeFile } from './document';
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
  importFile: (bytes: Uint8Array, format: 'brep', feature: string, name: string) =>
    Promise.resolve(service.importFile(bytes, format, feature, name)),
  shapeMeasures: (brep: string) => Promise.resolve(service.shapeMeasures(brep)),
  stepMeasures: (part: string, feature: string) => Promise.resolve(service.stepMeasures(part, feature)),
};

/** FreeCAD's own result for each Body: its volume and the box of its Tip's shape, in the Body's frame. */
function freecad(bytes: Uint8Array): { body: string; volume: number; box: [number[], number[]] }[] {
  const archive = readArchive(bytes);
  if (!archive.ok) throw new Error(archive.error);
  const doc = parseDocument(archive.value.documentXml);
  if (!doc.ok) throw new Error(doc.error);
  const measure = (label: string, files: (string | undefined)[]) => {
    const shapes = files.map((f) =>
      k.fromBREP(new TextDecoder().decode(archive.value.files.get(f ?? '') ?? new Uint8Array())),
    );
    const all = k.makeCompound(shapes);
    const box = k.getBoundingBox(all);
    const volume = shapes.reduce((sum, h) => sum + k.getVolume(h), 0);
    for (const h of [all, ...shapes]) k.release(h);
    return {
      body: label,
      volume,
      box: [
        [box.xmin, box.ymin, box.zmin],
        [box.xmax, box.ymax, box.zmax],
      ] as [number[], number[]],
    };
  };
  const bodies = doc.value.objects.filter((o) => o.type === 'PartDesign::Body');
  // A file without Bodies: the Part workbench objects it shows.
  if (bodies.length === 0) {
    const shown = doc.value.objects.filter(
      (o) => o.type.startsWith('Part::') && o.props.get('Visibility')?.children[0]?.attrs.value !== 'false',
    );
    return [
      measure(
        'Part workbench',
        shown.map((o) => shapeFile(o)),
      ),
    ];
  }
  return bodies.map((body) => {
    const tip = doc.value.byName.get(link(body, 'Tip')?.obj ?? '');
    return measure(body.label, [tip && shapeFile(tip)]);
  });
}

/** Each part's volume and the box of its shown meshes. */
function measured(display: Display): { volume: number; box: [number[], number[]] }[] {
  return display.definitions.map((def) => {
    let volume = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const body of def.bodies) {
      const m = service.measure('volume', [body.key]);
      if ('value' in m) volume += m.value;
      const p = body.mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a] as number, p[i + a] as number);
          max[a] = Math.max(max[a] as number, p[i + a] as number);
        }
      }
    }
    return { volume, box: [min, max] as [number[], number[]] };
  });
}

/** Features that come in as the shape FreeCAD stored, as the evaluator does not build them yet. */
const STORED: Record<string, string[]> = {
  'pad_on_face.FCStd': ['OnFace'],
  'pad_face_up_to_datum.FCStd': ['OnFace'],
};

/** Volume agreement in decimal places, where a modelled thread ends differently at the bottom of a blind bore. */
const PLACES: Record<string, number> = { 'hole_model_thread_blind.FCStd': 3 };

/** These show no Body: their own tests below measure them. */
const NO_BODY = new Set(['group_shapes.FCStd', 'link_shapes.FCStd']);
const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.FCStd') && !NO_BODY.has(f))
  .sort();

const opts = (name: string) => ({
  ids: seededIds(3),
  writer: { app: 'test', version: '0' },
  name,
  now: '2026-11-06T00:00:00Z',
});

describe('parameters and placements', { timeout: 120_000 }, () => {
  it('turns a spreadsheet into parameters that drive the dimensions bound to it', async () => {
    const imported = importFcstd(new Uint8Array(readFileSync(join(FIXTURES, 'parameters_sheet.FCStd'))), opts('sheet'));
    if (!imported.ok) throw new Error(imported.error);
    const { document, steps, checks } = imported.value;
    await complete(document, steps, client, checks);
    const table = (document.parameters as Json[])[0] as Json;
    expect(table.name).toBe('Sizes');
    const rows = table.parameters as Json[];
    expect(rows.map((r) => r.name)).toEqual(['width', 'thick', 'half']);
    const body = (d: Display) => (d.definitions[0] as Display['definitions'][number]).bodies[0];
    const volume = (d: Display) => {
      const m = service.measure('volume', [(body(d) as NonNullable<ReturnType<typeof body>>).key]);
      return 'value' in m ? m.value : 0;
    };
    expect(volume(service.evaluate(document))).toBeCloseTo(40 * 20 * 10, 6);
    // Doubling the width doubles the height through `half`; the pad follows `thick`.
    (((rows[0] as Json).value as Json).def as Json).expr = { text: '80 mm', grammar: 1, refs: {} };
    (((rows[1] as Json).value as Json).def as Json).expr = { text: '1 mm', grammar: 1, refs: {} };
    expect(volume(service.evaluate(document))).toBeCloseTo(80 * 40 * 2, 6);
  });

  it('reads the colours FreeCAD shows', async () => {
    const imported = importFcstd(new Uint8Array(readFileSync(join(FIXTURES, 'body_colours.FCStd'))), opts('colours'));
    if (!imported.ok) throw new Error(imported.error);
    const { document, steps, checks, styles } = imported.value;
    await complete(document, steps, client, checks, styles);
    const shown = service.evaluate(document).definitions.flatMap((d) => d.bodies.map((b) => [b.color, b.opacity]));
    expect(shown).toEqual([
      ['#ff0000', 1],
      ['#0000ff', 0.6],
    ]);
  });

  it("reads one feature's dimension from another as a named value", async () => {
    const imported = importFcstd(
      new Uint8Array(readFileSync(join(FIXTURES, 'expression_between_features.FCStd'))),
      opts('named'),
    );
    if (!imported.ok) throw new Error(imported.error);
    const { document, steps, checks, notes } = imported.value;
    await complete(document, steps, client, checks);
    expect(notes.filter((n) => n.message.includes('expression'))).toEqual([]);
    const [, pad, , pocket] = ((document.parts as Json[])[0] as Json).timeline as Json[];
    const length = (((((pad as Json).inputs as Json).sides as Json[])[0] as Json).extent as Json).distance as Json;
    const depth = (((((pocket as Json).inputs as Json).sides as Json[])[0] as Json).extent as Json).distance as Json;
    expect(((depth.d as Json).def as Json).expr).toMatchObject({
      refs: { [(length.d as Json).name as string]: { value: { id: (length.d as Json).id } } },
    });
  });

  it('places a Body by its containers, and again for a link to it', async () => {
    const imported = importFcstd(
      new Uint8Array(readFileSync(join(FIXTURES, 'part_container.FCStd'))),
      opts('container'),
    );
    if (!imported.ok) throw new Error(imported.error);
    const { document, steps, checks } = imported.value;
    await complete(document, steps, client, checks);
    const instances = ((document.assemblies as Json[])[0] as Json).instances as Json[];
    expect(instances.map((i) => (i.placement as Json).position)).toEqual([
      [10, 0, 50],
      [100, 0, 0],
    ]);
  });
});

describe('Part workbench shapes', { timeout: 120_000 }, () => {
  const finished = async (file: string) => {
    const imported = importFcstd(new Uint8Array(readFileSync(join(FIXTURES, file))), opts(file));
    if (!imported.ok) throw new Error(imported.error);
    const { document, steps, notes, checks } = imported.value;
    const late = await complete(document, steps, client, checks);
    return { document, notes: [...notes, ...late], display: service.evaluate(document) };
  };

  it('gives each shape a link places a part of its own, at the link and not at the shape', async () => {
    const { document, notes, display } = await finished('link_shapes.FCStd');
    expect(notes.filter((n) => n.severity === 'warning')).toEqual([]);
    expect(display.pauses).toEqual([]);
    expect((document.parts as Json[]).map((p) => p.name)).toEqual(['Box', 'Pin']);
    const [box, pin] = (document.parts as Json[]).map((p) => p.id);
    const instances = ((document.assemblies as Json[])[0] as Json).instances as Json[];
    expect(instances.map((i) => [((i.of as Json).part as Json).id, (i.placement as Json).position])).toEqual([
      [box, [95, 0, 100]],
      [box, [195, 0, 100]],
      [pin, [0, 50, 100]],
    ]);
  });

  it('takes the shapes shown from a group, and nothing from an object with no shape', async () => {
    const { document, notes } = await finished('group_shapes.FCStd');
    expect(notes.filter((n) => n.severity === 'warning')).toEqual([]);
    const rows = ((document.parts as Json[])[0] as Json).timeline as Json[];
    expect(rows.map((f) => f.name)).toEqual(['Box']);
  });
});

describe('FreeCAD fixtures', { timeout: 120_000 }, () => {
  for (const file of files) {
    it(`imports ${file} with FreeCAD's volume and extents`, async () => {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)));
      const imported = importFcstd(bytes, {
        ids: seededIds(3),
        writer: { app: 'test', version: '0' },
        name: file.replace(/\.FCStd$/, ''),
        now: '2026-11-06T00:00:00Z',
      });
      if (!imported.ok) throw new Error(imported.error);
      const { document, steps, notes, checks, styles } = imported.value;
      // Each file as the app opens it, on a worker that kept nothing of another.
      service.release();
      const late = await complete(document, steps, client, checks, styles);
      const read = readDocument(document);
      expect(read.diagnostics.filter((d) => d.severity === 'refuse')).toEqual([]);
      expect([...notes, ...late].filter((n) => n.severity === 'warning').map((n) => n.object)).toEqual(
        STORED[file] ?? [],
      );
      const display = service.evaluate(document);
      expect(display.pauses.map((p) => p.message)).toEqual([]);
      // The opened document takes over what finishing built.
      if (steps.some((s) => s.kind === 'locate'))
        expect(display.timing.resumed, JSON.stringify(display.timing.misses)).toBeGreaterThan(0);
      const want = freecad(bytes);
      const got = measured(display);
      expect(got).toHaveLength(want.length);
      want.forEach((w, i) => {
        const g = got[i] as (typeof got)[number];
        expect(g.volume / w.volume, `${w.body} volume ${g.volume} against ${w.volume}`).toBeCloseTo(
          1,
          PLACES[file] ?? 5,
        );
        for (let a = 0; a < 3; a++) {
          expect(Math.abs((g.box[0][a] as number) - (w.box[0][a] as number)), `${w.body} box min`).toBeLessThan(0.1);
          expect(Math.abs((g.box[1][a] as number) - (w.box[1][a] as number)), `${w.body} box max`).toBeLessThan(0.1);
        }
      });
    });
  }
});

/**
 * STEP, STL and BREP files read into a `core.import`'s stored shape, then
 * replayed by evaluation on the real kernel: the bodies the file holds, with
 * their volumes, and the same names from the same file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument } from '@tweakcad/format';
import { DocBuilder } from '../docBuilder';
import type { Json } from '../context';
import { EvaluationService } from './service';
import { ImportRefusal, type ImportFormat, type ImportProgress } from './importShape';

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  service = new EvaluationService(k);
});
afterAll(() => {
  service.release();
  k.releaseAll();
});

/** Two boxes, 10 × 20 × 30 at the origin and 5 × 5 × 5 at x = 40, as a file of `format`. */
function file(format: ImportFormat | 'brep-text'): Uint8Array {
  const a = k.makeBox(10, 20, 30);
  const b = k.translate(k.makeBox(5, 5, 5), 40, 0, 0);
  const both = k.makeCompound([a, b]);
  try {
    if (format === 'step') return new TextEncoder().encode(k.exportStep(both));
    if (format === 'stl') return new Uint8Array(k.exportStl(both, 0.1));
    if (format === 'brep-text') return new TextEncoder().encode(k.toBREP(both));
    return new Uint8Array(k.toBREPBinary(both));
  } finally {
    for (const h of [both, b, a]) k.release(h);
  }
}

/** A document of one `core.import` of `bytes`. */
function importDoc(bytes: Uint8Array, format: ImportFormat): { doc: Json; bodies: number } {
  const d = new DocBuilder();
  const inputs: Json = {
    source: {},
    stored: {},
    importer: { format, version: '1' },
    units: d.val('"mm"'),
    upAxis: d.val('"y"'),
  };
  const feature = d.feature('core.import', inputs);
  const shape = service.importFile(bytes, format, feature, `two-boxes.${format}`);
  inputs.source = { file: { asset: shape.source } };
  inputs.stored = shape.stored;
  const doc = d.document();
  Object.assign(doc.assets as Json, shape.assets);
  Object.assign(doc.names as Json, shape.names);
  return { doc, bodies: shape.bodies };
}

function volumes(doc: Json): number[] {
  const display = service.evaluate(doc);
  expect(display.pauses).toEqual([]);
  const keys = (display.definitions[0]?.bodies ?? []).map((b) => b.key);
  return keys
    .map((key) => {
      const m = service.measure('volume', [key]);
      return 'value' in m ? Math.round(m.value) : NaN;
    })
    .sort((x, y) => x - y);
}

describe('importing a file as a stored shape', { timeout: 60_000 }, () => {
  for (const format of ['step', 'brep', 'brep-text', 'stl'] as const) {
    it(`replays the solids of a ${format} file as bodies`, () => {
      const kind = format === 'brep-text' ? 'brep' : format;
      const { doc, bodies } = importDoc(file(format), kind);
      expect(readDocument(doc).refused).toBe(false);
      expect(bodies).toBe(2);
      expect(volumes(doc)).toEqual([125, 6000]);
    });
  }

  it('names the same file the same way, and keeps the file it came from', () => {
    const bytes = file('step');
    const a = service.importFile(bytes, 'step', 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'a.step');
    const b = service.importFile(bytes, 'step', 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'a.step');
    expect(b.stored).toEqual(a.stored);
    expect(Object.keys(a.assets)).toContain(a.source);
    expect(a.assets[a.source]?.size).toBe(bytes.length);
    expect(a.assets[a.stored.asset]?.mediaType).toBe('model/x-brep');
  });

  it('merges the coplanar triangles of an STL into faces, and refuses a mesh too fine to store', () => {
    // Two boxes: 1 compound, then per box 1 solid, 1 shell, 6 faces, 6 wires, 12 edges and 8 vertices.
    const shape = service.importFile(file('stl'), 'stl', 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'boxes.stl');
    expect(shape.stored.map).toHaveLength(1 + 2 * 34);
    const sphere = k.makeSphere(20);
    const fine = new Uint8Array(k.exportStl(sphere, 0.02));
    k.release(sphere);
    expect(() => service.importFile(fine, 'stl', 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'ball.stl')).toThrow(/faces/);
  });

  it('reports each stage of an STL import as it starts', () => {
    const stages: ImportProgress[] = [];
    service.importFile(file('stl'), 'stl', 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'two-boxes.stl', (p) => stages.push(p));
    expect(stages).toEqual([
      { stage: 'reading' },
      { stage: 'sewing', triangles: 24 },
      { stage: 'solids', done: 0, total: 2 },
      { stage: 'solids', done: 1, total: 2 },
      { stage: 'naming', faces: 12 },
    ]);
  });

  it('refuses an STL mesh with a hole in it, rather than making an open shell a body', () => {
    // A 10 mm cube's twelve triangles, outward, less the two of its top.
    const p = (i: number): [number, number, number] => [(i & 1) * 10, ((i >> 1) & 1) * 10, ((i >> 2) & 1) * 10];
    const quads = [
      [0, 2, 3, 1],
      [0, 1, 5, 4],
      [1, 3, 7, 5],
      [3, 2, 6, 7],
      [2, 0, 4, 6],
    ];
    const facet = (a: number, b: number, c: number) =>
      `facet normal 0 0 0\nouter loop\n${[a, b, c].map((i) => `vertex ${p(i).join(' ')}`).join('\n')}\nendloop\nendfacet`;
    const stl = `solid open\n${quads.flatMap(([a, b, c, d]) => [facet(a!, b!, c!), facet(a!, c!, d!)]).join('\n')}\nendsolid open\n`;
    const bytes = new TextEncoder().encode(stl);
    expect(() => service.importFile(bytes, 'stl', 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'open.stl')).toThrow(
      ImportRefusal,
    );
  });

  it('imports the closed meshes of an STL and counts the open ones it leaves out', () => {
    // A closed 10 mm cube, and 50 mm along x the same cube less its top.
    const p = (i: number, dx: number): [number, number, number] => [
      (i & 1) * 10 + dx,
      ((i >> 1) & 1) * 10,
      ((i >> 2) & 1) * 10,
    ];
    const sides = [
      [0, 2, 3, 1],
      [0, 1, 5, 4],
      [1, 3, 7, 5],
      [3, 2, 6, 7],
      [2, 0, 4, 6],
    ];
    const top = [4, 5, 7, 6];
    const facet = (dx: number, a: number, b: number, c: number) =>
      `facet normal 0 0 0\nouter loop\n${[a, b, c].map((i) => `vertex ${p(i, dx).join(' ')}`).join('\n')}\nendloop\nendfacet`;
    const quads = (dx: number, list: number[][]) =>
      list.flatMap(([a, b, c, d]) => [facet(dx, a!, b!, c!), facet(dx, a!, c!, d!)]);
    const stl = `solid mixed\n${[...quads(0, [...sides, top]), ...quads(50, sides)].join('\n')}\nendsolid mixed\n`;
    const { doc, bodies } = importDoc(new TextEncoder().encode(stl), 'stl');
    expect(bodies).toBe(1);
    expect(volumes(doc)).toEqual([1000]);
    const shape = service.importFile(
      new TextEncoder().encode(stl),
      'stl',
      'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA',
      'mixed.stl',
    );
    expect(shape.skipped).toBe(1);
  });

  it('refuses files with nothing solid in them', () => {
    const face = k.makeRectangle(10, 10);
    const open = new TextEncoder().encode(k.toBREP(face));
    k.release(face);
    expect(() => service.importFile(open, 'brep', 'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA', 'face.brep')).toThrow(
      ImportRefusal,
    );
    expect(() =>
      service.importFile(
        new TextEncoder().encode('not a step file'),
        'step',
        'feat_AAAAAAAAAAAAAAAAAAAAAAAAAA',
        'x.step',
      ),
    ).toThrow(ImportRefusal);
  });
});
